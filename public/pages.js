// Operations pages: tasks, workflows, prospects, approvals, permissions, connections, activity,
// schedules and settings. Every view reads real server state; nothing here is simulated.
import {
  $, esc, api, state, agentById, ago, icon, md, ringed, nav, toast, statePill, STATE_LABEL, fmtTime, fmtDur, money, agentName,
} from "./core.js";

const main = () => $("#main");
const shell = (title, body, { sub = "", actions = "" } = {}) => {
  main().innerHTML = `<div class="page"><div class="page-inner wide">
    <div class="page-head"><div><div class="page-title">${title}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div><div class="head-actions">${actions}</div></div>
    ${body}</div></div>`;
  return $(".page-inner");
};
const agentOptions = (selected, { any = false, none = false } = {}) =>
  `${none ? `<option value="">— choose a member —</option>` : ""}${any ? `<option value="*" ${selected === "*" ? "selected" : ""}>Any member</option>` : ""}` +
  state.agents.map((a) => `<option value="${a.id}" ${a.id === selected ? "selected" : ""}>${esc(a.name)}</option>`).join("");
const agentChip = (id) => {
  const a = agentById(id);
  return a ? `<span class="chip-agent" data-profile="${a.id}">${esc(a.emoji)} ${esc(a.name)}</span>` : `<span class="sub">${esc(agentName(id))}</span>`;
};
// Links from agents or imports are untrusted: anything but http(s) is rendered inert.
const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? "")) ? String(u) : "#");
const jsonBlock = (v) => `<pre class="json">${esc(JSON.stringify(v, null, 2))}</pre>`;
const errBox = (msg, recovery) => `<div class="banner bad"><b>${esc(msg)}</b>${recovery ? `<div>${esc(recovery)}</div>` : ""}</div>`;

