import "dotenv/config";
import express from "express";
import http from "node:http";
import { mkdirSync } from "node:fs";
import { WebSocketServer } from "ws";
import { agents, threads, memories, settings } from "./db.js";
import { DEFAULT_TEAM, DEFAULT_COMPANY_CONTEXT, isLegacyContext, upgradeTeam } from "./defaults.js";
import { TOOL_GROUPS } from "./tools.js";
import { MODELS, ADVISORS } from "./models.js";
import { addClient, broadcast } from "./hub.js";
import { runTurn, stop, isRunning, runningThreads, ENGINE } from "./runner.js";
import * as queue from "./queue.js";
import * as wf from "./workflows.js";
import * as sched from "./schedules.js";
import * as pros from "./prospects.js";
import * as act from "./actions.js";
import * as conn from "./connections.js";
import * as prov from "./providers.js";
import * as camp from "./campaigns.js";
import { listActivity, usageSummary, setLimits, getLimits, logActivity } from "./activity.js";
import {
  closeBrowser, openBrowser, browserStatus, tabTitle, tabPreview, bringToFront, openOwnerTab, clearCookiesFor, getEngine,
} from "./browser.js";
import { getAccounts, saveAccounts, getRules, saveRules, usageToday, accountStatus, normalizeDomain, importCookies } from "./sites.js";
import { ROOT, WORKSPACE_DIR } from "./paths.js";

mkdirSync(WORKSPACE_DIR, { recursive: true });
if (agents.count() === 0) for (const a of DEFAULT_TEAM) agents.create(a);
const ctx0 = settings.get("company_context");
if (!ctx0 || isLegacyContext(ctx0)) settings.set("company_context", DEFAULT_COMPANY_CONTEXT);
upgradeTeam();
wf.seedDefaultWorkflows();
camp.seedZeeCampaign();
sched.migrateLegacySchedules();
act.expireStaleInteractive();
queue.startWorker();

const PORT = Number(process.env.PORT ?? 4310);
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

const app = express();
// Blocks DNS-rebinding and cross-site requests from other pages open in your normal browser.
app.use((req, res, next) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return res.status(403).send("Forbidden host");
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).send("Forbidden origin");
  next();
});
app.use(express.json({ limit: "10mb" })); // full-browser cookie exports can be a few MB
app.use(express.static(`${ROOT}/public`));

// Wraps handlers so thrown validation errors come back as 400 with the message.
const h = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    if (!res.headersSent) res.status(400).json({ error: e.message });
  }
};

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
function cleanAgent(body) {
  const out = {};
  for (const k of ["name", "role", "emoji", "color", "instructions", "bio"]) if (typeof body[k] === "string") out[k] = body[k].trim();
  if (Array.isArray(body.tools)) out.tools = body.tools.filter((t) => t in TOOL_GROUPS);
  if (Array.isArray(body.permissions)) out.permissions = body.permissions.filter((p) => p in act.ACTION_TYPES);
  if (EFFORTS.includes(body.effort)) out.effort = body.effort;
  const validModel = (m) => (m in MODELS) || (typeof m === "string" && m.startsWith("provider:") && prov.providers.get(m.slice(9)));
  if (validModel(body.model)) out.model = body.model;
  if (body.fallback_model === "" || body.fallback_model === null) out.fallback_model = null;
  else if (validModel(body.fallback_model)) out.fallback_model = body.fallback_model;
  if (body.advisor in ADVISORS) out.advisor = body.advisor;
  return out;
}

const labels = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.label]));
// Claude models plus every custom provider you've added.
const modelLabels = () => ({ ...labels(MODELS), ...Object.fromEntries(prov.providers.list().map((p) => [`provider:${p.id}`, `${p.name} · ${p.model}`])) });
app.get("/api/meta", (_req, res) =>
  res.json({
    toolGroups: TOOL_GROUPS, efforts: EFFORTS, models: modelLabels(), advisors: labels(ADVISORS),
    actionTypes: act.ACTION_TYPES, channels: labels(act.CHANNELS), states: queue.STATES,
    running: runningThreads(), engine: ENGINE, timezone: sched.LOCAL_TZ,
  }));

