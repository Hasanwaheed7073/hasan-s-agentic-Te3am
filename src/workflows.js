// Workflow definitions (steps, dependencies, conditions, event triggers) and workflow runs.
import { db, now, uid, json, agents } from "./db.js";
import { broadcast } from "./hub.js";
import { logActivity } from "./activity.js";
import { createTask, tasks, onTaskChanged, cancelTask } from "./queue.js";
import { prospects } from "./prospects.js";

const parse = (w) => w && { ...w, steps: json(w.steps, []), triggers: json(w.triggers, []) };
const parseRun = (r) => r && { ...r, input: json(r.input, {}) };

export const workflows = {
  list: () => db.prepare("SELECT * FROM workflows ORDER BY created_at").all().map(parse),
  get: (id) => parse(db.prepare("SELECT * FROM workflows WHERE id = ?").get(id)),
  runs: (workflow_id, limit = 50) => db.prepare(`SELECT * FROM workflow_runs ${workflow_id ? "WHERE workflow_id = ?" : ""} ORDER BY created_at DESC LIMIT ?`)
    .all(...(workflow_id ? [workflow_id] : []), limit).map(parseRun),
  getRun: (id) => parseRun(db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id)),
};

// Validates step structure: unique keys, known agents (by ID), dependencies that exist and don't cycle.
export function validateWorkflow(w) {
  if (!w.name?.trim()) throw new Error("Workflow needs a name");
  if (!Array.isArray(w.steps) || !w.steps.length) throw new Error("Workflow needs at least one step");
  const keys = new Set();
  for (const s of w.steps) {
    if (!s.key || keys.has(s.key)) throw new Error(`Step keys must be unique and non-empty (problem: "${s.key}")`);
    keys.add(s.key);
    if (!agents.get(s.agent_id)) throw new Error(`Step "${s.key}": no team member with id ${s.agent_id}`);
    if (!s.title?.trim()) throw new Error(`Step "${s.key}" needs a title`);
  }
  for (const s of w.steps) for (const d of s.depends_on ?? []) if (!keys.has(d)) throw new Error(`Step "${s.key}" depends on unknown step "${d}"`);
  const visiting = new Set(); const done = new Set();
  const visit = (k) => {
    if (done.has(k)) return;
    if (visiting.has(k)) throw new Error(`Dependency cycle at step "${k}"`);
    visiting.add(k);
    for (const d of w.steps.find((s) => s.key === k).depends_on ?? []) visit(d);
    visiting.delete(k); done.add(k);
  };
  for (const s of w.steps) visit(s.key);
  for (const t of w.triggers ?? []) {
    if (t.event !== "booking_confirmed") throw new Error(`Unsupported trigger event "${t.event}"`);
    if (!agents.get(t.agent_id)) throw new Error(`Trigger: no team member with id ${t.agent_id}`);
  }
}

