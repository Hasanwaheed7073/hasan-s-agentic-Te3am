// Tool and integration health. Only real integrations are listed, and a status only says
// "working" after a real check or a real successful use.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { db, now } from "./db.js";
import { broadcast } from "./hub.js";
import { verifySmtp, smtpConfigured } from "./actions.js";
import * as browser from "./browser.js";
import { getAccounts, accountStatus } from "./sites.js";
import { WORKSPACE_DIR } from "./paths.js";
import { providers as providerRepo, rateInfo } from "./providers.js";

export const STATUS_LABEL = {
  not_configured: "Not configured", untested: "Connected, untested", working: "Working", failed: "Failed or expired",
};

const get = (key) => db.prepare("SELECT * FROM connections WHERE key = ?").get(key);
export function setStatus(key, status, detail = null) {
  const prev = get(key);
  db.prepare(`INSERT INTO connections (key, status, detail, last_tested_at, last_ok_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET status = excluded.status, detail = excluded.detail, last_tested_at = excluded.last_tested_at,
    last_ok_at = coalesce(excluded.last_ok_at, connections.last_ok_at)`)
    .run(key, status, detail, now(), status === "working" ? now() : null);
  if (prev?.status !== status) broadcast({ type: "connections_changed" });
}

// Real model calls report back here, so the engine's status reflects actual use.
export function reportEngineResult(engine, ok, detail) {
  setStatus(engine === "api" ? "anthropic_api" : "claude_code", ok ? "working" : "failed", detail);
}

const SESSION_TESTS = {
  "linkedin.com": { url: "https://www.linkedin.com/feed/", loggedOut: /\/login|authwall|checkpoint|signup/i },
  "google.com": { url: "https://myaccount.google.com/", loggedOut: /accounts\.google\.com\/(v3\/)?signin|ServiceLogin/i },
  "reddit.com": { url: "https://www.reddit.com/settings/", loggedOut: /\/login/i },
};

export async function listConnections(engine) {
  const rows = [];
  const row = (key, name, purpose, base, fallback) => {
    const s = get(key);
    rows.push({ key, name, purpose, status: base ?? s?.status ?? "untested", detail: s?.detail ?? null, last_tested_at: s?.last_tested_at ?? null, last_ok_at: s?.last_ok_at ?? null, fallback, testable: true });
  };
  if (engine === "claude-code") {
    row("claude_code", "Claude (Claude Code login)", "Runs every team member; includes web search and page fetch", null, "None: without it no agent can run.");
  } else {
    row("anthropic_api", "Claude (Anthropic API key)", "Runs every team member", process.env.ANTHROPIC_API_KEY ? null : "not_configured", "Switch ENGINE to claude-code in .env.");
  }
  for (const p of providerRepo.list()) {
    const key = `provider:${p.id}`;
    const s = get(key);
    const keyMissing = p.key_env && !process.env[p.key_env];
    const rl = rateInfo(p);
    rows.push({ key, name: `${p.name} (${p.model})`, purpose: "Custom AI provider for team members set to it",
      status: keyMissing ? "not_configured" : s?.status ?? "untested",
      detail: keyMissing ? `No API key (${p.key_env}). Add it in AI providers below.` : [s?.detail, rl?.remaining_requests != null ? `requests left: ${rl.remaining_requests}/${rl.limit_requests ?? "?"}, tokens left: ${rl.remaining_tokens ?? "?"}/${rl.limit_tokens ?? "?"}` : null].filter(Boolean).join(" · ") || null,
      last_tested_at: s?.last_tested_at ?? null, last_ok_at: s?.last_ok_at ?? null, testable: false, provider_id: p.id,
      fallback: "Members with a fallback model switch to it on the next attempt; otherwise tasks wait for the rate-limit reset." });
  }
  row("browser", "Team browser (Chrome)", "Opening sites, logged-in research", null, "Web search and fetch still work for research.");
  const smtp = get("email_smtp");
  rows.push({ key: "email_smtp", name: "Email sending (SMTP)", purpose: "Sends approved emails",
    status: smtpConfigured() ? smtp?.status ?? "untested" : "not_configured", detail: smtpConfigured() ? smtp?.detail : "Add SMTP_* settings to .env to enable.",
    last_tested_at: smtp?.last_tested_at ?? null, last_ok_at: smtp?.last_ok_at ?? null, testable: smtpConfigured(),
    fallback: "Drafts still get written; approved emails go to your manual-send queue." });
  for (const a of getAccounts()) {
    const key = `session:${a.domain}`;
    const st = await accountStatus(a).catch(() => ({ known: false }));
    const saved = get(key);
    // "Connected" is claimed only when login cookies are actually present (or a real check passed).
    let status = saved?.status ?? (st.known && (st.signedIn === true || (st.signedIn === null && st.cookieCount > 0)) ? "untested" : "not_configured");
    if (st.known && st.signedIn === false) status = "not_configured";
    rows.push({ key, name: `${a.name} session`, purpose: `Logged-in browsing on ${a.domain}`, status,
      detail: st.known ? (st.signedIn === false ? "No login cookie in the team browser." : saved?.detail ?? `${st.cookieCount} cookies stored`) : "Open the team browser to check.",
      last_tested_at: saved?.last_tested_at ?? null, last_ok_at: saved?.last_ok_at ?? null, testable: Boolean(SESSION_TESTS[a.domain]),
      fallback: "Public pages and web search still work. Private messages go to the manual-send queue." });
  }
  rows.push({ key: "manual_send", name: "Manual send queue", purpose: "LinkedIn, Reddit and other private messages or posts after approval",
    status: "working", detail: "Always available: you send approved content yourself and mark it sent.", testable: false, fallback: null });
  return rows;
}

export async function testConnection(key, engine) {
  if (key === "claude_code") {
    try {
      let ok = false; let detail = "";
      for await (const m of query({ prompt: "Reply with exactly: OK", options: { model: "claude-haiku-5-5", tools: [], settingSources: [], permissionMode: "dontAsk", maxTurns: 1, persistSession: false, cwd: WORKSPACE_DIR } })) {
        if (m.type === "result") { ok = m.subtype === "success"; detail = ok ? `Responded (est. $${(m.total_cost_usd ?? 0).toFixed(4)})` : (m.errors ?? []).join("; "); }
      }
      setStatus(key, ok ? "working" : "failed", detail);
    } catch (e) { setStatus(key, "failed", e.message); }
  } else if (key === "browser") {
    try { await browser.openBrowser(); setStatus(key, "working", `${browser.browserStatus().engine} launched`); }
    catch (e) { setStatus(key, "failed", e.message); }
  } else if (key === "email_smtp") {
    const r = await verifySmtp();
    setStatus(key, r.status, r.detail);
  } else if (key.startsWith("session:")) {
    const domain = key.slice(8);
    const test = SESSION_TESTS[domain];
    if (!test) throw new Error("No automatic test for this site.");
    try {
      const url = await browser.probeUrl(test.url);
      const ok = !test.loggedOut.test(url);
      setStatus(key, ok ? "working" : "failed", ok ? `Signed in (opened ${new URL(url).pathname})` : "Redirected to login: session missing or expired. Re-import cookies.");
    } catch (e) { setStatus(key, "failed", e.message); }
  } else if (key === "anthropic_api") {
    setStatus(key, process.env.ANTHROPIC_API_KEY ? "untested" : "not_configured", "Tested on first use.");
  }
  return get(key);
}
