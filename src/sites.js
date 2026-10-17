// Accounts you sign in to, and per-site rules the team's browser actions must follow.
// Rules are enforced in code, so an agent cannot talk its way past them.
import { settings } from "./db.js";
import * as browser from "./browser.js";

const DEFAULT_ACCOUNTS = [
  { name: "LinkedIn", domain: "linkedin.com", loginUrl: "https://www.linkedin.com/login", cookie: "li_at" },
  { name: "Google", domain: "google.com", loginUrl: "https://accounts.google.com/", cookie: "SID" },
  { name: "Indeed", domain: "indeed.com", loginUrl: "https://secure.indeed.com/auth", cookie: null },
];

// access: "blocked" = agents can't open the site; "approve" = reading and typing are free, but
// clicking buttons or submitting needs your OK each time; "full" = no extra checks.
const DEFAULT_RULES = [
  { domain: "linkedin.com", access: "approve", dailyLimit: 150, minDelaySec: 4 },
];

const readJson = (key, fallback) => {
  try { return JSON.parse(settings.get(key)) ?? fallback; } catch { return fallback; }
};

export const getAccounts = () => readJson("accounts", DEFAULT_ACCOUNTS);
export const saveAccounts = (list) => settings.set("accounts", JSON.stringify(list));
export const getRules = () => readJson("site_rules", DEFAULT_RULES);
export const saveRules = (list) => settings.set("site_rules", JSON.stringify(list));

// Session cookies that mean "signed in" on common sites, used for the status badge.
const SESSION_COOKIES = {
  "linkedin.com": "li_at", "google.com": "SID", "facebook.com": "c_user", "instagram.com": "sessionid",
  "x.com": "auth_token", "twitter.com": "auth_token", "github.com": "user_session",
};

export const baseDomain = (d) => d.replace(/^\./, "").split(".").slice(-2).join(".");
const matchesDomain = (cookieDomain, domain) => {
  const d = cookieDomain.replace(/^\./, "");
  return d === domain || d.endsWith(`.${domain}`);
};

const SAMESITE = { no_restriction: "None", none: "None", lax: "Lax", strict: "Strict" };

/**
 * Accepts the three common cookie export formats:
 * - JSON array (Cookie-Editor, EditThisCookie, browser devtools exports)
 * - Netscape cookies.txt (tab-separated)
 * - a raw "name=value; name2=value2" header string (needs `fallbackDomain`)
 * Returns Playwright cookie objects. Never logs values: cookies are as sensitive as passwords.
 */
