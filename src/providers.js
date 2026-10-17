// Custom AI providers with an OpenAI-compatible API (Groq, OpenRouter, Together, Fireworks, Ollama…).
// One account and key per provider. Rate limits are respected, never worked around: when a provider
// says "slow down", requests wait for its reset time.
import fs from "node:fs";
import { db, now, uid } from "./db.js";
import { ENV_FILE } from "./paths.js";

export const PRESETS = {
  groq: { name: "Groq", base_url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", key_env: "GROQ_API_KEY" },
  openrouter: { name: "OpenRouter", base_url: "https://openrouter.ai/api/v1", model: "", key_env: "OPENROUTER_API_KEY" },
  together: { name: "Together", base_url: "https://api.together.xyz/v1", model: "", key_env: "TOGETHER_API_KEY" },
  fireworks: { name: "Fireworks", base_url: "https://api.fireworks.ai/inference/v1", model: "", key_env: "FIREWORKS_API_KEY" },
  ollama: { name: "Ollama (local)", base_url: "http://localhost:11434/v1", model: "", key_env: "" },
};

export const providers = {
  list: () => db.prepare("SELECT * FROM providers ORDER BY created_at").all(),
  get: (id) => db.prepare("SELECT * FROM providers WHERE id = ?").get(id),
};

// What the UI may see: never the key itself.
export function publicProvider(p) {
  const key = p.key_env ? process.env[p.key_env] : null;
  return { ...p, key_set: Boolean(key), key_hint: key ? `••••${key.slice(-4)}` : null, needs_key: Boolean(p.key_env) };
}

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,60}$/;
function validate(p) {
  if (!p.name?.trim()) throw new Error("Give the provider a name.");
  let u;
  try { u = new URL(p.base_url); } catch { throw new Error("Base URL must be a full URL, e.g. https://api.groq.com/openai/v1"); }
  const local = ["localhost", "127.0.0.1"].includes(u.hostname);
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("Base URL must use https (http is allowed only for localhost).");
  if (!p.model?.trim()) throw new Error("Choose a model (use Test to list the provider's models).");
  if (p.key_env && !ENV_NAME.test(p.key_env)) throw new Error("Key variable name must look like GROQ_API_KEY.");
}

export function saveProvider(input) {
  const p = {
    id: input.id ?? uid(), name: String(input.name ?? "").trim(), base_url: String(input.base_url ?? "").trim().replace(/\/+$/, ""),
    model: String(input.model ?? "").trim(), key_env: String(input.key_env ?? "").trim().toUpperCase(),
    price_in: input.price_in === "" || input.price_in == null ? null : Number(input.price_in),
    price_out: input.price_out === "" || input.price_out == null ? null : Number(input.price_out),
  };
  validate(p);
  if (input.api_key) {
    if (!p.key_env) throw new Error("Set a key variable name to store the key.");
    setEnvVar(p.key_env, String(input.api_key).trim());
  }
  if (providers.get(p.id)) {
    db.prepare("UPDATE providers SET name=?, base_url=?, model=?, key_env=?, price_in=?, price_out=? WHERE id=?")
      .run(p.name, p.base_url, p.model, p.key_env || null, p.price_in, p.price_out, p.id);
  } else {
    db.prepare("INSERT INTO providers (id, name, base_url, model, key_env, price_in, price_out, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(p.id, p.name, p.base_url, p.model, p.key_env || null, p.price_in, p.price_out, now());
  }
  return providers.get(p.id);
}

export function deleteProvider(id) {
  const inUse = db.prepare("SELECT name FROM agents WHERE model = ? OR fallback_model = ?").all(`provider:${id}`, `provider:${id}`);
  if (inUse.length) throw new Error(`Used by ${inUse.map((a) => a.name).join(", ")}. Switch them to another model first.`);
  db.prepare("DELETE FROM providers WHERE id = ?").run(id);
}

// Keys live only in the local .env file (and this process's memory), never in the database.
function setEnvVar(name, value) {
  if (!ENV_NAME.test(name)) throw new Error("Invalid key variable name");
  if (/[\r\n]/.test(value)) throw new Error("Key must be a single line");
  const file = ENV_FILE;
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const i = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (i >= 0) lines[i] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
  fs.writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"));
  process.env[name] = value;
}

// ---------- Rate limits ----------
// Parses "7.66s", "2m59.56s", "1h2m" style reset values used by Groq/OpenAI-compatible APIs.
function parseDuration(v) {
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  let ms = 0;
  for (const [, n, unit] of String(v).matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) ms += Number(n) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  return ms || null;
}
// Limits are per model on Groq-style APIs, so state is kept per provider + model.
const limitState = new Map(); // "providerId:model" -> { until, info }
const lk = (p) => `${p.id}:${p.model}`;
export const rateInfo = (p) => limitState.get(lk(p))?.info ?? null;

function readLimits(p, res) {
  const h = (k) => res.headers.get(k);
  const info = {
    remaining_requests: h("x-ratelimit-remaining-requests"), limit_requests: h("x-ratelimit-limit-requests"),
    remaining_tokens: h("x-ratelimit-remaining-tokens"), limit_tokens: h("x-ratelimit-limit-tokens"),
    reset_requests: h("x-ratelimit-reset-requests"), reset_tokens: h("x-ratelimit-reset-tokens"), at: now(),
  };
  let until = 0;
  if (info.remaining_requests === "0") until = Math.max(until, now() + (parseDuration(info.reset_requests) ?? 1000));
  if (info.remaining_tokens === "0") until = Math.max(until, now() + (parseDuration(info.reset_tokens) ?? 1000));
  limitState.set(lk(p), { until, info });
}

export class ProviderError extends Error {
  constructor(message, { kind = "fatal", retryAt = null, status = null } = {}) {
    super(message);
    this.kind = kind; this.retryAt = retryAt; this.status = status;
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new ProviderError("Stopped", { kind: "cancelled" })); }, { once: true });
});

