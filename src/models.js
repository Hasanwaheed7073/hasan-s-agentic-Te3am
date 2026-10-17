// Prices are per million tokens (input / output). Haiku's rate rises to $0.50 / $2.50 when a single
// request's prompt is over 100K tokens.
export const MODELS = {
  haiku: { id: "claude-haiku-5-5", label: "Haiku 5.5 · cheapest ($0.10 / $0.50)", fallbacks: false, price: [0.10, 0.50] },
  sonnet: { id: "claude-sonnet-5-5", label: "Sonnet 5.5 · balanced ($2 / $10)", fallbacks: true, price: [2, 10] },
  opus: { id: "claude-opus-5-5", label: "Opus 5.5 · strongest ($4 / $20)", fallbacks: true, price: [4, 20] },
  // No AI: runs a scripted test plan through the real tool and permission layer. For verification only.
  test: { id: "test", label: "TEST · deterministic, no AI (for testing)", fallbacks: false, price: [0, 0] },
};

// The advisor is a stronger model the worker consults for plans and hard calls.
// You pay its rate only for those short consultations.
export const ADVISORS = {
  none: { id: null, label: "No advisor" },
  sonnet: { id: "claude-sonnet-5-5", label: "Sonnet 5.5 advisor" },
  opus: { id: "claude-opus-5-5", label: "Opus 5.5 advisor (recommended)" },
};

const RANK = { haiku: 0, sonnet: 1, opus: 2 };

export function resolveModels(agent) {
  const modelKey = MODELS[agent.model] && agent.model !== "test" ? agent.model : "haiku";
  const advisorKey = ADVISORS[agent.advisor] ? agent.advisor : "none";
  // The API only accepts an advisor stronger than the worker; an equal one adds cost for nothing.
  const advisorId = advisorKey !== "none" && RANK[advisorKey] > RANK[modelKey] ? ADVISORS[advisorKey].id : null;
  return { model: MODELS[modelKey].id, fallbacks: MODELS[modelKey].fallbacks, advisor: advisorId };
}
