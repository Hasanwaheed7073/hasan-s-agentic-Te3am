// Campaign dashboard: shared configuration, budget, verified prospects, drafts with reviews,
// agent statuses and handoffs. All numbers come from the server's records.
import { $, esc, api, state, ago, nav, toast, statePill, fmtTime, money, agentName } from "./core.js";

const CHECK_LABEL = {
  personalization: "Personalization", factual_accuracy: "Factual accuracy", sender_identity: "Sender identity",
  duplicate_prospect: "Duplicate prospect", opt_out_wording: "Opt-out wording", missing_information: "Missing information",
};
const AUTO_LABEL = {
  sender_identity: "Names sender", brand: "Names brand", no_other_affiliation: "No other company", opt_out_wording: "Easy decline",
  no_placeholders: "No placeholders", single_current_draft: "One current draft", prospect_contactable: "Not opted out",
};
const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? "")) ? String(u) : "#");

export async function renderCampaign(id) {
  const list = await api("/campaigns");
  const c0 = list.find((c) => c.id === id) ?? list[0];
  if (!c0) {
    $("#main").innerHTML = `<div class="page"><div class="page-inner wide"><div class="page-title">Campaign</div><div class="sub">No campaign set up yet.</div></div></div>`;
    return;
  }
  const d = await api(`/campaigns/${c0.id}/dashboard`);
  const c = d.campaign;
  const s = d.spend;
  const pct = Math.min(100, (s.total / Math.max(0.01, s.budget)) * 100);
  const current = d.drafts.filter((x) => x.status === "draft");
  const superseded = d.drafts.filter((x) => x.status === "superseded");

  $("#main").innerHTML = `<div class="page"><div class="page-inner wide">
    <div class="page-head"><div><div class="page-title">${esc(c.name)}</div>
      <div class="sub">${esc(c.brand)} · sender ${esc(c.sender_name)} · <span class="pill bad">Draft only — nothing is sent</span></div></div>
      <div class="head-actions">${d.active_run ? `<span class="pill warn">Run in progress</span>` : ""}
        <button class="btn-blue" id="run-campaign" ${d.active_run ? "disabled" : ""}>Run campaign</button></div></div>

    <div class="kpis">
      <div class="kpi"><b>${d.prospects.outreach_ready}</b><span>verified prospects</span></div>
      <div class="kpi"><b>${current.length}</b><span>drafts awaiting your approval</span></div>
      <div class="kpi"><b>${money(s.total)}</b><span>spent of ${money(s.budget)}</span><div class="meter"><span style="width:${pct}%"></span></div></div>
      <div class="kpi"><b>${money(s.remaining)}</b><span>remaining</span></div>
      <div class="kpi"><b>${d.cost_per_verified_prospect == null ? "—" : money(d.cost_per_verified_prospect)}</b><span>per verified prospect</span></div>
      <div class="kpi"><b>${d.handoffs_completed}</b><span>completed handoffs</span></div>
      <div class="kpi ${d.failed_tasks.length ? "bad" : ""}"><b>${d.failed_tasks.length}</b><span>failed tasks</span></div>
    </div>
    <div class="banner ${s.reconciliation.matches ? "good" : "bad"}">Budget meters ${s.reconciliation.matches ? "reconcile" : "DISAGREE"}: run records ${money(s.reconciliation.task_runs_total)} · usage log ${money(s.reconciliation.usage_log_total)}${s.reconciliation.matches ? "" : ` (difference ${money(s.reconciliation.difference)})`}. Costs are Claude Code's per-run estimates on your plan, not invoices. Before each step, the app checks that the remaining budget covers that step's typical cost, and the step runs with the remaining amount as a hard cap.</div>

    <div class="two-col">
      <div>
        <h3 class="section">Agents</h3>
        <div class="table-wrap"><table class="grid-table"><thead><tr><th>Member</th><th>Status</th><th>Last task</th><th>Model</th><th>Spend</th></tr></thead><tbody>
          ${d.agents.map((a) => `<tr><td><b>${esc(a.name.split(/\s[-—]/)[0])}</b></td><td>${statePill(a.status === "idle" ? "draft" : a.status)}</td>
            <td class="sub">${a.last_task ? `<a href="#" data-task="${a.last_task.id}">${esc(a.last_task.title.slice(0, 50))}</a> · ${ago(a.last_task.at)}` : "—"}</td>
            <td class="sub">${esc(a.model)}${a.advisor === "none" ? "" : ` + ${esc(a.advisor)} advisor`}</td><td>${money(a.cost)}</td></tr>`).join("")}
        </tbody></table></div>

        <h3 class="section">Verified prospects (${d.verified.length})</h3>
        ${d.verified.map((p) => `<div class="card"><div class="action-head"><a href="#" data-prospect="${p.id}"><b>${esc(p.name)}</b></a><span class="pill good">outreach-ready</span><span class="sub">verified ${fmtTime(p.verification?.verified_at)}</span></div>
          <div class="kv"><span>Website</span><a href="${esc(safeUrl(p.verification?.website_url))}" target="_blank" rel="noopener noreferrer">${esc(p.verification?.website_url)}</a> <span class="sub">(HTTP ${esc(p.verification?.website_status)})</span></div>
          <div class="kv"><span>Service</span>${esc(p.verification?.service_summary)}</div>
          <div class="kv"><span>Decision-maker</span>${esc(p.verification?.decision_maker)}${p.verification?.decision_maker_role ? `, ${esc(p.verification.decision_maker_role)}` : ""}</div>
          <div class="kv"><span>Contact</span>${esc(p.verification?.contact_method)}</div>
          ${p.verification?.uncertainty ? `<div class="kv"><span>Uncertain</span>${esc(p.verification.uncertainty)}</div>` : ""}</div>`).join("") || `<div class="sub">None yet.</div>`}
        ${d.unverified.length ? `<details class="card"><summary><b>Not outreach-ready (${d.unverified.length})</b></summary>${d.unverified.map((p) => `<div class="kv"><span><a href="#" data-prospect="${p.id}">${esc(p.name)}</a></span><span class="sub">missing: ${esc(p.missing.join("; "))}</span></div>`).join("")}</details>` : ""}

        <h3 class="section">Campaign configuration</h3>
        <form class="card" id="cfg">
          <label>Brand<input name="brand" value="${esc(c.brand)}" /></label>
          <label>Sender<input name="sender_name" value="${esc(c.sender_name)}" /></label>
          <label>Target<input name="target" value="${esc(c.target)}" /></label>
          <label>Approved service description<textarea name="service_description" rows="4">${esc(c.service_description)}</textarea></label>
          <div class="form-grid">
            <label>Budget (USD)<input name="budget_usd" type="number" step="0.01" min="0.01" value="${c.budget_usd}" /><span class="hint">Approved cap. Changing it is logged.</span></label>
            <label>Minimum reserve per step (USD)<input name="step_reserve_usd" type="number" step="0.01" min="0" value="${c.step_reserve_usd}" /><span class="hint">A step won't start unless at least this much (or its observed average) is left.</span></label>
          </div>
          <div class="kv"><span>Outreach mode</span><b>Draft only</b> <span class="sub">(fixed in code: requests to send are refused for this campaign)</span></div>
          <div class="row-actions"><button class="btn-blue">Save configuration</button></div>
          <div class="sub">Every Sarah, Zara and Omar step receives this exact block in its brief. Organization policies on your Claude account still take precedence.</div>
        </form>
      </div>
      <div>
        <h3 class="section">Drafts awaiting your approval (${current.length})</h3>
        ${current.map((x) => draftCard(x)).join("") || `<div class="sub">None.</div>`}
        ${superseded.length ? `<details class="card"><summary><b>Superseded drafts (${superseded.length})</b> <span class="sub">kept for history</span></summary>${superseded.map((x) => `<div class="kv"><span>${esc(x.id.slice(0, 8))} v${x.version}</span><span class="sub">${esc(agentName(x.agent_id))} · ${esc(x.prospect_name ?? "")} · superseded by ${esc((x.superseded_by ?? "").slice(0, 8))}</span></div>`).join("")}</details>` : ""}

        ${d.failed_tasks.length ? `<h3 class="section">Failed tasks</h3>${d.failed_tasks.map((t) => `<div class="card"><a href="#" data-task="${t.id}"><b>${esc(t.title)}</b></a> <span class="sub">${esc(t.agent ?? "")}</span><div class="sub bad-text">${esc(t.error ?? "")}</div></div>`).join("")}` : ""}
        <h3 class="section">Campaign tasks</h3>
        <div class="table-wrap"><table class="grid-table small"><thead><tr><th>Task</th><th>Owner</th><th>State</th><th>Updated</th></tr></thead><tbody>
          ${d.tasks.map((t) => `<tr class="clickable" data-task="${t.id}"><td>${esc(t.title)}${t.wait_reason ? `<div class="sub clamp">${esc(t.wait_reason)}</div>` : ""}</td><td class="sub">${esc((t.agent ?? "").split(/\s[-—]/)[0])}</td><td>${statePill(t.status)}</td><td class="sub">${ago(t.updated_at)}</td></tr>`).join("") || `<tr><td colspan="4" class="sub empty-row">No tasks yet.</td></tr>`}
        </tbody></table></div>
      </div>
    </div></div></div>`;

  const root = $(".page-inner");
  $("#cfg").onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    if (Number(body.budget_usd) !== c.budget_usd && !confirm(`Change the campaign budget from $${c.budget_usd} to $${body.budget_usd}?`)) return;
    try { await api(`/campaigns/${c.id}`, { method: "PUT", body }); toast("Campaign saved"); renderCampaign(c.id); } catch (err) { toast(err.message, "err"); }
  };
  $("#run-campaign").onclick = async () => {
    const avg = d.agents.map((a) => `${a.name.split(/\s[-—]/)[0]}`).join(" → ");
    if (!confirm(`Run ${avg} now with real models?\n\nThis uses your Claude plan. Remaining campaign budget: $${s.remaining.toFixed(2)}. Each step only starts if what's left covers its typical cost.\n\nNothing will be sent: the campaign is draft-only.`)) return;
    const target = prompt("How many verified agencies should Sarah aim for this run?", "5");
    if (!target) return;
    try { await api(`/campaigns/${c.id}/run`, { method: "POST", body: { input: { target_count: Number(target) || 5 } } }); toast("Campaign started"); renderCampaign(c.id); } catch (err) { toast(err.message, "err"); }
  };
  root.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-task]");
    if (t) { e.preventDefault(); return nav.openTask(t.dataset.task); }
    const p = e.target.closest("[data-prospect]");
    if (p) { e.preventDefault(); return nav.go({ name: "prospect", id: p.dataset.prospect }); }
    const rv = e.target.closest("[data-manual-review]");
    if (rv) return toggleReviewForm(rv.closest(".draft-card"));
    const ed = e.target.closest("[data-revise]");
    if (ed) return toggleReviseForm(ed.closest(".draft-card"));
  });
  root.addEventListener("submit", async (e) => {
    const f = e.target;
    if (!f.classList.contains("manual-review") && !f.classList.contains("revise")) return;
    e.preventDefault();
    const draftId = f.closest(".draft-card").dataset.draft;
    try {
      if (f.classList.contains("manual-review")) {
        const checks = Object.fromEntries(Object.keys(CHECK_LABEL).map((k) => [k, { pass: f[`c_${k}`].checked, note: f[`n_${k}`].value }]));
        await api(`/drafts/${draftId}/review`, { method: "POST", body: { checks, verdict: f.verdict.value, notes: f.notes.value } });
        toast("Your review is saved (manual)");
      } else {
        await api(`/drafts/${draftId}/revise`, { method: "POST", body: { content: f.content.value } });
        toast("Saved as a new manual version");
      }
      renderCampaign(c.id);
    } catch (err) { toast(err.message, "err"); }
  });
}

