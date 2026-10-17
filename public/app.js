import {
  $, esc, api, store, state, agentById, saveUnread, isBusy, ago, icon, md, avatar, ringed, modelLabel, nav, toast,
} from "./core.js";
import * as pages from "./pages.js";
import { renderCampaign } from "./campaign.js";
import { renderClients, renderClient } from "./clients.js";

// ---------- Rail ----------
const NAV = [
  ["home", "home", "Home"],
  ["messages", "send", "Messages"],
  ["activity", "pulse", "Activity"],
  ["campaign", "target", "Campaign"],
  ["clients", "bookmark", "Clients"],
  ["tasks", "tasks", "Tasks"],
  ["workflows", "flow", "Workflows"],
  ["prospects", "users", "Prospects"],
  ["notifications", "heart", "Notifications"],
  ["schedules", "clock", "Schedules", "desk"],
  ["permissions", "shield", "Permissions", "desk"],
  ["connections", "plug", "Connections", "desk"],
  ["browser", "globe", "Browser & accounts", "desk"],
  ["create", "plus", "New member", "desk"],
];
const ACTIVE_FOR = { task: "tasks", wfrun: "workflows", prospect: "prospects", client: "clients", profile: "messages", memory: "settings" };
function renderRail() {
  const badge = { messages: state.unread.size, notifications: state.pendingCount ?? 0 };
  const active = ACTIVE_FOR[state.view.name] ?? state.view.name;
  $("#rail").innerHTML = `
    <div class="wordmark">HASAN's TEAM</div>
    ${NAV.map(([key, ic, label, cls]) => `
      <button class="nav-item ${active === key ? "active" : ""} ${cls ?? ""}" data-nav="${key}" title="${label}">
        ${icon(ic)}<span class="lbl">${label}</span>${badge[key] ? `<span class="dot-badge">${badge[key]}</span>` : ""}
      </button>`).join("")}
    <div class="nav-spacer"></div>
    <button class="nav-item desk ${active === "settings" ? "active" : ""}" data-nav="settings" title="Settings">${icon("menu")}<span class="lbl">Settings</span></button>
    <div id="conn" class="conn ${state.ws?.readyState === 1 ? "ok" : ""}">${state.ws?.readyState === 1 ? "Connected" : "Connecting…"}</div>`;
}
$("#rail").addEventListener("click", (e) => {
  const b = e.target.closest("[data-nav]");
  if (!b) return;
  if (b.dataset.nav === "create") return openAgentDialog(null);
  go({ name: b.dataset.nav });
});

const ROUTES = {
  messages: () => renderMessagesView(),
  home: () => renderHome(),
  profile: (v) => renderProfile(v.agentId),
  campaign: (v) => renderCampaign(v.id),
  clients: () => renderClients(),
  client: (v) => renderClient(v.id),
  tasks: () => pages.renderTasks(),
  task: (v) => pages.renderTask(v.id),
  workflows: () => pages.renderWorkflows(),
  wfrun: (v) => pages.renderWorkflowRun(v.id),
  prospects: () => pages.renderProspects(),
  prospect: (v) => pages.renderProspect(v.id),
  notifications: () => pages.renderApprovals(),
  activity: () => pages.renderActivity(),
  permissions: () => pages.renderPermissions(),
  connections: () => pages.renderConnections(),
  schedules: () => pages.renderSchedules(),
  settings: () => pages.renderSettings(),
};
function go(view) {
  state.view = view;
  state.live = null;
  clearInterval(previewTimer);
  renderRail();
  const route = ROUTES[view.name];
  return route ? route(view) : openPage(view.name);
}
// Re-renders the current page after server-side changes, at most a few times per second.
let rerenderTimer = null;
function rerenderSoon(names) {
  if (!names.includes(state.view.name)) return;
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => {
    const focused = document.activeElement;
    if (focused && /INPUT|TEXTAREA|SELECT/.test(focused.tagName) && $("#main").contains(focused)) return; // don't wipe typing
    if (document.querySelector("#main details[open].create")) return; // or a half-filled form
    go(state.view);
  }, 400);
}

// ---------- Stories row ----------
function storiesHtml() {
  return `<div class="stories">
    ${state.agents.map((a) => `<button class="story" data-chat="${a.id}" title="${esc(a.role)}">${ringed(a)}<span class="name">${esc(a.name)}</span></button>`).join("")}
    <button class="story" data-create="1"><span class="add">+</span><span class="name">New</span></button>
  </div>`;
}
document.addEventListener("click", (e) => {
  const s = e.target.closest("[data-chat]");
  if (s) return openAgentChat(s.dataset.chat);
  if (e.target.closest("[data-create]")) return openAgentDialog(null);
  const p = e.target.closest("[data-profile]");
  if (p) return go({ name: "profile", agentId: p.dataset.profile });
  const t = e.target.closest("[data-open-thread]");
  if (t) return openThread(t.dataset.openThread);
  const ot = e.target.closest("[data-open-task]");
  if (ot) return go({ name: "task", id: ot.dataset.openTask });
});

// ---------- Messages view ----------
async function refreshInbox() {
  state.inbox = await api("/inbox");
  for (const r of state.inbox) if (r.running) state.busyThreads.add(r.threadId);
  if ($("#inbox")) renderInbox();
  renderRail();
}

function renderMessagesView() {
  $("#main").innerHTML = `<div class="dm ${state.view.threadId ? "has-chat" : ""}"><aside id="inbox"></aside><section id="chat"></section></div>`;
  renderInbox();
  if (state.view.threadId && state.thread) renderChat();
  else $("#chat").innerHTML = `<div class="empty-chat"><div><div class="big">${icon("send")}</div>
    <h3>Your team</h3><div>Send a message to any team member to get work done.</div>
    <div style="margin-top:16px"><button class="btn-blue" data-chat="${state.agents[0]?.id ?? ""}">Send message</button></div></div></div>`;
}

