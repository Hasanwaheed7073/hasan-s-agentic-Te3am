# HASAN's TEAM

Built by Hasan. A local AI team that actually executes work: a persistent task queue, a background worker, workflows with hand-offs, durable schedules, a shared prospect database, enforced action permissions, and an activity feed.

## Launch

1. Make sure Claude Code is signed in on this PC: open a terminal and run `claude` once. The team runs on that login (your Claude plan). No API key needed.
2. Double-click `start.bat` and the app opens at http://localhost:4310.
3. Optional, recommended: right-click `install-autostart.ps1` → **Run with PowerShell**. The worker then starts hidden whenever you sign in to Windows, restarts if it crashes, and schedules run without the app window. `start.bat` detects it and just opens the page. Undo with `uninstall-autostart.ps1`. Log: `data/worker.log`.

The worker runs inside the app's server process. Tasks and schedules run with no browser tab open, but only while that process runs and the PC is on and awake.

## Operate it

| Page | What it does |
|---|---|
| **Tasks** | Create tasks assigned by member ID. *Save draft* never runs anything; *Create & run* or **Run** queues it. Filter by state; open a task for its output, runs, history, approvals and live activity. Retry, cancel, reassign (with a recorded reason), answer questions. |
| **Workflows** | *Job seekers*: Ryan ∥ Reddit specialist → Adam → Zara → Omar. *Agency partners*: Sarah → Zara → Omar. Daniel starts when you mark a booking confirmed. **Run workflow** creates all steps; each starts when its inputs are ready. Steps with nothing to work on are skipped and labelled. Edit steps as JSON (agent IDs, `depends_on`, `condition`). |
| **Prospects** | Separate job-seeker and agency pipelines with source URL, evidence date, quote, known/unknown fields, qualification, owner, next action, interactions, contact permission and opt-out. CSV import/export. **Booking confirmed** starts Daniel once. |
| **Notifications** | Approval queue with the exact content, destination, account and action. Manual-send queue for approved messages on channels without automatic sending (LinkedIn, Reddit): copy, send yourself, then **I sent it**. |
| **Permissions** | Per-member action permissions (research, drafting, public posting, private messaging, email, external updates) and standing authorizations by member, action, channel, account, daily/total limit and expiry. |
| **Connections** | Real status of each integration: Not configured / Connected, untested / Working / Failed or expired, with a Test button and the fallback. |
| **Activity** | Live feed of runs, tool calls, outputs, errors, approvals, schedules. |
| **Schedules** | Cron schedules with time zone, next run (yours and theirs), overlap policy, missed-run policy, pause/resume, run now, history. |
| **Settings** | Run limits, estimated usage, background-worker status, business context. |

Alex (coordinator) can do the same from chat: `list_tasks`, `get_task`, `create_task`, `run_task`, `retry_task`, `reassign_task`, `cancel_task`, `run_workflow`, `list_agents`. Every action is recorded in the task history.

## How execution works

- **States:** Draft → Queued → Running → Completed, with Waiting for input, Waiting for approval, Failed and Cancelled. Every transition is stored with who caused it.
- **Runs:** each attempt is a run with its own ID, timestamps, model, estimated cost, tool-call count, error and a full log (Tasks → open → **Log**).
- **Claiming** is atomic, so a task can't run twice at once. A heartbeat every 2s; runs interrupted by a crash or restart are marked *abandoned* and retried.
- **Retries:** transient failures (timeouts, rate limits, network, plan usage limits) retry with backoff up to *Max attempts*. Other failures stop with the reason and a recovery step.
- **Hand-offs:** each task ends with `submit_output` (status, summary, `prospect_ids`, `qualified_prospect_ids`, `draft_ids`, data). Downstream tasks receive those outputs and the referenced prospect records automatically.
- **Honest empty results:** research can finish with `no_results`. Steps that depend on a non-empty list are then skipped instead of fed invented leads.

## Campaigns (Zee Careers agency test campaign)

The **Campaign** page is the single source of truth for brand, sender, target, approved service description, outreach mode (draft only, fixed in code) and budget. Every Sarah → Zara → Omar step gets the same campaign block in its brief.

