import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./paths.js";

mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(`${DATA_DIR}/team.db`);
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, emoji TEXT, color TEXT,
    instructions TEXT NOT NULL, tools TEXT NOT NULL, effort TEXT NOT NULL DEFAULT 'high',
    sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT,
    messages TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, agent_id TEXT, status TEXT NOT NULL,
    result TEXT, thread_id TEXT, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, content TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, cron TEXT NOT NULL, prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, last_run INTEGER, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS task_runs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL,
    started_at INTEGER NOT NULL, finished_at INTEGER, heartbeat_at INTEGER, thread_id TEXT,
    error TEXT, error_kind TEXT, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER,
    tool_calls INTEGER NOT NULL DEFAULT 0, model TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id);
  CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL,
    from_status TEXT, to_status TEXT, actor TEXT, note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id);
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, agent_id TEXT, task_id TEXT, run_id TEXT,
    kind TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT
  );
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, pipeline TEXT, steps TEXT NOT NULL,
    triggers TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL, input TEXT,
    created_by TEXT, schedule_id TEXT, created_at INTEGER NOT NULL, finished_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS schedule_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id TEXT NOT NULL, fired_at INTEGER NOT NULL,
    scheduled_for INTEGER, outcome TEXT NOT NULL, task_id TEXT, workflow_run_id TEXT, note TEXT
  );
  CREATE TABLE IF NOT EXISTS prospects (
    id TEXT PRIMARY KEY, pipeline TEXT NOT NULL, name TEXT, business TEXT, source_url TEXT, evidence_date TEXT,
    quote TEXT, evidence TEXT NOT NULL DEFAULT '[]', known TEXT NOT NULL DEFAULT '{}', unknown TEXT NOT NULL DEFAULT '[]',
    qualification_status TEXT NOT NULL DEFAULT 'new', rationale TEXT, owner_id TEXT, next_action TEXT,
    contact_permission TEXT NOT NULL DEFAULT 'unknown', opted_out INTEGER NOT NULL DEFAULT 0, opted_out_at INTEGER,
    booking_status TEXT, possible_duplicate_of TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS prospect_identifiers (
    prospect_id TEXT NOT NULL, pipeline TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY (pipeline, kind, value)
  );
  CREATE TABLE IF NOT EXISTS interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, prospect_id TEXT NOT NULL, at INTEGER NOT NULL, agent_id TEXT,
    type TEXT NOT NULL, summary TEXT NOT NULL, action_id TEXT, task_id TEXT
  );
  CREATE TABLE IF NOT EXISTS actions (
    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, task_id TEXT, run_id TEXT, agent_id TEXT,
    action_type TEXT NOT NULL, channel TEXT, account TEXT, destination TEXT, prospect_id TEXT, subject TEXT,
    content TEXT NOT NULL, status TEXT NOT NULL, grant_id TEXT, approval_id TEXT, result TEXT, error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, action_id TEXT, task_id TEXT, agent_id TEXT, thread_id TEXT,
    summary TEXT NOT NULL, details TEXT, status TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL, decided_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS grants (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, action_type TEXT NOT NULL, channel TEXT NOT NULL,
    account TEXT NOT NULL, daily_limit INTEGER, total_limit INTEGER, expires_at INTEGER, note TEXT,
    created_at INTEGER NOT NULL, revoked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS connections (
    key TEXT PRIMARY KEY, status TEXT NOT NULL, detail TEXT, last_tested_at INTEGER, last_ok_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, agent_id TEXT, task_id TEXT, run_id TEXT,
    kind TEXT NOT NULL, model TEXT, cost_usd REAL NOT NULL DEFAULT 0, input_tokens INTEGER, output_tokens INTEGER
  );
  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT NOT NULL, sender_name TEXT NOT NULL, target TEXT NOT NULL,
    service_description TEXT NOT NULL, outreach_mode TEXT NOT NULL DEFAULT 'draft_only', budget_usd REAL NOT NULL,
    workflow_id TEXT, pipeline TEXT NOT NULL DEFAULT 'agency', step_reserve_usd REAL NOT NULL DEFAULT 0.30,
    status TEXT NOT NULL DEFAULT 'active', notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY, action_id TEXT NOT NULL, prospect_id TEXT, campaign_id TEXT, task_id TEXT,
    reviewer_kind TEXT NOT NULL, reviewer TEXT NOT NULL, checks TEXT NOT NULL, verdict TEXT NOT NULL, notes TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, full_name TEXT, target_titles TEXT NOT NULL DEFAULT '[]', locations TEXT NOT NULL DEFAULT '[]',
    work_mode TEXT NOT NULL DEFAULT 'any', seniority TEXT, salary_floor TEXT, industries TEXT, must_haves TEXT, exclusions TEXT,
    resume_text TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL, title TEXT NOT NULL, company TEXT NOT NULL, url TEXT NOT NULL, url_canon TEXT,
    location TEXT, work_mode TEXT, posted_date TEXT, salary_text TEXT, requirements TEXT, source TEXT, status TEXT NOT NULL,
    link_state TEXT, link_status INTEGER, link_note TEXT, link_checked_at INTEGER, fit_score INTEGER, fit_reasons TEXT, gaps TEXT,
    application TEXT, owner_note TEXT, applied_at INTEGER, found_by TEXT, scored_by TEXT, task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client_id);
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL, key_env TEXT,
    price_in REAL, price_out REAL, created_at INTEGER NOT NULL
  );