app.get("/api/system", h(async () => ({
  worker: queue.workerStatus(), scheduler: await sched.schedulerHealth(), engine: ENGINE,
  running_tasks: queue.runningTaskIds(), pending_approvals: act.approvals.list("pending").length,
})));

// ---------- Agents ----------
app.get("/api/agents", (_req, res) => res.json(agents.list()));
app.post("/api/agents", h((req) => {
  const a = cleanAgent(req.body);
  if (!a.name || !a.role || !a.instructions) throw new Error("name, role and instructions are required");
  if (agents.findByName(a.name)) throw new Error("A team member with that name already exists");
  const created = agents.create({ tools: ["web", "browser", "files", "memory", "tasks", "prospects"], permissions: act.DEFAULT_PERMISSIONS, ...a });
  broadcast({ type: "agents_changed" });
  return created;
}));
app.put("/api/agents/:id", h((req) => {
  const a = agents.update(req.params.id, cleanAgent(req.body));
  if (!a) throw new Error("No such team member");
  broadcast({ type: "agents_changed" });
  return a;
}));
app.delete("/api/agents/:id", h((req) => {
  const active = queue.tasks.list({ agent_id: req.params.id, status: queue.ACTIVE_STATES.join(",") });
  if (active.length) throw new Error(`This member owns ${active.length} active task(s). Reassign or cancel them first.`);
  agents.remove(req.params.id);
  broadcast({ type: "agents_changed" });
}));

// ---------- Chat ----------
app.get("/api/agents/:id/thread", (req, res) => {
  if (!agents.get(req.params.id)) return res.status(404).end();
  const t = threads.mainFor(req.params.id);
  res.json({ ...t, running: isRunning(t.id) });
});
// Last visible line of a thread, for the inbox list.
function lastPreview(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b.type === "text" && b.text.trim() && !b.text.startsWith("[Context]")) {
        return { from: m.role === "user" ? "you" : "agent", text: b.text.replace(/\s+/g, " ").slice(0, 120) };
      }
    }
  }
  return { from: null, text: "" };
}
app.get("/api/inbox", (_req, res) => {
  const busy = new Set(queue.runningTaskIds().map((id) => queue.tasks.get(id)?.agent_id));
  res.json(agents.list().map((a) => {
    const t = threads.mainFor(a.id);
    return { agentId: a.id, threadId: t.id, ...lastPreview(t.messages), updated_at: t.updated_at, running: isRunning(t.id), task_running: busy.has(a.id) };
  }));
});
app.post("/api/agents/:id/new-chat", (req, res) => {
  const t = threads.create(req.params.id, "chat", "Chat");
  res.json({ ...t, running: false });
});
app.get("/api/threads/:id", (req, res) => {
  const t = threads.get(req.params.id);
  if (!t) return res.status(404).end();
  res.json({ ...t, running: isRunning(t.id) });
});
app.post("/api/threads/:id/messages", (req, res) => {
  const t = threads.get(req.params.id);
  const agent = t && agents.get(t.agent_id);
  const text = String(req.body.text ?? "").trim();
  if (!agent) return res.status(404).end();
  if (!text) return res.status(400).json({ error: "Empty message" });
  if (t.kind === "task") return res.status(400).json({ error: "This is a task run log. Use the task's Run/Retry controls, or message the member in their chat." });
  if (isRunning(t.id)) return res.status(409).json({ error: `${agent.name} is still working. Stop them or wait.` });
  runTurn({ agent, threadId: t.id, userText: text }).catch((e) => console.error(e));
  res.json({ ok: true });
});
app.post("/api/threads/:id/stop", (req, res) => {
  stop(req.params.id);
  res.json({ ok: true });
});