async function act(promise, okMsg) {
  try {
    const r = await promise;
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, "err");
    throw e;
  }
}
// Run/retry return {ok, reason, recovery}; show the specific reason when execution can't start.
async function runOrExplain(path) {
  const res = await fetch(`/api${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const r = await res.json();
  if (r.ok) toast(r.note || "Queued");
  else toast(`${r.reason} ${r.recovery ?? ""}`, "err");
  return r;
}

// ---------------------------------------------------------------- Tasks
const FILTERS = ["active", "draft", "queued", "running", "waiting_input", "waiting_approval", "completed", "failed", "cancelled", "all"];
let taskFilter = "active";

export async function renderTasks() {
  const [all, sys] = await Promise.all([api("/tasks"), api("/system")]);
  const counts = Object.fromEntries(FILTERS.map((f) => [f, all.filter((t) => matchFilter(t, f)).length]));
  const rows = all.filter((t) => matchFilter(t, taskFilter));
  const openTasks = all.filter((t) => !["completed", "failed", "cancelled"].includes(t.status));
  const root = shell("Tasks", `
    ${workerBanner(sys)}
    <details class="card create" ${all.length ? "" : "open"}><summary><b>＋ New task</b> <span class="sub">Creating a task does not run it. Use “Create & run” or Run later.</span></summary>
      <form id="new-task" class="form-grid">
        <label class="span2">Title<input name="title" required placeholder="e.g. Find 10 agency partners in Ontario" /></label>
        <label>Owner<select name="agent_id" required>${agentOptions("", { none: true })}</select></label>
        <label>Depends on<select name="depends_on" multiple size="3">${openTasks.map((t) => `<option value="${t.id}">${esc(t.title)} (${esc(agentName(t.agent_id))})</option>`).join("")}</select></label>
        <label class="span2">Instructions<textarea name="description" rows="4" placeholder="What to do, what counts as done, constraints."></textarea></label>
        <label class="span2">Inputs (optional JSON)<textarea name="input" rows="2" placeholder='{"criteria": "Directors in fintech, Toronto"}'></textarea></label>
        <div class="span2 row-actions"><button type="submit" name="mode" value="draft" class="btn-grey">Save draft</button><button type="submit" name="mode" value="run" class="btn-blue">Create &amp; run</button></div>
      </form>
    </details>
    <div class="filters">${FILTERS.map((f) => `<button class="fchip ${f === taskFilter ? "on" : ""}" data-filter="${f}">${f === "active" ? "Active" : f === "all" ? "All" : STATE_LABEL[f]} <span>${counts[f]}</span></button>`).join("")}</div>
    <div class="table-wrap"><table class="grid-table">
      <thead><tr><th>Task</th><th>Owner</th><th>State</th><th>Attempts</th><th>Updated</th><th></th></tr></thead>
      <tbody>${rows.map(taskRow).join("") || `<tr><td colspan="6" class="sub empty-row">No tasks here.</td></tr>`}</tbody>
    </table></div>`, { sub: "Every task runs in the background worker with retries, limits and a full history." });

  root.querySelector("#new-task").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    let input = {};
    if (f.input.value.trim()) { try { input = JSON.parse(f.input.value); } catch { return toast("Inputs must be valid JSON", "err"); } }
    const body = { title: f.title.value, agent_id: f.agent_id.value, description: f.description.value, input,
      depends_on: [...f.depends_on.selectedOptions].map((o) => o.value), run: e.submitter?.value === "run" };
    const t = await act(api("/tasks", { method: "POST", body }), body.run ? "Created and queued" : "Draft saved");
    nav.openTask(t.id);
  });
  root.querySelectorAll("[data-filter]").forEach((b) => (b.onclick = () => { taskFilter = b.dataset.filter; renderTasks(); }));
  root.querySelector("tbody").addEventListener("click", taskRowClick);
}
const matchFilter = (t, f) => (f === "all" ? true : f === "active" ? ["queued", "running", "waiting_input", "waiting_approval", "draft"].includes(t.status) : t.status === f);

function taskRow(t) {
  const note = t.status === "failed" ? t.error : t.wait_reason;
  return `<tr data-task="${t.id}" class="clickable">
    <td><b>${esc(t.title)}</b>${t.step_key ? ` <span class="pill muted">${esc(t.step_key)}</span>` : ""}${note ? `<div class="sub clamp">${esc(note)}</div>` : ""}</td>
    <td>${agentChip(t.agent_id)}</td>
    <td>${statePill(t.status, t.output?.skipped ? " (skipped)" : t.output?.status === "no_results" ? " · 0 results" : "")}</td>
    <td>${t.attempts}</td><td class="sub">${ago(t.updated_at)}</td>
    <td class="row-btns">${taskButtons(t)}</td></tr>`;
}
function taskButtons(t) {
  const b = [];
  if (["draft", "completed"].includes(t.status)) b.push(`<button class="btn-blue sm" data-run="${t.id}">Run</button>`);
  if (["failed", "cancelled"].includes(t.status)) b.push(`<button class="btn-blue sm" data-retry="${t.id}">Retry</button>`);
  if (["queued", "running", "waiting_input", "waiting_approval", "draft"].includes(t.status)) b.push(`<button class="btn-grey sm" data-cancel="${t.id}">Cancel</button>`);
  return b.join("");
}
async function taskRowClick(e) {
  const btn = e.target.closest("button");
  if (btn?.dataset.run) { e.stopPropagation(); await runOrExplain(`/tasks/${btn.dataset.run}/run`); return; }
  if (btn?.dataset.retry) { e.stopPropagation(); const reason = prompt("Reason for retry (recorded):", "") ?? ""; await runOrExplain(`/tasks/${btn.dataset.retry}/retry`); return void reason; }
  if (btn?.dataset.cancel) { e.stopPropagation(); if (confirm("Cancel this task?")) await act(api(`/tasks/${btn.dataset.cancel}/cancel`, { method: "POST", body: {} }), "Cancelled"); return; }
  if (e.target.closest("[data-profile]")) return;
  const row = e.target.closest("[data-task]");
  if (row) nav.openTask(row.dataset.task);
}

function workerBanner(sys) {
  const w = sys.worker;
  return `<div class="banner ${w.alive ? "good" : "bad"}">${w.alive
    ? `● Background worker running · ${w.running}/${w.limits.max_concurrent_runs} slots busy · heartbeat ${Math.max(0, Math.round((Date.now() - w.heartbeat_at) / 1000))}s ago`
    : "Background worker is not responding. Tasks won't start until the app is restarted."}</div>`;
}

export async function renderTask(id) {
  const t = await api(`/tasks/${id}`).catch(() => null);
  if (!t) return shell("Task", errBox("Task not found."));
  const runs = t.runs.map((r) => `<tr>
      <td>#${r.attempt}</td><td>${statePill(r.status === "succeeded" ? "completed" : r.status === "running" ? "running" : r.status === "cancelled" ? "cancelled" : "failed", ["timed_out", "abandoned"].includes(r.status) ? ` · ${esc(r.status.replace("_", " "))}` : "")}</td>
      <td class="sub">${fmtTime(r.started_at)}</td><td>${fmtDur((r.finished_at ?? Date.now()) - r.started_at)}</td>
      <td>${esc(r.model ?? "—")}</td><td>${money(r.cost_usd)}</td><td>${r.tool_calls}</td>
      <td class="sub">${esc(r.error ?? "")}</td>
      <td>${r.thread_id ? `<button class="btn-grey sm" data-thread="${r.thread_id}">Log</button>` : ""}</td></tr>`).join("");
  const out = t.output;
  const root = shell(esc(t.title), `
    <div class="task-top">
      <div>${statePill(t.status)} ${t.output?.skipped ? `<span class="pill muted">skipped</span>` : ""} <span class="sub">· owner</span> ${agentChip(t.agent_id)}
        <span class="sub">· attempts ${t.attempts}${t.max_attempts ? `/${t.max_attempts}` : ""} · created ${fmtTime(t.created_at)} by ${esc(agentName(t.created_by))}</span></div>
      <div class="row-btns">${taskButtons(t)}
        <select id="reassign"><option value="">Reassign…</option>${state.agents.filter((a) => a.id !== t.agent_id).map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select>
        <button class="btn-red sm" id="del-task">Delete</button></div>
    </div>
    ${t.status === "failed" && t.error ? errBox("Failed", t.error) : ""}
    ${t.wait_reason && t.status !== "failed" ? `<div class="banner warn">${esc(t.wait_reason)}</div>` : ""}
    ${t.status === "waiting_input" ? `<form id="answer" class="card"><b>${esc(agentName(t.agent_id))} asks:</b><p>${esc(t.wait_reason)}</p>
      <textarea name="answer" rows="3" required placeholder="Your answer"></textarea><div class="row-actions"><button class="btn-blue">Send answer &amp; resume</button></div></form>` : ""}
    <div class="two-col">
      <div>
        <h3 class="section">Output</h3>
        ${out ? `<div class="card"><div class="out-status">${esc(out.status ?? "")}${out.structured === false ? ` <span class="pill warn">unstructured</span>` : ""}</div>
          <div class="md">${md(out.summary ?? "")}</div>
          ${["prospect_ids", "qualified_prospect_ids", "draft_ids"].filter((f) => out[f]?.length).map((f) => `<div class="kv"><span>${f.replace(/_/g, " ")}</span>${out[f].map((id) => f === "draft_ids" ? `<code>${esc(id.slice(0, 8))}</code>` : `<a href="#" data-prospect="${id}">${esc(id.slice(0, 8))}</a>`).join(" ")}</div>`).join("")}
          ${out.data ? `<details><summary class="sub">Data</summary>${jsonBlock(out.data)}</details>` : ""}</div>` : `<div class="sub">No output yet.</div>`}
        <h3 class="section">Instructions &amp; inputs</h3>
        <div class="card"><div class="md">${md(t.description || "_(none)_")}</div>${Object.keys(t.input ?? {}).length ? jsonBlock(t.input) : ""}</div>
        ${t.dependencies.length ? `<h3 class="section">Depends on</h3><div class="card">${t.dependencies.map((d) => `<div class="dep" data-task="${d.id}">${statePill(d.status)} <a href="#">${esc(d.title)}</a> · ${esc(agentName(d.agent_id))}</div>`).join("")}</div>` : ""}
        ${t.actions.length ? `<h3 class="section">Drafts &amp; actions</h3>${t.actions.map(actionCard).join("")}` : ""}
      </div>
      <div>
        <h3 class="section">Runs</h3>
        <div class="table-wrap"><table class="grid-table small"><thead><tr><th>#</th><th>Result</th><th>Started</th><th>Took</th><th>Model</th><th>Est. cost</th><th>Tools</th><th>Error</th><th></th></tr></thead>
        <tbody>${runs || `<tr><td colspan="9" class="sub empty-row">Not run yet.</td></tr>`}</tbody></table></div>
        <h3 class="section">History</h3>
        <div class="timeline">${t.events.map((ev) => `<div><span class="sub">${fmtTime(ev.at)}</span> <b>${esc(ev.type.replace(/_/g, " "))}</b>${ev.to_status && ev.from_status !== ev.to_status ? ` → ${esc(STATE_LABEL[ev.to_status] ?? ev.to_status)}` : ""} <span class="sub">by ${esc(agentName(ev.actor))}</span>${ev.note ? `<div class="sub">${esc(ev.note)}</div>` : ""}</div>`).reverse().join("")}</div>
        <h3 class="section">Activity</h3>
        <div class="feed compact">${t.activity.map(activityItem).join("") || `<div class="sub">No activity yet.</div>`}</div>
      </div>
    </div>`, { actions: `<button class="btn-grey" id="back-tasks">← Tasks</button>` });

  $("#back-tasks").onclick = () => nav.go({ name: "tasks" });
  root.querySelector(".task-top").addEventListener("click", taskRowClick);
  $("#reassign").onchange = async (e) => {
    if (!e.target.value) return;
    const reason = prompt("Reason for reassigning (recorded in history):", "");
    if (reason === null) { e.target.value = ""; return; }
    await act(api(`/tasks/${id}/reassign`, { method: "POST", body: { agent_id: e.target.value, reason } }), "Reassigned");
    renderTask(id);
  };
  $("#del-task").onclick = async () => { if (confirm("Delete this task and its history?")) { await act(api(`/tasks/${id}`, { method: "DELETE" }), "Deleted"); nav.go({ name: "tasks" }); } };
  $("#answer")?.addEventListener("submit", async (e) => { e.preventDefault(); await act(api(`/tasks/${id}/answer`, { method: "POST", body: { answer: e.target.answer.value } }), "Answer sent; task re-queued"); renderTask(id); });
  root.addEventListener("click", (e) => {
    const th = e.target.closest("[data-thread]");
    if (th) return nav.openThread(th.dataset.thread);
    const p = e.target.closest("[data-prospect]");
    if (p) { e.preventDefault(); return nav.go({ name: "prospect", id: p.dataset.prospect }); }
    const d = e.target.closest(".dep[data-task]");
    if (d) { e.preventDefault(); return nav.openTask(d.dataset.task); }
  });
}

// ---------------------------------------------------------------- Activity
export function activityItem(a) {
  const ICON = { run_started: "▶️", tool_call: "🔧", tool_result: "↳", tool_error: "⚠️", output: "📦", error: "❌", approval_requested: "✋", approval_decided: "⚖️",
    status: "🔁", task_created: "🆕", reassigned: "🔀", schedule: "⏰", action_executed: "📤", action_blocked: "⛔", workflow_started: "🧩", permission: "🔐" };
  return `<div class="feed-item k-${esc(a.kind)}" ${a.task_id ? `data-task="${a.task_id}"` : ""}>
    <span class="t">${new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
    <span class="ico">${ICON[a.kind] ?? "•"}</span>
    <span class="s">${esc(a.summary)}</span></div>`;
}

let activityAgent = "";
export async function renderActivity() {
  const items = await api(`/activity?limit=300${activityAgent ? `&agent_id=${activityAgent}` : ""}`);
  const root = shell("Activity", `
    <div class="filters"><select id="act-agent"><option value="">Everyone</option>${agentOptions(activityAgent)}</select>
      <span class="sub">Live. Every entry comes from a real run, tool call, approval or schedule.</span></div>
    <div class="feed" id="feed">${items.map(activityItem).join("") || `<div class="sub">Nothing yet. Run a task to see live activity.</div>`}</div>`);
  $("#act-agent").onchange = (e) => { activityAgent = e.target.value; renderActivity(); };
  root.addEventListener("click", (e) => { const r = e.target.closest("[data-task]"); if (r) nav.openTask(r.dataset.task); });
}
export function pushActivity(item) {
  const feed = $("#feed");
  if (!feed || state.view.name !== "activity") return;
  if (activityAgent && item.agent_id !== activityAgent) return;
  feed.insertAdjacentHTML("afterbegin", activityItem(item));
  feed.querySelector(".sub:only-child")?.remove();
}

// ---------------------------------------------------------------- Workflows
export async function renderWorkflows() {
  const ws = await api("/workflows");
  const stepHtml = (w) => {
    const levels = [];
    const level = {};
    const lv = (s) => level[s.key] ?? (level[s.key] = (s.depends_on ?? []).length ? 1 + Math.max(...s.depends_on.map((d) => lv(w.steps.find((x) => x.key === d)))) : 0);
    w.steps.forEach((s) => { (levels[lv(s)] ??= []).push(s); });
    return `<div class="flow">${levels.map((group) => `<div class="flow-col">${group.map((s) => `<div class="flow-step" title="${esc(s.instructions ?? "")}">
      ${agentById(s.agent_id) ? ringed(agentById(s.agent_id), "sm") : ""}<div><b>${esc(agentName(s.agent_id))}</b><div class="sub">${esc(s.title)}</div>${s.condition ? `<div class="pill muted">only if ${esc(s.condition.field?.replace(/_/g, " ") ?? "condition")}</div>` : ""}</div></div>`).join("")}</div>`).join(`<div class="flow-arrow">→</div>`)}
      ${(w.triggers ?? []).map((tr) => `<div class="flow-arrow">⋯</div><div class="flow-col"><div class="flow-step trig"><b>${esc(agentName(tr.agent_id))}</b><div class="sub">when a booking is confirmed</div></div></div>`).join("")}</div>`;
  };
  const root = shell("Workflows", `
    ${ws.map((w) => `<div class="card wf" data-wf="${w.id}">
      <div class="wf-head"><div><h3>${esc(w.name)}</h3><div class="sub">${esc(w.description ?? "")}${w.pipeline ? ` · pipeline: ${esc(w.pipeline.replace("_", " "))}` : ""}</div></div>
        <div class="row-btns"><button class="btn-blue" data-runwf="${w.id}">Run workflow</button><button class="btn-grey" data-editwf="${w.id}">Edit</button></div></div>
      ${stepHtml(w)}
      ${w.runs.length ? `<div class="wf-runs"><div class="sub">Recent runs</div>${w.runs.map((r) => `<div class="wf-run" data-wfrun="${r.id}">${statePill(r.status === "running" ? "running" : r.status)} <span class="sub">${fmtTime(r.created_at)} · by ${esc(agentName(r.created_by))}</span> <a href="#">View steps</a></div>`).join("")}</div>` : ""}
    </div>`).join("") || `<div class="sub">No workflows yet.</div>`}
    <details class="card"><summary><b>＋ New workflow</b> <span class="sub">Steps reference team members by ID; dependencies run in order, independent steps run in parallel.</span></summary>
      <textarea id="wf-json" rows="14" spellcheck="false">${esc(JSON.stringify({ name: "New workflow", pipeline: "job_seeker", description: "", steps: [
        { key: "research", title: "Research", agent_id: state.agents[0]?.id ?? "", depends_on: [], instructions: "..." },
        { key: "next", title: "Next step", agent_id: state.agents[1]?.id ?? "", depends_on: ["research"], condition: { type: "deps_list_nonempty", field: "prospect_ids" }, instructions: "..." },
      ], triggers: [] }, null, 2))}</textarea>
      <div class="sub">Agent IDs: ${state.agents.map((a) => `${esc(a.name)} = <code>${a.id}</code>`).join(" · ")}</div>
      <div class="row-actions"><button class="btn-blue" id="wf-save">Save workflow</button></div></details>`,
  { sub: "Structured outputs flow between steps automatically. Steps with nothing to work on are skipped honestly." });

  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-runwf],[data-editwf],[data-wfrun]");
    if (!b) return;
    e.preventDefault();
    if (b.dataset.runwf) {
      const criteria = prompt("Optional focus for this run (e.g. 'Directors in fintech, Toronto'). Leave empty for defaults:", "");
      if (criteria === null) return;
      const r = await act(api(`/workflows/${b.dataset.runwf}/run`, { method: "POST", body: { input: criteria.trim() ? { criteria: criteria.trim() } : {} } }), "Workflow started");
      nav.go({ name: "wfrun", id: r.run.id });
    } else if (b.dataset.editwf) {
      const w = ws.find((x) => x.id === b.dataset.editwf);
      const ta = $("#wf-json");
      ta.value = JSON.stringify({ id: w.id, name: w.name, pipeline: w.pipeline, description: w.description, steps: w.steps, triggers: w.triggers }, null, 2);
      ta.closest("details").open = true;
      ta.scrollIntoView({ behavior: "smooth" });
    } else if (b.dataset.wfrun) nav.go({ name: "wfrun", id: b.dataset.wfrun });
  });
  $("#wf-save").onclick = async () => {
    let w;
    try { w = JSON.parse($("#wf-json").value); } catch { return toast("Not valid JSON", "err"); }
    await act(w.id ? api(`/workflows/${w.id}`, { method: "PUT", body: w }) : api("/workflows", { method: "POST", body: w }), "Workflow saved");
    renderWorkflows();
  };
}

export async function renderWorkflowRun(id) {
  const r = await api(`/workflow-runs/${id}`);
  const byKey = Object.fromEntries(r.tasks.map((t) => [t.step_key, t]));
  shell(`${esc(r.workflow?.name ?? "Workflow")} run`, `
    <div class="task-top"><div>${statePill(r.status === "running" ? "running" : r.status)} <span class="sub">started ${fmtTime(r.created_at)} by ${esc(agentName(r.created_by))}</span></div>
      <div class="row-btns">${r.status === "running" ? `<button class="btn-grey" id="cancel-wf">Cancel run</button>` : ""}</div></div>
    ${Object.keys(r.input ?? {}).length ? `<div class="card"><b>Input</b>${jsonBlock(r.input)}</div>` : ""}
    <div class="table-wrap"><table class="grid-table"><thead><tr><th>Step</th><th>Owner</th><th>State</th><th>Result</th><th></th></tr></thead><tbody>
    ${(r.workflow?.steps ?? []).map((s) => { const t = byKey[s.key]; return t ? `<tr class="clickable" data-task="${t.id}"><td><b>${esc(s.title)}</b><div class="sub">${esc(s.key)}${s.depends_on?.length ? ` · after ${esc(s.depends_on.join(" + "))}` : ""}</div></td>
      <td>${agentChip(t.agent_id)}</td><td>${statePill(t.status, t.output?.skipped ? " (skipped)" : "")}</td>
      <td class="sub clamp">${esc(t.output?.summary ?? t.wait_reason ?? t.error ?? "")}</td><td>${taskButtons(t)}</td></tr>` : ""; }).join("")}
    </tbody></table></div>`, { actions: `<button class="btn-grey" id="back-wf">← Workflows</button>` });
  $("#back-wf").onclick = () => nav.go({ name: "workflows" });
  $("#cancel-wf")?.addEventListener("click", async () => { if (confirm("Cancel all unfinished steps?")) { await act(api(`/workflow-runs/${id}/cancel`, { method: "POST", body: {} }), "Cancelled"); renderWorkflowRun(id); } });
  $("tbody").addEventListener("click", taskRowClick);
}

// ---------------------------------------------------------------- Prospects
let pipeline = "job_seeker";
let pq = { q: "", status: "" };
export async function renderProspects() {
  const rows = await api(`/prospects?pipeline=${pipeline}${pq.status ? `&status=${pq.status}` : ""}${pq.q ? `&q=${encodeURIComponent(pq.q)}` : ""}`);
  const root = shell("Prospects", `
    <div class="tabs-row"><button class="${pipeline === "job_seeker" ? "on" : ""}" data-pipe="job_seeker">Job seekers</button><button class="${pipeline === "agency" ? "on" : ""}" data-pipe="agency">Agency partners</button></div>
    <div class="filters">
      <input id="pq" placeholder="Search name or business" value="${esc(pq.q)}" style="max-width:260px" />
      <select id="pstatus"><option value="">All statuses</option>${["new", "needs_info", "qualified", "disqualified"].map((s) => `<option ${pq.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      <span class="grow"></span>
      <a class="btn-grey" href="/api/prospects/export.csv?pipeline=${pipeline}" download>Export CSV</a>
      <label class="btn-grey file-btn">Import CSV<input type="file" id="pimport" accept=".csv,text/csv" hidden /></label>
    </div>
    <div class="table-wrap"><table class="grid-table">
      <thead><tr><th>${pipeline === "agency" ? "Business" : "Name"}</th><th>Status</th><th>Evidence</th><th>Owner · next action</th><th>Contact</th></tr></thead>
      <tbody>${rows.map((p) => `<tr class="clickable" data-prospect="${p.id}">
        <td><b>${esc(p.name || p.business || "—")}</b>${p.business && p.name ? `<div class="sub">${esc(p.business)}</div>` : ""}${p.possible_duplicate_of ? ` <span class="pill warn">possible duplicate</span>` : ""}</td>
        <td>${qualPill(p.qualification_status)}${p.booking_status === "confirmed" ? ` <span class="pill good">booked</span>` : ""}</td>
        <td class="sub clamp">${p.quote ? `“${esc(p.quote.slice(0, 120))}”` : ""}<div>${esc(p.evidence_date ?? "")} · <a href="${esc(safeUrl(p.source_url))}" target="_blank" rel="noopener noreferrer">source</a></div></td>
        <td>${p.owner_id ? agentChip(p.owner_id) : ""}<div class="sub">${esc(p.next_action ?? "")}</div></td>
        <td>${p.opted_out ? `<span class="pill bad">opted out</span>` : `<span class="pill muted">${esc(p.contact_permission)}</span>`}</td></tr>`).join("") || `<tr><td colspan="5" class="sub empty-row">No prospects yet. Research tasks add them with public evidence.</td></tr>`}</tbody>
    </table></div>`, { sub: "Deduplicated by LinkedIn, Reddit, email, website or source URL, never by name alone." });
  root.querySelectorAll("[data-pipe]").forEach((b) => (b.onclick = () => { pipeline = b.dataset.pipe; renderProspects(); }));
  $("#pq").onchange = (e) => { pq.q = e.target.value.trim(); renderProspects(); };
  $("#pstatus").onchange = (e) => { pq.status = e.target.value; renderProspects(); };
  $("#pimport").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const r = await act(api("/prospects/import", { method: "POST", body: { text: await file.text(), pipeline } }));
    alert(`Imported into ${pipeline.replace("_", " ")}: ${r.created} new, ${r.updated} merged into existing, ${r.possible_duplicates} flagged as possible duplicates.${r.errors.length ? `\n\nSkipped rows:\n${r.errors.join("\n")}` : ""}`);
    renderProspects();
  };
  root.querySelector("tbody").addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const r = e.target.closest("[data-prospect]");
    if (r) nav.go({ name: "prospect", id: r.dataset.prospect });
  });
}
const qualPill = (s) => `<span class="pill ${s === "qualified" ? "good" : s === "disqualified" ? "bad" : s === "needs_info" ? "warn" : "muted"}">${esc(s.replace("_", " "))}</span>`;

export async function renderProspect(id) {
  const p = await api(`/prospects/${id}`).catch(() => null);
  if (!p) return shell("Prospect", errBox("Prospect not found."));
  const root = shell(esc(p.name || p.business || "Prospect"), `
    <div class="two-col">
      <div>
        <div class="card"><div class="kv"><span>Pipeline</span>${esc(p.pipeline.replace("_", " "))}</div>
          ${p.business ? `<div class="kv"><span>Business</span>${esc(p.business)}</div>` : ""}
          <div class="kv"><span>Source</span><a href="${esc(safeUrl(p.source_url))}" target="_blank" rel="noopener noreferrer">${esc(p.source_url)}</a></div>
          <div class="kv"><span>Evidence date</span>${esc(p.evidence_date ?? "unknown")}</div>
          ${p.quote ? `<blockquote>${esc(p.quote)}</blockquote>` : ""}
          ${p.possible_duplicate_of ? `<div class="banner warn">Same name as another record but no shared identifier, so they were kept separate. <a href="#" data-prospect="${p.possible_duplicate_of}">Compare</a></div>` : ""}</div>
        <h3 class="section">What we know</h3>
        <div class="card">${Object.entries(p.known).map(([k, v]) => `<div class="kv"><span>${esc(k)}</span>${esc(typeof v === "string" ? v : JSON.stringify(v))}</div>`).join("") || `<div class="sub">Nothing recorded.</div>`}
          ${p.unknown.length ? `<div class="kv"><span>Unknown</span>${p.unknown.map((u) => `<span class="pill muted">${esc(u)}</span>`).join(" ")}</div>` : ""}
          <div class="kv"><span>Identifiers</span>${p.identifiers.map((i) => `<code>${esc(i.kind)}:${esc(i.value)}</code>`).join(" ")}</div></div>
        ${p.evidence.length > 1 ? `<h3 class="section">All evidence</h3>${p.evidence.map((e) => `<div class="card"><a href="${esc(safeUrl(e.source_url))}" target="_blank" rel="noopener noreferrer">${esc(e.source_url)}</a> <span class="sub">${esc(e.date ?? "")}</span>${e.quote ? `<blockquote>${esc(e.quote)}</blockquote>` : ""}</div>`).join("")}` : ""}
        <h3 class="section">Interaction history</h3>
        <div class="timeline">${p.interactions.map((i) => `<div><span class="sub">${fmtTime(i.at)}</span> <b>${esc(i.type)}</b> <span class="sub">${esc(agentName(i.agent_id ?? "owner"))}</span><div>${esc(i.summary)}</div></div>`).join("") || `<div class="sub">None yet.</div>`}</div>
        ${p.actions.length ? `<h3 class="section">Drafts &amp; actions</h3>${p.actions.map(actionCard).join("")}` : ""}
      </div>
      <div>
        <form class="card" id="pform">
          <label>Qualification<select name="qualification_status">${["new", "needs_info", "qualified", "disqualified"].map((s) => `<option ${p.qualification_status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
          <label>Rationale<textarea name="rationale" rows="3">${esc(p.rationale ?? "")}</textarea></label>
          <label>Owner<select name="owner_id"><option value="">—</option>${agentOptions(p.owner_id)}</select></label>
          <label>Next action<input name="next_action" value="${esc(p.next_action ?? "")}" /></label>
          <label>Contact permission<select name="contact_permission">${["unknown", "allowed", "do_not_contact"].map((s) => `<option ${p.contact_permission === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
          <div class="row-actions"><button class="btn-blue">Save</button></div>
        </form>
        <div class="card">
          <div class="kv"><span>Opt-out</span>${p.opted_out ? `<span class="pill bad">Opted out ${fmtTime(p.opted_out_at)}</span>` : `<span class="pill muted">No</span>`}</div>
          <div class="row-actions"><button class="${p.opted_out ? "btn-grey" : "btn-red"}" id="optout">${p.opted_out ? "Remove opt-out" : "Record opt-out"}</button></div>
          <div class="sub">Opt-outs block every agent and channel from contacting this person.</div>
        </div>
        <div class="card">
          <div class="kv"><span>Booking</span>${esc(p.booking_status ?? "none")}</div>
          <div class="row-actions"><button class="btn-blue" id="booked">Booking confirmed</button></div>
          <div class="sub">Starts call preparation (Daniel) for this prospect, once.</div>
        </div>
      </div>
    </div>`, { actions: `<button class="btn-grey" id="back-p">← Prospects</button>` });
  $("#back-p").onclick = () => nav.go({ name: "prospects" });
  $("#pform").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    await act(api(`/prospects/${id}`, { method: "PUT", body: { qualification_status: f.qualification_status.value, rationale: f.rationale.value, owner_id: f.owner_id.value || null, next_action: f.next_action.value, contact_permission: f.contact_permission.value } }), "Saved");
    renderProspect(id);
  };
  $("#optout").onclick = async () => {
    const note = p.opted_out ? "" : prompt("How did they opt out? (recorded)", "");
    if (note === null) return;
    await act(api(`/prospects/${id}/opt-out`, { method: "POST", body: { opted_out: !p.opted_out, note } }), p.opted_out ? "Opt-out removed" : "Opt-out recorded");
    renderProspect(id);
  };
  $("#booked").onclick = async () => {
    const r = await act(api(`/prospects/${id}/booking`, { method: "POST", body: { status: "confirmed" } }));
    toast(r.created.length ? r.created.map((t) => (t.deduplicated ? `Already started: ${t.title}` : `Started: ${t.title}`)).join(" · ") : "No booking trigger configured for this pipeline.", r.created.length ? "ok" : "err");
    renderProspect(id);
  };
  root.addEventListener("click", (e) => { const l = e.target.closest("[data-prospect]"); if (l) { e.preventDefault(); nav.go({ name: "prospect", id: l.dataset.prospect }); } });
}

// ---------------------------------------------------------------- Approvals & manual sends
export function actionCard(a) {
  const statusCls = { sent: "good", sent_manually: "good", ready_for_manual_send: "warn", pending_approval: "warn", uncertain: "warn", failed: "bad", denied: "bad", draft: "muted", blocked_opt_out: "bad" }[a.status] ?? "muted";
  return `<div class="card action" data-action="${a.id}">
    <div class="action-head"><span class="pill ${statusCls}">${esc(a.status.replace(/_/g, " "))}</span>
      <b>${esc((state.meta.actionTypes[a.action_type] ?? a.action_type))}</b> <span class="sub">via ${esc(a.channel)} · account ${esc(a.account)} · by ${esc(agentName(a.agent_id))}</span></div>
    ${a.destination ? `<div class="kv"><span>To</span>${/^https?:/.test(a.destination) ? `<a href="${esc(safeUrl(a.destination))}" target="_blank" rel="noopener noreferrer">${esc(a.destination)}</a>` : esc(a.destination)}</div>` : ""}
    ${a.subject ? `<div class="kv"><span>Subject</span>${esc(a.subject)}</div>` : ""}
    <pre class="content">${esc(a.content)}</pre>
    ${a.error ? `<div class="sub bad-text">${esc(a.error)}</div>` : ""}
    ${["ready_for_manual_send", "uncertain"].includes(a.status) ? `<div class="row-actions"><button class="btn-grey sm" data-copy="${a.id}">Copy text</button><button class="btn-blue sm" data-sent="${a.id}">I sent it</button><button class="btn-grey sm" data-notsent="${a.id}">Not sent</button></div>` : ""}
  </div>`;
}

export async function renderApprovals() {
  const [pending, actions, decided] = await Promise.all([api("/approvals?status=pending"), api("/actions"), api("/approvals")]);
  const manual = actions.filter((a) => ["ready_for_manual_send", "uncertain"].includes(a.status));
  const root = shell("Notifications", `
    <h3 class="section">Approval requests ${pending.length ? `<span class="pill bad">${pending.length}</span>` : ""}</h3>
    ${pending.map((ap) => `<div class="card approval-card" data-approval="${ap.id}">
      <div class="action-head">${agentById(ap.agent_id) ? ringed(agentById(ap.agent_id), "sm") : ""}<div><b>${esc(ap.summary)}</b><div class="sub">${fmtTime(ap.created_at)}${ap.task_id ? ` · <a href="#" data-task="${ap.task_id}">task</a>` : ""}</div></div></div>
      ${ap.kind === "action" ? `<div class="kv"><span>Action</span>${esc(state.meta.actionTypes[ap.details.action_type] ?? ap.details.action_type)}</div>
        <div class="kv"><span>Channel / account</span>${esc(ap.details.channel)} · ${esc(ap.details.account)}</div>
        <div class="kv"><span>Destination</span>${esc(ap.details.destination)}</div>
        ${ap.details.subject ? `<div class="kv"><span>Subject</span>${esc(ap.details.subject)}</div>` : ""}
        <pre class="content">${esc(ap.details.content)}</pre>` : `<pre class="content">${esc(ap.details.text ?? "")}</pre>`}
      <input placeholder="Optional note (sent back to the agent)" />
      <div class="row-actions"><button class="btn-blue" data-decide="1">Approve</button><button class="btn-grey" data-decide="0">Deny</button></div>
    </div>`).join("") || `<div class="sub">Nothing waiting. Actions outside your standing permissions appear here with the exact content.</div>`}
    <h3 class="section">Manual-send queue ${manual.length ? `<span class="pill warn">${manual.length}</span>` : ""}</h3>
    <div class="sub" style="margin-bottom:8px">Approved items for channels without automatic sending. They count as sent only after you confirm.</div>
    ${manual.map(actionCard).join("") || `<div class="sub">Empty.</div>`}
    <h3 class="section">Recent decisions</h3>
    <div class="timeline">${decided.filter((d) => d.status !== "pending").slice(0, 30).map((d) => `<div><span class="sub">${fmtTime(d.decided_at)}</span> <span class="pill ${d.status === "approved" ? "good" : "bad"}">${esc(d.status)}</span> ${esc(d.summary)}${d.note ? `<div class="sub">${esc(d.note)}</div>` : ""}</div>`).join("") || `<div class="sub">None yet.</div>`}</div>`);
  root.addEventListener("click", async (e) => {
    const d = e.target.closest("[data-decide]");
    if (d) {
      const card = d.closest("[data-approval]");
      d.disabled = true;
      await act(api(`/approvals/${card.dataset.approval}/decide`, { method: "POST", body: { approved: d.dataset.decide === "1", note: card.querySelector("input").value } }), d.dataset.decide === "1" ? "Approved" : "Denied");
      return renderApprovals();
    }
    await handleActionButtons(e, renderApprovals);
    const t = e.target.closest("[data-task]");
    if (t) { e.preventDefault(); nav.openTask(t.dataset.task); }
  });
}
export async function handleActionButtons(e, rerender) {
  const b = e.target.closest("[data-copy],[data-sent],[data-notsent]");
  if (!b) return;
  if (b.dataset.copy) {
    const a = (await api("/actions")).find((x) => x.id === b.dataset.copy);
    await navigator.clipboard.writeText(a.content).then(() => toast("Copied")).catch(() => toast("Copy failed", "err"));
  } else {
    const sent = Boolean(b.dataset.sent);
    const note = sent ? "" : prompt("What happened? (recorded)", "") ?? "";
    await act(api(`/actions/${b.dataset.sent || b.dataset.notsent}/manual`, { method: "POST", body: { sent, note } }), sent ? "Marked sent" : "Marked not sent");
    rerender();
  }
}

// ---------------------------------------------------------------- Permissions
export async function renderPermissions() {
  const grants = await api("/grants");
  const types = state.meta.actionTypes;
  const root = shell("Permissions", `
    <div class="sub" style="margin-bottom:10px">What each member may do at all. Enforced when a tool runs, not just in prompts. New members get Research and Drafting only.</div>
    <div class="table-wrap"><table class="grid-table perm"><thead><tr><th>Member</th>${Object.values(types).map((l) => `<th>${esc(l.split(" (")[0])}</th>`).join("")}</tr></thead>
      <tbody>${state.agents.map((a) => `<tr><td>${agentChip(a.id)}</td>${Object.keys(types).map((k) => `<td><input type="checkbox" data-agent="${a.id}" data-perm="${k}" ${a.permissions.includes(k) ? "checked" : ""} /></td>`).join("")}</tr>`).join("")}</tbody></table></div>
    <h3 class="section">Standing authorizations</h3>
    <div class="sub" style="margin-bottom:10px">Inside a grant, actions run without asking you each time. Everything else goes to the approval queue. Opt-outs always win.</div>
    <form class="card form-grid" id="gform">
      <label>Member<select name="agent_id">${agentOptions("", { any: true })}</select></label>
      <label>Action<select name="action_type">${["public_post", "private_message", "email_send", "external_update"].map((k) => `<option value="${k}">${esc(types[k])}</option>`).join("")}</select></label>
      <label>Channel<select name="channel"><option value="*">Any</option>${Object.entries(state.meta.channels).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select></label>
      <label>Account<input name="account" placeholder="* = any, or e.g. hasan@company.com" value="*" /></label>
      <label>Daily limit<input name="daily_limit" type="number" min="0" placeholder="no limit" /></label>
      <label>Total limit<input name="total_limit" type="number" min="0" placeholder="no limit" /></label>
      <label>Expires<input name="expires_at" type="date" /></label>
      <label>Note<input name="note" placeholder="why" /></label>
      <div class="span2 row-actions"><button class="btn-blue">Grant</button></div>
    </form>
    <div class="table-wrap"><table class="grid-table"><thead><tr><th>Member</th><th>Action</th><th>Channel</th><th>Account</th><th>Limits</th><th>Used (today/total)</th><th>Status</th><th></th></tr></thead>
    <tbody>${grants.map((g) => `<tr><td>${g.agent_id === "*" ? "Any member" : agentChip(g.agent_id)}</td><td>${esc(types[g.action_type])}</td><td>${esc(g.channel)}</td><td>${esc(g.account)}</td>
      <td class="sub">${g.daily_limit ?? "∞"}/day · ${g.total_limit ?? "∞"} total${g.expires_at ? ` · until ${new Date(g.expires_at).toLocaleDateString()}` : ""}</td>
      <td>${g.usage.today} / ${g.usage.total}</td><td>${g.revoked_at ? `<span class="pill muted">revoked</span>` : `<span class="pill good">active</span>`}</td>
      <td>${g.revoked_at ? "" : `<button class="btn-red sm" data-revoke="${g.id}">Revoke</button>`}</td></tr>`).join("") || `<tr><td colspan="8" class="sub empty-row">No standing authorizations. Every external action asks you first.</td></tr>`}</tbody></table></div>`);
  root.querySelector(".perm").addEventListener("change", async (e) => {
    const cb = e.target.closest("[data-perm]");
    if (!cb) return;
    const a = agentById(cb.dataset.agent);
    const perms = new Set(a.permissions);
    cb.checked ? perms.add(cb.dataset.perm) : perms.delete(cb.dataset.perm);
    await act(api(`/agents/${a.id}`, { method: "PUT", body: { permissions: [...perms] } }), `${a.name}: permissions saved`);
    state.agents = await api("/agents");
  });
  $("#gform").onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (f.expires_at) f.expires_at = new Date(f.expires_at + "T23:59:59").getTime(); else delete f.expires_at;
    await act(api("/grants", { method: "POST", body: f }), "Granted");
    renderPermissions();
  };
  root.addEventListener("click", async (e) => {
    const r = e.target.closest("[data-revoke]");
    if (r && confirm("Revoke this authorization?")) { await act(api(`/grants/${r.dataset.revoke}`, { method: "DELETE" }), "Revoked"); renderPermissions(); }
  });
}

// ---------------------------------------------------------------- Connections
const CONN_CLS = { working: "good", untested: "warn", failed: "bad", not_configured: "muted" };
const CONN_LABEL = { working: "Working", untested: "Connected, untested", failed: "Failed or expired", not_configured: "Not configured" };
export async function renderConnections() {
  const rows = await api("/connections");
  const root = shell("Connections", `
    <div class="grid">${rows.map((c) => `<div class="card conn-card">
      <div class="action-head"><b>${esc(c.name)}</b><span class="pill ${CONN_CLS[c.status]}">${CONN_LABEL[c.status]}</span></div>
      <div class="sub">${esc(c.purpose)}</div>
      ${c.detail ? `<div class="detail">${esc(c.detail)}</div>` : ""}
      <div class="sub">${c.last_tested_at ? `Checked ${ago(c.last_tested_at)} ago` : "Never checked"}${c.last_ok_at ? ` · last OK ${ago(c.last_ok_at)} ago` : ""}</div>
      ${c.fallback ? `<div class="sub fallback">If unavailable: ${esc(c.fallback)}</div>` : ""}
      ${c.testable ? `<div class="row-actions"><button class="btn-grey sm" data-test="${esc(c.key)}">Test now</button></div>` : ""}
    </div>`).join("")}</div>
    <div class="sub" style="margin-top:14px">Only real integrations are listed. “Working” means a real check or a real run succeeded. Sending to LinkedIn and Reddit has no automatic connector: approved messages go to your manual-send queue.</div>
    <h3 class="section">AI providers</h3>
    <div class="sub" style="margin-bottom:10px">Any OpenAI-compatible API (Groq, OpenRouter, Together, Fireworks, Ollama). One account per provider; rate limits are respected, not rotated around. Keys are saved only in this PC's <code>.env</code> and never shown again.</div>
    <div id="providers"></div>`);
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-test]");
    if (!b) return;
    b.disabled = true;
    b.textContent = "Testing…";
    await act(api(`/connections/${encodeURIComponent(b.dataset.test)}/test`, { method: "POST", body: {} }));
    renderConnections();
  });
  renderProviders($("#providers"));
}

