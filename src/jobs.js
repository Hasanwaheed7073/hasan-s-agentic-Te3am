// Client job search: client profiles, job postings found for them, fit scores and application packs.
// The system itself checks every posting link. Nothing is applied for automatically: the owner applies
// (or approves) and marks it applied.
import { db, now, uid, json } from "./db.js";
import { broadcast } from "./hub.js";
import { logActivity } from "./activity.js";
import { setOutputValidator, tasks as taskRepo } from "./queue.js";
import { jobDetails } from "./jobsources.js";

export const WORK_MODES = ["any", "remote", "hybrid", "onsite"];
export const JOB_STATUSES = ["found", "shortlisted", "skipped", "tailored", "applied", "interview", "offer", "rejected", "closed"];
const OWNER_STATUSES = ["shortlisted", "skipped", "applied", "interview", "offer", "rejected", "closed"];

const parseClient = (c) => c && { ...c, target_titles: json(c.target_titles, []), locations: json(c.locations, []), target_companies: json(c.target_companies, []) };
const parseJob = (j) => j && { ...j, application: json(j.application, null), fit_reasons: json(j.fit_reasons, []), gaps: json(j.gaps, []) };

export const clients = {
  list: () => db.prepare("SELECT * FROM clients ORDER BY status = 'active' DESC, updated_at DESC").all().map(parseClient),
  get: (id) => parseClient(db.prepare("SELECT * FROM clients WHERE id = ?").get(id)),
};
export const jobs = {
  get: (id) => parseJob(db.prepare("SELECT * FROM jobs WHERE id = ?").get(id)),
  list({ client_id, status, limit = 500 } = {}) {
    const where = []; const args = [];
    if (client_id) { where.push("client_id = ?"); args.push(client_id); }
    if (status) { where.push("status = ?"); args.push(status); }
    return db.prepare(`SELECT * FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY coalesce(fit_score, -1) DESC, created_at DESC LIMIT ?`)
      .all(...args, limit).map(parseJob);
  },
  counts: (client_id) => Object.fromEntries(db.prepare("SELECT status, count(*) AS n FROM jobs WHERE client_id = ? GROUP BY status").all(client_id).map((r) => [r.status, r.n])),
};

const list = (v) => (Array.isArray(v) ? v : String(v ?? "").split(/[\n,;]+/)).map((s) => String(s).trim()).filter(Boolean);
const text = (v) => (v == null ? null : String(v).trim() || null);

// ---------- Clients ----------
export function saveClient(input, { actor = "owner" } = {}) {
  const id = input.id ?? uid();
  const cur = clients.get(id);
  const c = {
    label: text(input.label) ?? cur?.label, full_name: input.full_name !== undefined ? text(input.full_name) : cur?.full_name ?? null,
    target_titles: input.target_titles !== undefined ? list(input.target_titles) : cur?.target_titles ?? [],
    locations: input.locations !== undefined ? list(input.locations) : cur?.locations ?? [],
    target_companies: input.target_companies !== undefined ? list(input.target_companies) : cur?.target_companies ?? [],
    work_mode: input.work_mode ?? cur?.work_mode ?? "any", seniority: input.seniority !== undefined ? text(input.seniority) : cur?.seniority ?? null,
    salary_floor: input.salary_floor !== undefined ? text(input.salary_floor) : cur?.salary_floor ?? null,
    industries: input.industries !== undefined ? text(input.industries) : cur?.industries ?? null,
    must_haves: input.must_haves !== undefined ? text(input.must_haves) : cur?.must_haves ?? null,
    exclusions: input.exclusions !== undefined ? text(input.exclusions) : cur?.exclusions ?? null,
    resume_text: input.resume_text !== undefined ? text(input.resume_text) : cur?.resume_text ?? null,
    notes: input.notes !== undefined ? text(input.notes) : cur?.notes ?? null,
    status: input.status ?? cur?.status ?? "active",
  };
  if (!c.label) throw new Error("Give the client a label (e.g. Client A). Agents and files use the label, not the full name.");
  if (!c.target_titles.length) throw new Error("Add at least one target job title.");
  if (!WORK_MODES.includes(c.work_mode)) throw new Error(`work_mode must be one of: ${WORK_MODES.join(", ")}`);
  if (!["active", "paused"].includes(c.status)) throw new Error("status must be active or paused");
  const cols = ["label", "full_name", "target_titles", "locations", "target_companies", "work_mode", "seniority", "salary_floor", "industries", "must_haves", "exclusions", "resume_text", "notes", "status"];
  const vals = cols.map((k) => (Array.isArray(c[k]) ? JSON.stringify(c[k]) : c[k]));
  if (cur) db.prepare(`UPDATE clients SET ${cols.map((k) => `${k}=?`).join(", ")}, updated_at=? WHERE id=?`).run(...vals, now(), id);
  else db.prepare(`INSERT INTO clients (id, ${cols.join(", ")}, created_at, updated_at) VALUES (?, ${cols.map(() => "?").join(", ")}, ?, ?)`).run(id, ...vals, now(), now());
  logActivity({ kind: "client", summary: `${actor === "owner" ? "You" : actor} ${cur ? "updated" : "added"} client ${c.label}` });
  broadcast({ type: "jobs_changed" });
  return clients.get(id);
}