export function saveWorkflow(w) {
  validateWorkflow(w);
  const id = w.id ?? uid();
  const exists = workflows.get(id);
  if (exists) {
    db.prepare("UPDATE workflows SET name=?, description=?, pipeline=?, steps=?, triggers=?, updated_at=? WHERE id=?")
      .run(w.name, w.description ?? null, w.pipeline ?? null, JSON.stringify(w.steps), JSON.stringify(w.triggers ?? []), now(), id);
  } else {
    db.prepare("INSERT INTO workflows (id, name, description, pipeline, steps, triggers, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, w.name, w.description ?? null, w.pipeline ?? null, JSON.stringify(w.steps), JSON.stringify(w.triggers ?? []), now(), now());
  }
  broadcast({ type: "workflows_changed" });
  return workflows.get(id);
}

export const deleteWorkflow = (id) => { db.prepare("DELETE FROM workflows WHERE id = ?").run(id); broadcast({ type: "workflows_changed" }); };

/** Starts a workflow: one task per step, all queued; the worker starts each when its dependencies complete. */
export function runWorkflow(workflowId, input = {}, { actor = "owner", schedule_id = null, campaign_id = null } = {}) {
  const w = workflows.get(workflowId);
  if (!w) throw new Error("No such workflow");
  validateWorkflow(w);
  // One active run per campaign: a second launch is refused rather than duplicating work.
  if (campaign_id && db.prepare("SELECT 1 FROM workflow_runs WHERE campaign_id = ? AND status = 'running'").get(campaign_id)) {
    throw new Error("This campaign already has a run in progress. Wait for it to finish or cancel it first.");
  }
  const runId = uid();
  db.prepare("INSERT INTO workflow_runs (id, workflow_id, status, input, created_by, schedule_id, campaign_id, created_at) VALUES (?, ?, 'running', ?, ?, ?, ?, ?)")
    .run(runId, w.id, JSON.stringify(input ?? {}), actor, schedule_id, campaign_id, now());
  const byKey = {};
  // Steps are created in dependency order so each can reference its upstream task IDs.
  const order = [];
  const seen = new Set();
  const visit = (s) => { if (seen.has(s.key)) return; for (const d of s.depends_on ?? []) visit(w.steps.find((x) => x.key === d)); seen.add(s.key); order.push(s); };
  w.steps.forEach(visit);
  for (const s of order) {
    const t = createTask({
      title: s.title, description: s.instructions ?? "", agent_id: s.agent_id, status: "queued",
      input: { ...(input ?? {}), workflow: w.name, step: s.key, pipeline: w.pipeline },
      depends_on: (s.depends_on ?? []).map((d) => byKey[d].id), condition: s.condition ?? null,
      workflow_run_id: runId, step_key: s.key, schedule_id, campaign_id, validator: s.validate ?? null,
    }, { actor });
    byKey[s.key] = t;
  }
  logActivity({ kind: "workflow_started", summary: `${actor === "owner" ? "You" : agents.get(actor)?.name ?? actor} started workflow "${w.name}" (${order.length} steps)` });
  broadcast({ type: "workflows_changed" });
  return { run: workflows.getRun(runId), tasks: Object.values(byKey) };
}

export function cancelWorkflowRun(runId, { actor = "owner" } = {}) {
  for (const t of tasks.list({ workflow_run_id: runId })) cancelTask(t.id, { actor, reason: "workflow cancelled" });
}

// Workflow run status follows its tasks.
onTaskChanged((t) => {
  if (!t?.workflow_run_id) return;
  const ts = tasks.list({ workflow_run_id: t.workflow_run_id, limit: 1000 });
  let status = "running";
  if (ts.every((x) => x.status === "completed")) status = "completed";
  else if (ts.some((x) => x.status === "failed")) status = "failed";
  else if (ts.every((x) => ["completed", "cancelled", "failed"].includes(x.status))) status = "cancelled";
  const run = workflows.getRun(t.workflow_run_id);
  if (run && run.status !== status) {
    db.prepare("UPDATE workflow_runs SET status = ?, finished_at = ? WHERE id = ?").run(status, status === "running" ? null : now(), run.id);
    broadcast({ type: "workflows_changed" });
  }
});

// ---------- Event triggers ----------
// "Daniel starts when a booking is confirmed": one task per prospect per booking, never duplicated.
export function fireBookingConfirmed(prospectId, { actor = "owner" } = {}) {
  const p = prospects.get(prospectId);
  if (!p) throw new Error("No such prospect");
  const created = [];
  for (const w of workflows.list()) {
    for (const trig of w.triggers) {
      if (trig.event !== "booking_confirmed" || (w.pipeline && w.pipeline !== p.pipeline)) continue;
      const t = createTask({
        title: `${trig.title ?? "Prepare sales call"}: ${p.name || p.business}`,
        description: trig.instructions ?? "", agent_id: trig.agent_id, status: "queued",
        input: { workflow: w.name, trigger: "booking_confirmed", pipeline: p.pipeline, prospect_ids: [p.id] },
        trigger_key: `booking:${w.id}:${p.id}`,
      }, { actor });
      created.push(t);
    }
  }
  return created;
}

// ---------- Default workflows for Hasan's team ----------
// Anonymous posts can't become clients, so web research looks for people who can be identified and
// reached, and Reddit (anonymous by design) is used for helpful reply drafts instead of lead lists.
export const JOB_SEEKER_STEPS = {
  signals: `Find mid-to-senior job seekers in the US or Canada who publicly show they need job-search help AND can be identified and reached. Good sources: LinkedIn posts by named people (#OpenToWork, "laid off", "looking for my next role", "100 applications") whose headline shows their level and location; posts on other public forums or blogs by named professionals. Skip anonymous posts with no name or profile: they can't become clients. Record each with upsert_prospect (pipeline job_seeker, source URL, evidence date, exact quote, linkedin_url if any, and in known: seniority and location with where you saw them). Put prospect IDs in prospect_ids. If you find none, submit status "no_results" with an empty list. Never invent people.`,
  reddit: `Reddit users are anonymous, so use Reddit for engagement, not lead lists. Web search and fetch can't reach reddit.com: read it with your browser tools (old.reddit.com search and subreddit pages). Find up to 5 recent threads (last 14 days) in r/jobs, r/jobsearchhacks, r/careerguidance, r/recruitinghell, r/cscareerquestions or industry subs where a mid-to-senior US/Canada professional asks for job-search help. For each, draft a genuinely helpful public reply with save_draft (channel reddit, intended_action public_post, destination = thread URL) that answers their question first; mention the service only if that subreddit's rules allow it. Nothing is posted. Record a prospect with upsert_prospect only when the post or profile states both seniority and location. Put draft IDs in draft_ids and any prospect IDs in prospect_ids; if nothing fits, submit "no_results".`,
  qualify: `Qualify each upstream prospect for reverse recruiting. Mark "qualified" when the evidence reasonably shows mid-to-senior level (title, years or scope) AND a US/Canada location AND an active search; not every detail has to be confirmed: list what's unconfirmed in unknown. Use "needs_info" only when seniority or location is genuinely absent, and "disqualified" when clearly junior, outside the US/Canada, or not searching. Set qualification_status and a one-line rationale with update_prospect. Put qualified IDs in qualified_prospect_ids (empty list if none).`,
};
// Matches your existing teammates by name once and stores their IDs; later renames don't break anything.
export function seedDefaultWorkflows() {
  if (workflows.list().length) return [];
  const find = (re) => agents.list().find((a) => re.test(a.name))?.id;
  const ids = {
    ryan: find(/^ryan/i), reddit: find(/reddit/i), adam: find(/^adam/i), sarah: find(/^sarah/i),
    zara: find(/^zara/i), omar: find(/^omar/i), daniel: find(/^daniel/i),
  };
  if (Object.values(ids).some((v) => !v)) return []; // team not set up; workflows can be created in the UI
  const OUT = "Record every prospect with upsert_prospect (with source URL, evidence date and the supporting quote), then call submit_output.";
  const made = [];
  made.push(saveWorkflow({
    name: "Job seekers", pipeline: "job_seeker",
    description: "Find mid-to-senior US/Canada job seekers showing buying signals, qualify them, draft outreach, update the pipeline.",
    steps: [
      { key: "signals", title: "Find buying signals (web)", agent_id: ids.ryan, depends_on: [], instructions: JOB_SEEKER_STEPS.signals },
      { key: "reddit", title: "Community engagement (Reddit)", agent_id: ids.reddit, depends_on: [], instructions: JOB_SEEKER_STEPS.reddit },
      { key: "qualify", title: "Qualify prospects", agent_id: ids.adam, depends_on: ["signals", "reddit"], condition: { type: "deps_list_nonempty", field: "prospect_ids" }, instructions: JOB_SEEKER_STEPS.qualify },
      { key: "outreach", title: "Draft outreach", agent_id: ids.zara, depends_on: ["qualify"], condition: { type: "deps_list_nonempty", field: "qualified_prospect_ids" },
        instructions: "Write a short, specific outreach draft for each qualified prospect, grounded in their quote. Save each with save_draft (include prospect_id and destination if known). Do not send. Put the prospect IDs you drafted for in prospect_ids and draft IDs in draft_ids." },
      { key: "pipeline", title: "Update pipeline", agent_id: ids.omar, depends_on: ["outreach"], condition: { type: "deps_list_nonempty", field: "prospect_ids" },
        instructions: "For each prospect with a draft, set next_action and owner with update_prospect, and log an interaction. Summarize the pipeline state in submit_output." },
    ],
    triggers: [{ event: "booking_confirmed", agent_id: ids.daniel, title: "Prepare sales call",
      instructions: "A call is booked with this prospect. Prepare a call brief: their situation (from evidence), likely goals and objections, discovery questions, and how the reverse-recruiting offer fits. Use only recorded facts; mark unknowns." }],
  }));
  made.push(saveWorkflow({
    name: "Agency partners", pipeline: "agency",
    description: "Find career coaches and agencies that could use white-label job-search execution, draft outreach, update the pipeline.",
    steps: [
      { key: "research", title: "Find agency partners", agent_id: ids.sarah, depends_on: [],
        instructions: `Find career coaches and career-services agencies (US/Canada) that could resell or outsource job-search execution. ${OUT} Use pipeline "agency". Put prospect IDs in prospect_ids; if none fit, submit "no_results" with an empty list.` },
      { key: "outreach", title: "Draft partner outreach", agent_id: ids.zara, depends_on: ["research"], condition: { type: "deps_list_nonempty", field: "prospect_ids" },
        instructions: "Draft a short partnership note for each agency, referencing something specific from their public evidence. Save with save_draft; do not send. Put prospect IDs in prospect_ids and draft IDs in draft_ids." },
      { key: "pipeline", title: "Update partner pipeline", agent_id: ids.omar, depends_on: ["outreach"], condition: { type: "deps_list_nonempty", field: "prospect_ids" },
        instructions: "Set next_action and owner for each agency prospect with a draft and log an interaction. Summarize in submit_output." },
    ],
    triggers: [{ event: "booking_confirmed", agent_id: ids.daniel, title: "Prepare partner call",
      instructions: "A call is booked with this agency. Prepare a partner call brief: their services and audience (from evidence), white-label fit, questions, and likely objections. Only recorded facts; mark unknowns." }],
  }));
  return made;
}
