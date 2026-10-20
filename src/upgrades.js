// One-time upgrade (2026-10-18, approved by the owner): client job search, retargeted job-seeker steps,
// no-stall campaign handoff.
// Only changes things still at their earlier defaults; your own edits are left alone.
import { db, agents, settings } from "./db.js";
import { logActivity } from "./activity.js";
import { workflows, saveWorkflow, JOB_SEEKER_STEPS } from "./workflows.js";
import { jobSearchSteps, OLD_SOURCE_START, OLD_TAILOR_START, SOURCE_INSTRUCTIONS, TAILOR_INSTRUCTIONS } from "./jobs.js";
import { OLD_CAMPAIGN_OUTREACH_START, CAMPAIGN_OUTREACH_INSTRUCTIONS } from "./campaigns.js";

const OLD_SCOUT_START = "You source job openings for the owner's clients (job seekers moving into or up within clinical research).";
const SCOUT_INSTRUCTIONS = `You source job openings for the owner's reverse-recruiting clients: mid-to-senior professionals in the US and Canada, any industry.
- Work from the client profile in your brief: target titles, seniority, locations or work mode, salary floor, must-haves and exclusions.
- Search job boards (LinkedIn Jobs, Indeed, Glassdoor, Wellfound), company career pages and ATS sites (Greenhouse, Lever, Workday, Ashby). Prefer postings from the last 14 days and direct company/ATS links.
- Record every candidate with add_job; the system checks the link. Score each with score_job: shortlist only real fits, with reasons tied to the profile and honest gaps.
- Refer to clients only by their label. Never invent postings, salaries or links.
- Never submit an application. If a board requires login, say so.`;

// Step instructions as first seeded, recognised by their opening words.
const OLD_STEP_START = {
  signals: "Find public posts from mid-to-senior job seekers in the US or Canada who show a need for job-search help",
  reddit: "Research relevant subreddits for mid-to-senior US/Canada job seekers expressing a need for job-search help.",
  qualify: "Qualify each upstream prospect for reverse recruiting (seniority, location US/Canada, active search, fit).",
};
const VOLUME_MEMBERS = [/^ryan/i, /reddit/i, /^scout/i, /^sarah/i];

export function applyResultsUpgrade() {
  if (settings.get("results_upgrade_v1")) return null;
  const changes = [];
  const find = (re) => agents.list().find((a) => re.test(a.name));
  const scout = find(/^scout/i), zara = find(/^zara/i), alex = find(/^alex/i);

  // 1. Job-search tools for the sourcer, the writer and the coordinator.
  for (const a of [scout, zara, alex].filter(Boolean)) {
    if (!a.tools.includes("jobs")) { agents.update(a.id, { tools: [...a.tools, "jobs"] }); changes.push(`${a.name.split(/\s[-—]/)[0]}: job-search tools`); }
  }
  if (scout?.instructions.startsWith(OLD_SCOUT_START)) { agents.update(scout.id, { instructions: SCOUT_INSTRUCTIONS }); changes.push("Scout: instructions for any-industry mid-to-senior clients"); }

  // 2. Client job search workflow (Scout finds and verifies → Zara prepares application packs).
  if (scout && zara && !workflows.list().some((w) => w.name === "Client job search")) {
    saveWorkflow({ name: "Client job search", pipeline: null, description: "Scout finds and verifies matching postings → Zara prepares application packs. Nothing is submitted.", steps: jobSearchSteps({ scout: scout.id, zara: zara.id }), triggers: [] });
    changes.push("added workflow Client job search");
  }

  // 3. Job-seeker workflow: identifiable leads, Reddit reply drafts, a realistic qualification bar.
  for (const w of workflows.list()) {
    let touched = false;
    const steps = w.steps.map((s) => {
      if (OLD_STEP_START[s.key] && s.instructions?.startsWith(OLD_STEP_START[s.key])) { touched = true; return { ...s, instructions: JOB_SEEKER_STEPS[s.key], ...(s.key === "reddit" ? { title: "Community engagement (Reddit)" } : {}) }; }
      if (s.key === "outreach" && s.validate === "drafts_for_prospects" && s.instructions?.startsWith(OLD_CAMPAIGN_OUTREACH_START)) { touched = true; return { ...s, instructions: CAMPAIGN_OUTREACH_INSTRUCTIONS }; }
      return s;
    });
    if (touched) { saveWorkflow({ ...w, steps }); changes.push(`workflow "${w.name}": updated step instructions`); }
  }

  // (This upgrade first also moved four members to Groq; that was reverted by the second upgrade below.)
  settings.set("results_upgrade_v1", String(Date.now()));
  if (changes.length) logActivity({ kind: "upgrade", summary: `Results upgrade: ${changes.join("; ")}` });
  return changes;
}

// Second upgrade (2026-10-18): direct job-source tools and the sourcing playbook. The first real run
// showed Groq's free tier rate-limits these prompts on the first request and that search engines
// block automated queries, so members moved to Groq by the first upgrade go back to Haiku (which
// has Claude's own web search). Only reverts what the first upgrade set.
const SCOUT_INSTRUCTIONS_V2 = `You source job openings for the owner's reverse-recruiting clients: mid-to-senior professionals in the US and Canada, any industry.
- Work from the client profile in your brief and follow the JOB SOURCING PLAYBOOK it includes.
- Search with search_jobs (LinkedIn public listings, company Greenhouse/Lever/Ashby/SmartRecruiters boards, remote boards). Record candidates in bulk with add_jobs, read requirements with find_jobs, then shortlist or skip with score_jobs.
- Refer to clients only by their label. Never invent postings, salaries or links.
- Never submit an application. If a site shows a bot check or needs a login, stop using it and say so.`;
export function applyJobSourcingUpgrade() {
  if (settings.get("results_upgrade_v2")) return null;
  const changes = [];
  const find = (re) => agents.list().find((a) => re.test(a.name));
  const scout = find(/^scout/i);
  if (scout && (scout.instructions === SCOUT_INSTRUCTIONS || scout.instructions.startsWith(OLD_SCOUT_START))) {
    agents.update(scout.id, { instructions: SCOUT_INSTRUCTIONS_V2 });
    changes.push("Scout: sourcing playbook instructions");
  }
  for (const w of workflows.list().filter((x) => x.name === "Client job search")) {
    let touched = false;
    const steps = w.steps.map((s) => {
      if (s.key === "source" && s.instructions?.startsWith(OLD_SOURCE_START)) { touched = true; return { ...s, instructions: SOURCE_INSTRUCTIONS }; }
      if (s.key === "tailor" && s.instructions?.startsWith(OLD_TAILOR_START)) { touched = true; return { ...s, instructions: TAILOR_INSTRUCTIONS }; }
      return s;
    });
    if (touched) { saveWorkflow({ ...w, steps }); changes.push("Client job search: bulk tools and playbook"); }
  }
  const groqIds = new Set(db.prepare("SELECT id FROM providers WHERE base_url LIKE '%api.groq.com%'").all().map((p) => `provider:${p.id}`));
  for (const re of VOLUME_MEMBERS) {
    const a = find(re);
    if (!a || !groqIds.has(a.model) || a.fallback_model !== "haiku") continue;
    agents.update(a.id, { model: "haiku", fallback_model: null });
    changes.push(`${a.name.split(/\s[-—]/)[0]}: back to Haiku`);
  }
  settings.set("results_upgrade_v2", String(Date.now()));
  if (changes.length) logActivity({ kind: "upgrade", summary: `Job sourcing upgrade: ${changes.join("; ")}` });
  return changes;
}
