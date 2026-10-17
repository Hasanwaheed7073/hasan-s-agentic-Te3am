// Shared prospect database: separate job-seeker and agency pipelines, identifier-based dedup,
// interaction history, opt-outs and CSV import/export.
import { db, now, uid, json, tx } from "./db.js";
import { parseCsv, toCsv } from "./csv.js";

export const PIPELINES = ["job_seeker", "agency"];
export const QUAL_STATUSES = ["new", "needs_info", "qualified", "outreach_ready", "disqualified"];
export const CONTACT_PERMISSIONS = ["unknown", "allowed", "do_not_contact"];

// ---------- Canonical identifiers ----------
export function canonicalUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    const host = url.hostname.toLowerCase().replace(/^www\.|^m\.|^old\./, "");
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch { return null; }
}

// Strong identifiers only: a matching name alone never merges two records.
export function identifiersFor(p) {
  const ids = [];
  const add = (kind, value) => { if (value) ids.push({ kind, value: String(value).trim().toLowerCase() }); };
  const k = p.known ?? {};
  for (const u of [p.linkedin_url, k.linkedin_url, p.source_url, k.website, p.website]) {
    const m = u && String(u).match(/linkedin\.com\/(in|company)\/([^/?#]+)/i);
    if (m) add("linkedin", `${m[1]}/${decodeURIComponent(m[2])}`);
  }
  for (const u of [p.reddit_username, k.reddit_username]) {
    if (u) add("reddit", String(u).replace(/^.*reddit\.com\/(?:u|user)\//i, "").replace(/^\/?u\//, "").split(/[/?#]/)[0]);
  }
  const profile = p.source_url && String(p.source_url).match(/reddit\.com\/(?:u|user)\/([^/?#]+)/i);
  if (profile) add("reddit", profile[1]);
  for (const e of [p.email, k.email]) if (e && /@/.test(e)) add("email", e);
  for (const w of [p.website, k.website]) {
    if (!w || /linkedin\.com|reddit\.com/i.test(w)) continue;
    const c = canonicalUrl(w);
    if (c) add("domain", c.split("/")[0]);
  }
  // The exact public post/profile the evidence came from (same post = same author).
  const src = canonicalUrl(p.source_url);
  if (src) add("source", src);
  const seen = new Set();
  return ids.filter((i) => (seen.has(i.kind + i.value) ? false : seen.add(i.kind + i.value)));
}

const parse = (r) => r && {
  ...r, evidence: json(r.evidence, []), known: json(r.known, {}), unknown: json(r.unknown, []), opted_out: Boolean(r.opted_out),
  verification: json(r.verification, null),
};

// ---------- Strict verification (outreach-ready gate) ----------
const isHttp = (u) => /^https?:\/\/[^\s]+$/i.test(String(u ?? "").trim());
const REQUIRED = [
  ["website", (v) => isHttp(v.website_url) && v.website_ok === true, "verified business website (must load)"],
  ["service", (v) => v.service_summary?.trim() && isHttp(v.service_source_url), "relevant service offering with source URL"],
  ["decision_maker", (v) => v.decision_maker?.trim() && isHttp(v.decision_maker_source_url), "identifiable decision-maker with source URL"],
  ["contact", (v) => v.contact_method?.trim() && isHttp(v.contact_source_url), "documented contact method with source URL"],
];
export function isVerified(p) {
  const v = p?.verification;
  if (!v) return { ok: false, missing: REQUIRED.map((r) => r[2]) };
  const missing = REQUIRED.filter(([, ok]) => !ok(v)).map((r) => r[2]);
  return { ok: missing.length === 0 && !p.opted_out, missing: p.opted_out ? [...missing, "prospect has opted out"] : missing };
}

// The system itself checks that the website loads; the agent's word isn't enough.
async function checkWebsite(url) {
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "User-Agent": "Mozilla/5.0 (verification check)" } });
    return { ok: res.status < 400, status: res.status, final_url: res.url };
  } catch (e) {
    return { ok: false, status: null, error: e.message };
  }
}

export async function recordVerification(id, input, { agent_id = null } = {}) {
  const p = prospects.get(id);
  if (!p) throw new Error("No such prospect");
  for (const k of ["website_url", "service_source_url", "decision_maker_source_url", "contact_source_url"]) {
    if (input[k] && !isHttp(input[k])) throw new Error(`${k} must be an http(s) link`);
  }
  const site = input.website_url ? await checkWebsite(input.website_url) : { ok: false, status: null, error: "no website given" };
  const v = {
    website_url: input.website_url ?? null, website_ok: site.ok, website_status: site.status, website_error: site.error ?? null, website_checked_at: now(),
    service_summary: input.service_summary ?? null, service_source_url: input.service_source_url ?? null,
    decision_maker: input.decision_maker ?? null, decision_maker_role: input.decision_maker_role ?? null, decision_maker_source_url: input.decision_maker_source_url ?? null,
    contact_method: input.contact_method ?? null, contact_source_url: input.contact_source_url ?? null,
    uncertainty: input.uncertainty ?? null, verified_at: now(), verified_by: agent_id,
  };
  db.prepare("UPDATE prospects SET verification = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(v), now(), id);
  const check = isVerified(prospects.get(id));
  const status = check.ok ? "outreach_ready" : "needs_info";
  db.prepare("UPDATE prospects SET qualification_status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
  logInteraction(id, { agent_id, type: "verification", summary: check.ok ? "Verified: outreach-ready" : `Not outreach-ready; missing: ${check.missing.join(", ")}` });
  return { prospect_id: id, outreach_ready: check.ok, missing: check.missing, website_check: site };
}

export const prospects = {
  get: (id) => parse(db.prepare("SELECT * FROM prospects WHERE id = ?").get(id)),
  list({ pipeline, status, q, limit = 500 } = {}) {
    const where = [];
    const args = [];
    if (pipeline) { where.push("pipeline = ?"); args.push(pipeline); }
    if (status) { where.push("qualification_status = ?"); args.push(status); }
    if (q) { where.push("(lower(coalesce(name,'')) LIKE ? OR lower(coalesce(business,'')) LIKE ?)"); args.push(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`); }
    return db.prepare(`SELECT * FROM prospects ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC LIMIT ?`)
      .all(...args, limit).map(parse);
  },
  identifiers: (id) => db.prepare("SELECT kind, value FROM prospect_identifiers WHERE prospect_id = ?").all(id),
  interactions: (id) => db.prepare("SELECT * FROM interactions WHERE prospect_id = ? ORDER BY at DESC").all(id),
};

/**
 * Creates or updates a prospect. Matches an existing record only on a strong identifier
 * (LinkedIn profile, Reddit user, email, website domain, or the exact source URL) within the same
 * pipeline. Same name without a shared identifier creates a new record flagged as a possible duplicate.
 */
export function upsertProspect(input, { agent_id = null } = {}) {
  const pipeline = input.pipeline;
  if (!PIPELINES.includes(pipeline)) throw new Error(`pipeline must be one of: ${PIPELINES.join(", ")}`);
  if (!input.name && !input.business) throw new Error("Give a public name or business name.");
  if (!input.source_url) throw new Error("source_url is required: every prospect needs a public source.");
  // Only real web links: a javascript: or data: URL from a poisoned page must never become a clickable link.
  if (!/^https?:\/\/[^\s]+$/i.test(String(input.source_url).trim())) throw new Error("source_url must be a public http(s) link.");
  for (const k of ["linkedin_url", "website"]) {
    if (input[k] && !/^https?:\/\//i.test(input[k]) && /^[a-z]+:/i.test(input[k])) throw new Error(`${k} must be an http(s) link.`);
  }
  const ids = identifiersFor(input);

  return tx(() => {
    let existing = null;
    for (const i of ids) {
      const hit = db.prepare("SELECT prospect_id FROM prospect_identifiers WHERE pipeline = ? AND kind = ? AND value = ?")
        .get(pipeline, i.kind, i.value);
      if (hit) { existing = prospects.get(hit.prospect_id); break; }
    }
    const evidenceItem = input.source_url ? { source_url: input.source_url, date: input.evidence_date ?? null, quote: input.quote ?? null } : null;

    if (existing) {
      const evidence = [...existing.evidence];
      if (evidenceItem && !evidence.some((e) => e.source_url === evidenceItem.source_url)) evidence.push(evidenceItem);
      const known = { ...existing.known, ...(input.known ?? {}) };
      // Keep the first name on record; other spellings become aliases instead of overwriting it.
      if (input.name && existing.name && input.name.trim().toLowerCase() !== existing.name.trim().toLowerCase()) {
        known.aliases = [...new Set([...(existing.known.aliases ?? []), input.name.trim()])];
      }
      const unknown = (input.unknown ?? existing.unknown).filter((f) => !(f in known));
      db.prepare(`UPDATE prospects SET name = coalesce(name, ?), business = coalesce(business, ?), evidence = ?, known = ?, unknown = ?,
        quote = coalesce(quote, ?), evidence_date = coalesce(evidence_date, ?), updated_at = ? WHERE id = ?`)
        .run(input.name ?? null, input.business ?? null, JSON.stringify(evidence), JSON.stringify(known), JSON.stringify(unknown),
          input.quote ?? null, input.evidence_date ?? null, now(), existing.id);
      for (const i of ids) {
        db.prepare("INSERT OR IGNORE INTO prospect_identifiers (prospect_id, pipeline, kind, value) VALUES (?, ?, ?, ?)").run(existing.id, pipeline, i.kind, i.value);
      }
      return { id: existing.id, result: "updated_existing" };
    }

    const id = uid();
    const sameName = input.name
      ? db.prepare("SELECT id FROM prospects WHERE pipeline = ? AND lower(name) = lower(?) LIMIT 1").get(pipeline, input.name)
      : null;
    db.prepare(`INSERT INTO prospects (id, pipeline, name, business, source_url, evidence_date, quote, evidence, known, unknown,
      qualification_status, rationale, owner_id, next_action, contact_permission, possible_duplicate_of, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, pipeline, input.name ?? null, input.business ?? null, input.source_url, input.evidence_date ?? null, input.quote ?? null,
        JSON.stringify(evidenceItem ? [evidenceItem] : []), JSON.stringify(input.known ?? {}), JSON.stringify(input.unknown ?? []),
        QUAL_STATUSES.includes(input.qualification_status) ? input.qualification_status : "new", input.rationale ?? null,
        input.owner_id ?? agent_id, input.next_action ?? null,
        CONTACT_PERMISSIONS.includes(input.contact_permission) ? input.contact_permission : "unknown",
        sameName?.id ?? null, now(), now());
    for (const i of ids) {
      db.prepare("INSERT OR IGNORE INTO prospect_identifiers (prospect_id, pipeline, kind, value) VALUES (?, ?, ?, ?)").run(id, pipeline, i.kind, i.value);
    }
    return { id, result: sameName ? "created_possible_duplicate" : "created", possible_duplicate_of: sameName?.id ?? null };
  });
}

export function updateProspect(id, fields, { agent_id = null } = {}) {
  const p = prospects.get(id);
  if (!p) throw new Error(`No prospect ${id}`);
  const m = { ...p };
  if (fields.qualification_status !== undefined) {
    if (!QUAL_STATUSES.includes(fields.qualification_status)) throw new Error(`qualification_status must be one of ${QUAL_STATUSES.join(", ")}`);
    if (fields.qualification_status === "outreach_ready" && !isVerified(p).ok) {
      throw new Error(`Can't mark outreach-ready: missing ${isVerified(p).missing.join(", ")}. Use record_verification.`);
    }
    m.qualification_status = fields.qualification_status;
  }
  for (const k of ["rationale", "next_action", "owner_id", "name", "business", "booking_status"]) if (fields[k] !== undefined) m[k] = fields[k];
  if (fields.contact_permission !== undefined) {
    if (!CONTACT_PERMISSIONS.includes(fields.contact_permission)) throw new Error(`contact_permission must be one of ${CONTACT_PERMISSIONS.join(", ")}`);
    m.contact_permission = fields.contact_permission;
  }
  if (fields.known) m.known = { ...p.known, ...fields.known };
  if (fields.unknown) m.unknown = fields.unknown;
  m.unknown = m.unknown.filter((f) => !(f in m.known));
  db.prepare(`UPDATE prospects SET qualification_status=?, rationale=?, next_action=?, owner_id=?, name=?, business=?, booking_status=?,
    contact_permission=?, known=?, unknown=?, updated_at=? WHERE id=?`)
    .run(m.qualification_status, m.rationale, m.next_action, m.owner_id, m.name, m.business, m.booking_status ?? null,
      m.contact_permission, JSON.stringify(m.known), JSON.stringify(m.unknown), now(), id);
  if (fields.qualification_status && fields.qualification_status !== p.qualification_status) {
    logInteraction(id, { agent_id, type: "qualification", summary: `Status ${p.qualification_status} → ${m.qualification_status}${m.rationale ? `: ${m.rationale}` : ""}` });
  }
  return prospects.get(id);
}

// Opt-outs apply to every agent and every channel; the action layer checks this before any contact.
export function setOptOut(id, optedOut, { agent_id = null, note } = {}) {
  db.prepare("UPDATE prospects SET opted_out = ?, opted_out_at = ?, contact_permission = ?, updated_at = ? WHERE id = ?")
    .run(optedOut ? 1 : 0, optedOut ? now() : null, optedOut ? "do_not_contact" : "unknown", now(), id);
  logInteraction(id, { agent_id, type: optedOut ? "opt_out" : "opt_in", summary: note || (optedOut ? "Opted out of contact" : "Opt-out removed") });
}

export function logInteraction(prospect_id, { agent_id = null, type, summary, action_id = null, task_id = null }) {
  db.prepare("INSERT INTO interactions (prospect_id, at, agent_id, type, summary, action_id, task_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(prospect_id, now(), agent_id, type, String(summary).slice(0, 2000), action_id, task_id);
}

// Finds an opted-out prospect matching a destination (email, LinkedIn URL, Reddit user).
export function optOutFor({ prospect_id, destination }) {
  if (prospect_id) {
    const p = prospects.get(prospect_id);
    if (p && (p.opted_out || p.contact_permission === "do_not_contact")) return p;
  }
  if (destination) {
    const ids = identifiersFor({ email: destination, linkedin_url: destination, reddit_username: /^u\//.test(destination) ? destination : null, source_url: null });
    for (const i of ids) {
      const hit = db.prepare(`SELECT p.* FROM prospect_identifiers pi JOIN prospects p ON p.id = pi.prospect_id
        WHERE pi.kind = ? AND pi.value = ? AND (p.opted_out = 1 OR p.contact_permission = 'do_not_contact')`).get(i.kind, i.value);
      if (hit) return parse(hit);
    }
  }
  return null;
}

// ---------- CSV ----------
const CSV_COLUMNS = ["id", "pipeline", "name", "business", "source_url", "evidence_date", "quote", "linkedin_url", "email", "website",
  "reddit_username", "qualification_status", "rationale", "owner_id", "next_action", "contact_permission", "opted_out", "known", "unknown"];

export function exportCsv(pipeline) {
  const rows = prospects.list({ pipeline, limit: 100000 }).map((p) => ({
    ...p, linkedin_url: p.known.linkedin_url ?? "", email: p.known.email ?? "", website: p.known.website ?? "",
    reddit_username: p.known.reddit_username ?? "", opted_out: p.opted_out ? "yes" : "no",
    known: JSON.stringify(p.known), unknown: p.unknown.join("; "),
  }));
  return toCsv(CSV_COLUMNS, rows);
}

export function importCsv(text, { pipeline: forcePipeline, agent_id = null } = {}) {
  const rows = parseCsv(text);
  const report = { created: 0, updated: 0, possible_duplicates: 0, errors: [] };
  rows.forEach((r, i) => {
    try {
      let known = {};
      try { known = r.known ? JSON.parse(r.known) : {}; } catch { known = {}; }
      for (const k of ["linkedin_url", "email", "website", "reddit_username"]) if (r[k]) known[k] = r[k];
      const res = upsertProspect({
        pipeline: forcePipeline || r.pipeline, name: r.name || null, business: r.business || null, source_url: r.source_url,
        evidence_date: r.evidence_date || null, quote: r.quote || null, known,
        unknown: r.unknown ? r.unknown.split(/;\s*/).filter(Boolean) : [], linkedin_url: r.linkedin_url, email: r.email,
        website: r.website, reddit_username: r.reddit_username, qualification_status: r.qualification_status || undefined,
        rationale: r.rationale || null, owner_id: r.owner_id || null, next_action: r.next_action || null,
        contact_permission: r.contact_permission || undefined,
      }, { agent_id });
      if (res.result === "updated_existing") report.updated++;
      else { report.created++; if (res.possible_duplicate_of) report.possible_duplicates++; }
      if (/^(yes|true|1)$/i.test(r.opted_out ?? "")) setOptOut(res.id, true, { note: "Imported as opted out" });
    } catch (e) {
      report.errors.push(`Row ${i + 2}: ${e.message}`);
    }
  });
  return report;
}
