// Shared helpers and state for the app's pages.
export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const api = async (path, opts = {}) => {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};
export const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export const state = {
  meta: null,
  agents: [],
  inbox: [],
  view: { name: "messages" }, // messages | home | notifications | profile | tasks | schedules | memory | browser | settings
  thread: null,
  busyThreads: new Set(),
  busyAgents: new Map(), // agentId -> number of running turns (chat or task)
  approvals: new Map(),
  pendingCount: 0,
  unread: new Set(store.get("unread", [])),
  liked: new Set(store.get("liked", [])),
  live: null,
  ws: null,
};
export const agentById = (id) => state.agents.find((a) => a.id === id);
export const saveUnread = () => store.set("unread", [...state.unread]);
export const isBusy = (agentId) => (state.busyAgents.get(agentId) ?? 0) > 0 || state.inbox.some((r) => r.agentId === agentId && r.running);

export function ago(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 604800) return `${Math.round(s / 86400)}d`;
  return `${Math.round(s / 604800)}w`;
}

// ---------- Icons (outline, Instagram-like weight) ----------
export const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  send: '<path d="M22 3 9.2 10.8"/><path d="M22 3 15 21l-3.8-8.2L3 9z"/>',
  heart: '<path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.4 4.5 7 4.5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.6 0 5.6 3.5 4.3 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/>',
  plus: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 8v8M8 12h8"/>',
  tasks: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bookmark: '<path d="M6 3h12v18l-6-4.5L6 21z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.8 3.8 5.8 3.8 9s-1.3 6.2-3.8 9c-2.5-2.8-3.8-5.8-3.8-9S9.5 5.8 12 3z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  chat: '<path d="M20.5 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20l1.2-4.6A8.5 8.5 0 1 1 20.5 11.5z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  flow: '<rect x="3" y="4" width="6" height="5" rx="1.5"/><rect x="15" y="4" width="6" height="5" rx="1.5"/><rect x="9" y="15" width="6" height="5" rx="1.5"/><path d="M6 9v2.5h12V9M12 11.5V15"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.6.8 2.7 2.5 3 5.2"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  plug: '<path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0z"/><path d="M12 17v4"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
};
export const icon = (name) => `<svg class="i" viewBox="0 0 24 24">${ICONS[name]}</svg>`;

// ---------- Safe Markdown (escape first, then format) ----------
export function md(src) {
  const blocks = [];
  let s = esc(src).replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${code}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const inline = (t) =>
    t
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  const out = [];
  const lines = s.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\u0000\d+\u0000$/.test(line.trim())) { out.push(line.trim()); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { out.push(`<h3>${inline(h[2])}</h3>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const row = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      let html = `<table><tr>${row(line).map((c) => `<th>${c}</th>`).join("")}</tr>`;
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        html += `<tr>${row(lines[i]).map((c) => `<td>${c}</td>`).join("")}</tr>`;
        i++;
      }
      i--;
      out.push(html + "</table>");
      continue;
    }
    const li = line.match(/^\s*([-*]|\d+\.)\s+(.*)/);
    if (li) {
      const tag = /\d/.test(li[1]) ? "ol" : "ul";
      let html = `<${tag}>`;
      while (i < lines.length && lines[i].match(/^\s*([-*]|\d+\.)\s+(.*)/)) {
        html += `<li>${inline(lines[i].match(/^\s*([-*]|\d+\.)\s+(.*)/)[2])}</li>`;
        i++;
      }
      i--;
      out.push(html + `</${tag}>`);
      continue;
    }
    out.push(line.trim() ? `<p>${inline(line)}</p>` : "");
  }
  return out.join("").replace(/\u0000(\d+)\u0000/g, (_, n) => blocks[n]);
}

// ---------- Avatars ----------
export function avatar(agent, size = "") {
  return `<span class="av ${size}" style="background:${esc(agent?.color ?? "#888")}2e">${esc(agent?.emoji ?? "🤖")}</span>`;
}
// Story ring: spins while working, colored when there's an unread reply, grey otherwise.
export function ringed(agent, size = "md") {
  const cls = isBusy(agent.id) ? "busy" : state.unread.has(agent.id) ? "unread" : "seen";
  return `<span class="ring ${cls}"><span class="gap">${avatar(agent, size)}</span></span>`;
}

// Accepts a thread's frozen config ({ model: "claude-…", advisor }) or an agent ({ model: "haiku", advisor: "opus" }).
export function modelLabel(c) {
  if (c?.engine === "openai") return c.model; // e.g. "Groq:llama-3.3-70b-versatile"
  if (typeof c?.model === "string" && c.model.startsWith("provider:")) return state.meta.models[c.model] ?? "Custom provider";
  const name = (m) => (m ? m.replace("claude-", "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/^\w/, (x) => x.toUpperCase()) : "");
  const worker = c?.model?.startsWith("claude-") ? name(c.model) : (state.meta.models[c?.model] ?? "").split(" ·")[0];
  const adv = c?.advisor?.startsWith?.("claude-") ? name(c.advisor) : c?.advisor && c.advisor !== "none" ? (state.meta.advisors[c.advisor] ?? "").split(" advisor")[0] : "";
  return adv && adv !== worker ? `${worker} + ${adv} advisor` : worker;
}

// Navigation callbacks, filled in by app.js (avoids a circular import).
export const nav = { go: () => {}, openThread: () => {}, openAgentChat: () => {}, openTask: () => {}, openAgentDialog: () => {} };

export const STATE_LABEL = {
  draft: "Draft", queued: "Queued", running: "Running", waiting_input: "Waiting for input",
  waiting_approval: "Waiting for approval", completed: "Completed", failed: "Failed", cancelled: "Cancelled",
};
export const statePill = (s, extra = "") => `<span class="state st-${esc(s)}">${esc(STATE_LABEL[s] ?? s)}${extra}</span>`;
export const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
export const fmtDur = (ms) => (ms == null ? "—" : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
export const money = (v) => (v == null ? "—" : `$${Number(v).toFixed(v > 0 && v < 0.1 ? 4 : 2)}`);
export const agentName = (id) => (id === "owner" ? "You" : id === "schedule" ? "Schedule" : id === "system" ? "System" : agentById(id)?.name ?? (id === "*" ? "Any member" : id ?? "—"));
export async function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast mini ${kind}`;
  el.textContent = msg;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "err" ? 7000 : 3500);
}
