// Job sources queried directly by the app (no web search engine in between): LinkedIn's public job
// search (logged out, paced), company ATS boards (Greenhouse, Lever, Ashby, SmartRecruiters) and remote
// job boards with public feeds (Remotive, Himalayas, Jobicy, RemoteOK). Results come back compact, so
// a run can cover many searches without spending many tokens.
// Sites behind bot checks (Indeed, hiring.cafe) are not queried here; agents may open them in the
// browser like a normal visitor, and stop if a verification page appears.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const disabled = () => new Set(String(process.env.JOB_SOURCES_DISABLED ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean));
export const SOURCES = ["linkedin", "companies", "remote_boards"];

async function get(url, { json = false, timeout = 20000, method = "GET", body } = {}) {
  const res = await fetch(url, { method, body, redirect: "follow", signal: AbortSignal.timeout(timeout),
    headers: { "User-Agent": UA, Accept: json ? "application/json" : "text/html,*/*", "Accept-Language": "en-US,en;q=0.9" } });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return json ? res.json() : res.text();
}
const strip = (html) => String(html ?? "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|li|div|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
const isoDate = (v) => { if (!v) return null; const d = new Date(typeof v === "number" && v < 1e12 ? v * 1000 : v); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };
const money = (min, max, cur = "", per = "") => (min || max ? `${cur ? cur + " " : ""}${[min, max].filter(Boolean).map((n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : n)).join("-")}${per ? `/${per}` : ""}` : null);

// ---------- Title matching ----------
const SYN = { ops: "operations", vp: "vice president", svp: "senior vice president", evp: "executive vice president", sr: "senior", mgr: "manager", dir: "director", eng: "engineering", hr: "human resources", cfo: "chief financial officer", coo: "chief operating officer", cto: "chief technology officer" };
const STOP = new Set(["of", "and", "the", "for", "a", "an", "to", "in", "&", "-", "/", ","]);
const tokens = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9+#]+/g, " ").split(" ").filter(Boolean)
  .flatMap((w) => (SYN[w] ?? w).split(" ")).filter((w) => !STOP.has(w)).map((w) => (w.length > 4 ? w.replace(/s$/, "") : w));
export function titleMatches(title, queries) {
  const have = new Set(tokens(title));
  return queries.some((q) => { const need = tokens(q); return need.length > 0 && need.every((w) => have.has(w)); });
}

// ---------- LinkedIn (public, logged out) ----------
// Paced and capped, roughly the speed of a person clicking through results. LinkedIn answers fast
// bursts with HTTP 429; we then wait and retry once, and pause LinkedIn for a while if it repeats.
const LI = { last: 0, day: "", count: 0, cap: Number(process.env.LINKEDIN_DAILY_REQUESTS ?? 400), blockedUntil: 0 };
export const LINKEDIN_PER_SEARCH = 14;
// One LinkedIn request at a time, even when several jobs are processed in parallel.
let liChain = Promise.resolve();
function liGet(url) { const p = liChain.then(() => liGetOne(url)); liChain = p.catch(() => {}); return p; }
async function liGetOne(url, retried = false) {
  const today = new Date().toDateString();
  if (LI.day !== today) { LI.day = today; LI.count = 0; }
  if (LI.count >= LI.cap) throw new Error(`daily LinkedIn request cap (${LI.cap}) reached`);
  if (Date.now() < LI.blockedUntil) throw new Error(`LinkedIn asked us to slow down; paused until ${new Date(LI.blockedUntil).toLocaleTimeString()}`);
  const wait = LI.last + 4000 + Math.random() * 2000 - Date.now();
  if (wait > 0) await sleep(wait);
  LI.last = Date.now(); LI.count++;
  try { return await get(url); } catch (e) {
    if (![429, 999].includes(e.status)) throw e;
    if (!retried) { await sleep(45000); return liGetOne(url, true); }
    LI.blockedUntil = Date.now() + 15 * 60000;
    throw new Error(`LinkedIn asked us to slow down (HTTP ${e.status}); paused for 15 minutes`);
  }
}
export const linkedInPaused = () => Date.now() < LI.blockedUntil;
const LI_LEVEL = { entry: 2, associate: 3, mid_senior: 4, director: 5, executive: 6 };
const LI_MODE = { onsite: 1, remote: 2, hybrid: 3 };
async function linkedInPage({ query, location, days, work_modes, levels }, page) {
  const p = new URLSearchParams({ keywords: query, location: location || "", start: String(page * 10) });
  if (days) p.set("f_TPR", `r${days * 86400}`);
  const wt = (work_modes ?? []).map((m) => LI_MODE[m]).filter(Boolean); if (wt.length) p.set("f_WT", wt.join(","));
  const el = (levels ?? []).map((l) => LI_LEVEL[l]).filter(Boolean); if (el.length) p.set("f_E", el.join(","));
  const html = await liGet(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${p}`);
  const out = [];
  for (const c of html.split(/base-card relative/).slice(1)) {
    const id = c.match(/urn:li:jobPosting:(\d+)/)?.[1];
    if (!id) continue;
    const pick = (re) => strip(c.match(re)?.[1] ?? "") || null;
    out.push({
      title: pick(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/), company: pick(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/),
      location: pick(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/), posted: c.match(/datetime="([\d-]+)"/)?.[1] ?? null,
      salary: pick(/job-search-card__salary-info[^>]*>([\s\S]*?)<\/span>/), url: `https://www.linkedin.com/jobs/view/${id}`, source: "LinkedIn",
    });
  }
  return out;
}