async function refreshMeta() {
  state.meta = await api("/meta");
}

async function renderProviders(el) {
  const { presets, providers } = await api("/providers");
  el.innerHTML = `
    ${providers.map((p) => `<div class="card" data-prov="${p.id}">
      <div class="action-head"><b>${esc(p.name)}</b><span class="sub">${esc(p.base_url)}</span>
        ${p.needs_key ? (p.key_set ? `<span class="pill good">key ${esc(p.key_hint)}</span>` : `<span class="pill bad">no key</span>`) : `<span class="pill muted">no key needed</span>`}</div>
      <div class="form-grid">
        <label>Model<input name="model" value="${esc(p.model)}" list="models-${p.id}" /><datalist id="models-${p.id}"></datalist></label>
        <label>${p.needs_key ? `Replace API key (${esc(p.key_env)})` : "API key"}<input name="api_key" type="password" autocomplete="off" placeholder="${p.key_set ? "leave empty to keep the current key" : "paste key"}" ${p.needs_key ? "" : "disabled"} /></label>
        <label>Price in ($ per 1M tokens, optional)<input name="price_in" type="number" step="any" min="0" value="${p.price_in ?? ""}" /></label>
        <label>Price out ($ per 1M tokens, optional)<input name="price_out" type="number" step="any" min="0" value="${p.price_out ?? ""}" /></label>
      </div>
      <div class="test-result sub"></div>
      <div class="row-actions"><button class="btn-red sm" data-pdel="${p.id}">Delete</button><button class="btn-grey sm" data-ptest="${p.id}">Test &amp; list models</button><button class="btn-blue sm" data-psave="${p.id}">Save</button></div>
    </div>`).join("")}
    <details class="card create"><summary><b>＋ Add a provider</b></summary>
      <form id="pform-new" class="form-grid">
        <label>Preset<select name="preset"><option value="">Custom</option>${Object.entries(presets).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join("")}</select></label>
        <label>Name<input name="name" required /></label>
        <label class="span2">Base URL<input name="base_url" required placeholder="https://api.groq.com/openai/v1" /></label>
        <label>Model<input name="model" required placeholder="Test after saving to see the list" /></label>
        <label>Key variable name<input name="key_env" placeholder="GROQ_API_KEY (empty for local Ollama)" /></label>
        <label class="span2">API key<input name="api_key" type="password" autocomplete="off" placeholder="Saved to .env on this PC only" /></label>
        <div class="span2 row-actions"><button class="btn-blue">Add provider</button></div>
      </form>
    </details>`;
  const form = $("#pform-new", el);
  form.preset.onchange = () => {
    const p = presets[form.preset.value];
    if (!p) return;
    form.name.value = p.name; form.base_url.value = p.base_url; form.model.value = p.model; form.key_env.value = p.key_env;
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    delete body.preset;
    await act(api("/providers", { method: "POST", body }), "Provider added. Click Test to check it.");
    await refreshMeta();
    renderProviders(el);
  };
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-ptest],[data-psave],[data-pdel]");
    if (!b) return;
    const card = b.closest("[data-prov]");
    const id = b.dataset.ptest || b.dataset.psave || b.dataset.pdel;
    if (b.dataset.pdel) {
      if (!confirm("Delete this provider? Its key stays in .env.")) return;
      await act(api(`/providers/${id}`, { method: "DELETE" }), "Deleted");
      await refreshMeta();
      return renderProviders(el);
    }
    if (b.dataset.psave) {
      const p = providers.find((x) => x.id === id);
      const body = { name: p.name, base_url: p.base_url, key_env: p.key_env, model: card.querySelector("[name=model]").value,
        price_in: card.querySelector("[name=price_in]").value, price_out: card.querySelector("[name=price_out]").value };
      const key = card.querySelector("[name=api_key]").value;
      if (key) body.api_key = key;
      await act(api(`/providers/${id}`, { method: "PUT", body }), "Saved");
      await refreshMeta();
      return renderProviders(el);
    }
    b.disabled = true;
    b.textContent = "Testing…";
    const out = card.querySelector(".test-result");
    try {
      const r = await api(`/providers/${id}/test`, { method: "POST", body: {} });
      card.querySelector("datalist").innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join("");
      out.innerHTML = r.model_available
        ? `<span class="pill good">Working</span> replied “${esc(r.reply)}”. ${r.models.length} models on this account; click the Model box to pick another.${r.limits?.remaining_requests != null ? ` Requests left: ${esc(r.limits.remaining_requests)}/${esc(r.limits.limit_requests ?? "?")}.` : ""}`
        : `<span class="pill bad">Model not available</span> “${esc(card.querySelector("[name=model]").value)}” isn't offered. Pick one from the Model box, then Save.`;
    } catch (err) {
      out.innerHTML = `<span class="pill bad">Failed</span> ${esc(err.message)}`;
    }
    b.disabled = false;
    b.textContent = "Test & list models";
  });
}