`);

// Columns added after the first release; ALTER fails harmlessly when they already exist.
for (const sql of [
  "ALTER TABLE agents ADD COLUMN model TEXT NOT NULL DEFAULT 'haiku'",
  "ALTER TABLE agents ADD COLUMN advisor TEXT NOT NULL DEFAULT 'opus'",
  "ALTER TABLE agents ADD COLUMN bio TEXT",
  `ALTER TABLE agents ADD COLUMN permissions TEXT NOT NULL DEFAULT '["research","drafting"]'`,
  "ALTER TABLE agents ADD COLUMN fallback_model TEXT",
  "ALTER TABLE tasks ADD COLUMN campaign_id TEXT",
  "ALTER TABLE tasks ADD COLUMN validator TEXT",
  "ALTER TABLE workflow_runs ADD COLUMN campaign_id TEXT",
  "ALTER TABLE prospects ADD COLUMN verification TEXT",
  "ALTER TABLE actions ADD COLUMN version INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE actions ADD COLUMN supersedes TEXT",
  "ALTER TABLE actions ADD COLUMN superseded_by TEXT",
  "ALTER TABLE actions ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent'",
  "ALTER TABLE actions ADD COLUMN campaign_id TEXT",
  "ALTER TABLE actions ADD COLUMN owner_notes TEXT",
  "ALTER TABLE threads ADD COLUMN config TEXT",
  "ALTER TABLE threads ADD COLUMN context_hash TEXT",
  "ALTER TABLE tasks ADD COLUMN input TEXT",
  "ALTER TABLE tasks ADD COLUMN output TEXT",
  "ALTER TABLE tasks ADD COLUMN error TEXT",
  "ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE tasks ADD COLUMN condition TEXT",
  "ALTER TABLE tasks ADD COLUMN workflow_run_id TEXT",
  "ALTER TABLE tasks ADD COLUMN step_key TEXT",
  "ALTER TABLE tasks ADD COLUMN schedule_id TEXT",
  "ALTER TABLE tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN max_attempts INTEGER",
  "ALTER TABLE tasks ADD COLUMN not_before INTEGER",
  "ALTER TABLE tasks ADD COLUMN heartbeat_at INTEGER",
  "ALTER TABLE tasks ADD COLUMN current_run_id TEXT",
  "ALTER TABLE tasks ADD COLUMN started_at INTEGER",
  "ALTER TABLE tasks ADD COLUMN finished_at INTEGER",
  "ALTER TABLE tasks ADD COLUMN wait_reason TEXT",
  "ALTER TABLE tasks ADD COLUMN trigger_key TEXT",
  "ALTER TABLE schedules ADD COLUMN name TEXT",
  "ALTER TABLE schedules ADD COLUMN timezone TEXT",
  "ALTER TABLE schedules ADD COLUMN target_type TEXT NOT NULL DEFAULT 'task'",
  "ALTER TABLE schedules ADD COLUMN workflow_id TEXT",
  "ALTER TABLE schedules ADD COLUMN input TEXT",
  "ALTER TABLE schedules ADD COLUMN next_run_at INTEGER",
  "ALTER TABLE schedules ADD COLUMN overlap_policy TEXT NOT NULL DEFAULT 'skip'",
  "ALTER TABLE schedules ADD COLUMN missed_policy TEXT NOT NULL DEFAULT 'run_once'",
  "ALTER TABLE schedules ADD COLUMN last_outcome TEXT",
]) {
  try { db.exec(sql); } catch {}
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_trigger ON tasks(trigger_key) WHERE trigger_key IS NOT NULL");

// One-time conversion of pre-queue task statuses. Old "todo"/"in_progress" tasks never had a real
// worker behind them, so they come back as drafts you can run.
const OLD_STATUS = { todo: "draft", in_progress: "draft", waiting: "waiting_input", done: "completed" };
for (const [from, to] of Object.entries(OLD_STATUS)) {
  db.prepare("UPDATE tasks SET status = ? WHERE status = ?").run(to, from);
}
db.exec(`UPDATE tasks SET output = json_object('summary', result, 'structured', json('false'))
         WHERE status = 'completed' AND output IS NULL AND result IS NOT NULL`);
db.exec(`UPDATE tasks SET error = coalesce(error, result) WHERE status = 'failed' AND error IS NULL`);

export const now = () => Date.now();
export const uid = () => randomUUID();
export const json = (s, fallback) => {
  if (s === null || s === undefined || s === "") return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

const parseAgent = (r) => r && {
  ...r, tools: json(r.tools, []), permissions: json(r.permissions, ["research", "drafting"]),
};
const parseThread = (r) => r && { ...r, messages: JSON.parse(r.messages), config: r.config ? JSON.parse(r.config) : null };

export const agents = {
  list: () => db.prepare("SELECT * FROM agents ORDER BY sort, created_at").all().map(parseAgent),
  get: (id) => parseAgent(db.prepare("SELECT * FROM agents WHERE id = ?").get(id)),
  findByName: (name) =>
    parseAgent(db.prepare("SELECT * FROM agents WHERE lower(name) = lower(?)").get(name.trim())),
  create(a) {
    const id = a.id ?? randomUUID();
    db.prepare(
      `INSERT INTO agents (id, name, role, emoji, color, instructions, tools, effort, model, advisor, bio, permissions, fallback_model, sort, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, a.name, a.role, a.emoji ?? "🤖", a.color ?? "#6b7cff", a.instructions,
      JSON.stringify(a.tools ?? []), a.effort ?? "high", a.model ?? "haiku", a.advisor ?? "opus", a.bio ?? null,
      JSON.stringify(a.permissions ?? ["research", "drafting"]), a.fallback_model ?? null, a.sort ?? 100, now());
    return agents.get(id);
  },
  update(id, a) {
    const cur = agents.get(id);
    if (!cur) return null;
    const m = { ...cur, ...a };
    db.prepare(
      `UPDATE agents SET name=?, role=?, emoji=?, color=?, instructions=?, tools=?, effort=?, model=?, advisor=?, bio=?, permissions=?, fallback_model=? WHERE id=?`,
    ).run(m.name, m.role, m.emoji, m.color, m.instructions, JSON.stringify(m.tools), m.effort, m.model, m.advisor,
      m.bio ?? null, JSON.stringify(m.permissions), m.fallback_model || null, id);
    return agents.get(id);
  },
  remove: (id) => db.prepare("DELETE FROM agents WHERE id = ?").run(id),
  count: () => db.prepare("SELECT count(*) AS n FROM agents").get().n,
};