function renderInbox() {
  const rows = [...state.inbox].sort((a, b) => b.updated_at - a.updated_at);
  $("#inbox").innerHTML = `
    <div class="inbox-head"><h2>HASAN's TEAM</h2><button class="icon-btn" data-create="1" title="New team member">${icon("edit")}</button></div>
    ${storiesHtml()}
    <div class="inbox-tabs"><span class="on">Messages</span><span>${state.agents.length} members</span></div>
    <div class="threads">${rows.map((r) => {
      const a = agentById(r.agentId);
      if (!a) return "";
      const busy = isBusy(a.id);
      const unread = state.unread.has(a.id);
      const preview = busy ? "Working…" : r.text ? `${r.from === "you" ? "You: " : ""}${r.text}` : a.role;
      return `<button class="thread-row ${state.view.agentId === a.id && !state.view.isTask ? "active" : ""} ${unread ? "unread" : ""}" data-chat="${a.id}">
        ${ringed(a)}
        <span class="meta"><div class="who">${esc(a.name)}</div><div class="preview">${esc(preview)}${r.text && !busy ? ` · ${ago(r.updated_at)}` : ""}</div></span>
        ${unread ? '<span class="blue-dot"></span>' : ""}
      </button>`;
    }).join("")}</div>`;
}

async function openAgentChat(agentId) {
  const thread = await api(`/agents/${agentId}/thread`);
  showThread(thread, false);
}
async function openThread(threadId) {
  const thread = await api(`/threads/${threadId}`);
  showThread(thread, thread.kind === "task");
}

function showThread(thread, isTask) {
  state.thread = thread;
  if (thread.running) state.busyThreads.add(thread.id);
  if (!isTask) { state.unread.delete(thread.agent_id); saveUnread(); }
  state.view = { name: "messages", agentId: thread.agent_id, threadId: thread.id, isTask };
  state.live = null;
  renderRail();
  if (!$("#inbox")) renderMessagesView();
  else { $(".dm").classList.add("has-chat"); renderInbox(); renderChat(); }
}

function renderChat() {
  const thread = state.thread;
  const agent = agentById(thread.agent_id);
  const running = state.busyThreads.has(thread.id);
  const isTask = state.view.isTask;
  $("#chat").innerHTML = `
    <div class="chat-head">
      <button class="icon-btn back-btn" id="back">${icon("back")}</button>
      <button data-profile="${agent.id}">${ringed(agent, "")}</button>
      <div class="t"><b>${esc(agent.name)}</b><small id="presence">${running ? "Working…" : isTask ? `Task · ${esc(thread.title ?? "")}` : `${esc(agent.role)} · ${esc(modelLabel(thread.config ?? agent))}`}</small></div>
      <div class="actions">
        <button class="pill-btn stop" id="stop-btn" ${running ? "" : "hidden"}>Stop</button>
        ${isTask ? `<button class="pill-btn" data-chat="${agent.id}">Back to chat</button>` : `<button class="pill-btn" id="new-chat" title="Start a fresh conversation">New chat</button>`}
        <button class="icon-btn" data-profile="${agent.id}" title="Profile">${icon("info")}</button>
      </div>
    </div>
    <div id="log"><div class="log-inner"></div></div>
    ${isTask ? `<div class="composer task-note">This is a task run log. Use Run, Retry or Cancel on the task page. <button class="link-btn blue" id="to-task">Open tasks</button></div>` : ""}
    <div class="composer" ${isTask ? "hidden" : ""}><form id="composer">
      <textarea id="input" rows="1" placeholder="Message…"></textarea>
      <button class="send" type="submit" disabled>Send</button>
    </form></div>`;
  renderMessages();
  if (running) startLive();

  $("#back").onclick = () => { state.view = { name: "messages" }; renderMessagesView(); };
  $("#to-task")?.addEventListener("click", () => go({ name: "tasks" }));
  $("#stop-btn").onclick = () => api(`/threads/${thread.id}/stop`, { method: "POST" });
  if ($("#new-chat")) $("#new-chat").onclick = async () => {
    if (!confirm(`Start a new chat with ${agent.name}? The old one stays saved, but they won't see it in the new chat.`)) return;
    showThread(await api(`/agents/${agent.id}/new-chat`, { method: "POST" }), false);
  };
  const input = $("#input");
  const send = $(".composer .send");
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = input.scrollHeight + "px";
    send.disabled = !input.value.trim();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#composer").requestSubmit(); }
  });
  $("#composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    // Show the bubble first: the server announces the reply (typing dots) before this request returns.
    const bubble = appendMine(text);
    input.value = "";
    input.style.height = "auto";
    send.disabled = true;
    try {
      await api(`/threads/${thread.id}/messages`, { method: "POST", body: { text } });
    } catch (err) {
      bubble.remove();
      input.value = text;
      send.disabled = false;
      alert(err.message);
    }
  });
  input.focus();
}

const SUGGESTIONS = {
  "Chief of Staff": ["Plan my week: what should the team work on?", "Get Sage to audit our website for SEO", "What's on the task board?"],
  "SEO Specialist": ["Find 20 keywords for 'become a clinical research coordinator'", "Audit our homepage for SEO issues", "Who ranks for 'CRA training' and why?"],
  "Marketing Lead": ["Draft 5 LinkedIn posts for the CRCM program", "Write a 3-email nurture sequence for webinar sign-ups", "What are competitors saying in their ads?"],
  "Job Sourcing": ["Find 15 remote entry-level CRC/CTA roles posted this week", "Shortlist CRA I roles in Texas for client-A", "Which CROs are hiring the most right now?"],
};

function introHtml(agent) {
  const sug = SUGGESTIONS[agent.role] ?? ["What can you do for me?"];
  return `<div class="intro">${ringed(agent, "xl")}<b>${esc(agent.name)}</b><small>${esc(agent.role)} · HASAN's TEAM</small>
    <button class="pill-btn" data-profile="${agent.id}">View profile</button>
    <div class="chips">${sug.map((s) => `<button data-suggest="${esc(s)}">${esc(s)}</button>`).join("")}</div></div>`;
}