- **Handoffs:** Zara starts only after Sarah's output passes validation (every prospect outreach-ready); Omar starts only after Zara's passes (one current draft per prospect naming the sender and brand, no placeholders). A failed check stops the workflow and is shown as a failed handoff. One active run per campaign.
- **Verification:** a prospect is outreach-ready only with a website the system itself loaded, a relevant service, a named decision-maker and a contact method, each with a source URL, plus a timestamp and uncertainty notes.
- **Quality control:** Omar receives the approved service text and each draft's full text, and records a six-point review. Automatic checks run on every draft. Your reviews and text corrections are stored separately, marked manual; corrections become a new version and the agent's version is kept.
- **Budget:** the meter is the engine-recorded cost of the campaign's runs (reconciled against the usage log). A step won't start unless the remaining budget covers its typical cost, and it runs with the remaining amount as a hard cap. Costs are Claude Code estimates on your plan.
- **Stall detection:** a run with no tool call or output for 5 minutes (Settings) is stopped and retried.

## Custom AI providers (Groq and other OpenAI-compatible APIs)

Connections → **AI providers** → *Add a provider*. Pick a preset (Groq, OpenRouter, Together, Fireworks, local Ollama) or enter any OpenAI-compatible base URL, paste the API key, then **Test & list models** and choose a model. Keys are saved only in this folder's `.env`; the page shows only the last 4 characters.

Then set a member's **Worker model** to that provider in Edit profile. Optionally set a **Fallback model** (e.g. Haiku on your Claude login): if the provider is rate-limited or down, the task's next attempt runs on the fallback.

- Rate limits are respected: short limits are waited out inside the run; long ones re-queue the task until the provider's reset time (or switch to the fallback). One account per provider; the app does not rotate accounts to get around limits.
- Same tools, permissions, approvals, opt-outs and limits as Claude members. Custom-provider members search with `fetch_url` (DuckDuckGo HTML) and the browser; they can't view screenshots.
- Usage is counted from the provider's token counts; add per-million prices on the provider to see estimated cost.

## Permissions and safety (enforced in code)

- New members get **Research** and **Drafting** only. Tools a member isn't permitted to use are rejected when called, whatever the prompt says.
- External actions go only through `request_action`. Order of checks: permission → opt-out → exactly-once → standing grant (runs now) → otherwise the approval queue. On approval, the system, not the agent, carries out the exact approved content.
- **Exactly once:** the same content to the same destination is one action, even across retries or different members.
- **Opt-outs** apply to every member and channel, matched by prospect and by destination identifier.
- **No fake sends:** email counts as sent only when the mail server accepts the recipient (inbox delivery is not confirmed). Timeouts are recorded as *uncertain*, never sent. LinkedIn/Reddit go to the manual-send queue until you confirm.
- Web pages and search results are treated as data; they can't change instructions or permissions. Per-site browser rules still apply (Browser & accounts).

## Limits (Settings)

| Limit | When reached |
|---|---|
| Concurrent runs (2) | Extra queued tasks wait for a free slot. |
| Max runtime per run (15 min) | Run stopped as a timeout and retried if attempts remain. Waiting for your approval doesn't count. |
| Max attempts (3) | Task marked Failed; click Retry. |
| Max tool actions per run (60) | Run stopped as Failed (not retried). Built-in web search/fetch count too. |
| Daily spend cap (off by default on a Claude plan; 0 = no cap) | If set: no new runs start until local midnight, and each turn gets only the remaining amount. |
| Per-run budget (off by default on a Claude plan; 0 = no cap) | If set: that run stops with a budget error. |

Costs are Claude Code's API-equivalent estimates. On a Claude plan you're billed by plan, but heavy use still hits plan usage limits. The dollar caps are off by default on a Claude plan (they're on by default only with `ENGINE=api`). In testing, a small research task was about $0.30–0.40 (estimated), mostly from the Opus advisor and web searches. Set a member's advisor to "No advisor" to cut that.

## Configuration (.env)

- `ENGINE=claude-code` (default) or `api` with `ANTHROPIC_API_KEY`.
- Email sending (optional): `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. Without them, drafting still works and approved emails go to the manual-send queue.
- `PORT`, `BROWSER_HEADLESS`, `APPROVAL_TIMEOUT_MINUTES`.

**Personal use only.** This runs on your own Claude login. Anthropic doesn't allow apps shared with or offered to others to use claude.ai logins. For a team rollout use API keys (`ENGINE=api`).

## Testing

A **TEST · deterministic, no AI** model option runs scripted steps through the real tool and permission layer, for verifying the system without model calls. Don't use it for real work.

## Where things live

- `data/team.db`: everything (team, chats, tasks, runs, workflows, prospects, approvals, grants, schedules, usage).
- `workspace/`: files the team writes.
- `data/browser-profile-chrome/`: the team browser's logins. Keep it private.
U n k n o w n   c o m m a n d :   " e c h o "  
  
 T o   s e e   a   l i s t   o f   s u p p o r t e d   n p m   c o m m a n d s ,   r u n :  
     n p m   h e l p  
 