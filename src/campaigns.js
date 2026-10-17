// Campaigns: one source of truth (brand, sender, target, service, draft-only mode, budget) injected into
// every step, plus the budget meter, pre-launch budget check, step validators and draft checks.
import { db, now, uid, json, agents, settings } from "./db.js";
import { broadcast } from "./hub.js";
import { logActivity } from "./activity.js";
import { setLaunchCheck, setOutputValidator, tasks as taskRepo, ACTIVE_STATES } from "./queue.js";
import { workflows, saveWorkflow } from "./workflows.js";
import { prospects, isVerified } from "./prospects.js";

const parse = (c) => c && c;
export const campaigns = {
  list: () => db.prepare("SELECT * FROM campaigns ORDER BY created_at").all().map(parse),
  get: (id) => parse(db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id)),
};

const EDITABLE = ["name", "brand", "sender_name", "target", "service_description", "notes", "step_reserve_usd", "budget_usd"];
export function updateCampaign(id, fields, { actor = "owner" } = {}) {
  const c = campaigns.get(id);
  if (!c) throw new Error("No such campaign");
  const m = { ...c };
  for (const k of EDITABLE) if (fields[k] !== undefined) m[k] = typeof c[k] === "number" ? Number(fields[k]) : String(fields[k]).trim();
  for (const k of ["name", "brand", "sender_name", "target", "service_description"]) if (!m[k]) throw new Error(`${k} can't be empty`);
  if (!(m.budget_usd > 0)) throw new Error("Budget must be a positive amount");
  db.prepare(`UPDATE campaigns SET name=?, brand=?, sender_name=?, target=?, service_description=?, notes=?, step_reserve_usd=?, budget_usd=?, updated_at=? WHERE id=?`)
    .run(m.name, m.brand, m.sender_name, m.target, m.service_description, m.notes ?? null, m.step_reserve_usd, m.budget_usd, now(), id);
  const changed = EDITABLE.filter((k) => String(c[k]) !== String(m[k]));
  if (changed.length) logActivity({ kind: "campaign", summary: `${actor === "owner" ? "You" : actor} changed campaign ${changed.join(", ")}${changed.includes("budget_usd") ? ` (budget $${c.budget_usd} → $${m.budget_usd})` : ""}` });
  broadcast({ type: "campaigns_changed" });
  return campaigns.get(id);
}

// ---------- The shared brief block ----------
export function campaignBlock(c) {
  return `CAMPAIGN (single source of truth; every teammate receives this exact block)
- Campaign: ${c.name}
- Brand: ${c.brand}
- Sender: ${c.sender_name} (sign drafts as "${c.sender_name}, ${c.brand}")
- Target: ${c.target}
- Approved service description (describe the service only with this; add no claims, prices, results or guarantees):
"${c.service_description}"
- Outreach mode: DRAFT ONLY. Nothing is sent, posted or submitted. Do not call request_action; the system refuses it for this campaign.
- Represent only ${c.brand}. Do not claim affiliation with any other company or organization.
- Organization policies that apply to your account take precedence. If one conflicts with this campaign, stop and state the conflict in your output instead of working around it.`;
}

export const VERIFICATION_RULES = `VERIFICATION RULES (enforced by the system)
A prospect is outreach-ready only when record_verification has all four, each with a public source URL you actually opened:
1. Business website (the system checks that it loads).
2. Relevant service offering (career coaching, resume writing, or career services for job seekers).
3. Identifiable decision-maker (name and role).
4. Documented contact method (public email, contact form, or phone).
Record what you couldn't confirm in "uncertainty". Never infer a name, email or service you didn't see. Put only outreach-ready prospect IDs in prospect_ids. If none qualify, submit status "no_results" with an empty list.`;

// ---------- Spending ----------
// The campaign meter is the engine-recorded cost of the campaign's task runs (task_runs.cost_usd, from
// Claude Code's own per-run report). usage_log records the same runs separately; the two must agree.
export function spend(c) {
  const byAgent = db.prepare(`SELECT t.agent_id, count(r.id) AS runs, coalesce(sum(r.cost_usd), 0) AS cost FROM task_runs r
    JOIN tasks t ON t.id = r.task_id WHERE t.campaign_id = ? GROUP BY t.agent_id`).all(c.id);
  const total = byAgent.reduce((s, r) => s + r.cost, 0);
  const usageTotal = db.prepare(`SELECT coalesce(sum(cost_usd), 0) AS c FROM usage_log WHERE task_id IN (SELECT id FROM tasks WHERE campaign_id = ?)`).get(c.id).c;
  return {
    total, remaining: Math.max(0, c.budget_usd - total), budget: c.budget_usd,
    by_agent: byAgent.map((r) => ({ ...r, name: agents.get(r.agent_id)?.name ?? r.agent_id })),
    reconciliation: { task_runs_total: total, usage_log_total: usageTotal, difference: Math.abs(total - usageTotal), matches: Math.abs(total - usageTotal) < 0.0001 },
  };
}