function renderMessages() {
  const log = $(".log-inner");
  const agent = agentById(state.thread.agent_id);
  const msgs = state.thread.messages;
  // Client tool results live in user messages; server tool results (web, advisor) in assistant ones.
  const results = new Map();
  for (const m of msgs) if (Array.isArray(m.content))
    for (const b of m.content) if (b.tool_use_id) results.set(b.tool_use_id, b);

  let html = introHtml(agent);
  let group = null; // open "them" group
  const close = () => { if (group) { html += `${group}</div></div>`; group = null; } };
  for (const m of msgs) {
    if (m.role === "user") {
      const text = typeof m.content === "string"
        ? m.content
        : m.content.filter((b) => b.type === "text" && !b.text.startsWith("[Context]")).map((b) => b.text).join("\n");
      if (!text) continue;
      close();
      const fromAgent = /^(Task from |Scheduled job:)/.test(text);
      html += `<div class="row-me"><div class="stack"><div class="bubble ${fromAgent ? "task" : ""}">${esc(text)}</div></div></div>`;
      continue;
    }
    const body = m.content.map((b) => renderBlock(b, results)).join("");
    if (!body) continue;
    if (!group) group = `<div class="row-them"><span class="av-slot">${avatar(agent, "sm")}</span><div class="stack">`;
    group += body;
  }
  close();
  log.innerHTML = html;
  log.querySelectorAll("[data-suggest]").forEach((b) => (b.onclick = () => {
    $("#input").value = b.dataset.suggest;
    $("#input").dispatchEvent(new Event("input"));
    $("#input").focus();
  }));
  scrollDown(true);
}

function renderBlock(b, results) {
  switch (b.type) {
    case "text":
      return b.text.trim() ? `<div class="bubble">${md(b.text)}</div>` : "";
    case "thinking":
      return b.thinking?.trim() ? `<details class="act think"><summary>💭 <span class="sum">Thinking</span></summary><div class="body">${esc(b.thinking)}</div></details>` : "";
    case "tool_use":
    case "server_tool_use":
      return toolCard(b.id, b.name, b.input, results.get(b.id));
    case "web_search_tool_result": {
      const list = Array.isArray(b.content) ? b.content : [];
      if (!list.length) return "";
      return `<div class="sources">${list.slice(0, 5).map((r) => `<a href="${esc(/^https?:\/\//i.test(r.url ?? "") ? r.url : "#")}" target="_blank" rel="noopener noreferrer">${esc(r.title || r.url)}</a>`).join("")}</div>`;
    }
    case "compaction":
      return `<div class="note">Earlier conversation was summarized to save space.</div>`;
    default:
      return "";
  }
}

const TOOL_LABELS = {
  web_search: "🔍", web_fetch: "🌐", WebSearch: "🔍", WebFetch: "🌐", browser_navigate: "🧭", browser_click: "👆",
  browser_type: "⌨️", browser_snapshot: "👀", browser_screenshot: "📸", browser_scroll: "↕️", browser_back: "↩️",
  browser_select: "🔽", browser_press_key: "⌨️", write_file: "💾", read_file: "📄", list_files: "📁",
  delegate_task: "🤝", request_approval: "✋", remember: "💡", forget: "🗑️", create_task: "📋", update_task: "📋",
  list_tasks: "📋", create_schedule: "⏰", list_schedules: "⏰", delete_schedule: "⏰", advisor: "🧠",
};
const FRIENDLY = {
  browser_navigate: "Opened", browser_click: "Clicked", browser_type: "Typed", browser_snapshot: "Read page",
  browser_screenshot: "Screenshot", browser_scroll: "Scrolled", browser_back: "Back", write_file: "Saved",
  read_file: "Read", list_files: "Files", delegate_task: "Asked", request_approval: "Asked you",
  remember: "Remembered", create_task: "New task", update_task: "Task updated", advisor: "Asked advisor",
  web_search: "Searched", WebSearch: "Searched", web_fetch: "Read", WebFetch: "Read", create_schedule: "Scheduled",
};
function toolSummary(name, input) {
  if (!input) return "";
  return input.query || input.url || input.path || input.member || input.action || input.title || input.fact ||
    input.question || (input.ref != null ? `#${input.ref}` : "") || "";
}
function toolCard(id, name, input, result) {
  if (result && result.type !== "tool_result") {
    // Server tool result: web results show as sources; advisor advice is encrypted and only the model reads it.
    const failed = String(result.content?.type ?? "").endsWith("_error");
    result = { is_error: failed, content: failed ? `Failed: ${result.content.error_code}` : name === "advisor" ? "Advice received." : "" };
  }
  const st = result ? (result.is_error ? "err" : "ok") : "";
  let resultHtml = "";
  if (result && result.content !== "") {
    const content = result.content;
    if (Array.isArray(content)) {
      resultHtml = content.map((c) => c.type === "image"
        ? `<img src="data:${esc(c.source?.media_type ?? c.mimeType)};base64,${esc(c.source?.data ?? c.data)}" alt="screenshot" />`
        : `<pre>${esc(c.text ?? "")}</pre>`).join("");
    } else {
      resultHtml = `<pre>${esc(String(content ?? "").slice(0, 4000))}</pre>`;
    }
  }
  const label = FRIENDLY[name] ?? name;
  return `<details class="act ${st}" data-tool="${esc(id)}">
    <summary>${esc(TOOL_LABELS[name] ?? "🔧")} <span class="sum">${esc(label)} ${esc(String(toolSummary(name, input)).slice(0, 70))}</span>
      <span class="state">${result ? (result.is_error ? "failed" : "✓") : '<span class="spin"></span>'}</span></summary>
    <div class="body">${input && Object.keys(input).length ? `<pre>${esc(JSON.stringify(input, null, 2))}</pre>` : ""}<div class="res">${resultHtml}</div></div>
  </details>`;
}