// What agents see: everything they need to search and tailor, under the label. The full name stays with you.
export function clientBrief(c) {
  return {
    client_id: c.id, label: c.label, target_titles: c.target_titles, locations: c.locations, target_companies: c.target_companies, work_mode: c.work_mode, seniority: c.seniority,
    salary_floor: c.salary_floor, industries: c.industries, must_haves: c.must_haves, exclusions: c.exclusions, notes: c.notes,
    resume_text: c.resume_text ? c.resume_text.slice(0, 12000) : null,
  };
}

// ---------- Posting links: checked by the system, not taken on the agent's word ----------
const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;
const CLOSED = /(no longer accepting applications|this job (has )?expired|job (posting )?(has )?expired|position has been filled|job is no longer available|no longer available|this job is closed|posting (has been )?closed|job not found)/i;
const TRACKING = /^(utm_|ref|refid|trackingid|trk|src|source|from|position|pagenum|currentjobid|origin|lipi|gh_src|lever-source)/i;

export function canonicalJobUrl(u) {
  try {
    const url = new URL(u);
    const li = /linkedin\.com$/i.test(url.hostname) && url.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/);
    if (li) return `linkedin.com/jobs/view/${li[1]}`;
    for (const k of [...url.searchParams.keys()]) if (TRACKING.test(k)) url.searchParams.delete(k);
    url.searchParams.sort();
    return `${url.hostname.toLowerCase().replace(/^www\.|^m\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch { return null; }
}

export async function checkPosting(url) {
  const checked_at = now();
  let u;
  try { u = new URL(url); } catch { return { state: "dead", status: null, note: "not a valid URL", checked_at }; }
  if (!/^https?:$/.test(u.protocol) || PRIVATE_HOST.test(u.hostname)) return { state: "dead", status: null, note: "only public http(s) links", checked_at };
  try {
    const res = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36", Accept: "text/html,*/*" } });
    if ([404, 410].includes(res.status)) return { state: "dead", status: res.status, final_url: res.url, note: "page not found", checked_at };
    if ([401, 403, 429, 999].includes(res.status) || res.status >= 500) return { state: "blocked", status: res.status, final_url: res.url, note: "site refuses automated checks; open it to confirm it's still open", checked_at };
    if (res.status >= 400) return { state: "dead", status: res.status, final_url: res.url, note: `HTTP ${res.status}`, checked_at };
    const body = (await res.text()).slice(0, 600_000).replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
    if (CLOSED.test(body)) return { state: "closed", status: res.status, final_url: res.url, note: `page says: "${body.match(CLOSED)[0]}"`, checked_at };
    return { state: "live", status: res.status, final_url: res.url, checked_at };
  } catch (e) {
    return { state: "blocked", status: null, note: `couldn't load (${e.message}); open it to confirm`, checked_at };
  }
}

