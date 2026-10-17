// Live activity feed, run limits and usage/cost accounting.
import { db, now, settings, json } from "./db.js";
import { broadcast } from "./hub.js";

// ---------- Activity ----------
export function logActivity({ agent_id = null, task_id = null, run_id = null, kind, summary, detail = null }) {
  const at = now();
  const r = db.prepare(
    "INSERT INTO activity (at, agent_id, task_id, run_id, kind, summary, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(at, agent_id, task_id, run_id, kind, String(summary).slice(0, 500), detail ? JSON.stringify(detail).slice(0, 4000) : null);
  const item = { id: Number(r.lastInsertRowid), at, agent_id, task_id, run_id, kind, summary, detail };
  broadcast({ type: "activity", item });
  return item;
}

export function listActivity({ limit = 200, task_id, agent_id, before } = {}) {
  const where = [];
  const args = [];
  if (task_id) { where.push("task_id = ?"); args.push(task_id); }
  if (agent_id) { where.push("agent_id = ?"); args.push(agent_id); }
  if (before) { where.push("id < ?"); args.push(before); }
  return db.prepare(`SELECT * FROM activity ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit).map((r) => ({ ...r, detail: json(r.detail, null) }));
}

// ---------- Limits ----------
// On the Claude Code login (subscription) the dollar figures are API-equivalent estimates, not charges,
// and the plan's own usage limits apply. So dollar caps are off there by default (0 = no cap); they
// stay on by default only when running on a paid API key.
const ON_SUBSCRIPTION = (process.env.ENGINE || (process.env.ANTHROPIC_API_KEY ? "api" : "claude-code")) === "claude-code";
export const DEFAULT_LIMITS = {
  max_concurrent_runs: 2,     // more queued tasks wait their turn
  max_runtime_minutes: 15,    // a run past this is stopped and counted as a timeout (retried if attempts remain)
  max_attempts: 3,            // total attempts per task, including the first
  max_tool_actions: 60,       // tool calls per run; reaching it stops the run as failed (not retried)
  stall_minutes: 5,           // a live run with no tool call or output for this long is stopped and retried
  daily_spend_usd: ON_SUBSCRIPTION ? 0 : 5,     // 0 = no cap; otherwise no new runs start after the cap until midnight
  per_run_budget_usd: ON_SUBSCRIPTION ? 0 : 1,  // 0 = no cap; otherwise a run stops when its estimated cost reaches this
};
export const getLimits = () => ({ ...DEFAULT_LIMITS, ...json(settings.get("limits"), {}) });
export function setLimits(patch) {
  const next = { ...getLimits() };
  for (const k of Object.keys(DEFAULT_LIMITS)) {
    if (patch[k] === undefined) continue;
    const v = Number(patch[k]);
    if (Number.isFinite(v) && v >= 0) next[k] = v;
  }
  next.max_concurrent_runs = Math.max(1, Math.round(next.max_concurrent_runs));
  next.max_attempts = Math.max(1, Math.round(next.max_attempts));
  settings.set("limits", JSON.stringify(next));
  return next;
}

// ---------- Usage ----------
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function recordUsage({ agent_id, task_id = null, run_id = null, kind, model, cost_usd = 0, input_tokens = null, output_tokens = null }) {
  db.prepare(
    "INSERT INTO usage_log (at, agent_id, task_id, run_id, kind, model, cost_usd, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(now(), agent_id, task_id, run_id, kind, model ?? null, Number(cost_usd) || 0, input_tokens, output_tokens);
}

export function spendToday() {
  return db.prepare("SELECT coalesce(sum(cost_usd), 0) AS c FROM usage_log WHERE at >= ?").get(startOfToday()).c;
}

export function usageSummary(days = 7) {
  const since = startOfToday() - (days - 1) * 86400000;
  const rows = db.prepare(`
    SELECT date(at / 1000, 'unixepoch', 'localtime') AS day, agent_id, count(*) AS calls, sum(cost_usd) AS cost,
           sum(coalesce(input_tokens, 0)) AS input_tokens, sum(coalesce(output_tokens, 0)) AS output_tokens
    FROM usage_log WHERE at >= ? GROUP BY day, agent_id ORDER BY day DESC`).all(since);
  return { today: spendToday(), limits: getLimits(), rows };
}

export function budgetBlockReason() {
  const { daily_spend_usd } = getLimits();
  if (daily_spend_usd > 0 && spendToday() >= daily_spend_usd) {
    return `Daily spending limit reached ($${spendToday().toFixed(2)} of $${daily_spend_usd.toFixed(2)} estimated). New runs start after midnight, or raise the limit in Settings.`;
  }
  return null;
}