function appendMine(text) {
  const log = $(".log-inner");
  log.insertAdjacentHTML("beforeend", `<div class="row-me"><div class="stack"><div class="bubble">${esc(text)}</div></div></div>`);
  scrollDown(true);
  return log.lastElementChild;
}

function scrollDown(force) {
  const el = $("#log");
  if (!el) return;
  if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
}

// ---------- Live streaming ----------
function startLive() {
  const log = $(".log-inner");
  if (!log || state.live) return;
  const agent = agentById(state.thread.agent_id);
  log.insertAdjacentHTML("beforeend", `<div class="row-them live"><span class="av-slot">${avatar(agent, "sm")}</span>
    <div class="stack"><div class="typing"><i></i><i></i><i></i></div></div></div>`);
  const stack = log.querySelector(".row-them.live .stack");
  state.live = { stack, typing: stack.querySelector(".typing"), current: null, textBuf: "" };
  scrollDown(true);
}

function liveEvent(e) {
  const L = state.live;
  if (!L) return;
  const before = (html) => L.typing.insertAdjacentHTML("beforebegin", html);
  if (e.type === "text_start") {
    before(`<div class="bubble"></div>`);
    L.current = L.typing.previousElementSibling;
    L.textBuf = "";
  } else if (e.type === "text_delta" && L.current?.classList.contains("bubble")) {
    L.textBuf += e.text;
    L.current.innerHTML = md(L.textBuf);
  } else if (e.type === "thinking_start") {
    before(`<details class="act think"><summary>💭 <span class="sum">Thinking…</span></summary><div class="body"></div></details>`);
    L.current = L.typing.previousElementSibling;
  } else if (e.type === "thinking_delta" && L.current?.classList.contains("think")) {
    L.current.querySelector(".body").textContent += e.text;
  } else if (e.type === "tool_start") {
    before(toolCard(e.id, e.name, null, null));
    L.current = null;
  } else if (e.type === "tool_input") {
    const card = L.stack.querySelector(`[data-tool="${CSS.escape(e.id)}"]`);
    if (card) {
      card.querySelector(".sum").textContent = `${FRIENDLY[e.name] ?? e.name} ${String(toolSummary(e.name, e.input)).slice(0, 70)}`;
      card.querySelector(".body").insertAdjacentHTML("afterbegin", `<pre>${esc(JSON.stringify(e.input, null, 2))}</pre>`);
    }
  } else if (e.type === "tool_result") {
    const card = L.stack.querySelector(`[data-tool="${CSS.escape(e.id)}"]`);
    if (card) {
      card.classList.add(e.isError ? "err" : "ok");
      card.querySelector(".state").textContent = e.isError ? "failed" : "✓";
      if (e.preview) card.querySelector(".res").innerHTML = `<pre>${esc(e.preview)}</pre>`;
    }
  } else if (e.type === "error") {
    before(`<div class="error-note">⚠ ${esc(e.message)}</div>`);
  }
  scrollDown(false);
}

// ---------- Home feed: finished work as posts ----------
async function renderHome() {
  const tasks = await api("/tasks");
  const posts = tasks.filter((t) => t.output?.summary || t.status === "running");
  $("#main").innerHTML = `<div class="page"><div class="page-inner narrow">
    ${storiesHtml()}
    <div style="height:12px"></div>
    ${posts.length ? posts.map((t) => {
      const a = agentById(t.agent_id);
      const liked = state.liked.has(t.id);
      const status = t.status === "completed" ? (t.output?.status === "no_results" ? '<span class="pill muted">0 results</span>' : "") : t.status === "failed" ? '<span class="pill bad">Failed</span>' : '<span class="pill warn">Running</span>';
      return `<article class="post">
        <div class="post-head">${a ? `<button data-profile="${a.id}">${ringed(a, "sm")}</button>` : ""}
          <b>${esc(a?.name ?? "Team")}</b><span class="sub">• ${ago(t.updated_at)}</span><span class="grow"></span>${status}</div>
        <div class="post-media"><div class="ttl">${esc(t.title)}</div><div class="txt">${esc((t.output?.summary || t.description || "").slice(0, 900))}</div></div>
        <div class="post-actions">
          <button class="${liked ? "liked" : ""}" data-like="${t.id}" title="Like">${icon("heart")}</button>
          <button data-open-task="${t.id}" title="Open the task">${icon("chat")}</button>
          ${a ? `<button data-chat="${a.id}" title="Message ${esc(a.name)}">${icon("send")}</button>` : ""}
          <span class="grow"></span>
        </div>
        <div class="post-caption"><b>${esc(a?.name ?? "")}</b>${esc(a?.role ?? "")}</div>
      </article>`;
    }).join("") : `<div class="empty-chat" style="padding:60px 0"><div><div class="big">${icon("home")}</div><h3>No posts yet</h3>
      <div>Finished tasks from your team show up here.<br />Create a task or run a workflow to get started.</div></div></div>`}
  </div></div>`;
  $(".page-inner").addEventListener("click", async (e) => {
    const like = e.target.closest("[data-like]");
    if (like) {
      const id = like.dataset.like;
      state.liked.has(id) ? state.liked.delete(id) : state.liked.add(id);
      store.set("liked", [...state.liked]);
      like.classList.toggle("liked");
    }
  });
}

