// Clients and their job search: profile, matched postings (link checked by the system), fit scores,
// application packs, and what you've applied to. Nothing is submitted by the team.
import { $, esc, api, nav, toast, fmtTime, agentName } from "./core.js";

const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? "")) ? String(u) : "#");
const LINK = {
  live: ["good", "link live"], blocked: ["warn", "check link yourself"], closed: ["bad", "posting closed"], dead: ["bad", "link dead"],
};
const STATUS_PILL = { found: "muted", shortlisted: "warn", skipped: "muted", tailored: "good", applied: "good", interview: "good", offer: "good", rejected: "bad", closed: "bad" };
const STATUS_LABEL = { tailored: "ready to apply" };
let jobFilter = "open";

const shell = (title, body, { sub = "", actions = "" } = {}) => {
  $("#main").innerHTML = `<div class="page"><div class="page-inner wide">
    <div class="page-head"><div><div class="page-title">${title}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div><div class="head-actions">${actions}</div></div>
    ${body}</div></div>`;
  return $(".page-inner");
};

function clientForm(c = {}) {
  const v = (k) => esc(Array.isArray(c[k]) ? c[k].join(", ") : c[k] ?? "");
  return `<form class="card" id="client-form">
    <div class="form-grid">
      <label>Label<input name="label" value="${v("label")}" placeholder="Client A" required /><span class="hint">What the team sees and uses in files.</span></label>
      <label>Full name (private)<input name="full_name" value="${v("full_name")}" /><span class="hint">Only shown to you; never sent to agents.</span></label>
      <label>Target titles<input name="target_titles" value="${v("target_titles")}" placeholder="Director of Operations, Head of Operations" required /><span class="hint">Comma-separated.</span></label>
      <label>Locations<input name="locations" value="${v("locations")}" placeholder="Toronto, ON; Remote (Canada)" /></label>
      <label>Work mode<select name="work_mode">${["any", "remote", "hybrid", "onsite"].map((m) => `<option ${c.work_mode === m ? "selected" : ""}>${m}</option>`).join("")}</select></label>
      <label>Seniority<input name="seniority" value="${v("seniority")}" placeholder="Director, 12+ years" /></label>
      <label>Salary floor<input name="salary_floor" value="${v("salary_floor")}" placeholder="CAD 150k" /></label>
      <label>Industries<input name="industries" value="${v("industries")}" placeholder="SaaS, fintech" /></label>
    </div>
    <label>Target companies<textarea name="target_companies" rows="2" placeholder="Shopify, Stripe, lever:palantir, https://jobs.ashbyhq.com/ramp">${v("target_companies")}</textarea><span class="hint">Scout checks these companies' job boards directly (Greenhouse, Lever, Ashby, SmartRecruiters). Comma-separated.</span></label>
    <label>Must-haves<textarea name="must_haves" rows="2">${v("must_haves")}</textarea></label>
    <label>Exclusions<textarea name="exclusions" rows="2" placeholder="No agencies, no relocation, no commission-only">${v("exclusions")}</textarea></label>
    <label>Resume (plain text)<textarea name="resume_text" rows="8" placeholder="Paste the client's resume. Application packs use only what's here.">${v("resume_text")}</textarea></label>
    <label>Notes<textarea name="notes" rows="2">${v("notes")}</textarea></label>
    ${c.id ? `<label>Status<select name="status"><option ${c.status === "active" ? "selected" : ""}>active</option><option ${c.status === "paused" ? "selected" : ""}>paused</option></select></label>` : ""}
    <div class="row-actions"><button class="btn-blue">${c.id ? "Save profile" : "Add client"}</button></div>
  </form>`;
}

async function submitClient(e, id) {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try {
    const c = await api(id ? `/clients/${id}` : "/clients", { method: id ? "PUT" : "POST", body });
    toast(id ? "Profile saved" : "Client added");
    nav.go({ name: "client", id: c.id });
  } catch (err) { toast(err.message, "err"); }
}

export async function renderClients() {
  const rows = await api("/clients");
  const root = shell("Clients", `
    <div class="table-wrap"><table class="grid-table"><thead><tr><th>Client</th><th>Looking for</th><th>Shortlisted</th><th>Ready to apply</th><th>Applied</th><th></th></tr></thead><tbody>
      ${rows.map((c) => `<tr class="clickable" data-client="${c.id}"><td><b>${esc(c.label)}</b>${c.full_name ? `<div class="sub">${esc(c.full_name)}</div>` : ""}${c.status === "paused" ? ` <span class="pill muted">paused</span>` : ""}</td>
        <td class="sub">${esc(c.target_titles.join(", "))}${c.locations.length ? ` · ${esc(c.locations.join(", "))}` : ""}${c.has_resume ? "" : ` <span class="pill warn">no resume</span>`}</td>
        <td>${c.counts.shortlisted ?? 0}</td><td>${c.counts.tailored ?? 0}</td><td>${(c.counts.applied ?? 0) + (c.counts.interview ?? 0) + (c.counts.offer ?? 0)}</td>
        <td>${c.searching ? `<span class="pill warn">searching…</span>` : ""}</td></tr>`).join("") || `<tr><td colspan="6" class="sub empty-row">No clients yet. Add one below.</td></tr>`}
    </tbody></table></div>
    <h3 class="section">Add a client</h3>${clientForm()}`,
    { sub: "Scout finds and checks postings for each client; Zara writes the application packs. You apply (nothing is submitted for you)." });
  root.querySelector("tbody").addEventListener("click", (e) => { const r = e.target.closest("[data-client]"); if (r) nav.go({ name: "client", id: r.dataset.client }); });
  $("#client-form").onsubmit = (e) => submitClient(e, null);
}