// ---------- Tasks ----------
app.get("/api/tasks", (req, res) => res.json(queue.tasks.list({ status: req.query.status || undefined, agent_id: req.query.agent_id || undefined, workflow_run_id: req.query.workflow_run_id || undefined })));
app.get("/api/tasks/:id", h((req) => {
  const t = queue.tasks.get(req.params.id);
  if (!t) throw new Error("No such task");
  return {
    ...t, runs: queue.tasks.runs(t.id), events: queue.tasks.events(t.id), actions: act.actions.list({ task_id: t.id }),
    dependencies: t.depends_on.map((id) => queue.tasks.get(id)).filter(Boolean).map((d) => ({ id: d.id, title: d.title, status: d.status, agent_id: d.agent_id })),
    activity: listActivity({ task_id: t.id, limit: 200 }),
  };
}));
app.post("/api/tasks", h((req) => {
  const b = req.body;
  return queue.createTask({
    title: b.title, description: b.description, agent_id: b.agent_id || null, input: b.input ?? {},
    depends_on: b.depends_on ?? [], status: b.run ? "queued" : "draft",
  }, { actor: "owner" });
}));
app.put("/api/tasks/:id", h((req) => queue.updateTask(req.params.id, req.body)));
app.delete("/api/tasks/:id", h((req) => queue.tasks.remove(req.params.id)));
app.post("/api/tasks/:id/run", (req, res) => {
  const r = queue.runTask(req.params.id, { actor: "owner" });
  res.status(r.ok ? 200 : 409).json(r);
});
app.post("/api/tasks/:id/retry", (req, res) => {
  const r = queue.retryTask(req.params.id, { actor: "owner", reason: req.body?.reason });
  res.status(r.ok ? 200 : 409).json(r);
});
app.post("/api/tasks/:id/cancel", h((req) => queue.cancelTask(req.params.id, { actor: "owner", reason: req.body?.reason })));
app.post("/api/tasks/:id/reassign", h((req) => queue.reassignTask(req.params.id, req.body.agent_id, { actor: "owner", reason: req.body.reason })));
app.post("/api/tasks/:id/answer", h((req) => queue.answerInput(req.params.id, String(req.body.answer ?? "").trim() || (() => { throw new Error("Write an answer"); })(), { actor: "owner" })));

// ---------- Workflows ----------
app.get("/api/workflows", (_req, res) => res.json(wf.workflows.list().map((w) => ({ ...w, runs: wf.workflows.runs(w.id, 10) }))));
app.post("/api/workflows", h((req) => wf.saveWorkflow(req.body)));
app.put("/api/workflows/:id", h((req) => wf.saveWorkflow({ ...req.body, id: req.params.id })));
app.delete("/api/workflows/:id", h((req) => wf.deleteWorkflow(req.params.id)));
app.post("/api/workflows/:id/run", h((req) => wf.runWorkflow(req.params.id, req.body?.input ?? {}, { actor: "owner" })));
app.get("/api/workflow-runs/:id", h((req) => {
  const run = wf.workflows.getRun(req.params.id);
  if (!run) throw new Error("No such run");
  return { ...run, workflow: wf.workflows.get(run.workflow_id), tasks: queue.tasks.list({ workflow_run_id: run.id, limit: 1000 }) };
}));
app.post("/api/workflow-runs/:id/cancel", h((req) => wf.cancelWorkflowRun(req.params.id, { actor: "owner" })));

// ---------- Schedules ----------
app.get("/api/schedules", h(async () => ({
  health: await sched.schedulerHealth(),
  schedules: sched.schedules.list().map((s) => ({ ...s, history: sched.schedules.history(s.id, 10) })),
})));
app.post("/api/schedules", h((req) => sched.createSchedule(req.body)));
app.put("/api/schedules/:id", h((req) => sched.setEnabled(req.params.id, Boolean(req.body.enabled))));
app.delete("/api/schedules/:id", h((req) => sched.deleteSchedule(req.params.id)));
app.post("/api/schedules/:id/run-now", h((req) => {
  const s = sched.schedules.get(req.params.id);
  if (!s) throw new Error("No such schedule");
  return sched.fire(s, { note: "run now (manual)", actor: "owner" });
}));
app.get("/api/schedules/:id/history", h((req) => sched.schedules.history(req.params.id, 100)));