// ---------- Jobs ----------
export async function addJob(input, { agent_id = null, task_id = null } = {}) {
  const c = clients.get(input.client_id);
  if (!c) throw new Error("Unknown client_id");
  for (const k of ["title", "company", "url"]) if (!text(input[k])) throw new Error(`${k} is required`);
  if (!/^https?:\/\//i.test(input.url)) throw new Error("url must be the posting's http(s) link");
  const canon = canonicalJobUrl(input.url);
  const dup = db.prepare("SELECT * FROM jobs WHERE client_id = ? AND (url_canon = ? OR (lower(company) = lower(?) AND lower(title) = lower(?)))").get(c.id, canon, input.company.trim(), input.title.trim());
  if (dup) return { job_id: dup.id, duplicate: true, status: dup.status, link_state: dup.link_state, note: "Already recorded for this client; not added again." };
  // Known sources (LinkedIn, Greenhouse, Lever) give the full posting: it doubles as the link check
  // and fills in the requirements, so the writer and the owner see what the job actually asks for.
  let chk; let details = null;
  if (/linkedin\.com\/jobs\/view|greenhouse\.io\/[^/]+\/jobs\/|jobs\.lever\.co\//i.test(input.url)) {
    try {
      details = await jobDetails(input.url);
      chk = details.closed ? { state: "closed", status: 200, note: "page says it's no longer accepting applications", checked_at: now() } : { state: "live", status: 200, checked_at: now() };
    } catch (e) {
      chk = e.status === 404 ? { state: "dead", status: 404, note: "page not found", checked_at: now() }
        : /slow down|paused|cap/.test(e.message) ? { state: "blocked", status: null, note: "LinkedIn rate limit; open it to confirm it's still open", checked_at: now() }
        : await checkPosting(input.url);
    }
  } else chk = await checkPosting(input.url);
  if (!details && chk.state === "live" && !text(input.requirements)) details = await jobDetails(input.url).catch(() => null);
  if (details) {
    // LinkedIn's public search ignores its remote filter, so the description is the evidence.
    const remote = /\b(fully |100% )?remote\b/i.test(details.description ?? "") ? (/\bhybrid\b/i.test(details.description) ? "hybrid/remote (see description)" : "remote (stated in description)") : null;
    input = { ...input, work_mode: input.work_mode && input.work_mode !== "unknown" ? input.work_mode : remote ?? "not stated in description", salary_text: input.salary_text || details.salary || null,
      requirements: text(input.requirements) || [details.criteria?.length ? details.criteria.join(" · ") : null, details.applicants, details.description].filter(Boolean).join("\n") };
  }
  // Checked again after the network calls above: another call may have recorded it meanwhile.
  const late = db.prepare("SELECT id, status, link_state FROM jobs WHERE client_id = ? AND (url_canon = ? OR (lower(company) = lower(?) AND lower(title) = lower(?)))").get(c.id, canon, input.company.trim(), input.title.trim());
  if (late) return { job_id: late.id, duplicate: true, status: late.status, link_state: late.link_state, note: "Already recorded for this client; not added again." };
  const id = uid();
  db.prepare(`INSERT INTO jobs (id, client_id, title, company, url, url_canon, location, work_mode, posted_date, salary_text, requirements, source,
    status, link_state, link_status, link_note, link_checked_at, found_by, task_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, c.id, input.title.trim(), input.company.trim(), input.url.trim(), canon, text(input.location), text(input.work_mode), text(input.posted_date),
      text(input.salary_text), text(input.requirements)?.slice(0, 6000) ?? null, text(input.source), ["dead", "closed"].includes(chk.state) ? "closed" : "found",
      chk.state, chk.status, chk.note ?? null, chk.checked_at, agent_id, task_id, now(), now());
  broadcast({ type: "jobs_changed" });
  return { job_id: id, duplicate: false, link_state: chk.state, link_note: chk.note ?? null,
    note: chk.state === "live" ? "Posting loads." : chk.state === "blocked" ? "Recorded; the site blocks automated checks, so the owner will confirm it." : "Posting looks closed or missing; it can't be shortlisted." };
}

export function scoreJob(id, input, { agent_id = null } = {}) {
  const j = jobs.get(id);
  if (!j) throw new Error("Unknown job_id");
  const score = Number(input.fit_score);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error("fit_score must be 0-100");
  const decision = input.decision ?? "shortlisted";
  if (!["shortlisted", "skipped"].includes(decision)) throw new Error("decision must be shortlisted or skipped");
  if (decision === "shortlisted" && ["dead", "closed"].includes(j.link_state)) throw new Error(`Can't shortlist: the posting is ${j.link_state} (${j.link_note ?? "checked by the system"}).`);
  const reasons = list(input.fit_reasons); const gaps = list(input.gaps);
  if (decision === "shortlisted" && !reasons.length) throw new Error("Give at least one fit reason tied to the client's profile.");
  db.prepare("UPDATE jobs SET fit_score = ?, fit_reasons = ?, gaps = ?, status = CASE WHEN status IN ('applied','interview','offer','rejected') THEN status ELSE ? END, scored_by = ?, updated_at = ? WHERE id = ?")
    .run(Math.round(score), JSON.stringify(reasons), JSON.stringify(gaps), decision, agent_id, now(), id);
  broadcast({ type: "jobs_changed" });
  return jobs.get(id);
}

const PLACEHOLDER = /\[[^\]\n]{1,40}\]|\{\{[^}]+\}\}|<\s*(name|company|hiring manager)\s*>/i;
export function saveApplication(id, input, { agent_id = null, origin = "agent" } = {}) {
  const j = jobs.get(id);
  if (!j) throw new Error("Unknown job_id");
  if (!["shortlisted", "tailored"].includes(j.status)) throw new Error(`Only shortlisted jobs get an application pack (this one is ${j.status}).`);
  const cover = text(input.cover_note);
  if (!cover) throw new Error("cover_note is required");
  const app = {
    version: (j.application?.version ?? 0) + 1, origin, by: agent_id, at: now(),
    cover_note: cover, resume_tweaks: list(input.resume_tweaks), screening_answers: text(input.screening_answers), owner_notes: text(input.owner_notes),
    checks: { no_placeholders: !PLACEHOLDER.test(cover), names_company: cover.toLowerCase().includes(j.company.toLowerCase()) },
  };
  db.prepare("UPDATE jobs SET application = ?, status = 'tailored', updated_at = ? WHERE id = ?").run(JSON.stringify(app), now(), id);
  broadcast({ type: "jobs_changed" });
  return { job_id: id, version: app.version, checks: app.checks };
}

