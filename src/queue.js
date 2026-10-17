// Persistent task queue and the background worker that executes it. The worker lives in the server
// process, so tasks and schedules run whether or not any browser tab is open.
import { db, now, uid, json, agents, settings } from "./db.js";
import { broadcast } from "./hub.js";
import { logActivity, getLimits, budgetBlockReason } from "./activity.js";
import { approvals, setActionResolvedHook } from "./actions.js";

export const STATES = {
  draft: "Draft", queued: "Queued", running: "Running", waiting_input: "Waiting for input",
  waiting_approval: "Waiting for approval", completed: "Completed", failed: "Failed", cancelled: "Cancelled",
};
export const ACTIVE_STATES = ["queued", "running", "waiting_input", "waiting_approval"];
const TERMINAL = ["completed", "failed", "cancelled"];

const parseTask = (r) => r && {
  ...r, input: json(r.input, {}), output: json(r.output, null), depends_on: json(r.depends_on, []), condition: json(r.condition, null),
};

export const tasks = {
  get: (id) => parseTask(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id)),
  list({ status, agent_id, workflow_run_id, limit = 300 } = {}) {
    const where = [];
    const args = [];
    if (status) { where.push(`status IN (${status.split(",").map(() => "?").join(",")})`); args.push(...status.split(",")); }
    if (agent_id) { where.push("agent_id = ?"); args.push(agent_id); }
    if (workflow_run_id) { where.push("workflow_run_id = ?"); args.push(workflow_run_id); }
    return db.prepare(`SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC LIMIT ?`)
      .all(...args, limit).map(parseTask);
  },
  runs: (task_id) => db.prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt DESC, started_at DESC").all(task_id),
  events: (task_id) => db.prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY id").all(task_id),
  remove(id) {
    if (running.has(id)) throw new Error("Cancel the running task before deleting it.");
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    broadcast({ type: "tasks_changed" });
  },
};

function event(task_id, type, { from = null, to = null, actor = null, note = null } = {}) {
  db.prepare("INSERT INTO task_events (task_id, at, type, from_status, to_status, actor, note) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(task_id, now(), type, from, to, actor, note);
}

const actorLabel = (actor) => agents.get(actor)?.name ?? ({ owner: "You", schedule: "Schedule", system: "System" }[actor] ?? actor ?? "System");

function transition(id, to, { actor = "system", note = null, fields = {}, type = "status" } = {}) {
  const t = tasks.get(id);
  if (!t) throw new Error(`No task ${id}`);
  const sets = ["status = ?", "updated_at = ?"];
  const args = [to, now()];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    args.push(v !== null && typeof v === "object" ? JSON.stringify(v) : v);
  }
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  event(id, type, { from: t.status, to, actor, note });
  if (t.status !== to) {
    logActivity({ agent_id: t.agent_id, task_id: id, kind: "status", summary: `${t.title}: ${STATES[t.status] ?? t.status} → ${STATES[to]}${note ? ` (${note})` : ""}` });
  }
  broadcast({ type: "tasks_changed", task_id: id });
  hooks.onTaskChanged(tasks.get(id));
  return tasks.get(id);
}