// Typical cost of a step: the average recorded cost of this member's earlier runs, or the campaign reserve.
export function stepReserve(task, c) {
  const avg = db.prepare(`SELECT avg(r.cost_usd) AS a, count(*) AS n FROM task_runs r JOIN tasks t ON t.id = r.task_id
    WHERE t.agent_id = ? AND r.cost_usd > 0`).get(task.agent_id);
  return avg.n ? Math.max(avg.a, c.step_reserve_usd) : c.step_reserve_usd;
}

// Before a campaign step launches: it must fit in what's left, after reserving for steps already running.
setLaunchCheck((task, runningIds) => {
  if (!task.campaign_id) return null;
  const c = campaigns.get(task.campaign_id);
  if (!c) return { reason: "Campaign was deleted." };
  const s = spend(c);
  const reservedByOthers = runningIds.map((id) => taskRepo.get(id)).filter((t) => t?.campaign_id === c.id && t.id !== task.id)
    .reduce((sum, t) => sum + stepReserve(t, c), 0);
  const available = s.remaining - reservedByOthers;
  const need = stepReserve(task, c);
  if (available < need) {
    return { reason: `Campaign budget: $${available.toFixed(2)} available of $${c.budget_usd.toFixed(2)} (spent $${s.total.toFixed(2)}${reservedByOthers ? `, $${reservedByOthers.toFixed(2)} reserved for running steps` : ""}); this step typically costs ~$${need.toFixed(2)}. Not started so the cap isn't exceeded.` };
  }
  return null;
});

// The hard cap passed to the engine for a campaign step: never more than what's left.
export function runBudget(task) {
  if (!task?.campaign_id) return Infinity;
  const c = campaigns.get(task.campaign_id);
  return c ? Math.max(0.01, spend(c).remaining) : Infinity;
}