const MAX_INLINE_WAIT_MS = 65_000; // short waits happen inside the run; longer ones re-queue the task

/** Calls /chat/completions. Waits for the provider's rate-limit reset (up to ~1 min) instead of failing. */
export async function chatCompletion(p, body, { signal, onWait } = {}) {
  const key = p.key_env ? process.env[p.key_env] : null;
  if (p.key_env && !key) throw new ProviderError(`${p.name}: no API key. Add it under Connections → AI providers.`, { kind: "fatal" });
  for (let attempt = 0; attempt < 4; attempt++) {
    const until = limitState.get(lk(p))?.until ?? 0;
    if (until > now()) {
      const wait = until - now();
      if (wait > MAX_INLINE_WAIT_MS) throw new ProviderError(`${p.name} rate limit: resets in ${Math.ceil(wait / 1000)}s`, { kind: "rate_limited", retryAt: until });
      onWait?.(wait);
      await sleep(wait, signal);
    }
    let res;
    try {
      res = await fetch(`${p.base_url}/chat/completions`, {
        method: "POST", signal,
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: p.model, ...body }),
      });
    } catch (e) {
      if (signal?.aborted) throw new ProviderError("Stopped", { kind: "cancelled" });
      throw new ProviderError(`${p.name} unreachable: ${e.message}`, { kind: "transient" });
    }
    readLimits(p, res);
    if (res.status === 429) {
      const retryAfter = parseDuration(res.headers.get("retry-after")) ?? parseDuration(res.headers.get("x-ratelimit-reset-tokens")) ?? 10_000;
      const at = now() + retryAfter;
      limitState.set(lk(p), { ...(limitState.get(lk(p)) ?? {}), until: at });
      if (retryAfter > MAX_INLINE_WAIT_MS) throw new ProviderError(`${p.name} rate limit: resets in ${Math.ceil(retryAfter / 1000)}s`, { kind: "rate_limited", retryAt: at });
      continue; // the loop waits for the reset, then retries
    }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok) {
      const msg = data?.error?.message ?? text.slice(0, 300);
      const kind = res.status >= 500 ? "transient" : res.status === 401 || res.status === 403 ? "fatal" : "fatal";
      throw new ProviderError(`${p.name} error ${res.status}: ${msg}`, { kind, status: res.status });
    }
    return data;
  }
  throw new ProviderError(`${p.name} kept rate-limiting after several waits`, { kind: "rate_limited", retryAt: limitState.get(lk(p))?.until ?? now() + 60_000 });
}

export async function listModels(p) {
  const key = p.key_env ? process.env[p.key_env] : null;
  const res = await fetch(`${p.base_url}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  readLimits(p, res);
  if (!res.ok) throw new ProviderError(`${p.name} error ${res.status}: ${(await res.text()).slice(0, 200)}`, { status: res.status });
  const data = await res.json();
  return (data.data ?? []).map((m) => m.id).sort();
}

// A real round trip: lists models, then asks the chosen model for a one-word reply.
export async function testProvider(p) {
  const models = await listModels(p);
  const r = await chatCompletion(p, { messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5, temperature: 0 });
  const reply = r.choices?.[0]?.message?.content?.trim() ?? "";
  return { models, reply, model_available: models.includes(p.model), limits: rateInfo(p) };
}

export function costFor(p, usage) {
  if (p.price_in == null || p.price_out == null || !usage) return 0;
  return ((usage.prompt_tokens ?? 0) * p.price_in + (usage.completion_tokens ?? 0) * p.price_out) / 1e6;
}