// ---------------------------------------------------------------- Schedules
const PRESETS = [["0 9 * * 1-5", "Weekdays 9:00"], ["0 9 * * *", "Every day 9:00"], ["0 9 * * 1", "Mondays 9:00"], ["0 */4 * * *", "Every 4 hours"], ["*/30 * * * *", "Every 30 minutes"]];
const TZS = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Toronto", "America/Vancouver", "Europe/London", "Asia/Karachi", "Asia/Dubai", "UTC"];
export async function renderSchedules() {
  const [{ health, schedules }, wfs] = await Promise.all([api("/schedules"), api("/workflows")]);
  const tzList = [...new Set([state.meta.timezone, ...TZS])];
  const root = shell("Schedules", `
    <div class="banner ${health.worker_alive && health.autostart.installed ? "good" : health.worker_alive ? "warn" : "bad"}">${esc(health.statement)}</div>
    <details class="card create"><summary><b>＋ New schedule</b></summary>
      <form id="sform" class="form-grid">
        <label>Name<input name="name" required placeholder="e.g. Daily job-seeker research" /></label>
        <label>Runs<select name="target_type" id="ttype"><option value="workflow">A workflow</option><option value="task">A task for one member</option></select></label>
        <label class="t-wf">Workflow<select name="workflow_id">${wfs.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join("")}</select></label>
        <label class="t-task" hidden>Member<select name="agent_id">${agentOptions("", { none: true })}</select></label>
        <label class="span2 t-task" hidden>Instructions each run<textarea name="prompt" rows="3"></textarea></label>
        <label>When<select id="preset"><option value="">Custom…</option>${PRESETS.map(([c, l]) => `<option value="${c}">${l}</option>`).join("")}</select></label>
        <label>Cron (min hour day month weekday)<input name="cron" required value="0 9 * * 1-5" /></label>
        <label>Time zone<select name="timezone">${tzList.map((z) => `<option ${z === state.meta.timezone ? "selected" : ""}>${z}</option>`).join("")}</select></label>
        <label>If the previous run is still going<select name="overlap_policy"><option value="skip">Skip this run</option><option value="queue">Queue it anyway</option></select></label>
        <label>If runs were missed (app off)<select name="missed_policy"><option value="run_once">Run once when back</option><option value="skip">Skip missed runs</option></select></label>
        <div class="span2 row-actions"><button class="btn-blue">Create schedule</button></div>
      </form></details>
    ${schedules.map((s) => `<div class="card sched">
      <div class="action-head"><b>${esc(s.name ?? s.cron)}</b> ${s.enabled ? (health.worker_alive ? `<span class="pill good">Active</span>` : `<span class="pill bad">Not running</span>`) : `<span class="pill muted">Paused</span>`}
        <span class="sub">${s.target_type === "workflow" ? `workflow: ${esc(wfs.find((w) => w.id === s.workflow_id)?.name ?? "?")}` : `task for ${esc(agentName(s.agent_id))}`}</span></div>
      <div class="kv"><span>Schedule</span><code>${esc(s.cron)}</code> · ${esc(s.timezone ?? "")}</div>
      <div class="kv"><span>Next run</span>${s.enabled && s.next_run_at ? `${new Date(s.next_run_at).toLocaleString([], { timeZone: s.timezone, dateStyle: "medium", timeStyle: "short" })} (${esc(s.timezone)}) · ${fmtTime(s.next_run_at)} your time` : "—"}</div>
      <div class="kv"><span>Policies</span>overlap: ${esc(s.overlap_policy)} · missed: ${esc(s.missed_policy.replace("_", " "))}</div>
      ${s.target_type === "task" ? `<div class="sub clamp">${esc(s.prompt)}</div>` : ""}
      <div class="row-actions"><button class="btn-grey sm" data-toggle="${s.id}" data-on="${s.enabled ? 0 : 1}">${s.enabled ? "Pause" : "Resume"}</button>
        <button class="btn-grey sm" data-runnow="${s.id}">Run now</button><button class="btn-red sm" data-del="${s.id}">Delete</button></div>
      <details><summary class="sub">Run history (${s.history.length})</summary><div class="timeline">${s.history.map((h) => `<div><span class="sub">${fmtTime(h.fired_at)}</span> <b>${esc(h.outcome.replace(/_/g, " "))}</b>${h.note ? ` <span class="sub">${esc(h.note)}</span>` : ""}${h.task_id ? ` <a href="#" data-task="${h.task_id}">task</a>` : ""}${h.workflow_run_id ? ` <a href="#" data-wfrun="${h.workflow_run_id}">run</a>` : ""}</div>`).join("") || `<div class="sub">Not fired yet.</div>`}</div></details>
    </div>`).join("") || `<div class="sub">No schedules yet.</div>`}`, { sub: "Schedules are checked by the server's background worker every few seconds. No browser tab is needed." });
  const showType = () => {
    const wf = $("#ttype").value === "workflow";
    root.querySelectorAll(".t-wf").forEach((el) => (el.hidden = !wf));
    root.querySelectorAll(".t-task").forEach((el) => (el.hidden = wf));
  };
  $("#ttype").onchange = showType;
  $("#preset").onchange = (e) => { if (e.target.value) $("#sform").cron.value = e.target.value; };
  $("#sform").onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    await act(api("/schedules", { method: "POST", body }), "Schedule created");
    renderSchedules();
  };
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-toggle],[data-runnow],[data-del],[data-task],[data-wfrun]");
    if (!b) return;
    e.preventDefault();
    if (b.dataset.toggle) await act(api(`/schedules/${b.dataset.toggle}`, { method: "PUT", body: { enabled: b.dataset.on === "1" } }));
    else if (b.dataset.runnow) await act(api(`/schedules/${b.dataset.runnow}/run-now`, { method: "POST", body: {} }), "Started");
    else if (b.dataset.del) { if (!confirm("Delete this schedule?")) return; await act(api(`/schedules/${b.dataset.del}`, { method: "DELETE" })); }
    else if (b.dataset.task) return nav.openTask(b.dataset.task);
    else if (b.dataset.wfrun) return nav.go({ name: "wfrun", id: b.dataset.wfrun });
    renderSchedules();
  });
}