// ---------- Drafts: automatic checks ----------
const PLACEHOLDER = /\[[^\]\n]{1,40}\]|\{\{[^}]+\}\}|<\s*(name|first name|company)\s*>/i;
const OPT_OUT = /(not (a )?(good )?fit|not interested|no (worries|problem)|prefer not|opt[- ]?out|unsubscribe|(won'?t|will not) (follow up|reach out|contact you) again|reply [^.\n]{0,30}(stop|no thanks))/i;
export function autoChecks(draft, c) {
  const text = draft.content ?? "";
  const lower = text.toLowerCase();
  const others = draft.prospect_id ? db.prepare("SELECT count(*) AS n FROM actions WHERE prospect_id = ? AND status = 'draft' AND id != ?").get(draft.prospect_id, draft.id).n : 0;
  const p = draft.prospect_id ? prospects.get(draft.prospect_id) : null;
  return {
    sender_identity: { pass: lower.includes(c.sender_name.toLowerCase()), note: `must name the sender "${c.sender_name}"` },
    brand: { pass: lower.includes(c.brand.toLowerCase()), note: `must name the brand "${c.brand}"` },
    no_other_affiliation: { pass: !/yana careers|\bi run hasan\b/i.test(text), note: "must not present another company or the old brand" },
    opt_out_wording: { pass: OPT_OUT.test(text), note: "should give an easy way to decline" },
    no_placeholders: { pass: !PLACEHOLDER.test(text), note: "no [brackets] or {{fields}} left in" },
    single_current_draft: { pass: others === 0, note: others ? `${others} other current draft(s) for this prospect` : "one current draft for this prospect" },
    prospect_contactable: { pass: Boolean(p && !p.opted_out && p.contact_permission !== "do_not_contact"), note: p?.opted_out ? "prospect opted out" : "prospect not opted out" },
  };
}
export const REVIEW_CHECKS = ["personalization", "factual_accuracy", "sender_identity", "duplicate_prospect", "opt_out_wording", "missing_information"];

// ---------- Step validators (the handoff only proceeds when these pass) ----------
const currentDrafts = (prospectId) => db.prepare("SELECT * FROM actions WHERE prospect_id = ? AND status = 'draft' ORDER BY created_at DESC").all(prospectId);
const upstreamList = (task, field) => task.depends_on.map((d) => taskRepo.get(d)).flatMap((d) => d?.output?.[field] ?? []);

setOutputValidator((task, output) => {
  if (!task.validator) return null;
  const c = task.campaign_id ? campaigns.get(task.campaign_id) : null;
  if (task.validator === "research_verified") {
    const ids = output.prospect_ids ?? [];
    if (output.status === "no_results" && ids.length === 0) return null;
    if (!ids.length) return "no prospect IDs submitted (use status no_results if none qualified)";
    for (const id of ids) {
      const p = prospects.get(id);
      if (!p) return `unknown prospect ${id}`;
      if (c && p.pipeline !== c.pipeline) return `${p.business || p.name} is in the ${p.pipeline} pipeline, not ${c.pipeline}`;
      if (p.opted_out) return `${p.business || p.name} has opted out`;
      const v = isVerified(p);
      if (!v.ok) return `${p.business || p.name} is not outreach-ready: missing ${v.missing.join(", ")}`;
    }
    return null;
  }
  if (task.validator === "drafts_for_prospects") {
    const want = [...new Set(upstreamList(task, "prospect_ids"))];
    const draftIds = output.draft_ids ?? [];
    for (const pid of want) {
      const drafts = currentDrafts(pid);
      const p = prospects.get(pid);
      if (!drafts.length) return `no current draft for ${p?.business || p?.name || pid}`;
      if (drafts.length > 1) return `${drafts.length} current drafts for ${p?.business || p?.name}; only one may be current`;
      if (!draftIds.includes(drafts[0].id)) return `draft_ids doesn't include the current draft for ${p?.business || p?.name}`;
      if (c) {
        const ac = autoChecks(drafts[0], c);
        const failed = ["sender_identity", "brand", "no_other_affiliation", "no_placeholders"].filter((k) => !ac[k].pass);
        if (failed.length) return `draft for ${p?.business || p?.name} fails: ${failed.map((k) => ac[k].note).join("; ")}`;
      }
    }
    return null;
  }
  if (task.validator === "review_complete") {
    const draftIds = [...new Set(upstreamList(task, "draft_ids"))];
    for (const did of draftIds) {
      const r = db.prepare("SELECT * FROM reviews WHERE action_id = ? AND task_id = ? AND reviewer_kind = 'agent' ORDER BY created_at DESC LIMIT 1").get(did, task.id);
      if (!r) return `no review recorded for draft ${did.slice(0, 8)}`;
      const checks = json(r.checks, {});
      const missing = REVIEW_CHECKS.filter((k) => typeof checks[k]?.pass !== "boolean");
      if (missing.length) return `review of ${did.slice(0, 8)} is missing checks: ${missing.join(", ")}`;
    }
    return null;
  }
  return null;
});

// ---------- Reviews ----------
export function recordReview({ action_id, checks, verdict, notes, reviewer_kind, reviewer, task_id = null }) {
  const d = db.prepare("SELECT * FROM actions WHERE id = ?").get(action_id);
  if (!d) throw new Error("No such draft");
  if (!["approve_for_owner", "needs_changes", "reject"].includes(verdict)) throw new Error("verdict must be approve_for_owner, needs_changes or reject");
  const clean = {};
  for (const k of REVIEW_CHECKS) {
    const v = checks?.[k];
    if (typeof v?.pass !== "boolean") throw new Error(`check "${k}" needs pass true/false and a note`);
    clean[k] = { pass: v.pass, note: String(v.note ?? "").slice(0, 500) };
  }
  const id = uid();
  db.prepare("INSERT INTO reviews (id, action_id, prospect_id, campaign_id, task_id, reviewer_kind, reviewer, checks, verdict, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, action_id, d.prospect_id, d.campaign_id, task_id, reviewer_kind, reviewer, JSON.stringify(clean), verdict, notes ?? null, now());
  logActivity({ agent_id: reviewer_kind === "agent" ? reviewer : null, task_id, kind: "review", summary: `${reviewer_kind === "manual" ? "You" : agents.get(reviewer)?.name ?? reviewer} reviewed draft ${action_id.slice(0, 8)}: ${verdict.replace(/_/g, " ")}` });
  broadcast({ type: "campaigns_changed" });
  return id;
}
export const reviewsFor = (actionId) => db.prepare("SELECT * FROM reviews WHERE action_id = ? ORDER BY created_at DESC").all(actionId).map((r) => ({ ...r, checks: json(r.checks, {}) }));

// ---------- Dashboard ----------
export function dashboard(id) {
  const c = campaigns.get(id);
  if (!c) throw new Error("No such campaign");
  const s = spend(c);
  const all = db.prepare(`SELECT * FROM prospects WHERE pipeline = ? ORDER BY updated_at DESC`).all(c.pipeline).map((r) => prospects.get(r.id));
  const verified = all.filter((p) => p.qualification_status === "outreach_ready");
  const drafts = db.prepare(`SELECT a.* FROM actions a JOIN prospects p ON p.id = a.prospect_id WHERE p.pipeline = ? AND a.status IN ('draft','superseded') ORDER BY a.created_at DESC`).all(c.pipeline);
  const ctasks = taskRepo.list({ limit: 1000 }).filter((t) => t.campaign_id === c.id);
  const memberIds = [...new Set([...(workflows.get(c.workflow_id)?.steps ?? []).map((st) => st.agent_id), ...ctasks.map((t) => t.agent_id)])];
  const activeRun = db.prepare("SELECT * FROM workflow_runs WHERE campaign_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1").get(c.id);
  const handoffs = ctasks.filter((t) => t.depends_on.length && (taskRepo.runs(t.id).length > 0));
  return {
    campaign: c, spend: s, active_run: activeRun ?? null,
    cost_per_verified_prospect: verified.length ? s.total / verified.length : null,
    prospects: { total: all.length, outreach_ready: verified.length, needs_info: all.filter((p) => p.qualification_status === "needs_info").length },
    verified: verified.map((p) => ({ id: p.id, name: p.business || p.name, verification: p.verification })),
    unverified: all.filter((p) => p.qualification_status !== "outreach_ready").map((p) => ({ id: p.id, name: p.business || p.name, status: p.qualification_status, missing: isVerified(p).missing })),
    drafts: drafts.map((d) => ({ ...d, auto_checks: autoChecks(d, c), reviews: reviewsFor(d.id), prospect_name: prospects.get(d.prospect_id)?.business || prospects.get(d.prospect_id)?.name })),
    agents: memberIds.map((aid) => {
      const mine = ctasks.filter((t) => t.agent_id === aid).sort((a, b) => b.updated_at - a.updated_at);
      return { id: aid, name: agents.get(aid)?.name ?? aid, advisor: agents.get(aid)?.advisor, model: agents.get(aid)?.model,
        status: mine.find((t) => t.status === "running") ? "running" : mine[0]?.status ?? "idle", last_task: mine[0] ? { id: mine[0].id, title: mine[0].title, status: mine[0].status, at: mine[0].updated_at } : null,
        cost: s.by_agent.find((b) => b.agent_id === aid)?.cost ?? 0 };
    }),
    failed_tasks: ctasks.filter((t) => t.status === "failed").map((t) => ({ id: t.id, title: t.title, error: t.error, agent: agents.get(t.agent_id)?.name })),
    handoffs_completed: handoffs.length,
    tasks: ctasks.map((t) => ({ id: t.id, title: t.title, status: t.status, step_key: t.step_key, agent: agents.get(t.agent_id)?.name, updated_at: t.updated_at, wait_reason: t.wait_reason })),
  };
}

export function hasActiveRun(campaignId) {
  return Boolean(db.prepare("SELECT 1 FROM workflow_runs WHERE campaign_id = ? AND status = 'running'").get(campaignId)) ||
    taskRepo.list({ limit: 2000 }).some((t) => t.campaign_id === campaignId && ACTIVE_STATES.includes(t.status));
}

// ---------- One-time setup for the approved Zee Careers test campaign ----------
const SERVICE = "White-label reverse recruiting for career coaches, resume writers and career-service agencies: we run their clients' job search behind the scenes, including targeted job sourcing, tailored applications, recruiter outreach, follow-ups and progress tracking.";

export const OLD_CAMPAIGN_OUTREACH_START = "For each upstream prospect, write one short draft with save_draft (include prospect_id, channel and destination from the verified contact method).";
export const CAMPAIGN_OUTREACH_INSTRUCTIONS = "Write one short draft with save_draft for EVERY upstream prospect (include prospect_id, channel and destination from the verified contact method). Ground the personalization in their recorded evidence, describe the service only with the approved description, sign as the campaign sender, and include an easy way to decline. If research flagged something to confirm (a title, a name spelling), still write the draft, avoid relying on the uncertain detail, and put the doubt in owner_notes: the owner reviews every draft before anything is sent. Do not send. Put draft IDs in draft_ids and the prospect IDs in prospect_ids.";

export function campaignWorkflowSteps(ids) {
  return [
    { key: "research", title: "Research & verify agency prospects", agent_id: ids.sarah, depends_on: [], validate: "research_verified",
      instructions: "Find US and Canadian career coaches, resume writers and career-service agencies that fit the campaign. For each candidate, open its website and record evidence with upsert_prospect (pipeline agency), then call record_verification with the four required items and their source URLs. Only outreach-ready prospects go in prospect_ids. Honest zero results are fine." },
    { key: "outreach", title: "Draft personalized outreach", agent_id: ids.zara, depends_on: ["research"], condition: { type: "deps_list_nonempty", field: "prospect_ids" }, validate: "drafts_for_prospects",
      instructions: CAMPAIGN_OUTREACH_INSTRUCTIONS },
    { key: "review", title: "Quality review & pipeline update", agent_id: ids.omar, depends_on: ["outreach"], condition: { type: "deps_list_nonempty", field: "draft_ids" }, validate: "review_complete",
      instructions: "Review every upstream draft (full text is in your brief; get_drafts also returns it) against the approved service description and the prospect's evidence. Call record_review for each with all six checks: personalization, factual_accuracy, sender_identity, duplicate_prospect, opt_out_wording, missing_information. Then set next_action with update_prospect and log an interaction. Nothing is sent. Put reviewed draft IDs in draft_ids." },
  ];
}

export function seedZeeCampaign() {
  if (settings.get("campaign_seed_v1")) return null;
  const find = (re) => agents.list().find((a) => re.test(a.name))?.id;
  const ids = { sarah: find(/^sarah/i), zara: find(/^zara/i), omar: find(/^omar/i) };
  if (!ids.sarah || !ids.zara || !ids.omar) return null;

  const wf = saveWorkflow({ name: "Zee Careers agency campaign", pipeline: "agency", description: "Sarah verifies → Zara drafts → Omar reviews. Draft only.", steps: campaignWorkflowSteps(ids), triggers: [] });
  const id = uid();
  db.prepare(`INSERT INTO campaigns (id, name, brand, sender_name, target, service_description, outreach_mode, budget_usd, workflow_id, pipeline, step_reserve_usd, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'draft_only', 5, ?, 'agency', 0.30, ?, ?, ?)`)
    .run(id, "Zee Careers agency test campaign", "Zee Careers", "Hasan Waheed", "US and Canadian career coaches, resume writers, and career-service agencies",
      SERVICE, wf.id, "Opening spend: the three approved Sarah/Zara/Omar runs from 2026-10-17 are linked to this campaign.", now(), now());

  // Opening balance from the real engine records (approved: about $1.25): link those runs' tasks.
  const OPENING_TASKS = ["6839e82e-0f40-4995-b2c6-7bd05c5482e1", "9c7c66d9-c2a8-4540-8a9d-ccbe7e13e9a7", "8bddc0b8-8782-4e09-ab70-73665bca2902"];
  for (const t of OPENING_TASKS) db.prepare("UPDATE tasks SET campaign_id = ? WHERE id = ? AND campaign_id IS NULL").run(id, t);

  // Approved: Zara's draft stays current; Sarah's and Alex's earlier drafts are superseded (kept, not deleted).
  const CURRENT = "56016f49-79dd-4f8b-9bbe-821d7fe8cce1";
  for (const old of ["aab87386-6477-4348-84c5-0172125709ce", "07f0f97d-3196-479b-82c4-678f0fd6c785"]) {
    db.prepare("UPDATE actions SET status = 'superseded', superseded_by = ?, result = coalesce(result, 'Superseded by owner decision (2026-10-17)'), updated_at = ? WHERE id = ? AND status = 'draft'").run(CURRENT, now(), old);
  }
  db.prepare("UPDATE actions SET campaign_id = ? WHERE id = ?").run(id, CURRENT);

  // Approved: Opus advisor off for Sarah, Zara and Omar (they stay on Haiku).
  for (const aid of Object.values(ids)) agents.update(aid, { advisor: "none" });

  settings.set("campaign_seed_v1", String(now()));
  logActivity({ kind: "campaign", summary: "Set up Zee Careers agency test campaign (draft only, $5 budget); linked opening runs; superseded 2 drafts; advisor off for Sarah, Zara, Omar" });
  return campaigns.get(id);
}
