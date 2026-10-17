// Engine for custom OpenAI-compatible providers (Groq etc.). Same tools, permissions, approvals and
// limits as the Claude engines: every tool call goes through runTool.
import { toolsFor, runTool } from "./tools.js";
import { providers, chatCompletion, costFor, ProviderError } from "./providers.js";

const MAX_STEPS = Number(process.env.MAX_STEPS_PER_TURN ?? 60);
const MAX_TOOL_RESULT = 12_000; // keeps long pages from exhausting smaller context windows

export const OPENAI_ENGINE_NOTE = `You have no built-in web search. To search, call fetch_url with https://html.duckduckgo.com/html/?q=<your query> (URL-encoded), then fetch_url the result pages you need. Use browser tools for sites that need a login or clicking. Call tools with valid JSON arguments only.`;

function resultText(out) {
  if (Array.isArray(out)) {
    return out.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image omitted: this model can't view images]" : "")).join("\n");
  }
  const s = typeof out === "string" ? out : JSON.stringify(out);
  return s.length > MAX_TOOL_RESULT ? s.slice(0, MAX_TOOL_RESULT) + "\n...[truncated]" : s || "(no output)";
}

export async function runOpenAiTurn({ agent, config, ctx, emit, messages, save, signal, userText }) {
  const p = providers.get(config.providerId);
  if (!p) return { status: "error", errorKind: "fatal", errorMessage: "This member's AI provider was deleted. Choose another model in their profile.", model: config.model };
  const toolCtx = { ...ctx, engineKind: "openai" };
  const defs = toolsFor(agent, p.model, toolCtx).filter((d) => !d.type && d.name !== "browser_screenshot");
  const tools = defs.map((d) => ({ type: "function", function: { name: d.name, description: d.description, parameters: d.input_schema } }));
  // The provider's own conversation history lives in the thread config (the UI transcript is separate).
  config.history ??= [{ role: "system", content: `${config.system[0].text}\n\n${OPENAI_ENGINE_NOTE}` }];
  config.history.push({ role: "user", content: userText });

  const usage = { input_tokens: 0, output_tokens: 0 };
  let costUsd = 0;
  let lastText = "";
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) return { status: "stopped", text: lastText, usage, costUsd, model: `${p.name}:${p.model}` };
      const r = await chatCompletion(p, { messages: config.history, ...(tools.length ? { tools, tool_choice: "auto" } : {}), temperature: 0.3 }, {
        signal, onWait: (ms) => emit({ type: "note", message: `${p.name} rate limit: waiting ${Math.ceil(ms / 1000)}s for the reset` }),
      });
      usage.input_tokens += r.usage?.prompt_tokens ?? 0;
      usage.output_tokens += r.usage?.completion_tokens ?? 0;
      costUsd += costFor(p, r.usage);
      const msg = r.choices?.[0]?.message;
      if (!msg) throw new ProviderError(`${p.name} returned no message`, { kind: "transient" });
      config.history.push({ role: "assistant", content: msg.content ?? "", ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });

      if (msg.content?.trim()) {
        emit({ type: "text_start" });
        emit({ type: "text_delta", text: msg.content });
        messages.push({ role: "assistant", content: [{ type: "text", text: msg.content }] });
        lastText = msg.content;
        save();
      }
      if (!msg.tool_calls?.length) break;

      const blocks = [];
      const results = [];
      for (const tc of msg.tool_calls) {
        const name = tc.function?.name;
        let input = {};
        let parseError = null;
        try { input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { parseError = "Arguments were not valid JSON. Call the tool again with valid JSON."; }
        emit({ type: "tool_start", id: tc.id, name });
        emit({ type: "tool_input", id: tc.id, name, input });
        blocks.push({ type: "tool_use", id: tc.id, name, input });
        let content; let isError = false;
        if (parseError) { content = `Error: ${parseError}`; isError = true; }
        else {
          try { content = resultText(await runTool(name, input, toolCtx)); }
          catch (e) { content = `Error: ${e.message}`; isError = true; }
        }
        config.history.push({ role: "tool", tool_call_id: tc.id, content });
        results.push({ type: "tool_result", tool_use_id: tc.id, content, ...(isError ? { is_error: true } : {}) });
        emit({ type: "tool_result", id: tc.id, isError, preview: content.slice(0, 400) });
        if (signal.aborted) break;
      }
      messages.push({ role: "assistant", content: blocks });
      messages.push({ role: "user", content: results });
      save();
    }
  } catch (e) {
    if (signal.aborted || e.kind === "cancelled") return { status: "stopped", text: lastText, usage, costUsd, model: `${p.name}:${p.model}` };
    const kind = e instanceof ProviderError ? e.kind : "fatal";
    emit({ type: "error", message: e.message });
    return { status: "error", text: lastText, usage, costUsd, model: `${p.name}:${p.model}`, errorKind: kind, errorMessage: e.message, retryAt: e.retryAt ?? null };
  }
  return { status: "done", text: lastText, usage, costUsd, model: `${p.name}:${p.model}` };
}
