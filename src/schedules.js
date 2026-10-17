// Durable schedules. The next run time is stored in the database and checked by the worker every few
// seconds, so a schedule fires without any browser open and missed runs are detected after downtime.
import { CronExpressionParser } from "cron-parser";
import { execFile } from "node:child_process";
import { db, now, uid, json, agents } from "./db.js";
import { broadcast } from "./hub.js";
import { logActivity } from "./activity.js";
import { createTask, tasks, ACTIVE_STATES, onTick, workerStatus } from "./queue.js";
import { workflows, runWorkflow } from "./workflows.js";

export const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const GRACE_MS = 2 * 60_000; // a fire more than 2 minutes late counts as missed

const parse = (s) => s && { ...s, input: json(s.input, {}), enabled: Boolean(s.enabled) };

export function nextRun(cron, timezone, from = new Date()) {
  return CronExpressionParser.parse(cron, { tz: timezone || LOCAL_TZ, currentDate: from }).next().toDate().getTime();
}
export function validateCron(cron, timezone) {
  try { nextRun(cron, timezone); } catch (e) { throw new Error(`Invalid schedule "${cron}": ${e.message}`); }
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone || LOCAL_TZ }); } catch { throw new Error(`Unknown time zone "${timezone}"`); }
}

export const schedules = {
  list: () => db.prepare("SELECT * FROM schedules ORDER BY created_at").all().map(parse),
  get: (id) => parse(db.prepare("SELECT * FROM schedules WHERE id = ?").get(id)),
  history: (id, limit = 50) => db.prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT ?").all(id, limit),
};

