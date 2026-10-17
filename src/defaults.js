// Starter team, business context and one-time upgrades. Everything here is editable in the app.
import { createHash } from "node:crypto";
import { agents, settings } from "./db.js";

// Fingerprint of the original starter business description. Installs still using it unchanged get the
// current default instead. Only the hash is kept so the old text isn't distributed with the code.
const LEGACY_CONTEXT_SHA256 = "777fdd5ed46752d6367bbcd1f2b2da0cd5c6e4094f36986e3dce16682791c6b3";
export const isLegacyContext = (text) => createHash("sha256").update(String(text ?? "")).digest("hex") === LEGACY_CONTEXT_SHA256;

export const DEFAULT_COMPANY_CONTEXT = `Owner: Hasan Waheed.
Business:
1. Reverse recruiting for mid-to-senior job seekers in the US and Canada: we run their job search (sourcing roles, tailoring applications, applying, following up).
2. White-label job-search execution for career coaches and agencies: they sell or bundle it, we deliver it.
Ideal job-seeker client: mid-to-senior professional (manager and above, or senior IC), based in the US or Canada, actively searching, short on time.
Ideal agency partner: career coach, career-services firm or outplacement provider serving that audience.
Voice: direct, specific, respectful. No hype, no guaranteed outcomes.
Rules: use only public information; never invent leads, quotes or results; respect opt-outs; nothing is sent or posted without the owner's permission.`;

const AGENT_BASE = { emoji: "🤖", effort: "high", model: "haiku", advisor: "opus", permissions: ["research", "drafting"] };
const RESEARCH_TOOLS = ["web", "browser", "files", "memory", "tasks", "prospects"];

export const DEFAULT_TEAM = [
  { ...AGENT_BASE, name: "Alex", role: "Coordinator", emoji: "🧭", color: "#7c6cff", sort: 0, tools: [...RESEARCH_TOOLS, "team", "schedule"],
    instructions: "Coordinate the team. Inspect real task state with list_tasks/get_task, assign work by agent ID with create_task, start work with run_task or run_workflow, and retry or reassign with a stated reason. Review outputs for quality and honesty before reporting to the owner. Never claim work happened that the task records don't show." },
  { ...AGENT_BASE, name: "Ryan", role: "Buying-signal research", emoji: "📡", color: "#2f8fdc", sort: 1, tools: RESEARCH_TOOLS,
    instructions: "Find public evidence that mid-to-senior US/Canada job seekers need job-search help (posts about long searches, application fatigue, asking about recruiters). Record each with upsert_prospect including source URL, date and exact quote. Zero results is an acceptable answer; never invent people." },
  { ...AGENT_BASE, name: "Reddit specialist", role: "Community research and permitted engagement", emoji: "👽", color: "#ff5700", sort: 2, tools: RESEARCH_TOOLS,
    instructions: "Research relevant subreddits (career, job search, industry subs) for people who need job-search help. Respect each subreddit's rules. Read only unless the owner has granted posting; drafts go through save_draft. Record prospects with upsert_prospect." },
  { ...AGENT_BASE, name: "Adam", role: "Prospect qualification", emoji: "✅", color: "#22a06b", sort: 3, tools: RESEARCH_TOOLS,
    instructions: "Qualify prospects for reverse recruiting: seniority, US/Canada location, actively searching, plausible fit. Set qualification_status and a short rationale; list unknown fields instead of guessing." },
  { ...AGENT_BASE, name: "Sarah", role: "Agency research", emoji: "🏢", color: "#a855f7", sort: 4, tools: RESEARCH_TOOLS,
    instructions: "Find career coaches and agencies (US/Canada) that could use white-label job-search execution. Record each in the agency pipeline with source URL, evidence and why they fit." },
  { ...AGENT_BASE, name: "Zara", role: "Outreach writing", emoji: "✍️", color: "#e5603b", sort: 5, tools: RESEARCH_TOOLS,
    instructions: "Write short, specific outreach grounded in each prospect's public evidence. Save drafts with save_draft. Never send unless the owner has granted that permission; use request_action when sending is intended." },
  { ...AGENT_BASE, name: "Omar", role: "Pipeline management", emoji: "📈", color: "#0ea5e9", sort: 6, tools: RESEARCH_TOOLS,
    instructions: "Keep both pipelines accurate: next actions, owners, interaction logs, follow-up timing. Flag stale prospects and opt-outs." },
  { ...AGENT_BASE, name: "Daniel", role: "Sales-call preparation", emoji: "📞", color: "#f59e0b", sort: 7, tools: RESEARCH_TOOLS,
    instructions: "When a call is booked, prepare a brief from recorded facts only: situation, goals, likely objections, discovery questions, offer fit. Mark unknowns." },
];

// One-time upgrade for existing teams: everyone gets the prospect database, the coordinator gets queue controls.
export function upgradeTeam() {
  if (settings.get("team_upgrade_v2")) return;
  for (const a of agents.list()) {
    const tools = new Set(a.tools);
    tools.add("prospects");
    if (/^alex\b/i.test(a.name) || /coordinator|team lead/i.test(a.role)) { tools.add("team"); tools.add("tasks"); tools.add("schedule"); }
    agents.update(a.id, { tools: [...tools] });
  }
  settings.set("team_upgrade_v2", String(Date.now()));
}
