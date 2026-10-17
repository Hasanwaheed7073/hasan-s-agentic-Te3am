// Action permissions, standing grants, the persisted approval queue, and exactly-once external actions.
// Everything here is enforced in code at execution time; prompts and UI buttons are not the boundary.
import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import { db, now, uid, json, agents } from "./db.js";
import { broadcast } from "./hub.js";
import { logActivity } from "./activity.js";
import { optOutFor, logInteraction } from "./prospects.js";

export const ACTION_TYPES = {
  research: "Research (web, browser, reading)",
  drafting: "Drafting (save drafts, files)",
  public_post: "Public posting",
  private_message: "Private messaging",
  email_send: "Email sending",
  external_update: "Updating external systems",
};
export const EXTERNAL_TYPES = ["public_post", "private_message", "email_send", "external_update"];
export const DEFAULT_PERMISSIONS = ["research", "drafting"];
export const hasPermission = (agent, type) => (agent?.permissions ?? DEFAULT_PERMISSIONS).includes(type);

// Channels we can actually execute. Anything else becomes a manual send you confirm yourself.
export const CHANNELS = {
  email: { label: "Email", auto: () => smtpConfigured() },
  linkedin: { label: "LinkedIn", auto: () => false },
  reddit: { label: "Reddit", auto: () => false },
  other: { label: "Other", auto: () => false },
};

