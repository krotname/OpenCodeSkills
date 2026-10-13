// The only paid exception is a fixed model with an explicit local expiry.
export const GPT_FALLBACK = "openai/gpt-6.1-sol";
export const MODEL_ORDER = Object.freeze([
  "opencode/muse-spark-1.3-contributor-free",
  "opencode/space-bunny-free",
  "opencode/step-5-preview-free",
  "opencode/exo-free",
  "opencode/cat-jam-free",
  "opencode/mimo-v2.6-flash-free",
  "opencode/longcat-2.5-preview-free",
  "opencode/ling-3.1-flash-free",
  "opencode/big-pickle",
]);

export function freeModels(catalog) {
  const found = new Map();
  const blocks = catalog.replace(/\u001b\[[0-9;]*m/g, "").split(/^(opencode\/[\w.-]+)\s*$/m);
  for (let index = 1; index < blocks.length; index += 2) {
    let model;
    try { model = JSON.parse(blocks[index + 1].trim()); } catch { continue; }
    const cost = model.cost;
    if (model.providerID !== "opencode" || model.capabilities?.toolcall !== true || model.status === "deprecated") continue;
    if (cost?.input !== 0 || cost?.output !== 0 || (cost.cache?.read ?? 0) !== 0 || (cost.cache?.write ?? 0) !== 0) continue;
    if (blocks[index] !== `opencode/${model.id}`) continue;
    found.set(blocks[index], model);
  }
  const models = MODEL_ORDER.filter((id) => found.has(id));
  if (!models.length) throw new Error("Нет доступных бесплатных OpenCode-моделей с поддержкой инструментов");
  return models;
}

export function gptFallbackActive(policy, now = Date.now()) {
  const until = typeof policy?.gptFallbackUntil === "string" ? Date.parse(policy.gptFallbackUntil) : NaN;
  return Number.isFinite(until) && now < until;
}

export function executionModels(catalog, policy, now = Date.now()) {
  let models;
  try { models = freeModels(catalog); }
  catch (error) { if (!gptFallbackActive(policy, now)) throw error; models = []; }
  if (gptFallbackActive(policy, now)) {
    models.splice(models[0] === MODEL_ORDER[0] ? 1 : 0, 0, GPT_FALLBACK);
  }
  return models;
}

export function modelEnvironment(environment, model, permissions) {
  const overrides = JSON.parse(environment.OPENCODE_CONFIG_CONTENT || "{}");
  const permission = permissions ?? overrides.permission;
  const agent = { ...overrides.agent };
  for (const name of new Set(["build", "plan", "general", "explore", "scout", "compaction", "title", "summary", ...Object.keys(agent)])) {
    agent[name] = { ...agent[name], model };
  }
  const provider = { ...overrides.provider };
  if (model === GPT_FALLBACK) {
    provider.openai = {
      ...provider.openai,
      models: { ...provider.openai?.models, "gpt-6.1-sol": { name: "GPT-6.1 Sol" } },
    };
  }
  return {
    ...environment,
    NO_COLOR: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...overrides, model, small_model: model,
      enabled_providers: [model.split("/")[0]],
      disabled_providers: [],
      provider,
      agent,
      permission: { ...(typeof permission === "string" ? { "*": permission } : permission), task: "deny" },
    }),
  };
}