/** Creates a task. Assignment is always by agent ID. Creation never starts execution unless status is "queued". */
export function createTask(t, { actor = "owner" } = {}) {
  if (!t.title?.trim()) throw new Error("title is required");
  if (t.agent_id && !agents.get(t.agent_id)) throw new Error(`No team member with id ${t.agent_id}`);
  const deps = t.depends_on ?? [];
  for (const d of deps) if (!tasks.get(d)) throw new Error(`Dependency ${d} does not exist`);
  const status = t.status === "queued" ? "queued" : "draft";
  if (status === "queued" && !t.agent_id) throw new Error("A task needs an owner (agent_id) before it can be queued.");
  const id = uid();
  try {
    db.prepare(`INSERT INTO tasks (id, title, description, agent_id, status, created_by, created_at, updated_at, input, depends_on,
      condition, workflow_run_id, step_key, schedule_id, trigger_key, max_attempts, campaign_id, validator)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, t.title.trim(), t.description ?? null, t.agent_id ?? null, status, actor, now(), now(), JSON.stringify(t.input ?? {}),
        JSON.stringify(deps), t.condition ? JSON.stringify(t.condition) : null, t.workflow_run_id ?? null, t.step_key ?? null,
        t.schedule_id ?? null, t.trigger_key ?? null, t.max_attempts ?? null, t.campaign_id ?? null, t.validator ?? null);
  } catch (e) {
    if (/UNIQUE/.test(e.message) && t.trigger_key) {
      const existing = db.prepare("SELECT id FROM tasks WHERE trigger_key = ?").get(t.trigger_key);
      return { ...tasks.get(existing.id), deduplicated: true };
    }
    throw e;
  }
  event(id, "created", { to: status, actor, note: t.agent_id ? `owner ${actorLabel(t.agent_id)}` : "unassigned" });
  logActivity({ agent_id: t.agent_id ?? null, task_id: id, kind: "task_created", summary: `${actorLabel(actor)} created "${t.title}"${status === "queued" ? " and queued it" : " (draft)"}` });
  broadcast({ type: "tasks_changed", task_id: id });
  return tasks.get(id);
}

export function updateTask(id, fields, { actor = "owner" } = {}) {
  const t = tasks.get(id);
  if (!t) throw new Error("No such task");
  if (t.status === "running") throw new Error("Can't edit a running task. Cancel it first.");
  const allowed = {};
  for (const k of ["title", "description"]) if (typeof fields[k] === "string") allowed[k] = fields[k];
  if (fields.input !== undefined) allowed.input = JSON.stringify(fields.input);
  if (fields.depends_on !== undefined) {
    for (const d of fields.depends_on) if (!tasks.get(d) || d === id) throw new Error(`Invalid dependency ${d}`);
    allowed.depends_on = JSON.stringify(fields.depends_on);
  }
  if (!Object.keys(allowed).length) return t;
  const sets = Object.keys(allowed).map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...Object.values(allowed), now(), id);
  event(id, "edited", { actor, note: Object.keys(allowed).join(", ") });
  broadcast({ type: "tasks_changed", task_id: id });
  return tasks.get(id);
}

// "Run task": validates everything that would stop execution and says how to fix it.
export function runTask(id, { actor = "owner", note = null, type = "run_requested" } = {}) {
  const t = tasks.get(id);
  if (!t) return { ok: false, reason: "Task not found.", recovery: "Refresh the task list." };
  if (t.status === "running" || running.has(id)) return { ok: false, reason: "This task is already running.", recovery: "Wait for it to finish, or cancel it." };
  if (t.status === "queued") return { ok: true, task: t, note: t.wait_reason || "Already queued." };
  if (!t.agent_id) return { ok: false, reason: "No owner assigned.", recovery: "Assign a team member (by ID), then run it." };
  const agent = agents.get(t.agent_id);
  if (!agent) return { ok: false, reason: "The assigned team member no longer exists.", recovery: "Reassign the task to an existing member." };
  if (t.status === "waiting_input") return { ok: false, reason: "Waiting for your answer.", recovery: "Answer the question on the task; it re-queues automatically." };
  if (t.status === "waiting_approval") return { ok: false, reason: "Waiting for approval decisions.", recovery: "Approve or deny the pending items in Notifications." };
  const fields = { attempts: 0, not_before: null, error: null, wait_reason: null, finished_at: null };
  const updated = transition(id, "queued", { actor, note, fields, type });
  const blocked = gate(updated);
  return { ok: true, task: updated, note: blocked.state === "blocked" ? blocked.reason : "Queued. The worker will start it shortly." };
}

export function cancelTask(id, { actor = "owner", reason = null } = {}) {
  const t = tasks.get(id);
  if (!t) throw new Error("No such task");
  if (TERMINAL.includes(t.status)) return t;
  const r = running.get(id);
  if (r) r.controller.abort("cancelled");
  return transition(id, "cancelled", { actor, note: reason, fields: { finished_at: now(), wait_reason: null }, type: "cancelled" });
}

export function retryTask(id, { actor = "owner", reason = null } = {}) {
  return runTask(id, { actor, note: reason ? `retry: ${reason}` : "retry", type: "retry" });
}

export function reassignTask(id, agent_id, { actor = "owner", reason = null } = {}) {
  const t = tasks.get(id);
  if (!t) throw new Error("No such task");
  if (t.status === "running") throw new Error("Can't reassign a running task. Cancel it first.");
  const to = agents.get(agent_id);
  if (!to) throw new Error(`No team member with id ${agent_id}`);
  db.prepare("UPDATE tasks SET agent_id = ?, updated_at = ? WHERE id = ?").run(agent_id, now(), id);
  event(id, "reassigned", { from: t.status, to: t.status, actor, note: `${actorLabel(t.agent_id)} → ${to.name}${reason ? `: ${reason}` : ""}` });
  logActivity({ agent_id, task_id: id, kind: "reassigned", summary: `${actorLabel(actor)} reassigned "${t.title}" to ${to.name}${reason ? ` (${reason})` : ""}` });
  broadcast({ type: "tasks_changed", task_id: id });
  return tasks.get(id);
}

export function answerInput(id, answer, { actor = "owner" } = {}) {
  const t = tasks.get(id);
  if (!t || t.status !== "waiting_input") throw new Error("This task is not waiting for input.");
  const input = { ...t.input, answers: [...(t.input.answers ?? []), { question: t.wait_reason, answer, at: now() }] };
  return transition(id, "queued", { actor, note: "input provided", fields: { input, wait_reason: null, not_before: null }, type: "input_provided" });
}

// ---------- Worker ----------
const running = new Map(); // task id -> { controller, run }
export const runningTaskIds = () => [...running.keys()];
let executor = null; // set by runner.js: async ({ task, run, signal, hooks }) => result
export const setExecutor = (fn) => (executor = fn);
const hooks = { onTaskChanged: () => {}, onTick: [] };
export const onTaskChanged = (fn) => {
  const prev = hooks.onTaskChanged;
  hooks.onTaskChanged = (t) => { prev(t); fn(t); };
};
export const onTick = (fn) => hooks.onTick.push(fn);
// Set by campaigns.js: a pre-launch check (e.g. campaign budget) and a validator for step outputs.
let launchCheck = () => null;      // (task) => null | { reason }
const outputValidators = [];        // each (task, output) => null | "why it failed"; the first failure wins
export const setLaunchCheck = (fn) => (launchCheck = fn);
export const setOutputValidator = (fn) => outputValidators.push(fn);
const outputValidator = (t, output) => { for (const v of outputValidators) { const r = v(t, output); if (r) return r; } return null; };

// Decides whether a queued task can start now.
function gate(t) {
  const deps = t.depends_on.map((d) => tasks.get(d));
  if (deps.some((d) => !d)) return { state: "fail", reason: "A dependency was deleted." };
  const bad = deps.find((d) => d.status === "failed" || d.status === "cancelled");
  if (bad) return { state: "cancel", reason: `Upstream task "${bad.title}" ${bad.status}.` };
  const pending = deps.filter((d) => d.status !== "completed");
  if (pending.length) return { state: "blocked", reason: `Waiting on: ${pending.map((d) => `"${d.title}" (${STATES[d.status]})`).join(", ")}` };
  if (t.condition && !conditionMet(t.condition, deps)) return { state: "skip", reason: describeCondition(t.condition) };
  if (!t.agent_id || !agents.get(t.agent_id)) return { state: "fail", reason: "Owner missing. Reassign the task to an existing member." };
  const budget = budgetBlockReason();
  if (budget) return { state: "blocked", reason: budget };
  if (t.not_before && t.not_before > now()) return { state: "blocked", reason: `Retry scheduled for ${new Date(t.not_before).toLocaleTimeString()}` };
  const stop = launchCheck(t, [...running.keys()]);
  if (stop) return { state: "fail", reason: stop.reason, kind: "budget_prelaunch" };
  return { state: "ready" };
}

// Conditions read structured outputs from dependencies, e.g. { type: "deps_list_nonempty", field: "prospect_ids" }.
function conditionMet(c, deps) {
  if (c.type === "deps_list_nonempty") return deps.some((d) => Array.isArray(d.output?.[c.field]) && d.output[c.field].length > 0);
  if (c.type === "always") return true;
  return true;
}
const describeCondition = (c) => (c.type === "deps_list_nonempty" ? `Skipped: no upstream step produced any ${c.field.replace(/_/g, " ")}.` : "Condition not met.");

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (const fn of hooks.onTick) { try { await fn(); } catch (e) { console.error("tick hook:", e); } }
    const limits = getLimits();
    const candidates = db.prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at LIMIT 100").all().map(parseTask);
    for (const t of candidates) {
      const g = gate(t);
      if (g.state === "ready") {
        if (running.size >= limits.max_concurrent_runs) {
          setWaitReason(t, `Waiting for a free slot (${limits.max_concurrent_runs} concurrent runs max).`);
          continue;
        }
        if (!executor) { setWaitReason(t, "Worker is starting up."); continue; }
        start(t);
      } else if (g.state === "blocked") setWaitReason(t, g.reason);
      else if (g.state === "skip") {
        transition(t.id, "completed", { note: g.reason, fields: { output: { skipped: true, status: "skipped", summary: g.reason }, finished_at: now(), wait_reason: null } });
      } else if (g.state === "cancel") {
        transition(t.id, "cancelled", { note: g.reason, fields: { finished_at: now(), wait_reason: g.reason } });
        logActivity({ agent_id: t.agent_id, task_id: t.id, kind: "handoff_failed", summary: `Handoff failed to "${t.title}": ${g.reason}` });
      } else if (g.state === "fail") {
        transition(t.id, "failed", { note: g.reason, fields: { error: g.reason, finished_at: now() }, type: g.kind ?? "status" });
        if (g.kind === "budget_prelaunch") logActivity({ agent_id: t.agent_id, task_id: t.id, kind: "budget_stop", summary: `Not started: ${g.reason}` });
      }
    }
  } finally {
    ticking = false;
  }
}

function setWaitReason(t, reason) {
  if (t.wait_reason === reason) return;
  db.prepare("UPDATE tasks SET wait_reason = ? WHERE id = ?").run(reason, t.id);
  broadcast({ type: "tasks_changed", task_id: t.id });
}

function start(t) {
  const runId = uid();
  const ts = now();
  // Atomic claim: only one worker turn can move this task from queued to running.
  const claimed = db.prepare(`UPDATE tasks SET status = 'running', attempts = attempts + 1, current_run_id = ?, started_at = coalesce(started_at, ?),
    heartbeat_at = ?, wait_reason = NULL, error = NULL, updated_at = ? WHERE id = ? AND status = 'queued'`).run(runId, ts, ts, ts, t.id);
  if (claimed.changes !== 1) return;
  const task = tasks.get(t.id);
  db.prepare("INSERT INTO task_runs (id, task_id, attempt, status, started_at, heartbeat_at) VALUES (?, ?, ?, 'running', ?, ?)")
    .run(runId, task.id, task.attempts, ts, ts);
  event(task.id, "run_started", { from: "queued", to: "running", actor: "system", note: `run ${runId}, attempt ${task.attempts}` });
  logActivity({ agent_id: task.agent_id, task_id: task.id, run_id: runId, kind: "run_started", summary: `${actorLabel(task.agent_id)} started "${task.title}" (attempt ${task.attempts})` });
  if (task.depends_on.length && task.attempts === 1) {
    const from = task.depends_on.map((d) => tasks.get(d)).filter(Boolean);
    logActivity({ agent_id: task.agent_id, task_id: task.id, run_id: runId, kind: "handoff",
      summary: `Handoff: ${from.map((d) => `${actorLabel(d.agent_id)} ("${d.title}")`).join(" + ")} → ${actorLabel(task.agent_id)} ("${task.title}")` });
  }
  broadcast({ type: "tasks_changed", task_id: task.id });

  const controller = new AbortController();
  const run = { id: runId, attempt: task.attempts, toolCalls: 0, activeMs: 0, lastTick: now(), lastProgress: now(), pausedForApproval: false };
  running.set(task.id, { controller, run });
  const limits = getLimits();

  // Heartbeat + runtime limit. Time spent waiting for your approval doesn't count toward the limit.
  const beat = setInterval(() => {
    const n = now();
    if (!run.pausedForApproval) run.activeMs += n - run.lastTick;
    run.lastTick = n;
    db.prepare("UPDATE task_runs SET heartbeat_at = ? WHERE id = ?").run(n, runId);
    db.prepare("UPDATE tasks SET heartbeat_at = ? WHERE id = ?").run(n, task.id);
    if (limits.max_runtime_minutes > 0 && run.activeMs > limits.max_runtime_minutes * 60_000) controller.abort("timeout");
    // Stall: still alive (heartbeat) but no tool call, text or output for too long. Approval waits don't count.
    if (!run.pausedForApproval && limits.stall_minutes > 0 && n - run.lastProgress > limits.stall_minutes * 60_000) controller.abort("stalled");
  }, 2000);

  const runHooks = {
    onProgress() { run.lastProgress = now(); },
    onToolCall() {
      run.lastProgress = now();
      run.toolCalls++;
      db.prepare("UPDATE task_runs SET tool_calls = ? WHERE id = ?").run(run.toolCalls, runId);
      if (limits.max_tool_actions > 0 && run.toolCalls > limits.max_tool_actions) {
        controller.abort("tool_limit");
        throw new Error(`Tool action limit reached (${limits.max_tool_actions} per run). Stopping.`);
      }
    },
    onApprovalWait(waiting, summary) {
      run.pausedForApproval = waiting;
      run.lastTick = now();
      run.lastProgress = now();
      if (waiting) transition(task.id, "waiting_approval", { note: summary, fields: { wait_reason: `Waiting for your approval: ${summary}` }, type: "approval_wait" });
      else if (tasks.get(task.id)?.status === "waiting_approval") transition(task.id, "running", { note: "approval decided", fields: { wait_reason: null }, type: "approval_done" });
    },
  };

  (async () => {
    let result;
    try {
      result = await executor({ task, run: { id: runId, attempt: task.attempts }, signal: controller.signal, hooks: runHooks, limits });
    } catch (err) {
      result = { status: "error", errorKind: "fatal", errorMessage: err.message };
    } finally {
      clearInterval(beat);
      running.delete(task.id);
    }
    finalize(task.id, runId, result ?? { status: "error", errorKind: "fatal", errorMessage: "No result" }, controller.signal.reason, limits);
  })();
}

function finalize(taskId, runId, r, abortReason, limits) {
  const t = tasks.get(taskId);
  const runStatus = abortReason === "cancelled" ? "cancelled"
    : abortReason === "timeout" ? "timed_out"
    : abortReason === "stalled" ? "stalled"
      : r.status === "done" ? "succeeded" : "failed";
  const errText = abortReason === "timeout" ? `Run exceeded ${limits.max_runtime_minutes} min runtime limit`
    : abortReason === "tool_limit" ? `Run exceeded ${limits.max_tool_actions} tool actions limit`
    : abortReason === "stalled" ? `Run stalled: no progress for ${limits.stall_minutes} min`
      : r.errorMessage ?? null;
  db.prepare(`UPDATE task_runs SET status = ?, finished_at = ?, error = ?, error_kind = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?,
    thread_id = coalesce(?, thread_id), model = ? WHERE id = ?`)
    .run(runStatus, now(), errText, abortReason ?? r.errorKind ?? null, r.costUsd ?? null, r.usage?.input_tokens ?? null,
      r.usage?.output_tokens ?? null, r.threadId ?? null, r.model ?? null, runId);
  if (!t || t.status === "cancelled" || abortReason === "cancelled") {
    logActivity({ agent_id: t?.agent_id, task_id: taskId, run_id: runId, kind: "run_finished", summary: `"${t?.title}" cancelled` });
    return;
  }

  const thread = r.threadId ? { thread_id: r.threadId } : {};
  if (runStatus === "succeeded") {
    if (r.waitingFor) {
      transition(taskId, "waiting_input", { note: "agent asked a question", fields: { wait_reason: r.waitingFor, ...thread }, type: "needs_input" });
      return;
    }
    const output = r.output ?? { status: "completed", summary: r.text || "(no summary)", structured: false };
    // The next step only starts if this output passes the step's validator.
    const invalid = outputValidator(t, output);
    if (invalid) {
      transition(taskId, "failed", { note: `output failed validation: ${invalid}`, fields: { output, error: `Output failed validation: ${invalid} — fix the inputs or instructions, then Retry.`, finished_at: now(), ...thread }, type: "validation_failed" });
      logActivity({ agent_id: t.agent_id, task_id: taskId, run_id: runId, kind: "validation_failed", summary: `"${t.title}" output rejected: ${invalid}` });
      return;
    }
    const pending = approvals.pendingForTask(taskId);
    const to = pending > 0 ? "waiting_approval" : "completed";
    transition(taskId, to, {
      note: pending ? `${pending} action(s) awaiting approval` : output.status === "no_results" ? "zero results" : null,
      fields: { output, result: output.summary ?? null, finished_at: to === "completed" ? now() : null, wait_reason: pending ? `${pending} action(s) waiting for your approval` : null, ...thread },
      type: "run_succeeded",
    });
    logActivity({ agent_id: t.agent_id, task_id: taskId, run_id: runId, kind: "output", summary: `${actorLabel(t.agent_id)} finished "${t.title}": ${String(output.summary ?? "").slice(0, 300)}`, detail: { output_status: output.status, cost_usd: r.costUsd } });
    return;
  }

  const kind = abortReason === "timeout" ? "timeout" : abortReason === "stalled" ? "stalled" : abortReason === "tool_limit" ? "limit" : r.errorKind ?? "fatal";
  const transient = ["timeout", "stalled", "transient", "usage_limit", "rate_limited"].includes(kind);
  const maxAttempts = t.max_attempts ?? limits.max_attempts;
  logActivity({ agent_id: t.agent_id, task_id: taskId, run_id: runId, kind: "error", summary: `"${t.title}" attempt ${t.attempts} failed: ${errText}` });
  if (transient && t.attempts < maxAttempts) {
    // With a fallback model the next attempt switches models, so it can start right away;
    // otherwise wait for the provider's own reset time when it gave one.
    const hasFallback = Boolean(agents.get(t.agent_id)?.fallback_model);
    const delay = hasFallback && !r.usedFallback ? 5_000
      : r.retryAt ? Math.max(5_000, r.retryAt - now())
        : kind === "usage_limit" ? 30 * 60_000 : 30_000 * 2 ** (t.attempts - 1);
    transition(taskId, "queued", {
      note: `retry ${t.attempts + 1}/${maxAttempts} in ${Math.round(delay / 1000)}s after ${kind}`,
      fields: { not_before: now() + delay, error: errText, wait_reason: `Retrying after ${kind}: ${errText}`, ...thread }, type: "retry_scheduled",
    });
  } else {
    const recovery = transient ? "Attempts exhausted. Check the error, then click Retry." : recoveryFor(kind, errText);
    transition(taskId, "failed", { note: errText, fields: { error: `${errText}${recovery ? ` — ${recovery}` : ""}`, finished_at: now(), ...thread }, type: "run_failed" });
  }
}

function recoveryFor(kind, msg) {
  if (/not logged in|login|authenticat|invalid api key/i.test(msg ?? "")) return "Sign in to Claude Code (run `claude` in a terminal), then Retry.";
  if (kind === "limit") return "Raise the limit in Settings or split the task, then Retry.";
  if (kind === "refused") return "The model declined. Rephrase the task, then Retry.";
  if (kind === "budget") return "The per-run budget was reached. Raise it in Settings or narrow the task, then Retry.";
  return "Check the error and the run log, then Retry.";
}

// A run that was "running" when the app stopped can't still be running now.
function recoverAbandoned() {
  const limits = getLimits();
  const stuck = db.prepare("SELECT * FROM tasks WHERE status IN ('running') OR (status = 'waiting_approval' AND current_run_id IN (SELECT id FROM task_runs WHERE status = 'running'))").all().map(parseTask);
  db.prepare("UPDATE task_runs SET status = 'abandoned', finished_at = ?, error = 'App stopped while this run was in progress' WHERE status = 'running'").run(now());
  for (const t of stuck) {
    const maxAttempts = t.max_attempts ?? limits.max_attempts;
    if (t.attempts < maxAttempts) {
      transition(t.id, "queued", { note: "recovered after app restart", fields: { wait_reason: "Recovered after restart; will retry.", not_before: null }, type: "recovered" });
    } else {
      transition(t.id, "failed", { note: "interrupted; no attempts left", fields: { error: "Interrupted by an app restart and no attempts left — click Retry.", finished_at: now() }, type: "recovered" });
    }
  }
  return stuck.length;
}

// When the last pending approval for a finished run is decided, the task completes.
setActionResolvedHook((taskId) => {
  const t = tasks.get(taskId);
  if (!t || t.status !== "waiting_approval" || running.has(taskId)) return;
  if (approvals.pendingForTask(taskId) === 0) {
    transition(taskId, "completed", { note: "approvals decided", fields: { finished_at: now(), wait_reason: null }, type: "approvals_done" });
  }
});

let started = false;
export function startWorker() {
  if (started) return;
  started = true;
  const recovered = recoverAbandoned();
  if (recovered) console.log(`Recovered ${recovered} task(s) interrupted by the last shutdown.`);
  const beat = () => settings.set("worker_heartbeat", String(now()));
  beat();
  setInterval(beat, 5000);
  setInterval(tick, 1000);
}

export function workerStatus() {
  const hb = Number(settings.get("worker_heartbeat", "0"));
  return { alive: now() - hb < 20_000, heartbeat_at: hb, running: running.size, limits: getLimits() };
}