// ---------- Company ATS boards ----------
const ATS_URL = [
  ["greenhouse", /(?:boards|job-boards)\.greenhouse\.io\/([^/?#]+)/i], ["lever", /jobs\.lever\.co\/([^/?#]+)/i],
  ["ashby", /jobs\.ashbyhq\.com\/([^/?#]+)/i], ["smartrecruiters", /(?:careers|jobs)\.smartrecruiters\.com\/([^/?#]+)/i],
];
const slugify = (s) => String(s).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
function parseCompany(entry) {
  const s = String(entry).trim();
  const m = s.match(/^(greenhouse|lever|ashby|smartrecruiters):(.+)$/i);
  if (m) return [{ ats: m[1].toLowerCase(), slug: m[2].trim() }];
  for (const [ats, re] of ATS_URL) {
    const u = s.match(re);
    if (u) return [{ ats, slug: u[1] }];
  }
  const slug = slugify(s);
  return slug ? ["greenhouse", "lever", "ashby"].map((ats) => ({ ats, slug, guessed: true })) : [];
}
async function companyBoard({ ats, slug }, name) {
  if (ats === "greenhouse") {
    const d = await get(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`, { json: true });
    return d.jobs.map((j) => ({ title: j.title, company: j.company_name || name || slug, location: j.location?.name, posted: isoDate(j.first_published ?? j.updated_at), url: j.absolute_url, source: "Greenhouse" }));
  }
  if (ats === "lever") {
    const d = await get(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`, { json: true });
    return d.map((j) => ({ title: j.text, company: name || slug, location: [j.categories?.location, j.workplaceType].filter(Boolean).join(" · "), posted: isoDate(j.createdAt),
      salary: j.salaryRange ? money(j.salaryRange.min, j.salaryRange.max, j.salaryRange.currency, j.salaryRange.interval) : null, url: j.hostedUrl, source: "Lever" }));
  }
  if (ats === "ashby") {
    const d = await get(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`, { json: true, timeout: 30000 });
    return d.jobs.map((j) => ({ title: String(j.title).trim(), company: name || slug, location: [j.location, ...(j.secondaryLocations ?? []).map((x) => x.location)].filter(Boolean).join("; ") + (j.isRemote ? " · remote" : ""),
      posted: isoDate(j.publishedAt), salary: j.compensation?.compensationTierSummary ?? null, url: j.jobUrl, source: "Ashby" }));
  }
  if (ats === "smartrecruiters") {
    const d = await get(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100`, { json: true });
    return (d.content ?? []).map((j) => ({ title: j.name, company: j.company?.name || name || slug, location: [j.location?.city, j.location?.region, j.location?.country, j.location?.remote ? "remote" : ""].filter(Boolean).join(", "),
      posted: isoDate(j.releasedDate), url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`, source: "SmartRecruiters" }));
  }
  return [];
}

// ---------- Remote job boards (public feeds) ----------
let remoteOkCache = { at: 0, jobs: [] };
async function remoteBoards(query) {
  const q = encodeURIComponent(query);
  const tasks = [
    get(`https://remotive.com/api/remote-jobs?search=${q}&limit=100`, { json: true }).then((d) => d.jobs.map((j) => ({ title: j.title, company: j.company_name, location: `remote · ${j.candidate_required_location}`, posted: isoDate(j.publication_date), salary: j.salary || null, url: j.url, source: "Remotive" }))),
    get(`https://himalayas.app/jobs/api/search?q=${q}&limit=50`, { json: true }).then((d) => d.jobs.map((j) => ({ title: j.title, company: j.companyName, location: `remote · ${(j.locationRestrictions ?? []).join(", ") || "anywhere"}`, posted: isoDate(j.pubDate), salary: money(j.minSalary, j.maxSalary, j.currency), url: j.applicationLink || j.guid, source: "Himalayas" }))),
    get(`https://jobicy.com/api/v2/remote-jobs?count=50&tag=${q}`, { json: true }).then((d) => (d.jobs ?? []).map((j) => ({ title: strip(j.jobTitle), company: j.companyName, location: `remote · ${j.jobGeo}`, posted: isoDate(j.pubDate), salary: money(j.salaryMin, j.salaryMax, j.salaryCurrency, j.salaryPeriod), url: j.url, source: "Jobicy" }))),
    (async () => {
      if (Date.now() - remoteOkCache.at > 30 * 60000) remoteOkCache = { at: Date.now(), jobs: (await get("https://remoteok.com/api", { json: true })).slice(1) };
      return remoteOkCache.jobs.map((j) => ({ title: j.position, company: j.company, location: `remote · ${j.location || "anywhere"}`, posted: isoDate(j.date), salary: money(j.salary_min, j.salary_max, "USD"), url: j.url, source: "RemoteOK" }));
    })(),
  ];
  const settled = await Promise.allSettled(tasks);
  const names = ["Remotive", "Himalayas", "Jobicy", "RemoteOK"];
  return { jobs: settled.flatMap((s) => (s.status === "fulfilled" ? s.value : [])), errors: settled.map((s, i) => (s.status === "rejected" ? `${names[i]}: ${s.reason.message}` : null)).filter(Boolean) };
}

// ---------- The search ----------
const REMOTE_ANY = /remote|anywhere|worldwide|global/i;
export async function searchJobs(opts, { known = () => false } = {}) {
  const titles = (opts.titles ?? []).map(String).filter(Boolean).slice(0, 8);
  if (!titles.length) throw new Error("Give at least one job title to search for.");
  const off = disabled();
  const sources = (opts.sources?.length ? opts.sources : SOURCES).filter((s) => !off.has(s));
  const days = Math.min(60, Math.max(1, Number(opts.days) || 7));
  const cutoff = Date.now() - days * 86400000;
  const locTerms = (opts.location_terms ?? []).map((t) => String(t).toLowerCase()).filter(Boolean);
  const excludeWords = (opts.exclude_words ?? []).map((w) => String(w).toLowerCase());
  const excludeCompanies = (opts.exclude_companies ?? []).map((w) => String(w).toLowerCase());
  const errors = []; const raw = []; const coverage = [];

  if (sources.includes("linkedin")) {
    // Breadth first: page 1 of every title × location, then page 2, ... within a per-search request budget.
    const combos = titles.flatMap((t) => (opts.locations?.length ? opts.locations : [""]).slice(0, 4).map((loc) => ({ query: t, location: loc, days, work_modes: opts.work_modes, levels: opts.levels, n: 0, done: false })));
    const pages = Math.min(5, Math.max(1, Number(opts.pages) || 3));
    let budget = LINKEDIN_PER_SEARCH;
    outer: for (let page = 0; page < pages; page++) {
      for (const c of combos) {
        if (c.done) continue;
        if (budget-- <= 0) { errors.push(`LinkedIn: stopped at ${LINKEDIN_PER_SEARCH} requests for this search; run another search_jobs call for the remaining titles`); break outer; }
        try {
          const r = await linkedInPage(c, page);
          raw.push(...r); c.n += r.length;
          if (r.length < 10) c.done = true;
        } catch (e) { errors.push(`LinkedIn "${c.query}": ${e.message}`); if (/paused|cap/.test(e.message)) break outer; c.done = true; }
      }
    }
    for (const c of combos) if (c.n) coverage.push(`LinkedIn "${c.query}"${c.location ? ` in ${c.location}` : ""}: ${c.n}`);
  }
  if (sources.includes("companies") && opts.companies?.length) {
    const entries = opts.companies.slice(0, 30);
    await Promise.all(entries.map(async (entry) => {
      const name = /^[a-z]+:/i.test(entry) || /^https?:/i.test(entry) ? null : String(entry).trim();
      const tries = parseCompany(entry);
      const res = await Promise.allSettled(tries.map((t) => companyBoard(t, name)));
      const ok = res.map((r, i) => (r.status === "fulfilled" ? [tries[i], r.value] : null)).filter(Boolean);
      if (!ok.length) { errors.push(`${entry}: no public Greenhouse/Lever/Ashby board found${tries[0]?.guessed ? " (give the careers URL or ats:slug)" : ""}`); return; }
      for (const [t, jobs] of ok) { raw.push(...jobs); coverage.push(`${name ?? t.slug} (${t.ats}): ${jobs.length} open roles`); }
    }));
  }
  if (sources.includes("remote_boards") && (opts.work_modes ?? []).includes("remote")) {
    for (const t of titles.slice(0, 4)) {
      const r = await remoteBoards(t);
      raw.push(...r.jobs); errors.push(...r.errors); coverage.push(`Remote boards "${t}": ${r.jobs.length}`);
    }
  }

  // Filter, dedupe, drop what the client already has.
  const seen = new Set(); const jobs = []; const dropped = { title: 0, location: 0, old: 0, excluded: 0, duplicate: 0, already_recorded: 0 };
  for (const j of raw) {
    if (!j.title || !j.url || !/^https?:\/\//.test(j.url)) continue;
    const key = `${String(j.company).toLowerCase().trim()}|${String(j.title).toLowerCase().trim()}`;
    if (seen.has(key) || seen.has(j.url)) { dropped.duplicate++; continue; }
    seen.add(key); seen.add(j.url);
    if (j.source !== "LinkedIn" && !titleMatches(j.title, titles)) { dropped.title++; continue; }
    if (j.source === "LinkedIn" && opts.strict_titles !== false && !titleMatches(j.title, titles)) { dropped.title++; continue; }
    const t = j.title.toLowerCase(); const c = String(j.company ?? "").toLowerCase();
    if (excludeWords.some((w) => t.includes(w)) || excludeCompanies.some((w) => c.includes(w))) { dropped.excluded++; continue; }
    if (j.posted && new Date(j.posted).getTime() < cutoff) { dropped.old++; continue; }
    if (locTerms.length && j.source !== "LinkedIn") {
      const loc = String(j.location ?? "").toLowerCase();
      if (!locTerms.some((x) => loc.includes(x)) && !(locTerms.includes("remote") && REMOTE_ANY.test(loc) && !/europe|emea|apac|asia|latam|uk only|india/i.test(loc))) { dropped.location++; continue; }
    }
    if (known(j)) { dropped.already_recorded++; continue; }
    jobs.push(j);
  }
  jobs.sort((a, b) => String(b.posted ?? "").localeCompare(String(a.posted ?? "")));
  return { jobs: jobs.slice(0, Math.min(80, Number(opts.max_results) || 60)), total: jobs.length, coverage, dropped, errors };
}

// ---------- One posting's details ----------
export async function jobDetails(url) {
  const li = url.match(/linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d+)/i)?.[1];
  if (li) {
    const html = await liGet(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${li}`);
    const criteria = [...html.matchAll(/description__job-criteria-subheader">([\s\S]*?)<\/h3>[\s\S]*?description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/g)].map((m) => `${strip(m[1])}: ${strip(m[2])}`);
    return {
      closed: /no longer accepting applications/i.test(html), applicants: strip(html.match(/num-applicants__caption[^>]*>([\s\S]*?)</)?.[1] ?? "") || null,
      posted_ago: strip(html.match(/posted-time-ago__text[^>]*>([\s\S]*?)</)?.[1] ?? "") || null,
      salary: strip(html.match(/compensation__salary[^>]*>([\s\S]*?)</)?.[1] ?? "") || null, criteria,
      description: strip(html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "").slice(0, 6000),
    };
  }
  const gh = url.match(/(?:boards|job-boards)\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/i);
  if (gh) {
    const j = await get(`https://boards-api.greenhouse.io/v1/boards/${gh[1]}/jobs/${gh[2]}?content=true`, { json: true });
    return { closed: false, description: strip(strip(j.content)).slice(0, 6000), criteria: [j.location?.name].filter(Boolean) };
  }
  const lv = url.match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{36})/i);
  if (lv) {
    const j = await get(`https://api.lever.co/v0/postings/${lv[1]}/${lv[2]}`, { json: true });
    return { closed: false, description: [j.descriptionPlain, ...(j.lists ?? []).map((l) => `${l.text}\n${strip(l.content)}`), j.additionalPlain].filter(Boolean).join("\n").slice(0, 6000),
      criteria: [j.categories?.commitment, j.categories?.location, j.workplaceType].filter(Boolean), salary: j.salaryRange ? money(j.salaryRange.min, j.salaryRange.max, j.salaryRange.currency, j.salaryRange.interval) : null };
  }
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol) || PRIVATE_HOST.test(u.hostname) || u.hostname.endsWith(".local")) throw new Error("only public http(s) links");
  const html = await get(url);
  return { closed: /no longer accepting applications|job (has )?expired|position has been filled|no longer available/i.test(html), description: strip(html).slice(0, 6000), criteria: [] };
}