// ---------- Grants (standing authorization) ----------
const parseGrant = (g) => g;
export const grants = {
  list: () => db.prepare("SELECT * FROM grants ORDER BY created_at DESC").all().map(parseGrant),
  create(g) {
    if (!EXTERNAL_TYPES.includes(g.action_type)) throw new Error(`action_type must be one of ${EXTERNAL_TYPES.join(", ")}`);
    if (g.agent_id !== "*" && !agents.get(g.agent_id)) throw new Error("Unknown agent_id");
    const id = uid();
    const int = (v) => (v === null || v === undefined || v === "" ? null : Math.max(0, Math.round(Number(v))));
    db.prepare(`INSERT INTO grants (id, agent_id, action_type, channel, account, daily_limit, total_limit, expires_at, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, g.agent_id, g.action_type, (g.channel || "*").toLowerCase(), (g.account || "*").toLowerCase(),
        int(g.daily_limit), int(g.total_limit), g.expires_at ? Number(g.expires_at) : null, g.note ?? null, now());
    return db.prepare("SELECT * FROM grants WHERE id = ?").get(id);
  },
  revoke: (id) => db.prepare("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now(), id),
  usage(id) {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const q = "SELECT count(*) AS n FROM actions WHERE grant_id = ? AND status IN ('sent','sending','ready_for_manual_send','sent_manually','uncertain')";
    return {
      today: db.prepare(q + " AND created_at >= ?").get(id, startOfDay.getTime()).n,
      total: db.prepare(q).get(id).n,
    };
  },
};

// Finds a live grant covering this action with room left under its limits.
function findGrant({ agent_id, action_type, channel, account }) {
  const rows = db.prepare(`SELECT * FROM grants WHERE revoked_at IS NULL AND action_type = ?
    AND (agent_id = ? OR agent_id = '*') AND (channel = ? OR channel = '*') AND (account = ? OR account = '*')
    AND (expires_at IS NULL OR expires_at > ?) ORDER BY agent_id = '*', channel = '*', account = '*'`)
    .all(action_type, agent_id, (channel || "").toLowerCase(), (account || "").toLowerCase(), now());
  for (const g of rows) {
    const u = grants.usage(g.id);
    if (g.daily_limit !== null && u.today >= g.daily_limit) continue;
    if (g.total_limit !== null && u.total >= g.total_limit) continue;
    return g;
  }
  return null;
}

// ---------- Approvals ----------
const parseApproval = (a) => a && { ...a, details: json(a.details, {}) };
export const approvals = {
  list: (status) => db.prepare(`SELECT * FROM approvals ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT 300`)
    .all(...(status ? [status] : [])).map(parseApproval),
  get: (id) => parseApproval(db.prepare("SELECT * FROM approvals WHERE id = ?").get(id)),
  pendingForTask: (task_id) => db.prepare("SELECT count(*) AS n FROM approvals WHERE task_id = ? AND status = 'pending'").get(task_id).n,
};

function createApproval({ kind, action_id = null, task_id = null, agent_id = null, thread_id = null, summary, details }) {
  const id = uid();
  db.prepare(`INSERT INTO approvals (id, kind, action_id, task_id, agent_id, thread_id, summary, details, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(id, kind, action_id, task_id, agent_id, thread_id, summary, JSON.stringify(details ?? {}), now());
  const a = approvals.get(id);
  broadcast({ type: "approvals_changed" });
  logActivity({ agent_id, task_id, kind: "approval_requested", summary, detail: { approval_id: id, ...details } });
  return a;
}

// Interactive approvals block a live run (e.g. a browser click on an "ask me" site) until you answer.
const waiters = new Map(); // approval id -> resolve
export function requestInteractiveApproval({ agent, threadId, taskId = null, action, details, signal }) {
  const a = createApproval({ kind: "interactive", task_id: taskId, agent_id: agent.id, thread_id: threadId, summary: action, details: { text: details } });
  const timeoutMs = Number(process.env.APPROVAL_TIMEOUT_MINUTES ?? 30) * 60_000;
  return new Promise((resolve) => {
    const finish = (status, note) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      waiters.delete(a.id);
      db.prepare("UPDATE approvals SET status = ?, note = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, note ?? null, now(), a.id);
      broadcast({ type: "approvals_changed" });
      resolve({ approved: status === "approved", note: note ?? "" });
    };
    const timer = setTimeout(() => finish("expired", "No response in time. Do not perform the action; report it as pending."), timeoutMs);
    const onAbort = () => finish("expired", "Run was stopped.");
    signal?.addEventListener("abort", onAbort);
    waiters.set(a.id, finish);
  });
}

// Interactive approvals can't survive a restart: the run that was waiting is gone.
export function expireStaleInteractive() {
  db.prepare("UPDATE approvals SET status = 'expired', note = 'App restarted while waiting', decided_at = ? WHERE kind = 'interactive' AND status = 'pending'").run(now());
}

let onActionResolved = () => {};
export const setActionResolvedHook = (fn) => (onActionResolved = fn);

export async function decideApproval(id, approved, note = "", actor = "owner") {
  const a = approvals.get(id);
  if (!a) throw new Error("No such approval");
  if (a.status !== "pending") throw new Error(`Already ${a.status}`);
  if (a.kind === "interactive") {
    const w = waiters.get(id);
    if (!w) {
      db.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ?").run(now(), id);
      throw new Error("That run is no longer waiting (it ended or the app restarted).");
    }
    w(approved ? "approved" : "denied", note);
  } else {
    db.prepare("UPDATE approvals SET status = ?, note = ?, decided_at = ? WHERE id = ?").run(approved ? "approved" : "denied", note || null, now(), id);
    const action = getAction(a.action_id);
    if (action) {
      if (approved) await executeAction(action, { reason: "approved" });
      else setActionStatus(action.id, "denied", { error: note || "Denied by owner" });
    }
    broadcast({ type: "approvals_changed" });
  }
  logActivity({ agent_id: a.agent_id, task_id: a.task_id, kind: "approval_decided", summary: `${approved ? "Approved" : "Denied"} by ${actor}: ${a.summary}`, detail: { approval_id: id, note } });
  if (a.task_id) onActionResolved(a.task_id);
}

// ---------- Actions ----------
const getAction = (id) => db.prepare("SELECT * FROM actions WHERE id = ?").get(id);
export const actions = {
  get: getAction,
  list: ({ status, task_id, limit = 300 } = {}) => {
    const where = [];
    const args = [];
    if (status) { where.push("status = ?"); args.push(status); }
    if (task_id) { where.push("task_id = ?"); args.push(task_id); }
    return db.prepare(`SELECT * FROM actions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`).all(...args, limit);
  },
};

function setActionStatus(id, status, { result = null, error = null } = {}) {
  db.prepare("UPDATE actions SET status = ?, result = coalesce(?, result), error = ?, updated_at = ? WHERE id = ?").run(status, result, error, now(), id);
  broadcast({ type: "actions_changed" });
}

// Deliberately excludes the agent: the same message to the same destination from any teammate is one action.
export const idempotencyKey = (a) => createHash("sha256")
  .update([a.action_type, a.channel, a.account, a.destination, a.subject, a.content].map((v) => String(v ?? "").trim().toLowerCase()).join("␟"))
  .digest("hex");

/**
 * The only path to an external action. Order of checks:
 * 1. the agent's permission for this action type; 2. opt-outs; 3. exactly-once (same content to the
 * same destination is never sent twice, including on retries); 4. standing grant → execute now;
 * otherwise 5. the approval queue, executed by the system (not the agent) once you approve.
 */
export async function requestAction(ctx, input) {
  const { agent } = ctx;
  const type = input.action_type;
  if (!EXTERNAL_TYPES.includes(type)) throw new Error(`action_type must be one of ${EXTERNAL_TYPES.join(", ")}`);
  // Draft-only campaigns: refused before anything is recorded, whatever permissions or grants exist.
  const campaignId = ctx.taskRun?.task.campaign_id;
  if (campaignId) {
    const c = db.prepare("SELECT outreach_mode, name FROM campaigns WHERE id = ?").get(campaignId);
    if (c?.outreach_mode === "draft_only") {
      logActivity({ agent_id: agent.id, task_id: ctx.taskRun.task.id, kind: "action_blocked", summary: `Blocked ${type}: campaign "${c.name}" is draft-only` });
      return { status: "blocked_draft_only", message: `Not allowed: "${c.name}" is a draft-only campaign. Nothing was sent or queued. Save a draft instead.` };
    }
  }
  if (!hasPermission(agent, type)) {
    throw new Error(`${agent.name} is not permitted to request "${ACTION_TYPES[type]}". The owner can enable it in this member's profile. Save a draft instead.`);
  }
  if (!input.content?.trim()) throw new Error("content is required: the exact text to send or post.");
  if (!input.destination?.trim()) throw new Error("destination is required (email address, profile URL, subreddit/thread URL, or system record).");
  const channel = CHANNELS[input.channel] ? input.channel : "other";
  const row = {
    agent_id: agent.id, action_type: type, channel, account: (input.account || "default").trim(),
    destination: input.destination.trim(), subject: input.subject?.trim() || null, content: input.content.trim(),
    prospect_id: input.prospect_id || null, task_id: ctx.taskRun?.task.id ?? null, run_id: ctx.taskRun?.run.id ?? null,
  };

  const optedOut = optOutFor({ prospect_id: row.prospect_id, destination: row.destination });
  if (optedOut) {
    logActivity({ agent_id: agent.id, task_id: row.task_id, kind: "action_blocked", summary: `Blocked ${type} to ${row.destination}: contact opted out` });
    return { status: "blocked_opt_out", message: `Blocked: ${optedOut.name || optedOut.business || "this contact"} has opted out or is marked do-not-contact. Nothing was sent.` };
  }

  const key = idempotencyKey(row);
  const existing = db.prepare("SELECT * FROM actions WHERE idempotency_key = ?").get(key);
  if (existing) {
    return { status: existing.status, action_id: existing.id, duplicate: true,
      message: `Not repeated: this exact ${type} to ${row.destination} already exists (action ${existing.id}, status ${existing.status}).` };
  }

  const id = uid();
  db.prepare(`INSERT INTO actions (id, idempotency_key, task_id, run_id, agent_id, action_type, channel, account, destination, prospect_id,
    subject, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)`)
    .run(id, key, row.task_id, row.run_id, row.agent_id, type, channel, row.account, row.destination, row.prospect_id, row.subject, row.content, now(), now());

  const grant = findGrant({ agent_id: agent.id, action_type: type, channel, account: row.account });
  if (grant) {
    db.prepare("UPDATE actions SET grant_id = ? WHERE id = ?").run(grant.id, id);
    const done = await executeAction(getAction(id), { reason: "standing grant" });
    return { status: done.status, action_id: id, message: describeOutcome(done) };
  }

  const approval = createApproval({
    kind: "action", action_id: id, task_id: row.task_id, agent_id: agent.id,
    summary: `${agent.name}: ${ACTION_TYPES[type]} via ${CHANNELS[channel].label} to ${row.destination}`,
    details: { action_type: type, channel, account: row.account, destination: row.destination, subject: row.subject, content: row.content, prospect_id: row.prospect_id },
  });
  db.prepare("UPDATE actions SET status = 'pending_approval', approval_id = ?, updated_at = ? WHERE id = ?").run(approval.id, now(), id);
  broadcast({ type: "actions_changed" });
  return { status: "pending_approval", action_id: id, approval_id: approval.id,
    message: `Queued for the owner's approval (approval ${approval.id}). The system will carry it out after approval. Do not request it again.` };
}

function describeOutcome(a) {
  switch (a.status) {
    case "sent": return `Sent and accepted by the mail server (action ${a.id}). Delivery to the inbox is not confirmed.`;
    case "ready_for_manual_send": return `Approved. ${CHANNELS[a.channel]?.label ?? a.channel} has no automatic sending connected, so it is waiting in the owner's manual-send queue. It is NOT sent yet.`;
    case "failed": return `Failed, not sent: ${a.error}`;
    case "uncertain": return `Delivery uncertain (${a.error}). It is NOT counted as sent; the owner will check.`;
    default: return `Status: ${a.status}`;
  }
}

// Executes an approved or granted action exactly once. Never reports success it didn't observe.
async function executeAction(action, { reason }) {
  const claimed = db.prepare("UPDATE actions SET status = 'sending', updated_at = ? WHERE id = ? AND status IN ('requested','pending_approval')").run(now(), action.id);
  if (claimed.changes !== 1) return getAction(action.id); // someone else already handled it

  const auto = CHANNELS[action.channel]?.auto() && action.action_type === "email_send";
  if (!auto) {
    setActionStatus(action.id, "ready_for_manual_send", { result: `Approved (${reason}); waiting for you to send it manually.` });
  } else {
    try {
      const info = await sendEmail(action);
      const accepted = (info.accepted ?? []).map(String).map((s) => s.toLowerCase());
      if (accepted.includes(action.destination.toLowerCase())) {
        setActionStatus(action.id, "sent", { result: `Accepted by mail server: ${info.response ?? ""}`.trim() });
      } else {
        setActionStatus(action.id, "failed", { error: `Mail server did not accept the recipient (${info.response ?? "no response"})` });
      }
    } catch (err) {
      // A timeout after the server may have received the message is not proof either way.
      const uncertain = /timeout|ETIMEDOUT|ECONNRESET|socket/i.test(err.message);
      setActionStatus(action.id, uncertain ? "uncertain" : "failed", { error: err.message });
    }
  }
  const final = getAction(action.id);
  if (final.prospect_id) {
    logInteraction(final.prospect_id, { agent_id: final.agent_id, type: final.action_type, action_id: final.id, task_id: final.task_id, summary: `${ACTION_TYPES[final.action_type]} → ${final.status}` });
  }
  logActivity({ agent_id: final.agent_id, task_id: final.task_id, kind: "action_executed", summary: `${ACTION_TYPES[final.action_type]} to ${final.destination}: ${final.status}`, detail: { action_id: final.id, error: final.error } });
  return final;
}

// You confirm manual sends yourself; only then do they count as sent.
export function confirmManual(id, sent, note = "") {
  const a = getAction(id);
  if (!a) throw new Error("No such action");
  if (!["ready_for_manual_send", "uncertain"].includes(a.status)) throw new Error(`Action is ${a.status}`);
  setActionStatus(id, sent ? "sent_manually" : "failed", { result: sent ? `Marked sent by owner. ${note}`.trim() : null, error: sent ? null : note || "Marked not sent by owner" });
  if (a.prospect_id) logInteraction(a.prospect_id, { agent_id: a.agent_id, type: a.action_type, action_id: id, summary: sent ? "Sent manually by owner" : "Manual send marked failed" });
  logActivity({ agent_id: a.agent_id, task_id: a.task_id, kind: "action_executed", summary: `${ACTION_TYPES[a.action_type]} to ${a.destination}: ${sent ? "sent manually" : "not sent"}` });
}

// Drafts are internal and always allowed for agents with drafting permission.
// Your own correction to a draft: stored as a new version marked "manual", never mixed up with agent drafts.
export function manualRevision(draftId, content) {
  const d = getAction(draftId);
  if (!d) throw new Error("No such draft");
  if (d.status !== "draft") throw new Error(`Only the current draft can be revised (this one is ${d.status}).`);
  if (!String(content ?? "").trim()) throw new Error("Write the corrected text");
  const id = uid();
  db.prepare(`INSERT INTO actions (id, idempotency_key, task_id, run_id, agent_id, action_type, channel, account, destination, prospect_id,
    subject, content, status, version, supersedes, origin, campaign_id, created_at, updated_at)
    VALUES (?, ?, NULL, NULL, 'owner', ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, 'manual', ?, ?, ?)`)
    .run(id, `manual:${id}`, d.action_type, d.channel, d.account, d.destination, d.prospect_id, d.subject, String(content).trim(), d.version + 1, d.id, d.campaign_id, now(), now());
  db.prepare("UPDATE actions SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(id, now(), d.id);
  logActivity({ kind: "manual_edit", summary: `You revised draft ${d.id.slice(0, 8)} → v${d.version + 1} (manual)` });
  broadcast({ type: "actions_changed" });
  return getAction(id);
}

export function saveDraft(ctx, input) {
  if (!hasPermission(ctx.agent, "drafting")) throw new Error(`${ctx.agent.name} does not have drafting permission.`);
  if (!input.content?.trim()) throw new Error("content is required");
  const id = uid();
  const row = { agent_id: ctx.agent.id, action_type: input.intended_action || "private_message", channel: CHANNELS[input.channel] ? input.channel : "other",
    account: input.account || "default", destination: input.destination || "", subject: input.subject || null, content: input.content.trim() };
  const key = "draft:" + idempotencyKey(row);
  const existing = db.prepare("SELECT id, status FROM actions WHERE idempotency_key = ?").get(key);
  if (existing) return { draft_id: existing.id, duplicate: true, status: existing.status };
  if (input.prospect_id && !db.prepare("SELECT 1 FROM prospects WHERE id = ?").get(input.prospect_id)) throw new Error("Unknown prospect_id");
  // One current draft per prospect: a new draft becomes the next version and the old one is superseded (kept).
  const prev = input.prospect_id
    ? db.prepare("SELECT id, version FROM actions WHERE prospect_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1").get(input.prospect_id)
    : null;
  const origin = ctx.origin ?? "agent";
  db.prepare(`INSERT INTO actions (id, idempotency_key, task_id, run_id, agent_id, action_type, channel, account, destination, prospect_id,
    subject, content, status, version, supersedes, origin, campaign_id, owner_notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, key, ctx.taskRun?.task.id ?? null, ctx.taskRun?.run.id ?? null, row.agent_id, row.action_type, row.channel, row.account,
      row.destination, input.prospect_id || null, row.subject, row.content, (prev?.version ?? 0) + 1, prev?.id ?? null, origin,
      ctx.taskRun?.task.campaign_id ?? input.campaign_id ?? null, input.owner_notes?.trim() || null, now(), now());
  if (prev) db.prepare("UPDATE actions SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(id, now(), prev.id);
  broadcast({ type: "actions_changed" });
  return { draft_id: id, version: (prev?.version ?? 0) + 1, supersedes: prev?.id ?? null };
}

// ---------- Email connector (SMTP) ----------
export function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM);
}
function transporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }, connectionTimeout: 15000, socketTimeout: 30000,
  });
}
export async function verifySmtp() {
  if (!smtpConfigured()) return { status: "not_configured", detail: "Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM in .env" };
  try { await transporter().verify(); return { status: "working", detail: `Logged in to ${process.env.SMTP_HOST}` }; }
  catch (e) { return { status: "failed", detail: e.message }; }
}
async function sendEmail(a) {
  return transporter().sendMail({ from: process.env.SMTP_FROM, to: a.destination, subject: a.subject || "(no subject)", text: a.content });
}