// ---------- Prospects ----------
app.get("/api/prospects", (req, res) => res.json(pros.prospects.list({ pipeline: req.query.pipeline || undefined, status: req.query.status || undefined, q: req.query.q || undefined })));
app.get("/api/prospects/export.csv", (req, res) => {
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="prospects-${req.query.pipeline || "all"}.csv"` });
  res.send(pros.exportCsv(req.query.pipeline || undefined));
});
app.post("/api/prospects/import", h((req) => pros.importCsv(String(req.body.text ?? ""), { pipeline: req.body.pipeline || undefined })));
app.get("/api/prospects/:id", h((req) => {
  const p = pros.prospects.get(req.params.id);
  if (!p) throw new Error("No such prospect");
  return { ...p, identifiers: pros.prospects.identifiers(p.id), interactions: pros.prospects.interactions(p.id), actions: act.actions.list().filter((a) => a.prospect_id === p.id) };
}));
app.post("/api/prospects", h((req) => pros.upsertProspect(req.body)));
app.put("/api/prospects/:id", h((req) => pros.updateProspect(req.params.id, req.body)));
app.post("/api/prospects/:id/opt-out", h((req) => pros.setOptOut(req.params.id, req.body.opted_out !== false, { note: req.body.note })));
app.post("/api/prospects/:id/booking", h((req) => {
  const status = req.body.status === "confirmed" ? "confirmed" : req.body.status === "cancelled" ? "cancelled" : null;
  if (!status) throw new Error("status must be confirmed or cancelled");
  pros.updateProspect(req.params.id, { booking_status: status });
  pros.logInteraction(req.params.id, { type: "booking", summary: `Booking ${status} (marked by owner)` });
  const created = status === "confirmed" ? wf.fireBookingConfirmed(req.params.id) : [];
  return { created: created.map((t) => ({ id: t.id, title: t.title, deduplicated: Boolean(t.deduplicated) })) };
}));

// ---------- Approvals, actions, grants ----------
app.get("/api/approvals", (req, res) => res.json(act.approvals.list(req.query.status || undefined)));
app.post("/api/approvals/:id/decide", h(async (req) => { await act.decideApproval(req.params.id, Boolean(req.body.approved), req.body.note ?? ""); }));
app.get("/api/actions", (req, res) => res.json(act.actions.list({ status: req.query.status || undefined })));
app.post("/api/actions/:id/manual", h((req) => act.confirmManual(req.params.id, Boolean(req.body.sent), req.body.note ?? "")));
app.get("/api/grants", (_req, res) => res.json(act.grants.list().map((g) => ({ ...g, usage: act.grants.usage(g.id) }))));
app.post("/api/grants", h((req) => {
  const g = act.grants.create(req.body);
  logActivity({ agent_id: g.agent_id === "*" ? null : g.agent_id, kind: "permission", summary: `You granted standing permission: ${act.ACTION_TYPES[g.action_type]} via ${g.channel} (${g.account})${g.daily_limit !== null ? `, ${g.daily_limit}/day` : ""}` });
  broadcast({ type: "grants_changed" });
  return g;
}));
app.delete("/api/grants/:id", h((req) => { act.grants.revoke(req.params.id); broadcast({ type: "grants_changed" }); }));

// ---------- Campaigns ----------
app.get("/api/campaigns", (_req, res) => res.json(camp.campaigns.list().map((c) => ({ ...c, spend: camp.spend(c), active: camp.hasActiveRun(c.id) }))));
app.get("/api/campaigns/:id/dashboard", h((req) => camp.dashboard(req.params.id)));
app.put("/api/campaigns/:id", h((req) => camp.updateCampaign(req.params.id, req.body)));
app.post("/api/campaigns/:id/run", h((req) => {
  const c = camp.campaigns.get(req.params.id);
  if (!c) throw new Error("No such campaign");
  if (camp.hasActiveRun(c.id)) throw new Error("This campaign already has active steps. Wait for them to finish or cancel them first.");
  const s = camp.spend(c);
  if (s.remaining < c.step_reserve_usd) throw new Error(`Campaign budget: only ${s.remaining.toFixed(2)} left of ${c.budget_usd.toFixed(2)}. Not started.`);
  return wf.runWorkflow(c.workflow_id, { ...(req.body?.input ?? {}), campaign: c.name }, { actor: "owner", campaign_id: c.id });
}));
app.post("/api/drafts/:id/review", h((req) => camp.recordReview({ action_id: req.params.id, checks: req.body.checks, verdict: req.body.verdict, notes: req.body.notes, reviewer_kind: "manual", reviewer: "owner" })));
app.post("/api/drafts/:id/revise", h((req) => act.manualRevision(req.params.id, req.body.content)));

// ---------- Custom AI providers ----------
app.get("/api/providers", (_req, res) => res.json({ presets: prov.PRESETS, providers: prov.providers.list().map(prov.publicProvider) }));
app.post("/api/providers", h((req) => prov.publicProvider(prov.saveProvider(req.body))));
app.put("/api/providers/:id", h((req) => prov.publicProvider(prov.saveProvider({ ...req.body, id: req.params.id }))));
app.delete("/api/providers/:id", h((req) => prov.deleteProvider(req.params.id)));
app.post("/api/providers/:id/test", h(async (req) => {
  const p = prov.providers.get(req.params.id);
  if (!p) throw new Error("No such provider");
  try {
    const r = await prov.testProvider(p);
    conn.setStatus(`provider:${p.id}`, r.model_available ? "working" : "failed",
      r.model_available ? `Replied "${r.reply.slice(0, 20)}" · ${r.models.length} models available` : `Model "${p.model}" isn't offered by this account. Pick one from the list.`);
    return r;
  } catch (e) {
    conn.setStatus(`provider:${p.id}`, "failed", e.message);
    throw e;
  }
}));
app.post("/api/providers/:id/models", h(async (req) => {
  const p = prov.providers.get(req.params.id);
  if (!p) throw new Error("No such provider");
  return prov.listModels(p);
}));

