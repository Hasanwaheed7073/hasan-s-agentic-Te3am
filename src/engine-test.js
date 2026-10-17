// DETERMINISTIC TEST PROVIDER — no AI model is called. A team member whose model is "test" runs the
// script in task.input.test_script step by step through the same tool layer (permissions, opt-outs,
// approvals, idempotency) as real agents. Used to verify the execution system without spending usage.
//
// Steps: { tool, input } | { text } | { fail: "transient" | "fatal" } | { sleep_ms } | { cost_usd } (simulated engine cost)
// A workflow can give each step its own script via input.test_scripts[step_key].
// Any step may add { on_attempt: n } to run only on that attempt (e.g. fail on attempt 1, succeed on 2).
// Inputs may reference earlier results: "$prev.id", "$step.0.id", "$upstream.prospect_ids".
import { runTool } from "./tools.js";

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
});

function resolveRefs(value, env) {
  if (typeof value === "string" && value.startsWith("$")) {
    const [root, ...path] = value.slice(1).split(".");
    let base = root === "prev" ? env.results.at(-1) : root === "upstream" ? env.upstream : root === "step" ? env.results[Number(path.shift())] : undefined;
    for (const p of path) base = base?.[p];
    return base === undefined ? value : base;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, env));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, env)]));
  return value;
}

export async function runTestTurn({ ctx, emit, messages, save, signal }) {
  const task = ctx.taskRun?.task;
  const script = task?.input?.test_scripts?.[task.step_key] ?? task?.input?.test_script;
  const say = (text) => {
    emit({ type: "text_start" });
    emit({ type: "text_delta", text });
    messages.push({ role: "assistant", content: [{ type: "text", text }] });
    save();
  };
  if (!Array.isArray(script)) {
    say("[Deterministic test provider] I don't call an AI model. Give me a task whose input has a test_script to exercise the system.");
    return { status: "done", text: "test provider: no script", costUsd: 0, usage: { input_tokens: 0, output_tokens: 0 }, model: "test" };
  }
  // Upstream list fields merged, e.g. $upstream.prospect_ids = all prospect IDs from dependencies.
  const upstream = {};
  for (const o of ctx.taskRun.upstream ?? []) {
    for (const [k, v] of Object.entries(o.output ?? {})) if (Array.isArray(v)) upstream[k] = [...(upstream[k] ?? []), ...v];
  }
  const env = { results: [], upstream };
  const attempt = ctx.taskRun.run.attempt;
  let lastText = "";
  let n = 0;
  let cost = 0;
  try {
    for (const step of script) {
      if (signal.aborted) return { status: "stopped", model: "test" };
      if (step.on_attempt && step.on_attempt !== attempt) continue;
      if (step.fail) {
        const msg = `[test] simulated ${step.fail} failure on attempt ${attempt}`;
        emit({ type: "error", message: msg });
        return { status: "error", errorKind: step.fail === "transient" ? "transient" : "fatal", errorMessage: msg, costUsd: 0, model: "test" };
      }
      if (step.sleep_ms) await sleep(step.sleep_ms, signal);
      if (step.cost_usd) cost += Number(step.cost_usd);
      if (step.text) { say(step.text); lastText = step.text; }
      if (step.tool) {
        const id = `test_${ctx.taskRun.run.id.slice(0, 8)}_${n++}`;
        const input = resolveRefs(step.input ?? {}, env);
        emit({ type: "tool_start", id, name: step.tool });
        messages.push({ role: "assistant", content: [{ type: "tool_use", id, name: step.tool, input }] });
        emit({ type: "tool_input", id, name: step.tool, input });
        let out; let isError = false;
        try { out = await runTool(step.tool, input, ctx); } catch (e) { out = `Error: ${e.message}`; isError = true; }
        const text = typeof out === "string" ? out : JSON.stringify(out);
        let parsed = text;
        try { parsed = JSON.parse(text); } catch {}
        env.results.push(parsed);
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] });
        save();
        emit({ type: "tool_result", id, isError, preview: text.slice(0, 400) });
      }
    }
  } catch (e) {
    if (signal.aborted) return { status: "stopped", model: "test" };
    throw e;
  }
  return { status: "done", text: lastText || "[test] script finished", costUsd: cost, usage: { input_tokens: 0, output_tokens: 0 }, model: "test" };
}