export function setJobStatus(id, status, { note } = {}) {
  const j = jobs.get(id);
  if (!j) throw new Error("No such job");
  if (!OWNER_STATUSES.includes(status)) throw new Error(`status must be one of: ${OWNER_STATUSES.join(", ")}`);
  db.prepare("UPDATE jobs SET status = ?, owner_note = coalesce(?, owner_note), applied_at = CASE WHEN ? = 'applied' THEN ? ELSE applied_at END, updated_at = ? WHERE id = ?")
    .run(status, text(note), status, now(), now(), id);
  logActivity({ kind: "job", summary: `You marked ${j.title} at ${j.company} as ${status}` });
  broadcast({ type: "jobs_changed" });
  return jobs.get(id);
}

export async function recheckJob(id) {
  const j = jobs.get(id);
  if (!j) throw new Error("No such job");
  const chk = await checkPosting(j.url);
  db.prepare("UPDATE jobs SET link_state = ?, link_status = ?, link_note = ?, link_checked_at = ?, updated_at = ? WHERE id = ?")
    .run(chk.state, chk.status, chk.note ?? null, chk.checked_at, now(), id);
  broadcast({ type: "jobs_changed" });
  return jobs.get(id);
}

// ---------- Step validators for the client job search workflow ----------
const upstreamJobIds = (task) => [...new Set(task.depends_on.map((d) => taskRepo.get(d)).flatMap((d) => d?.output?.job_ids ?? []))];
setOutputValidator((task, output) => {
  if (task.validator === "jobs_shortlisted") {
    const ids = output.job_ids ?? [];
    if (output.status === "no_results" && !ids.length) return null;
    if (!ids.length) return "no job IDs submitted (use status no_results if nothing fit)";
    for (const id of ids) {
      const j = jobs.get(id);
      if (!j) return `unknown job ${id}`;
      if (task.input?.client_id && j.client_id !== task.input.client_id) return `${j.title} at ${j.company} belongs to another client`;
      if (j.status !== "shortlisted") return `${j.title} at ${j.company} is ${j.status}, not shortlisted (score it with score_jobs)`;
    }
    return null;
  }
  if (task.validator === "applications_ready") {
    for (const id of upstreamJobIds(task)) {
      const j = jobs.get(id);
      if (!j) continue;
      if (j.status === "skipped") continue; // the writer may drop a job, with a reason, via score_job
      if (!j.application) return `no application pack for ${j.title} at ${j.company} (save_applications, or score_jobs with decision skipped and a reason)`;
      if (!j.application.checks.no_placeholders) return `the cover note for ${j.title} at ${j.company} still has [placeholders]`;
    }
    return null;
  }
  return null;
});

