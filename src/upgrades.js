// One-time upgrade (2026-10-18, approved by the owner): client job search, retargeted job-seeker steps,
// no-stall campaign handoff, and Groq for the high-volume research members with Haiku as fallback.
// Only changes things still at their earlier defaults; your own edits are left alone.
import { db, agents, settings } from "./db.js";
import { logActivity } from "./activity.js";
import { workflows, saveWorkflow, JOB_SEEKER_STEPS } from "./workflows.js";
import { jobSearchSteps } from "./jobs.js";
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

  // 4. Groq for volume research, Haiku as the automatic fallback when Groq is rate-limited or down.
  const groq = db.prepare("SELECT p.id FROM providers p JOIN connections c ON c.key = 'provider:' || p.id WHERE p.base_url LIKE '%api.groq.com%' AND c.status = 'working' ORDER BY p.created_at LIMIT 1").get();
  if (groq) {
    for (const re of VOLUME_MEMBERS) {
      const a = find(re);
      if (!a || a.model !== "haiku") continue;
      agents.update(a.id, { model: `provider:${groq.id}`, fallback_model: a.fallback_model || "haiku" });
      changes.push(`${a.name.split(/\s[-—]/)[0]}: Groq, Haiku fallback`);
    }
  }

  settings.set("results_upgrade_v1", String(Date.now()));
  if (changes.length) logActivity({ kind: "upgrade", summary: `Results upgrade: ${changes.join("; ")}` });
  return changes;
}