function draftCard(x) {
  const auto = Object.entries(x.auto_checks ?? {});
  return `<div class="card draft-card" data-draft="${x.id}">
    <div class="action-head"><b>${esc(x.prospect_name ?? "Prospect")}</b><span class="pill muted">v${x.version}</span>
      <span class="pill ${x.origin === "manual" ? "warn" : "muted"}">${x.origin === "manual" ? "manual correction" : `by ${esc(agentName(x.agent_id))}`}</span>
      <span class="sub">${esc(x.channel)} → ${esc(x.destination || "?")}</span></div>
    <pre class="content">${esc(x.content)}</pre>
    ${x.owner_notes ? `<div class="banner warn"><b>For you to confirm:</b> ${esc(x.owner_notes)}</div>` : ""}
    <div class="chips-row">${auto.map(([k, v]) => `<span class="pill ${v.pass ? "good" : "bad"}" title="${esc(v.note)}">${v.pass ? "✓" : "✗"} ${esc(AUTO_LABEL[k] ?? k)}</span>`).join("")}<span class="sub"> automatic checks</span></div>
    ${x.reviews.map((r) => `<div class="review ${r.reviewer_kind}">
      <div class="action-head"><b>${r.reviewer_kind === "manual" ? "Your review (manual)" : `${esc(agentName(r.reviewer))}'s review (agent-generated)`}</b>
        <span class="pill ${r.verdict === "approve_for_owner" ? "good" : r.verdict === "reject" ? "bad" : "warn"}">${esc(r.verdict.replace(/_/g, " "))}</span><span class="sub">${fmtTime(r.created_at)}</span></div>
      <div class="chips-row">${Object.entries(r.checks).map(([k, v]) => `<span class="pill ${v.pass ? "good" : "bad"}" title="${esc(v.note)}">${v.pass ? "✓" : "✗"} ${esc(CHECK_LABEL[k] ?? k)}</span>`).join("")}</div>
      ${r.notes ? `<div class="sub">${esc(r.notes)}</div>` : ""}</div>`).join("") || `<div class="sub">No review yet.</div>`}
    <div class="row-actions"><button class="btn-grey sm" data-revise>Correct text</button><button class="btn-grey sm" data-manual-review>Add my review</button></div>
    <div class="form-slot"></div>
  </div>`;
}

function toggleReviewForm(card) {
  const slot = card.querySelector(".form-slot");
  if (slot.innerHTML) { slot.innerHTML = ""; return; }
  slot.innerHTML = `<form class="manual-review">
    ${Object.entries(CHECK_LABEL).map(([k, l]) => `<div class="kv"><label class="inline"><input type="checkbox" name="c_${k}" checked /> ${l}</label><input name="n_${k}" placeholder="note" /></div>`).join("")}
    <label>Verdict<select name="verdict"><option value="approve_for_owner">Approve</option><option value="needs_changes">Needs changes</option><option value="reject">Reject</option></select></label>
    <label>Notes<input name="notes" /></label>
    <div class="row-actions"><button class="btn-blue sm">Save manual review</button></div></form>`;
}
function toggleReviseForm(card) {
  const slot = card.querySelector(".form-slot");
  if (slot.innerHTML) { slot.innerHTML = ""; return; }
  const text = card.querySelector("pre.content").textContent;
  slot.innerHTML = `<form class="revise"><textarea name="content" rows="8">${esc(text)}</textarea>
    <div class="row-actions"><span class="sub">Saved as a new version marked manual; the agent's version is kept.</span><button class="btn-blue sm">Save correction</button></div></form>`;
}