// ---------------------------------------------------------------- Settings (limits, usage, context)
const LIMIT_HELP = {
  max_concurrent_runs: ["Concurrent runs", "More queued tasks wait for a free slot."],
  max_runtime_minutes: ["Max runtime per run (minutes)", "The run is stopped and counted as a timeout; it's retried while attempts remain. Time spent waiting for your approval doesn't count."],
  max_attempts: ["Max attempts per task", "After this many tries a task is marked Failed and waits for you to Retry."],
  max_tool_actions: ["Max tool actions per run", "The run stops as Failed (not retried) so a stuck agent can't loop forever."],
  daily_spend_usd: ["Daily spend cap (USD, estimated; 0 = no cap)", "Off by default on your Claude plan, where these are estimates, not charges. If set: no new runs start after the cap until local midnight, and each turn gets only the remaining amount."],
  per_run_budget_usd: ["Per-run budget (USD, estimated; 0 = no cap)", "Off by default on your Claude plan. If set: a task run that reaches it stops with a budget error."],
};
export async function renderSettings() {
  const [s, usage, sys] = await Promise.all([api("/settings"), api("/usage"), api("/system")]);
  const L = usage.limits;
  const byDay = {};
  for (const r of usage.rows) (byDay[r.day] ??= []).push(r);
  const root = shell("Settings", `
    <div class="two-col">
      <div>
        <form class="card" id="lform"><h3>Run limits</h3>
          ${Object.entries(LIMIT_HELP).map(([k, [label, help]]) => `<label>${label}<input type="number" step="any" min="0" name="${k}" value="${L[k]}" /><span class="hint">${help}</span></label>`).join("")}
          <div class="row-actions"><button class="btn-blue">Save limits</button></div></form>
        <div class="card"><h3>Usage</h3>
          <div class="big-num">${money(usage.today)} <span class="sub">estimated today of ${money(L.daily_spend_usd)} limit</span></div>
          <div class="meter"><span style="width:${Math.min(100, (usage.today / Math.max(0.01, L.daily_spend_usd)) * 100)}%"></span></div>
          <div class="sub">${state.meta.engine === "claude-code" ? "Estimates come from Claude Code and show the API-equivalent cost. On your Claude plan you're billed by plan, not per run, but heavy use still hits plan usage limits. The limits here apply to these estimates." : "Estimated from token counts at list prices."}</div>
          <table class="grid-table small"><thead><tr><th>Day</th><th>Member</th><th>Calls</th><th>Tokens in/out</th><th>Est. cost</th></tr></thead>
          <tbody>${Object.entries(byDay).flatMap(([day, rs]) => rs.map((r) => `<tr><td>${esc(day)}</td><td>${esc(agentName(r.agent_id))}</td><td>${r.calls}</td><td>${r.input_tokens}/${r.output_tokens}</td><td>${money(r.cost)}</td></tr>`)).join("") || `<tr><td colspan="5" class="sub empty-row">No usage yet.</td></tr>`}</tbody></table></div>
      </div>
      <div>
        <div class="card"><h3>Background worker</h3>
          <div class="banner ${sys.worker.alive ? "good" : "bad"}">${esc(sys.scheduler.statement)}</div>
          <div class="sub">To keep tasks and schedules running after reboots: right-click <code>install-autostart.ps1</code> in the app folder → <b>Run with PowerShell</b>. Undo with <code>uninstall-autostart.ps1</code>. The PC must be on, awake and signed in.</div></div>
        <div class="card"><h3>Business context</h3><div class="sub">Every team member reads this before each task.</div>
          <textarea id="ctx" rows="12" style="margin-top:8px">${esc(s.company_context)}</textarea>
          <div class="row-actions"><button class="btn-blue" id="save-ctx">Save</button></div></div>
        <div class="card"><h3>Engine</h3><div class="sub">${state.meta.engine === "claude-code" ? "Claude Code login on this PC (your Claude plan). If runs fail with a login error, open a terminal, run <code>claude</code> and sign in." : "Anthropic API key from .env."}</div></div>
        <div class="card"><h3>More</h3><div class="row-actions"><button class="btn-grey" data-go="memory">Memory</button><button class="btn-grey" data-go="browser">Browser &amp; accounts</button><button class="btn-grey" data-go="connections">Connections</button></div></div>
      </div>
    </div>`);
  $("#lform").onsubmit = async (e) => {
    e.preventDefault();
    await act(api("/limits", { method: "PUT", body: Object.fromEntries(new FormData(e.target)) }), "Limits saved");
    renderSettings();
  };
  $("#save-ctx").onclick = () => act(api("/settings", { method: "PUT", body: { company_context: $("#ctx").value } }), "Saved");
  root.addEventListener("click", (e) => { const b = e.target.closest("[data-go]"); if (b) nav.go({ name: b.dataset.go }); });
}

export const statusIcon = icon;