// ---------- Approvals (persisted on the server) ----------
const seenApprovals = new Set();
async function refreshApprovals({ toastNew = true } = {}) {
  const [pending, actions] = await Promise.all([api("/approvals?status=pending"), api("/actions?status=ready_for_manual_send")]);
  state.pendingCount = pending.length + actions.length;
  renderRail();
  for (const a of pending) {
    if (seenApprovals.has(a.id)) continue;
    seenApprovals.add(a.id);
    if (toastNew) showApprovalToast(a);
  }
  for (const el of document.querySelectorAll("#toasts .toast[data-approval]")) {
    if (!pending.some((p) => p.id === el.dataset.approval)) el.remove();
  }
}
function showApprovalToast(ap) {
  const a = agentById(ap.agent_id);
  const what = ap.kind === "action" ? `To: ${ap.details.destination}\n\n${ap.details.content}` : ap.details.text ?? "";
  $("#toasts").insertAdjacentHTML("beforeend", `
    <div class="toast" data-approval="${esc(ap.id)}">
      <div class="top">${a ? ringed(a, "sm") : ""}<div><b>${esc(a?.name ?? "A team member")}</b> needs your OK<div class="sub">${esc(ap.summary)}</div></div></div>
      ${what ? `<div class="what">${esc(what)}</div>` : ""}
      <input placeholder="Optional note…" />
      <div class="btns"><button class="btn-blue ok">Approve</button><button class="btn-grey no">Deny</button><button class="btn-grey view">All</button></div>
    </div>`);
  const el = $(`#toasts [data-approval="${CSS.escape(ap.id)}"]`);
  const decide = async (approved) => {
    try { await api(`/approvals/${ap.id}/decide`, { method: "POST", body: { approved, note: el.querySelector("input").value } }); toast(approved ? "Approved" : "Denied"); }
    catch (err) { toast(err.message, "err"); }
    el.remove();
    refreshApprovals({ toastNew: false });
  };
  el.querySelector(".ok").onclick = () => decide(true);
  el.querySelector(".no").onclick = () => decide(false);
  el.querySelector(".view").onclick = () => { el.remove(); go({ name: "notifications" }); };
}

// ---------- Profile ----------
async function renderProfile(agentId) {
  const a = agentById(agentId);
  if (!a) return go({ name: "messages" });
  const [tasks, schedRes] = await Promise.all([api("/tasks"), api("/schedules")]);
  const scheds = schedRes.schedules;
  const mine = tasks.filter((t) => t.agent_id === a.id);
  const done = mine.filter((t) => t.status === "completed").length;
  const tools = a.tools.map((t) => state.meta.toolGroups[t]).filter(Boolean);
  const bio = a.instructions.length > 220 ? `${esc(a.instructions.slice(0, 220))}… <button class="more" id="bio-more">more</button>` : esc(a.instructions);
  $("#main").innerHTML = `<div class="page"><div class="page-inner">
    <div class="profile-top">
      ${ringed(a, "xl")}
      <div class="info">
        <div class="name-row"><h2>${esc(a.name)}</h2>
          <button class="btn-grey" id="edit-profile">Edit profile</button>
          <button class="btn-blue" data-chat="${a.id}">Message</button></div>
        <div class="stats"><span><b>${mine.length}</b> tasks</span><span><b>${done}</b> done</span><span><b>${scheds.filter((s) => s.agent_id === a.id).length}</b> schedules</span></div>
        <div class="bio"><span class="role">${esc(a.role)}</span>${a.bio ? `<div>${esc(a.bio)}</div>` : ""}<span id="bio-text">${bio}</span></div>
        <div class="sub">${esc(modelLabel(a))} · ${tools.length} tools · effort ${esc(a.effort)} · permissions: ${esc(a.permissions.join(", "))}</div>
        <div class="sub">ID <code>${esc(a.id)}</code></div>
      </div>
    </div>
    <div class="tabs"><span>▦ Work</span></div>
    ${mine.length ? `<div class="tiles">${mine.map((t) => `
      <button class="tile" data-open-task="${t.id}" style="background:linear-gradient(160deg, ${esc(a.color)}33, transparent 70%), var(--code)">
        <span class="badge-st">${t.status === "completed" ? "✅" : t.status === "failed" ? "❌" : t.status === "cancelled" ? "🚫" : "⏳"}</span>
        <b>${esc(t.title)}</b><span class="sub">${ago(t.updated_at)}</span>
      </button>`).join("")}</div>`
      : `<div class="empty-chat" style="padding:60px 0"><div><div class="big">${icon("tasks")}</div><h3>No work yet</h3><div>Tasks ${esc(a.name)} works on show up here.</div></div></div>`}
  </div></div>`;
  $("#edit-profile").onclick = () => openAgentDialog(a);
  if ($("#bio-more")) $("#bio-more").onclick = () => ($("#bio-text").textContent = a.instructions);
}

// ---------- Socket ----------
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => { renderRail(); refreshInbox(); };
  ws.onclose = () => { renderRail(); setTimeout(connect, 1500); };
  ws.onmessage = (m) => handleEvent(JSON.parse(m.data));
}