// ---------- Connections, activity, usage ----------
app.get("/api/connections", h(() => conn.listConnections(ENGINE)));
app.post("/api/connections/:key/test", h((req) => conn.testConnection(req.params.key, ENGINE)));
app.get("/api/activity", (req, res) => res.json(listActivity({ limit: Math.min(500, Number(req.query.limit) || 200), before: Number(req.query.before) || undefined, task_id: req.query.task_id, agent_id: req.query.agent_id })));
app.get("/api/usage", (_req, res) => res.json(usageSummary(7)));
app.get("/api/limits", (_req, res) => res.json(getLimits()));
app.put("/api/limits", h((req) => setLimits(req.body)));

// ---------- Memory & settings ----------
app.get("/api/memories", (_req, res) => res.json(memories.list()));
app.post("/api/memories", (req, res) => {
  const content = String(req.body.content ?? "").trim();
  if (!content) return res.status(400).end();
  memories.add(req.body.agent_id || null, content);
  res.json({ ok: true });
});
app.delete("/api/memories/:id", (req, res) => {
  memories.remove(Number(req.params.id));
  res.json({ ok: true });
});
app.get("/api/settings", (_req, res) => res.json({ company_context: settings.get("company_context") }));
app.put("/api/settings", (req, res) => {
  if (typeof req.body.company_context === "string") settings.set("company_context", req.body.company_context);
  res.json({ ok: true });
});

