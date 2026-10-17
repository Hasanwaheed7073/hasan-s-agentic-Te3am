// Runs a team member through the Claude Agent SDK, which uses this PC's Claude Code login
// (your Claude plan) instead of an API key. Built-in Claude Code tools are switched off except
// web search/fetch; everything else goes through the team's own tools and rules.
import { query, tool, createSdkMcpServer, AbortError, USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { toolsFor, runTool } from "./tools.js";
import { WORKSPACE_DIR } from "./paths.js";

const PREFIX = "mcp__team__";
const MAX_TURNS = Number(process.env.MAX_STEPS_PER_TURN ?? 60);
const stripName = (name) => (name?.startsWith(PREFIX) ? name.slice(PREFIX.length) : name);

// The team's tool schemas are plain JSON Schema; the SDK wants a Zod shape.
function zodType(p) {
  if (p.enum) return z.enum(p.enum);
  if (p.type === "integer") return z.number().int();
  if (p.type === "number") return z.number();
  if (p.type === "boolean") return z.boolean();
  if (p.type === "array") return z.array(p.items ? zodType(p.items) : z.any());
  if (p.type === "object") return p.properties ? z.object(zodShape(p)) : z.record(z.string(), z.any());
  return z.string();
}
function zodShape(schema) {
  const required = new Set(schema.required ?? []);
  const shape = {};
  for (const [key, p] of Object.entries(schema.properties ?? {})) {
    let t = zodType(p);
    if (p.description) t = t.describe(p.description);
    shape[key] = required.has(key) ? t : t.optional();
  }
  return shape;
}

function toMcpResult(out) {
  if (Array.isArray(out)) {
    return {
      content: out.map((b) => (b.type === "image"
        ? { type: "image", data: b.source.data, mimeType: b.source.media_type }
        : { type: "text", text: b.text ?? "" })),
    };
  }
  const s = typeof out === "string" ? out : JSON.stringify(out);
  return { content: [{ type: "text", text: s.length > 30000 ? s.slice(0, 30000) + "\n...[truncated]" : s || "(no output)" }] };
}

const ADVISOR_SYSTEM = `You are a senior advisor to an AI team member who works for a business owner. You get their question and the relevant context. Reply with concise, concrete guidance: the best plan or answer, key risks, and what to check. No preamble. If the context is insufficient, say exactly what is missing.`;

// Sorts failures into retryable or not, so the queue retries only what can succeed later.
export function classifyError(message) {
  const m = String(message ?? "");
  if (USAGE_LIMIT_ERROR_PREFIXES.some((p) => m.includes(p))) return "usage_limit";
  if (/not logged in|invalid api key|authenticat|unauthori[sz]ed|forbidden|disabled for your org|permission/i.test(m)) return "fatal";
  if (/overloaded|rate.?limit|429|5dd|timeout|timed out|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|socket hang up|temporar/i.test(m)) return "transient";
  return "fatal";
}

async function askAdvisor(model, question, context, signal, onCost) {
  const abortController = new AbortController();
  signal?.addEventListener("abort", () => abortController.abort());
  const q = query({
    prompt: `Question:\n${question}\n\nContext:\n${context || "(none given)"}`,
    options: {
      model, systemPrompt: ADVISOR_SYSTEM, tools: [], settingSources: [], permissionMode: "dontAsk",
      maxTurns: 1, persistSession: false, cwd: WORKSPACE_DIR, abortController,
    },
  });
  let text = "";
  for await (const m of q) {
    if (m.type !== "result") continue;
    onCost?.(m.total_cost_usd ?? 0, m.usage);
    text = m.subtype === "success" ? m.result : `Advisor failed: ${(m.errors ?? []).join("; ")}`;
  }
  return text || "(no advice)";
}

function normalizeBlocks(blocks) {
  return blocks.map((b) => (b.type === "tool_use" ? { ...b, name: stripName(b.name) } : b));
}

/**
 * Runs one turn. `messages` is the app's own transcript (for the UI); the conversation the model
 * sees lives in the Claude Code session, resumed by `config.sessionId`.
 */
export async function runClaudeCodeTurn({ agent, config, prompt, ctx, emit, messages, save, signal, onSession }) {
  let advisorCost = 0;
  const resumedWithoutBaseline = Boolean(config.sessionId) && config.costTotal === undefined;
  const advisorUsage = { input_tokens: 0, output_tokens: 0 };
  const defs = toolsFor(agent, config.model, ctx).filter((d) => !d.type); // drop API server-tool entries
  const tools = defs.map((d) =>
    tool(d.name, d.description, zodShape(d.input_schema), async (args) => {
      try {
        return toMcpResult(await runTool(d.name, args, ctx));
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }));
  if (config.advisor) {
    tools.push(tool(
      "advisor",
      "Consult a stronger model for a plan or a hard call. It cannot see this conversation, so pass a self-contained question and all the context it needs.",
      { question: z.string().describe("What you need advice on"), context: z.string().describe("Goal, facts so far, options you're weighing") },
      async ({ question, context }) => {
        ctx.taskRun?.hooks?.onToolCall?.("advisor");
        const text = await askAdvisor(config.advisor, question, context, signal, (c, u) => {
          advisorCost += c;
          advisorUsage.input_tokens += u?.input_tokens ?? 0;
          advisorUsage.output_tokens += u?.output_tokens ?? 0;
        });
        return { content: [{ type: "text", text }] };
      },
    ));
  }
  const server = createSdkMcpServer({ name: "team", version: "1.0.0", tools, alwaysLoad: true });
  const builtins = config.web ? ["WebSearch", "WebFetch"] : [];

  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  signal.addEventListener("abort", onAbort);

  const q = query({
    prompt,
    options: {
      model: config.model,
      systemPrompt: config.system[0].text,
      tools: builtins,
      mcpServers: { team: server },
      allowedTools: [`${PREFIX}*`, ...builtins],
      permissionMode: "dontAsk", // anything not listed above is denied, never prompted
      settingSources: [], // ignore your personal Claude Code settings, hooks and plugins
      includePartialMessages: true,
      cwd: WORKSPACE_DIR,
      effort: config.effort,
      maxTurns: MAX_TURNS,
      resume: config.sessionId || undefined,
      abortController,
      // The only spending cap the app ever passes to Claude Code, and only when you set one in Settings.
      ...(Number.isFinite(ctx.budgetUsd) && ctx.budgetUsd > 0 ? { maxBudgetUsd: ctx.budgetUsd } : {}),
    },
  });

  let status = "done";
  let lastText = "";
  let errorKind = null;
  let errorMessage = null;
  let totalCost = null;
  let usage = null;
  try {
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") {
        onSession(m.session_id);
      } else if (m.type === "stream_event") {
        const ev = m.event;
        if (ev.type === "content_block_start") {
          const b = ev.content_block;
          if (b.type === "tool_use" || b.type === "server_tool_use") emit({ type: "tool_start", id: b.id, name: stripName(b.name) });
          else if (b.type === "thinking") emit({ type: "thinking_start" });
          else if (b.type === "text") emit({ type: "text_start" });
        } else if (ev.type === "content_block_delta") {
          if (ev.delta.type === "text_delta") emit({ type: "text_delta", text: ev.delta.text });
          else if (ev.delta.type === "thinking_delta") emit({ type: "thinking_delta", text: ev.delta.thinking });
        }
      } else if (m.type === "assistant") {
        const content = normalizeBlocks(m.message.content ?? []);
        messages.push({ role: "assistant", content });
        save();
        // Built-in web tools bypass runTool, so they're counted here toward the per-run tool limit.
        for (const raw of m.message.content ?? []) {
          if (raw.type === "tool_use" && !raw.name.startsWith(PREFIX)) {
            try { ctx.taskRun?.hooks?.onToolCall?.(raw.name); } catch { abortController.abort("tool_limit"); }
          }
        }
        for (const b of content) {
          if (b.type === "tool_use") emit({ type: "tool_input", id: b.id, name: b.name, input: b.input });
          if (b.type === "text" && b.text.trim()) lastText = b.text;
        }
      } else if (m.type === "user" && Array.isArray(m.message?.content)) {
        const results = m.message.content.filter((b) => b.type === "tool_result");
        if (results.length) {
          messages.push({ role: "user", content: results });
          save();
          for (const r of results) {
            const text = typeof r.content === "string" ? r.content
              : (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n") || "[image]";
            emit({ type: "tool_result", id: r.tool_use_id, isError: Boolean(r.is_error), preview: text.slice(0, 400) });
          }
        }
      } else if (m.type === "result") {
        totalCost = m.total_cost_usd ?? null;
        usage = m.usage ?? null;
        if (m.subtype === "success" && !m.is_error) {
          lastText = m.result || lastText;
        } else {
          status = "error";
          const why = m.subtype === "error_max_turns" ? `Stopped after ${MAX_TURNS} steps.`
            : m.subtype === "error_max_budget_usd" ? `Stopped: this run reached its budget (${ctx.budgetUsd?.toFixed(2)}).`
              : (m.errors ?? []).join("; ") || m.result || m.subtype;
          errorKind = m.subtype === "error_max_turns" ? "limit" : m.subtype === "error_max_budget_usd" ? "budget" : classifyError(why);
          errorMessage = why;
          emit({ type: "error", message: why });
        }
      }
    }
  } catch (err) {
    if (err instanceof AbortError || signal.aborted) {
      status = "stopped";
    } else {
      status = "error";
      errorKind = classifyError(err.message);
      errorMessage = err.message;
      const hint = errorKind === "fatal" && /log/i.test(err.message) ? ' Check that Claude Code is logged in (run "claude" once in a terminal).' : "";
      emit({ type: "error", message: `Claude Code error: ${err.message}.${hint}` });
      console.error(`[${agent.name}]`, err.message);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { q.close(); } catch {}
  }
  // A resumed session reports its cumulative total, so the turn's cost is the difference. Sessions
  // started before cost tracking have no baseline: their first total includes all earlier turns, so
  // that one turn is recorded as unknown (0) and becomes the baseline instead of a huge spike.
  let turnCost = 0;
  if (totalCost !== null) {
    turnCost = resumedWithoutBaseline ? 0 : Math.max(0, totalCost - (config.costTotal ?? 0));
    config.costTotal = totalCost;
  }
  return {
    status, text: lastText, errorKind, errorMessage, model: config.model,
    costUsd: turnCost + advisorCost,
    usage: { input_tokens: (usage?.input_tokens ?? 0) + advisorUsage.input_tokens, output_tokens: (usage?.output_tokens ?? 0) + advisorUsage.output_tokens },
  };
}