export async function renderClient(id) {
  let d;
  try { d = await api(`/clients/${id}`); } catch { return shell("Client", `<div class="banner bad">Client not found.</div>`); }
  const c = d.client;
  const open = (j) => !["skipped", "rejected", "closed"].includes(j.status) && !["dead", "closed"].includes(j.link_state);
  const shown = d.jobs.filter((j) => (jobFilter === "open" ? open(j) : jobFilter === "applied" ? ["applied", "interview", "offer"].includes(j.status) : true));
  const root = shell(esc(c.label), `
    ${!c.resume_text ? `<div class="banner warn">No resume yet. Scout can still find jobs, but application packs need the resume text.</div>` : ""}
    <div class="two-col">
      <div>
        <div class="tabs-row">${[["open", "Open"], ["applied", "Applied"], ["all", "All"]].map(([k, l]) => `<button class="${jobFilter === k ? "on" : ""}" data-filter="${k}">${l}</button>`).join("")}</div>
        ${shown.map(jobCard).join("") || `<div class="sub">No jobs here yet. Click <b>Find jobs</b>.</div>`}
      </div>
      <div><h3 class="section">Profile</h3>${clientForm(c)}</div>
    </div>`, {
    sub: `${esc(c.target_titles.join(", "))}${c.locations.length ? ` · ${esc(c.locations.join(", "))}` : ""} · ${esc(c.work_mode)}`,
    actions: `${d.schedule ? `<span class="pill good" title="next run ${esc(fmtTime(d.schedule.next_run_at))}">Daily search on · ${esc(d.schedule.cron.split(" ")[1])}:00 · target ${d.schedule.input.target_count}</span> <button class="btn-grey sm" id="sched-off">Stop daily</button>` : `<button class="btn-grey" id="sched-on">Search daily</button>`}
      ${d.active_run ? `<a class="pill warn" href="#" data-run="${d.active_run.id}">Search running…</a>` : ""}
      <button class="btn-blue" id="find-jobs" ${d.active_run || !d.workflow_id ? "disabled" : ""}>Find jobs</button>`,
  });
  $("#client-form").onsubmit = (e) => submitClient(e, c.id);
  const so = $("#sched-on"), sf = $("#sched-off");
  if (so) so.onclick = async () => {
    const hour = prompt("Run the search every weekday at what hour? (0-23, this PC's time)", "8");
    if (hour === null) return;
    const n = prompt("How many matching jobs per day?", "20");
    if (!n) return;
    try { await api(`/clients/${c.id}/schedule`, { method: "POST", body: { hour: Number(hour), target_count: Number(n) } }); toast("Daily search scheduled"); renderClient(c.id); } catch (err) { toast(err.message, "err"); }
  };
  if (sf) sf.onclick = async () => { try { await api(`/clients/${c.id}/schedule`, { method: "POST", body: { off: true } }); toast("Daily search stopped"); renderClient(c.id); } catch (err) { toast(err.message, "err"); } };
  $("#find-jobs").onclick = async () => {
    const n = prompt(`How many matching jobs should Scout aim for?\n\nScout searches LinkedIn, company job boards and remote boards; Zara writes the packs. Both use your Claude plan. Nothing is submitted.`, "10");
    if (!n) return;
    try { await api(`/clients/${c.id}/search`, { method: "POST", body: { target_count: Number(n) } }); toast("Job search started"); renderClient(c.id); } catch (err) { toast(err.message, "err"); }
  };
  root.addEventListener("click", async (e) => {
    const f = e.target.closest("[data-filter]");
    if (f) { jobFilter = f.dataset.filter; return renderClient(c.id); }
    const run = e.target.closest("[data-run]");
    if (run) { e.preventDefault(); return nav.go({ name: "wfrun", id: run.dataset.run }); }
    const st = e.target.closest("[data-status]");
    if (st) {
      const jobId = st.closest("[data-job]").dataset.job;
      const note = st.dataset.status === "applied" ? prompt("Note (optional): when/how you applied", "") : null;
      try { await api(`/jobs/${jobId}/status`, { method: "PUT", body: { status: st.dataset.status, note } }); renderClient(c.id); } catch (err) { toast(err.message, "err"); }
      return;
    }
    const rc = e.target.closest("[data-recheck]");
    if (rc) {
      try { const j = await api(`/jobs/${rc.closest("[data-job]").dataset.job}/recheck`, { method: "POST", body: {} }); toast(`Link: ${LINK[j.link_state]?.[1] ?? j.link_state}`); renderClient(c.id); } catch (err) { toast(err.message, "err"); }
      return;
    }
    const cp = e.target.closest("[data-copy]");
    if (cp) { await navigator.clipboard.writeText(cp.closest(".app-pack").querySelector("pre").textContent); toast("Cover note copied"); }
    const ed = e.target.closest("[data-edit-app]");
    if (ed) {
      const card = ed.closest("[data-job]");
      const slot = card.querySelector(".form-slot");
      if (slot.innerHTML) { slot.innerHTML = ""; return; }
      slot.innerHTML = `<form class="edit-app"><textarea name="cover_note" rows="8">${esc(card.querySelector(".app-pack pre")?.textContent ?? "")}</textarea>
        <div class="row-actions"><span class="sub">Saved as a new version marked manual.</span><button class="btn-blue sm">Save</button></div></form>`;
      slot.querySelector("form").onsubmit = async (ev) => {
        ev.preventDefault();
        const prev = d.jobs.find((x) => x.id === card.dataset.job)?.application ?? {};
        try { await api(`/jobs/${card.dataset.job}/application`, { method: "PUT", body: { ...prev, cover_note: ev.target.cover_note.value } }); toast("Saved"); renderClient(c.id); } catch (err) { toast(err.message, "err"); }
      };
    }
  });
}

