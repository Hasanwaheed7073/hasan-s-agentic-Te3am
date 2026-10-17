// Client job search: client profiles, job postings found for them, fit scores and application packs.
// The system itself checks every posting link. Nothing is applied for automatically: the owner applies
// (or approves) and marks it applied.
import { db, now, uid, json } from "./db.js";
import { broadcast } from "./hub.js";
import { logActivity } from "./activity.js";
import { setOutputValidator, tasks as taskRepo } from "./queue.js";

export const WORK_MODES = ["any", "remote", "hybrid", "onsite"];
export const JOB_STATUSES = ["found", "shortlisted", "skipped", "tailored", "applied", "interview", "offer", "rejected", "closed"];
const OWNER_STATUSES = ["shortlisted", "skipped", "applied", "interview", "offer", "rejected", "closed"];

const parseClient = (c) => c && { ...c, target_titles: json(c.target_titles, []), locations: json(c.locations, []) };
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
  const cols = ["label", "full_name", "target_titles", "locations", "work_mode", "seniority", "salary_floor", "industries", "must_haves", "exclusions", "resume_text", "notes", "status"];
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
    client_id: c.id, label: c.label, target_titles: c.target_titles, locations: c.locations, work_mode: c.work_mode, seniority: c.seniority,
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
  const chk = await checkPosting(input.url);
  const id = uid();
  db.prepare(`INSERT INTO jobs (id, client_id, title, company, url, url_canon, location, work_mode, posted_date, salary_text, requirements, source,
    status, link_state, link_status, link_note, link_checked_at, found_by, task_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, c.id, input.title.trim(), input.company.trim(), input.url.trim(), canon, text(input.location), text(input.work_mode), text(input.posted_date),
      text(input.salary_text), text(input.requirements)?.slice(0, 4000) ?? null, text(input.source), ["dead", "closed"].includes(chk.state) ? "closed" : "found",
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
      if (j.status !== "shortlisted") return `${j.title} at ${j.company} is ${j.status}, not shortlisted (score it with score_job)`;
    }
    return null;
  }
  if (task.validator === "applications_ready") {
    for (const id of upstreamJobIds(task)) {
      const j = jobs.get(id);
      if (!j) continue;
      if (j.status === "skipped") continue; // the writer may drop a job, with a reason, via score_job
      if (!j.application) return `no application pack for ${j.title} at ${j.company} (save_application, or score_job with decision skipped and a reason)`;
      if (!j.application.checks.no_placeholders) return `the cover note for ${j.title} at ${j.company} still has [placeholders]`;
    }
    return null;
  }
  return null;
});

// ---------- Default workflow ----------
export function jobSearchSteps(ids) {
  return [
    { key: "source", title: "Find & verify matching jobs", agent_id: ids.scout, depends_on: [], validate: "jobs_shortlisted",
      instructions: "Find real, currently open job postings that match the CLIENT PROFILE in your brief: target titles, seniority, location/work mode, salary floor, must-haves and exclusions. Search job boards (LinkedIn Jobs, Indeed, Glassdoor, Wellfound), company career pages and ATS sites (Greenhouse, Lever, Workday, Ashby). Prefer postings from the last 14 days and direct company/ATS links over aggregators. Record each candidate with add_job (the system loads the link and tells you if it's closed). Then score every one with score_job: shortlist only real fits, with reasons tied to the profile and honest gaps; skip the rest with a reason. Put shortlisted job IDs in job_ids. Never invent a posting, company, salary or link." },
    { key: "tailor", title: "Prepare application packs", agent_id: ids.zara, depends_on: ["source"], condition: { type: "deps_list_nonempty", field: "job_ids" }, validate: "applications_ready",
      instructions: "For each shortlisted job, write an application pack with save_application: a short cover note (under 180 words) that names the company and connects 2-3 specific requirements from the posting to real experience in the client's resume; resume_tweaks (bullets to emphasize or reword, using only experience the resume shows); and screening_answers if the posting lists questions. Never invent experience, employers, numbers or credentials: if the resume lacks something the job needs, say so in owner_notes. If a job turns out to be a poor fit, use score_job with decision skipped and the reason. Nothing is submitted. Put the job IDs in job_ids." },
  ];
}