let lastError = null;
async function handleEvent(e) {
  if (e.type === "turn_start") {
    state.busyThreads.add(e.threadId);
    state.busyAgents.set(e.agentId, (state.busyAgents.get(e.agentId) ?? 0) + 1);
  }
  if (e.type === "turn_end") {
    state.busyThreads.delete(e.threadId);
    state.busyAgents.set(e.agentId, Math.max(0, (state.busyAgents.get(e.agentId) ?? 1) - 1));
    const viewing = state.view.name === "messages" && state.view.threadId === e.threadId;
    const isMain = state.inbox.find((r) => r.threadId === e.threadId);
    if (isMain && !viewing) { state.unread.add(e.agentId); saveUnread(); }
  }
  if (e.type === "turn_start" || e.type === "turn_end") refreshInbox();

  if (e.type === "approvals_changed" || e.type === "actions_changed") { refreshApprovals(); rerenderSoon(["notifications", "task", "prospect", "campaign"]); return; }
  if (e.type === "activity") { pages.pushActivity(e.item); return; }
  if (e.type === "agents_changed") { state.agents = await api("/agents"); return refreshInbox(); }
  if (e.type === "tasks_changed") { rerenderSoon(["tasks", "task", "home", "wfrun", "profile", "campaign", "client"]); return; }
  if (e.type === "workflows_changed") { rerenderSoon(["workflows", "wfrun", "campaign"]); return; }
  if (e.type === "campaigns_changed") { rerenderSoon(["campaign"]); return; }
  if (e.type === "jobs_changed") { rerenderSoon(["clients", "client"]); return; }
  if (e.type === "schedules_changed") { rerenderSoon(["schedules"]); return; }
  if (e.type === "grants_changed") { rerenderSoon(["permissions"]); return; }
  if (e.type === "connections_changed") { rerenderSoon(["connections"]); return; }

  const open = state.view.name === "messages" && state.view.threadId === e.threadId && $("#log");
  if (!open) return;
  if (e.type === "turn_start") {
    $("#stop-btn")?.removeAttribute("hidden");
    if ($("#presence")) $("#presence").textContent = "Working…";
    startLive();
  } else if (e.type === "turn_end") {
    const keepError = lastError;
    state.live = null;
    state.thread = await api(`/threads/${e.threadId}`);
    renderChat();
    if (keepError) $(".log-inner").insertAdjacentHTML("beforeend", `<div class="error-note">⚠ ${esc(keepError)}</div>`);
    if (e.status === "stopped") $(".log-inner").insertAdjacentHTML("beforeend", `<div class="note">Stopped.</div>`);
    lastError = null;
    scrollDown(true);
  } else {
    if (e.type === "error") lastError = e.message;
    if (!state.live) startLive();
    liveEvent(e);
  }
}