// ---------- Bulk operations (one tool call for many jobs keeps runs inside the tool limit) ----------
async function pool(items, n, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); } }));
  return out;
}
export async function addJobs(clientId, items, ctx = {}) {
  if (!Array.isArray(items) || !items.length) throw new Error("jobs must be a non-empty list");
  // The same posting twice in one call is recorded once (they'd otherwise race past the duplicate check).
  const firstOf = new Map();
  const keyOf = (it) => [canonicalJobUrl(it.url), `${String(it.company ?? "").toLowerCase().trim()}|${String(it.title ?? "").toLowerCase().trim()}`];
  items.slice(0, 40).forEach((it, k) => { for (const key of keyOf(it)) if (key && !firstOf.has(key)) firstOf.set(key, k); });
  return pool(items.slice(0, 40), 4, async (it, k) => {
    if (keyOf(it).some((key) => key && firstOf.get(key) !== k)) return { title: it.title, company: it.company, duplicate: true, link_state: "duplicate in this list" };
    try {
      const r = await addJob({ ...it, client_id: clientId }, ctx);
      if (!r.duplicate && it.fit_score != null && it.decision) {
        try { const j = scoreJob(r.job_id, it, ctx); return { ...r, status: j.status, fit_score: j.fit_score }; }
        catch (e) { return { ...r, score_error: e.message }; }
      }
      return r;
    } catch (e) { return { title: it.title, company: it.company, error: e.message }; }
  });
}
export function scoreJobs(items, ctx = {}) {
  return (items ?? []).slice(0, 60).map((it) => {
    try { const j = scoreJob(it.job_id, it, ctx); return { job_id: j.id, status: j.status, fit_score: j.fit_score }; }
    catch (e) { return { job_id: it.job_id, error: e.message }; }
  });
}
export function saveApplications(items, ctx = {}) {
  return (items ?? []).slice(0, 40).map((it) => {
    try { return saveApplication(it.job_id, it, ctx); } catch (e) { return { job_id: it.job_id, error: e.message }; }
  });
}
// For search: has this client already got this posting (any status)?
export function knownFor(clientId) {
  const rows = db.prepare("SELECT url_canon, lower(company) AS c, lower(title) AS t FROM jobs WHERE client_id = ?").all(clientId);
  const urls = new Set(rows.map((r) => r.url_canon)); const pairs = new Set(rows.map((r) => `${r.c}|${r.t}`));
  return (j) => urls.has(canonicalJobUrl(j.url)) || pairs.has(`${String(j.company).toLowerCase().trim()}|${String(j.title).toLowerCase().trim()}`);
}