function jobCard(j) {
  const [lc, ll] = LINK[j.link_state] ?? ["muted", "link not checked"];
  const a = j.application;
  return `<div class="card" data-job="${j.id}">
    <div class="action-head"><a href="${esc(safeUrl(j.url))}" target="_blank" rel="noopener noreferrer"><b>${esc(j.title)}</b></a> <span>· ${esc(j.company)}</span>
      <span class="pill ${STATUS_PILL[j.status] ?? "muted"}">${esc(STATUS_LABEL[j.status] ?? j.status)}</span>
      ${j.fit_score != null ? `<span class="pill ${j.fit_score >= 75 ? "good" : j.fit_score >= 55 ? "warn" : "muted"}">fit ${j.fit_score}</span>` : ""}
      <span class="pill ${lc}" title="${esc(j.link_note ?? "")}">${ll}</span></div>
    <div class="sub">${esc([j.location, j.work_mode, j.salary_text, j.posted_date && `posted ${j.posted_date}`, j.source].filter(Boolean).join(" · "))}</div>
    ${j.fit_reasons.length ? `<div class="kv"><span>Why it fits</span>${esc(j.fit_reasons.join("; "))}</div>` : ""}
    ${j.gaps.length ? `<div class="kv"><span>Gaps</span>${esc(j.gaps.join("; "))}</div>` : ""}
    ${a ? `<details class="app-pack" open><summary><b>Application pack</b> <span class="sub">v${a.version} · ${a.origin === "manual" ? "your edit" : esc(agentName(a.by))} · ${fmtTime(a.at)}</span>
        ${a.checks?.no_placeholders === false ? `<span class="pill bad">has [placeholders]</span>` : ""}</summary>
      <pre class="content">${esc(a.cover_note)}</pre>
      ${a.resume_tweaks?.length ? `<div class="kv"><span>Resume tweaks</span><ul>${a.resume_tweaks.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
      ${a.screening_answers ? `<div class="kv"><span>Screening answers</span>${esc(a.screening_answers)}</div>` : ""}
      ${a.owner_notes ? `<div class="banner warn">${esc(a.owner_notes)}</div>` : ""}
      <div class="row-actions"><button class="btn-grey sm" data-copy>Copy cover note</button><button class="btn-grey sm" data-edit-app>Edit</button></div></details>` : ""}
    ${j.owner_note ? `<div class="sub">Your note: ${esc(j.owner_note)}</div>` : ""}
    <div class="row-actions">
      ${["applied", "interview", "offer", "rejected"].includes(j.status) ? "" : `<button class="btn-blue sm" data-status="applied">I applied</button>`}
      ${j.status === "applied" ? `<button class="btn-grey sm" data-status="interview">Interview</button>` : ""}
      ${j.status === "interview" ? `<button class="btn-grey sm" data-status="offer">Offer</button>` : ""}
      ${["applied", "interview"].includes(j.status) ? `<button class="btn-grey sm" data-status="rejected">Rejected</button>` : ""}
      ${["found", "shortlisted", "tailored"].includes(j.status) ? `<button class="btn-grey sm" data-status="skipped">Not interested</button>` : ""}
      <button class="btn-grey sm" data-recheck>Recheck link</button>
    </div>
    <div class="form-slot"></div>
  </div>`;
}