// ---------- Tool pages ----------
let previewTimer = null;
async function openPage(page) {
  const shell = (title, body, sub = "") => {
    $("#main").innerHTML = `<div class="page"><div class="page-inner"><div class="page-title">${title}</div>${sub ? `<div class="sub" style="margin:-8px 0 16px">${sub}</div>` : ""}${body}</div></div>`;
  };
  const nameOf = (id) => agentById(id)?.name ?? (id === "owner" ? "You" : id === "schedule" ? "Schedule" : "Unassigned");

  if (page === "memory") {
    const rows = await api("/memories");
    shell("Memory", `
      <div class="card"><form id="new-mem" class="row">
        <label class="grow">Add something the team should always know<input name="content" required placeholder="e.g. Our target audience is CRCs with 1–3 years of experience" /></label>
        <label style="width:170px">Who<select name="agent_id"><option value="">Whole team</option>${state.agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select></label>
        <button class="btn-blue" style="margin-bottom:10px">Save</button></form></div>
      ${rows.map((m) => `<div class="card"><div class="sub">${m.agent_id ? esc(nameOf(m.agent_id)) : "Whole team"} · ${ago(m.created_at)}</div>
        <div style="margin-top:4px">${esc(m.content)}</div><div class="card-actions"><button class="btn-red" data-del="${m.id}">Forget</button></div></div>`).join("")}`);
    $("#new-mem").onsubmit = async (e) => {
      e.preventDefault();
      await api("/memories", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
      openPage("memory");
    };
    $(".page-inner").addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-del]");
      if (b) { await api(`/memories/${b.dataset.del}`, { method: "DELETE" }); openPage("memory"); }
    });
  }

  if (page === "browser") {
    const [b, accounts, rules] = await Promise.all([api("/browser"), api("/accounts"), api("/site-rules")]);
    const engineName = { chrome: "Google Chrome", chromium: "Chromium" };
    const accStatus = (a) => {
      if (!a.status.known) return `<span class="pill muted">Open the browser to check</span>`;
      if (a.status.signedIn === true) return `<span class="pill good">● Signed in</span>`;
      if (a.status.signedIn === false) return `<span class="pill warn">Not signed in</span>`;
      return `<span class="pill muted">${a.status.cookieCount} saved cookies</span>`;
    };
    const ruleRow = (r) => `<tr>
      <td><input name="domain" value="${esc(r.domain)}" placeholder="example.com" /></td>
      <td><select name="access">${[["approve", "Ask me before clicks & submits"], ["full", "Full access"], ["blocked", "Blocked"]]
        .map(([v, l]) => `<option value="${v}" ${r.access === v ? "selected" : ""}>${l}</option>`).join("")}</select></td>
      <td><input name="dailyLimit" type="number" min="0" value="${r.dailyLimit ?? 0}" /></td>
      <td><input name="minDelaySec" type="number" min="0" value="${r.minDelaySec ?? 0}" /></td>
      <td class="sub">${rules.usage[r.domain] ?? 0}</td>
      <td><button type="button" class="btn-red del-rule">✕</button></td></tr>`;

    shell("Browser & accounts", `
      <div class="card">
        <div class="row" style="align-items:center">
          <div class="grow"><h3>Team browser ${b.running ? '<span class="pill good">● Open</span>' : '<span class="pill muted">Closed</span>'}</h3>
            <div class="sub">${engineName[b.engine]} with its own profile, separate from your everyday Chrome. Each member works in their own tab; logins are saved.</div></div>
          <label style="width:170px;margin:0">Engine<select id="engine">${Object.entries(engineName).map(([v, l]) => `<option value="${v}" ${b.preferred === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <button class="btn-blue" id="br-open">${b.running ? "Show window" : "Open browser"}</button>
          ${b.running ? `<button class="btn-grey" id="br-close">Close</button>` : ""}
        </div>
      </div>

      <div class="row" style="align-items:center;margin:26px 0 6px"><h3 class="section grow" style="margin:0">Accounts</h3>
        <button class="btn-blue" data-import="">Import cookies</button></div>
      <div class="sub" style="margin-bottom:10px">Fastest: <b>Import cookies</b> from your normal Chrome and the team is signed in at once, with no passwords. You can also click <b>Sign in</b> and log in yourself in the team browser.</div>
      <div class="grid">${accounts.map((a) => `
        <div class="card">
          <h3>${esc(a.name)}</h3><div class="sub">${esc(a.domain)}</div>
          <div style="margin:8px 0">${accStatus(a)}</div>
          <div class="card-actions">
            <button class="btn-blue" data-import="${esc(a.domain)}" data-name="${esc(a.name)}">Import cookies</button>
            <button class="btn-grey" data-signin="${esc(a.domain)}">Sign in</button>
            <button class="btn-grey" data-check="1">Check</button>
            <button class="btn-grey" data-signout="${esc(a.domain)}">Sign out</button>
            <button class="btn-red" data-delacc="${esc(a.domain)}" title="Remove from list">✕</button>
          </div>
        </div>`).join("")}
        <form class="card" id="add-acc">
          <h3>Add an account</h3>
          <input name="name" placeholder="Name, e.g. Upwork" required style="margin:6px 0" />
          <input name="loginUrl" placeholder="https://… login page" required />
          <div class="card-actions"><button class="btn-grey">Add</button></div>
        </form>
      </div>

      <h3 class="section">Site rules</h3>
      <div class="sub" style="margin-bottom:10px">Enforced in code on every browser action. "Ask me" lets members read, scroll and type freely, but every button click, Enter or submit waits for your approval. Daily limit counts all actions on that site; delay spaces actions out.</div>
      <form class="card" id="rules-form">
        <table class="rules"><thead><tr><th>Site</th><th>Access</th><th>Daily limit</th><th>Delay (s)</th><th>Today</th><th></th></tr></thead>
          <tbody>${rules.rules.map(ruleRow).join("")}</tbody></table>
        <div class="card-actions"><button type="button" class="btn-grey" id="add-rule">+ Add site</button><span class="grow"></span><span id="rules-saved" class="sub"></span><button class="btn-blue">Save rules</button></div>
      </form>

      <h3 class="section">Live tabs</h3>
      <div class="grid">${b.tabs.length ? b.tabs.map((t) => `
        <div class="card tab-card">
          <div class="sub"><b>${esc(t.name)}</b> · ${esc(t.title || "")}</div>
          <div class="sub url">${esc(t.url)}</div>
          <img data-preview="${esc(t.key)}" src="/api/browser/tabs/${encodeURIComponent(t.key)}/preview?t=${Date.now()}" alt="" />
          <div class="card-actions"><button class="btn-grey" data-front="${esc(t.key)}">Show in browser</button></div>
        </div>`).join("") : `<div class="sub">No open tabs yet. Tabs appear here when a member starts browsing.</div>`}</div>`);

    const root = $(".page-inner");
    $("#engine").onchange = async (e) => { await api("/browser/engine", { method: "PUT", body: { engine: e.target.value } }); openPage("browser"); };
    $("#br-open").onclick = async () => {
      try { await api("/browser/open", { method: "POST" }); if (b.tabs[0]) await api(`/browser/tabs/${b.tabs[0].key}/front`, { method: "POST" }); } catch (err) { alert(err.message); }
      openPage("browser");
    };
    if ($("#br-close")) $("#br-close").onclick = async () => { await api("/browser/close", { method: "POST" }); openPage("browser"); };
    $("#add-acc").onsubmit = async (e) => {
      e.preventDefault();
      try { await api("/accounts", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }); openPage("browser"); } catch (err) { alert(err.message); }
    };
    $("#add-rule").onclick = () => $(".rules tbody").insertAdjacentHTML("beforeend", ruleRow({ domain: "", access: "approve", dailyLimit: 100, minDelaySec: 3 }));
    $("#rules-form").onsubmit = async (e) => {
      e.preventDefault();
      const rows = [...root.querySelectorAll(".rules tbody tr")].map((tr) => Object.fromEntries(
        [...tr.querySelectorAll("input, select")].map((el) => [el.name, el.value])));
      await api("/site-rules", { method: "PUT", body: { rules: rows.filter((r) => r.domain.trim()) } });
      $("#rules-saved").textContent = "Saved. Applies immediately.";
    };
    root.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      if (btn.classList.contains("del-rule")) return btn.closest("tr").remove();
      try {
        if (btn.dataset.import !== undefined) return openCookieDialog(btn.dataset.import, btn.dataset.name);
        if (btn.dataset.signin) { await api(`/accounts/${btn.dataset.signin}/signin`, { method: "POST" }); return openPage("browser"); }
        if (btn.dataset.check) return openPage("browser");
        if (btn.dataset.signout && confirm("Sign the team out of this site?")) { await api(`/accounts/${btn.dataset.signout}/signout`, { method: "POST" }); return openPage("browser"); }
        if (btn.dataset.delacc && confirm("Remove this account from the list?")) { await api(`/accounts/${btn.dataset.delacc}`, { method: "DELETE" }); return openPage("browser"); }
        if (btn.dataset.front) return api(`/browser/tabs/${btn.dataset.front}/front`, { method: "POST" });
      } catch (err) { alert(err.message); }
    });
    // Refresh tab previews while this page is open.
    clearInterval(previewTimer);
    previewTimer = setInterval(() => {
      if (state.view.name !== "browser") return clearInterval(previewTimer);
      document.querySelectorAll("img[data-preview]").forEach((img) => {
        img.src = `/api/browser/tabs/${encodeURIComponent(img.dataset.preview)}/preview?t=${Date.now()}`;
      });
    }, 3000);
  }

}

// ---------- Agent dialog (Edit profile) ----------
let editing = null;
function openAgentDialog(agent) {
  editing = agent;
  const f = $("#agent-form");
  $("#agent-dialog-title").textContent = agent ? "Edit profile" : "New team member";
  f.name.value = agent?.name ?? "";
  f.emoji.value = agent?.emoji ?? "🤖";
  f.color.value = agent?.color ?? "#6b7cff";
  f.role.value = agent?.role ?? "";
  f.instructions.value = agent?.instructions ?? "";
  f.bio.value = agent?.bio ?? "";
  $("#agent-id").textContent = agent ? `ID ${agent.id}` : "ID assigned on save";
  const perms = new Set(agent?.permissions ?? ["research", "drafting"]);
  $("#perm-checks").innerHTML = Object.entries(state.meta.actionTypes)
    .map(([k, label]) => `<label><input type="checkbox" value="${k}" ${perms.has(k) ? "checked" : ""}/> ${esc(label)}</label>`).join("");
  f.effort.innerHTML = state.meta.efforts.map((e) => `<option ${e === (agent?.effort ?? "high") ? "selected" : ""}>${e}</option>`).join("");
  const options = (map, current) => Object.entries(map).map(([k, label]) => `<option value="${k}" ${k === current ? "selected" : ""}>${esc(label)}</option>`).join("");
  f.model.innerHTML = options(state.meta.models, agent?.model ?? "haiku");
  f.fallback_model.innerHTML = `<option value="">None</option>` + options(Object.fromEntries(Object.entries(state.meta.models).filter(([k]) => k !== "test")), agent?.fallback_model ?? "");
  f.advisor.innerHTML = options(state.meta.advisors, agent?.advisor ?? "opus");
  const tools = new Set(agent?.tools ?? ["web", "browser", "files", "memory", "tasks", "prospects"]);
  $("#tool-checks").innerHTML = Object.entries(state.meta.toolGroups)
    .map(([k, label]) => `<label><input type="checkbox" value="${k}" ${tools.has(k) ? "checked" : ""}/> ${esc(label)}</label>`).join("");
  $("#delete-agent").hidden = !agent;
  const syncAvatar = () => {
    const av = $("#dlg-av");
    av.textContent = f.emoji.value || "🤖";
    av.style.background = `${f.color.value}2e`;
  };
  f.emoji.oninput = syncAvatar;
  f.color.oninput = syncAvatar;
  syncAvatar();
  $("#agent-dialog").showModal();
}
$("#cancel-agent").onclick = () => $("#agent-dialog").close();
$("#agent-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value, emoji: f.emoji.value, color: f.color.value, role: f.role.value,
    instructions: f.instructions.value, effort: f.effort.value, model: f.model.value, advisor: f.advisor.value, fallback_model: f.fallback_model.value,
    tools: [...document.querySelectorAll("#tool-checks input:checked")].map((i) => i.value),
    bio: f.bio.value, permissions: [...document.querySelectorAll("#perm-checks input:checked")].map((i) => i.value),
  };
  try {
    const saved = editing ? await api(`/agents/${editing.id}`, { method: "PUT", body }) : await api("/agents", { method: "POST", body });
    $("#agent-dialog").close();
    state.agents = await api("/agents");
    await refreshInbox();
    if (editing) go({ name: "profile", agentId: saved.id });
    else openAgentChat(saved.id);
  } catch (err) {
    alert(err.message);
  }
});
$("#delete-agent").onclick = async () => {
  if (!editing || !confirm(`Remove ${editing.name} from the team?`)) return;
  try { await api(`/agents/${editing.id}`, { method: "DELETE" }); } catch (err) { return alert(err.message); }
  $("#agent-dialog").close();
  state.agents = await api("/agents");
  state.unread.delete(editing.id);
  saveUnread();
  await refreshInbox();
  go({ name: "messages" });
};

// ---------- Cookie import ----------
let cookieDomain = "";
function openCookieDialog(domain, name) {
  cookieDomain = domain || "";
  $("#cookie-title").textContent = domain ? `Import cookies · ${name || domain}` : "Import cookies";
  $("#cookie-text").value = "";
  $("#cookie-file").value = "";
  $("#cookie-file-name").textContent = "";
  $("#cookie-result").innerHTML = domain ? `<div class="sub">Only cookies for <b>${esc(domain)}</b> are imported. Use the Import cookies button at the top of the page for several sites at once.</div>` : `<div class="sub">You can paste cookies for several sites at once. New sites are added to your Accounts.</div>`;
  $("#do-import").disabled = false;
  $("#cookie-dialog").showModal();
}
$("#cancel-cookies").onclick = () => { $("#cookie-text").value = ""; $("#cookie-dialog").close(); if (state.view.name === "browser") openPage("browser"); };
$("#cookie-file").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $("#cookie-file-name").textContent = file.name;
  $("#cookie-text").value = await file.text();
};
$("#cookie-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#do-import");
  btn.disabled = true;
  $("#cookie-result").innerHTML = `<div class="sub"><span class="spin"></span> Importing… (the team browser opens if it was closed)</div>`;
  try {
    const r = await api("/cookies/import", { method: "POST", body: { text: $("#cookie-text").value, domain: cookieDomain || undefined } });
    $("#cookie-text").value = ""; // don't keep secrets on screen
    const extra = [r.failed ? `${r.failed} couldn't be added` : "", r.skipped ? `${r.skipped} for other sites skipped` : ""].filter(Boolean).join(", ");
    $("#cookie-result").innerHTML = r.imported
      ? `<div class="result-ok">✓ Imported ${r.imported} cookie${r.imported === 1 ? "" : "s"} for ${r.domains.map(esc).join(", ")}.${extra ? ` (${extra})` : ""}<br/>Close this, then the account should show <b>Signed in</b>. If a site still asks you to log in, its session may have expired: export again while signed in.</div>`
      : `<div class="result-err">Nothing imported.${extra ? ` ${extra}.` : ""} Check that you exported from the right site.</div>`;
    btn.textContent = "Import";
  } catch (err) {
    $("#cookie-result").innerHTML = `<div class="result-err">${esc(err.message)}</div>`;
  }
  btn.disabled = false;
});

// ---------- Boot ----------
(async () => {
  [state.meta, state.agents, state.inbox] = await Promise.all([api("/meta"), api("/agents"), api("/inbox")]);
  for (const id of state.meta.running) state.busyThreads.add(id);
  Object.assign(nav, { go, openThread, openAgentChat, openTask: (id) => go({ name: "task", id }), openAgentDialog });
  renderRail();
  connect();
  refreshApprovals({ toastNew: true });
  go({ name: "tasks" });
})();