// ---------- How to source (given to the sourcing step with every client search) ----------
export const SOURCING_PLAYBOOK = `JOB SOURCING PLAYBOOK (follow it; it's how a strong human sourcer finds 20+ real roles a day)
1. Read the CLIENT PROFILE. Write down: titles, level, locations, work mode, salary floor, must-haves, exclusions, industries, target companies, and from the resume: past employers, industries, core skills.
2. Build a title list of 5-8 real variants, e.g. "Director of Operations" → "Operations Director", "Head of Operations", "Senior Director Operations", "Director, Business Operations", "VP Operations" (only if the level fits). Add industry-specific names the resume suggests. Never drift to a different job family.
3. Search wide with search_jobs (it queries LinkedIn's public listings, company boards and remote boards directly; one call covers several titles and locations):
   - First pass: all title variants × each client location, days 7, levels matching the client (mid_senior/director/executive), work_modes from the profile.
   - If remote is OK, include "remote" in work_modes and the country (e.g. "United States", "Canada") as a location; remote boards are searched automatically. LinkedIn's public search can't filter remote: its results include on-site jobs, so check each job's work_mode (taken from the description) before shortlisting a remote-only client.
   - Company sweep: pass target companies, the client's past employers' competitors and peers you know of, and companies that appeared in good results, in companies (plain names are tried on Greenhouse, Lever and Ashby; "lever:slug" or a careers URL is exact). Direct company links beat aggregator links.
   - Not enough? Widen in this order: days 14, then 30; more title variants; nearby cities/metros; strict_titles false (then filter by hand).
4. Triage from the result lines before adding: drop wrong level, wrong location, excluded companies/industries, staffing/recruiting agencies (unless the client allows), posted salary clearly under the floor, and duplicates of the same role.
5. add_jobs with every plausible fit (up to ~1.5x the target) in one call. The system checks each link and pulls the full description into requirements. Closed or dead links can't be shortlisted.
6. Read requirements with find_jobs (with_details true), then score_jobs in one call. Rubric (100): title & level fit 30, must-haves & core skills 25, location & work mode 20, industry/domain 15, salary 10 (not posted = 5). Shortlist at 65+; skip the rest with a reason. Reasons quote the profile and the posting; gaps are honest.
7. Signals that raise priority: posted in the last 3 days, "Be among the first 25 applicants", direct company/ATS link, salary posted at or above the floor.
8. Indeed, Glassdoor and hiring.cafe block automated access. Use them only through your browser tab like a normal visitor; if a "verify you are human" page appears, stop using that site and note it. Never try to get around a bot check.
9. Repeat 3-6 until you hit the TARGET or have genuinely exhausted the methods above. Then submit_output with job_ids (shortlisted only) and a short coverage report in data: searches run, results per source, how many dropped and why, and what would find more.
Never invent a posting, company, salary or link: only use URLs that search_jobs, your browser or a page you opened returned.`;

// ---------- Default workflow ----------
export const OLD_SOURCE_START = "Find real, currently open job postings that match the CLIENT PROFILE in your brief";
export const OLD_TAILOR_START = "For each shortlisted job, write an application pack with save_application";
export const SOURCE_INSTRUCTIONS = "Find real, open job postings for the client in your brief, following the JOB SOURCING PLAYBOOK. Use search_jobs for the searches, add_jobs to record candidates in bulk, find_jobs (with_details) to read requirements, and score_jobs to shortlist or skip in bulk. Put shortlisted job IDs in job_ids and the coverage report in data.";
export const TAILOR_INSTRUCTIONS = "Write an application pack for every shortlisted job, using save_applications (several at once): a cover note under 180 words that names the company and connects 2-3 specific requirements from the posting (they're in the job's requirements) to real experience in the client's resume; resume_tweaks (bullets to emphasize or reword, only experience the resume shows); screening_answers if the posting lists questions. Never invent experience, employers, numbers or credentials: if the resume lacks something the job needs, say so in owner_notes. If a job is clearly a poor fit after reading it, use score_jobs with decision skipped and the reason. Nothing is submitted. Put the job IDs in job_ids.";
export function jobSearchSteps(ids) {
  return [
    { key: "source", title: "Find & verify matching jobs", agent_id: ids.scout, depends_on: [], validate: "jobs_shortlisted", instructions: SOURCE_INSTRUCTIONS },
    { key: "tailor", title: "Prepare application packs", agent_id: ids.zara, depends_on: ["source"], condition: { type: "deps_list_nonempty", field: "job_ids" }, validate: "applications_ready", instructions: TAILOR_INSTRUCTIONS },
  ];
}