export function createSchedule(s, { actor = "owner" } = {}) {
  const tz = s.timezone || LOCAL_TZ;
  validateCron(s.cron, tz);
  const target = s.target_type === "workflow" ? "workflow" : "task";
  if (target === "task" && !agents.get(s.agent_id)) throw new Error("Choose a team member (agent_id) for this schedule.");
  if (target === "workflow" && !workflows.get(s.workflow_id)) throw new Error("Choose a workflow for this schedule.");
  if (target === "task" && !s.prompt?.trim()) throw new Error("Give the instructions to run each time.");
  const id = uid();
  db.prepare(`INSERT INTO schedules (id, agent_id, cron, prompt, enabled, created_at, name, timezone, target_type, workflow_id, input,
    next_run_at, overlap_policy, missed_policy) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, s.agent_id ?? "", s.cron, s.prompt ?? "", now(), s.name?.trim() || null, tz, target, s.workflow_id ?? null,
      JSON.stringify(s.input ?? {}), nextRun(s.cron, tz),
      s.overlap_policy === "queue" ? "queue" : "skip", s.missed_policy === "skip" ? "skip" : "run_once");
  logActivity({ kind: "schedule", summary: `${agents.get(actor)?.name ?? "You"} created schedule "${s.name || s.cron}" (${tz})` });
  broadcast({ type: "schedules_changed" });
  return schedules.get(id);
}

export function setEnabled(id, enabled) {
  const s = schedules.get(id);
  if (!s) throw new Error("No such schedule");
  // Resuming starts from now: pauses don't produce a burst of "missed" runs.
  db.prepare("UPDATE schedules SET enabled = ?, next_run_at = ? WHERE id = ?").run(enabled ? 1 : 0, enabled ? nextRun(s.cron, s.timezone) : s.next_run_at, id);
  broadcast({ type: "schedules_changed" });
}
export function deleteSchedule(id) {
  db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  broadcast({ type: "schedules_changed" });
}

function record(s, outcome, { scheduled_for = null, task_id = null, workflow_run_id = null, note = null } = {}) {
  db.prepare("INSERT INTO schedule_runs (schedule_id, fired_at, scheduled_for, outcome, task_id, workflow_run_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(s.id, now(), scheduled_for, outcome, task_id, workflow_run_id, note);
  db.prepare("UPDATE schedules SET last_run = ?, last_outcome = ? WHERE id = ?").run(now(), outcome, s.id);
  logActivity({ agent_id: s.agent_id || null, task_id, kind: "schedule", summary: `Schedule "${s.name || s.cron}": ${outcome.replace(/_/g, " ")}${note ? ` (${note})` : ""}` });
}

function hasActiveRun(s) {
  const placeholders = ACTIVE_STATES.map(() => "?").join(",");
  return db.prepare(`SELECT count(*) AS n FROM tasks WHERE schedule_id = ? AND status IN (${placeholders})`).get(s.id, ...ACTIVE_STATES).n > 0;
}

export function fire(s, { scheduled_for = now(), note = null, actor = "schedule" } = {}) {
  if (s.target_type === "workflow") {
    const { run } = runWorkflow(s.workflow_id, s.input, { actor: "schedule", schedule_id: s.id });
    record(s, "started_workflow", { scheduled_for, workflow_run_id: run.id, note });
    return { workflow_run_id: run.id };
  }
  const t = createTask({
    title: s.name || `Scheduled: ${s.prompt.slice(0, 60)}`, description: s.prompt, agent_id: s.agent_id, status: "queued",
    input: { ...s.input, scheduled_for: new Date(scheduled_for).toISOString() }, schedule_id: s.id,
  }, { actor });
  record(s, "created_task", { scheduled_for, task_id: t.id, note });
  return { task_id: t.id };
}

async function checkSchedules() {
  const due = db.prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?").all(now()).map(parse);
  for (const s of due) {
    const scheduledFor = s.next_run_at;
    // Advance first, so a crash mid-fire can't fire the same occurrence twice.
    let missedCount = 0;
    let next = nextRun(s.cron, s.timezone, new Date(scheduledFor));
    while (next <= now()) { missedCount++; next = nextRun(s.cron, s.timezone, new Date(next)); }
    db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(next, s.id);

    const late = now() - scheduledFor > GRACE_MS;
    try {
      if (late) {
        const n = missedCount + 1;
        if (s.missed_policy === "skip") { record(s, "missed_skipped", { scheduled_for: scheduledFor, note: `${n} run(s) missed while the app was off` }); continue; }
        if (hasActiveRun(s) && s.overlap_policy === "skip") { record(s, "skipped_overlap", { scheduled_for: scheduledFor, note: "previous run still active" }); continue; }
        fire(s, { scheduled_for: scheduledFor, note: `catch-up: ${n} run(s) missed, ran once` });
        continue;
      }
      if (hasActiveRun(s) && s.overlap_policy === "skip") { record(s, "skipped_overlap", { scheduled_for: scheduledFor, note: "previous run still active" }); continue; }
      fire(s, { scheduled_for: scheduledFor });
    } catch (e) {
      record(s, "error", { scheduled_for: scheduledFor, note: e.message });
    }
  }
  if (due.length) broadcast({ type: "schedules_changed" });
}

let last = 0;
onTick(async () => {
  if (now() - last < 5000) return;
  last = now();
  await checkSchedules();
});

// Old node-cron schedules get a time zone and next run time.
export function migrateLegacySchedules() {
  for (const s of db.prepare("SELECT * FROM schedules WHERE next_run_at IS NULL").all()) {
    try {
      db.prepare("UPDATE schedules SET timezone = coalesce(timezone, ?), next_run_at = ? WHERE id = ?").run(LOCAL_TZ, nextRun(s.cron, s.timezone || LOCAL_TZ), s.id);
    } catch {
      db.prepare("UPDATE schedules SET enabled = 0, last_outcome = 'error' WHERE id = ?").run(s.id);
    }
  }
}

// ---------- Execution environment ----------
// The worker runs inside this app's server process. Schedules only fire while it runs, so we report
// whether Windows is set to start it automatically, instead of just claiming schedules are "active".
const TASK_NAME = "HASANS TEAM Worker";
let autostartCache = { at: 0, installed: null };
export function autostartStatus() {
  if (process.platform !== "win32") return Promise.resolve({ supported: false, installed: null });
  if (now() - autostartCache.at < 60_000) return Promise.resolve({ supported: true, installed: autostartCache.installed, task_name: TASK_NAME });
  return new Promise((resolve) => {
    execFile("schtasks", ["/Query", "/TN", TASK_NAME], { windowsHide: true }, (err) => {
      autostartCache = { at: now(), installed: !err };
      resolve({ supported: true, installed: !err, task_name: TASK_NAME });
    });
  });
}

export async function schedulerHealth() {
  const w = workerStatus();
  const auto = await autostartStatus();
  return {
    worker_alive: w.alive, worker_heartbeat_at: w.heartbeat_at, autostart: auto,
    statement: w.alive
      ? `Background worker running (heartbeat ${Math.round((now() - w.heartbeat_at) / 1000)}s ago). Schedules fire while this app runs on this PC${auto.installed ? "; it starts automatically when you sign in to Windows." : ". It does NOT start automatically yet — run install-autostart.ps1 so schedules survive reboots."}`
      : "Background worker is not running: schedules will not fire.",
  };
}