export const threads = {
  get: (id) => parseThread(db.prepare("SELECT * FROM threads WHERE id = ?").get(id)),
  create(agentId, kind, title) {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO threads (id, agent_id, kind, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, agentId, kind, title ?? null, now(), now());
    return threads.get(id);
  },
  // The latest chat thread is the agent's "main" conversation.
  mainFor(agentId) {
    const r = db
      .prepare("SELECT * FROM threads WHERE agent_id = ? AND kind = 'chat' ORDER BY created_at DESC LIMIT 1")
      .get(agentId);
    return r ? parseThread(r) : threads.create(agentId, "chat", "Chat");
  },
  // A thread's system prompt and tools are frozen on its first turn: changing them mid-thread
  // invalidates the model's earlier reasoning blocks (and the prompt cache).
  setConfig: (id, config) => db.prepare("UPDATE threads SET config = ? WHERE id = ?").run(JSON.stringify(config), id),
  setContextHash: (id, hash) => db.prepare("UPDATE threads SET context_hash = ? WHERE id = ?").run(hash, id),
  saveMessages: (id, messages) =>
    db.prepare("UPDATE threads SET messages = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(messages), now(), id),
};

export const memories = {
  // Shared memories (agent_id NULL) plus the agent's own.
  forAgent: (agentId) =>
    db.prepare("SELECT * FROM memories WHERE agent_id IS NULL OR agent_id = ? ORDER BY id").all(agentId),
  list: () => db.prepare("SELECT * FROM memories ORDER BY id DESC").all(),
  add: (agentId, content) =>
    db.prepare("INSERT INTO memories (agent_id, content, created_at) VALUES (?, ?, ?)").run(agentId, content, now()),
  remove: (id) => db.prepare("DELETE FROM memories WHERE id = ?").run(id),
};

export const settings = {
  get: (key, fallback = "") => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? fallback,
  set: (key, value) =>
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value),
};

// Runs fn inside one SQLite transaction (all-or-nothing).
export function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