export function parseCookies(text, fallbackDomain) {
  const t = String(text ?? "").trim();
  if (!t) throw new Error("Paste your exported cookies first.");
  let raw = [];
  if (t.startsWith("[") || t.startsWith("{")) {
    let j;
    try { j = JSON.parse(t); } catch { throw new Error("That looks like JSON but couldn't be read. Export again and paste the whole thing."); }
    if (!Array.isArray(j)) j = Array.isArray(j.cookies) ? j.cookies : [j];
    raw = j.map((c) => ({
      name: c.name, value: c.value, domain: c.domain ?? c.host, path: c.path, hostOnly: c.hostOnly,
      expires: c.expirationDate ?? c.expires ?? c.expiry, httpOnly: c.httpOnly ?? c.httponly, secure: c.secure, sameSite: c.sameSite,
    }));
  } else if (t.includes("\t")) {
    for (let line of t.split(/\r?\n/)) {
      let httpOnly = false;
      if (line.startsWith("#HttpOnly_")) { httpOnly = true; line = line.slice(10); }
      if (!line.trim() || line.startsWith("#")) continue;
      const [domain, , path, secure, expires, name, value = ""] = line.split("\t");
      raw.push({ name, value, domain, path, secure: secure === "TRUE", expires: Number(expires), httpOnly });
    }
  } else {
    if (!fallbackDomain) throw new Error("For a name=value cookie string, import it from that site's card so the app knows which site it belongs to.");
    for (const part of t.replace(/^cookie:\s*/i, "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) raw.push({ name: part.slice(0, i).trim(), value: part.slice(i + 1).trim(), domain: `.${fallbackDomain}`, secure: true });
    }
  }

  const out = [];
  for (const c of raw) {
    if (!c.name || !c.domain) continue;
    let domain = String(c.domain).trim().toLowerCase();
    if (c.hostOnly === true) domain = domain.replace(/^\./, "");
    let expires = Number(c.expires);
    if (!Number.isFinite(expires) || expires <= 0) expires = -1; // session cookie
    else if (expires > 1e11) expires = Math.round(expires / 1000); // milliseconds -> seconds
    let sameSite = SAMESITE[String(c.sameSite ?? "").toLowerCase()] ?? "Lax";
    const secure = Boolean(c.secure) || sameSite === "None";
    out.push({ name: String(c.name), value: String(c.value ?? ""), domain, path: c.path || "/", expires, httpOnly: Boolean(c.httpOnly), secure, sameSite });
  }
  if (!out.length) throw new Error("No cookies found in what you pasted.");
  return out;
}

// Imports cookies into the team browser and adds any new sites to the Accounts list.
export async function importCookies(text, onlyDomain) {
  let cookies = parseCookies(text, onlyDomain);
  const total = cookies.length;
  if (onlyDomain) cookies = cookies.filter((c) => matchesDomain(c.domain, onlyDomain));
  const { imported, failed } = await browser.addCookies(cookies);
  const domains = [...new Set(cookies.map((c) => baseDomain(c.domain)))];
  const accounts = getAccounts();
  for (const d of domains) {
    if (accounts.some((a) => a.domain === d)) continue;
    accounts.push({ name: d.split(".")[0].replace(/^\w/, (x) => x.toUpperCase()), domain: d, loginUrl: `https://${d}/`, cookie: SESSION_COOKIES[d] ?? null });
  }
  saveAccounts(accounts);
  return { imported, failed, skipped: total - cookies.length, domains };
}

export function normalizeDomain(input) {
  let s = String(input || "").trim().toLowerCase();
  try { if (/^https?:\/\//.test(s)) s = new URL(s).hostname; } catch {}
  return s.replace(/^www\./, "").replace(/\/.*$/, "");
}

function hostOf(url) {
  try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase(); } catch { return ""; }
}

export function ruleFor(url) {
  const host = hostOf(url);
  if (!host) return null;
  return getRules()
    .filter((r) => host === r.domain || host.endsWith(`.${r.domain}`))
    .sort((a, b) => b.domain.length - a.domain.length)[0] ?? null;
}

// --- daily usage, persisted so a restart doesn't reset the count ---
const today = () => new Date().toISOString().slice(0, 10);
function usage() {
  const u = readJson("site_usage", { day: today(), counts: {} });
  return u.day === today() ? u : { day: today(), counts: {} };
}
export const usageToday = () => usage().counts;
const lastAction = new Map(); // domain -> timestamp

function record(domain) {
  const u = usage();
  u.counts[domain] = (u.counts[domain] ?? 0) + 1;
  settings.set("site_usage", JSON.stringify(u));
  lastAction.set(domain, Date.now());
}

export async function accountStatus(account) {
  const cookies = await browser.cookiesFor(account.domain);
  if (cookies === null) return { known: false };
  const marker = account.cookie ?? SESSION_COOKIES[account.domain];
  const signedIn = marker ? cookies.some((c) => c.name === marker) : null;
  return { known: true, signedIn, cookieCount: cookies.length };
}

// Called before every browser action. `sensitive` marks actions that change something on the site.
export async function enforce(ctx, { url, sensitive, describe }) {
  const rule = ruleFor(url);
  if (!rule) return;
  if (rule.access === "blocked") {
    throw new Error(`The owner has blocked team access to ${rule.domain}. Do not try to reach it another way.`);
  }
  const used = usageToday()[rule.domain] ?? 0;
  if (rule.dailyLimit && used >= rule.dailyLimit) {
    throw new Error(`Daily limit reached for ${rule.domain} (${rule.dailyLimit} actions). Stop working on this site and tell the owner.`);
  }
  const wait = (lastAction.get(rule.domain) ?? 0) + (rule.minDelaySec ?? 0) * 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  if (rule.access === "approve" && sensitive) {
    const r = await ctx.requestApproval({
      action: `${describe} on ${rule.domain}`,
      details: `${ctx.agent.name} wants to do this on ${url}.\nThis site's rule requires your OK for clicks on buttons and for submitting.`,
    });
    if (!r.approved) throw new Error(`Owner denied: ${describe}.${r.note ? ` Note: ${r.note}` : ""} Do not retry it.`);
  }
  record(rule.domain);
}