// ---------- Browser & accounts ----------
app.get("/api/browser", async (_req, res) => {
  const s = browserStatus();
  const names = Object.fromEntries(agents.list().map((a) => [a.id, a.name]));
  const tabs = await Promise.all(s.tabs.map(async (t) => ({ ...t, name: t.key === "owner" ? "You" : names[t.key] ?? "?", title: await tabTitle(t.key) })));
  res.json({ ...s, tabs, preferred: getEngine() });
});
app.post("/api/browser/open", async (_req, res) => {
  try { await openBrowser(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/browser/close", async (_req, res) => {
  await closeBrowser();
  res.json({ ok: true });
});
app.put("/api/browser/engine", async (req, res) => {
  if (!["chrome", "chromium"].includes(req.body.engine)) return res.status(400).end();
  settings.set("browser_engine", req.body.engine);
  await closeBrowser(); // relaunches with the new engine on next use
  res.json({ ok: true });
});
app.get("/api/browser/tabs/:key/preview", async (req, res) => {
  const img = await tabPreview(req.params.key);
  if (!img) return res.status(404).end();
  res.set({ "Content-Type": "image/jpeg", "Cache-Control": "no-store" }).send(img);
});
app.post("/api/browser/tabs/:key/front", async (req, res) => {
  await bringToFront(req.params.key);
  res.json({ ok: true });
});
app.get("/api/accounts", async (_req, res) => {
  const list = await Promise.all(getAccounts().map(async (a) => ({ ...a, status: await accountStatus(a) })));
  res.json(list);
});
app.post("/api/accounts", (req, res) => {
  const name = String(req.body.name ?? "").trim();
  const loginUrl = String(req.body.loginUrl ?? "").trim();
  if (!name || !/^https:\/\//.test(loginUrl)) return res.status(400).json({ error: "Name and an https:// login URL are required" });
  const domain = normalizeDomain(loginUrl).split(".").slice(-2).join(".");
  const list = getAccounts().filter((a) => a.domain !== domain);
  saveAccounts([...list, { name, domain, loginUrl, cookie: null }]);
  res.json({ ok: true });
});
app.delete("/api/accounts/:domain", (req, res) => {
  saveAccounts(getAccounts().filter((a) => a.domain !== req.params.domain));
  res.json({ ok: true });
});
app.post("/api/accounts/:domain/signin", async (req, res) => {
  const a = getAccounts().find((x) => x.domain === req.params.domain);
  if (!a) return res.status(404).end();
  try { await openOwnerTab(a.loginUrl); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/cookies/import", async (req, res) => {
  try {
    const domain = req.body.domain ? normalizeDomain(req.body.domain) : null;
    res.json(await importCookies(req.body.text, domain));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post("/api/accounts/:domain/signout", async (req, res) => {
  await clearCookiesFor(req.params.domain);
  res.json({ ok: true });
});
const ACCESS = ["full", "approve", "blocked"];
app.get("/api/site-rules", (_req, res) => res.json({ rules: getRules(), usage: usageToday() }));
app.put("/api/site-rules", (req, res) => {
  if (!Array.isArray(req.body.rules)) return res.status(400).end();
  const rules = req.body.rules
    .map((r) => ({
      domain: normalizeDomain(r.domain),
      access: ACCESS.includes(r.access) ? r.access : "approve",
      dailyLimit: Math.max(0, Math.min(10000, Number(r.dailyLimit) || 0)),
      minDelaySec: Math.max(0, Math.min(120, Number(r.minDelaySec) || 0)),
    }))
    .filter((r) => r.domain.includes("."));
  saveRules(rules);
  res.json({ ok: true, rules });
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: ({ origin, req }) => ALLOWED_ORIGINS.has(origin) && ALLOWED_HOSTS.has(req.headers.host),
});
wss.on("connection", (ws) => addClient(ws));

// Bound to localhost only: this app can drive a logged-in browser, so it must not be reachable from the network.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`HASAN's TEAM is running at http://localhost:${PORT}`);
  console.log(ENGINE === "claude-code" ? "Engine: Claude Code login (your Claude plan). No API key needed." : "Engine: Anthropic API key from .env.");
  console.log("Background worker started: tasks and schedules run while this window stays open.");
});

const shutdown = async () => {
  await closeBrowser();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
