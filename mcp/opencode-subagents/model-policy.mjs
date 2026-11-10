// The only paid exception is a fixed model with an explicit local expiry.
export const GPT_FALLBACK = "openai/gpt-6.1-sol";
export const MODEL_ORDER = Object.freeze([
  "opencode/muse-spark-1.3-contributor-free",
  "opencode/space-bunny-free",
  "opencode/step-5-preview-free",
  "opencode/exo-free",
  "opencode/mimo-v2.6-flash-free",
  "opencode/longcat-2.5-preview-free",
  "opencode/ling-3.1-flash-free",
  "opencode/big-pickle",
]);

export function freeModels(catalog) {
  const snapshot = typeof catalog === "string" ? JSON.parse(catalog) : catalog;
  if (!Array.isArray(snapshot?.data)) throw new Error("Некорректный каталог OpenCode v2");
  const found = new Map();
  for (const model of snapshot.data) {
    if (model.providerID !== "opencode" || model.enabled !== true || model.capabilities?.tools !== true || model.status === "deprecated") continue;
    // Empty/unknown prices and any paid context tier are never evidence of free use.
    if (!Array.isArray(model.cost) || !model.cost.length || !model.cost.every((cost) =>
      cost?.input === 0 && cost?.output === 0 && (cost.cache?.read ?? 0) === 0 && (cost.cache?.write ?? 0) === 0)) continue;
    found.set(`opencode/${model.id}`, model);
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

export function modelEnvironment(environment, model, entries = []) {
  const overrides = JSON.parse(environment.OPENCODE_CONFIG_CONTENT || "{}");
  const documents = entries.filter((entry) => entry.type === "document").map((entry) => entry.info);
  const selection = { providerID: model.split("/")[0], model: model.slice(model.indexOf("/") + 1) };
  // Authored global policies outrank inline policies in v2. Fail closed if
  // one could reopen another provider instead of silently weakening isolation.
  if (documents.some((info) => (info.policies ?? []).some((rule) =>
    rule.action === "provider.use" && rule.effect === "allow" && rule.resource !== selection.providerID))) {
    throw new Error("Глобальная политика OpenCode разрешает другого провайдера; изоляция Muse невозможна");
  }
  const denyNested = ["task", "subagent"].map((action) => ({ action, resource: "*", effect: "deny" }));
  const configuredAgents = Object.assign({}, ...documents.map((info) => info.agents), overrides.agents);
  const agents = {};
  for (const name of new Set(["build", "plan", "general", "explore", "scout", "compaction", "title", "summary", ...Object.keys(configuredAgents)])) {
    const agent = configuredAgents[name] ?? {};
    agents[name] = { ...agent, model: selection, permissions: [...(agent.permissions ?? []), ...denyNested] };
  }
  const providers = { ...overrides.providers };
  if (model === GPT_FALLBACK) {
    providers.openai = {
      ...providers.openai,
      models: { ...providers.openai?.models, "gpt-6.1-sol": { name: "GPT-6.1 Sol" } },
    };
  }
  return {
    ...environment,
    NO_COLOR: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...overrides, model: selection, default_agent: "build", providers, agents,
      permissions: [...documents.flatMap((info) => info.permissions ?? []), ...(overrides.permissions ?? []), ...denyNested],
      policies: [
        ...(overrides.policies ?? []),
        { action: "provider.use", resource: "*", effect: "deny" },
        { action: "provider.use", resource: selection.providerID, effect: "allow" },
      ],
      experimental: { ...overrides.experimental, subagent_depth: 0 },
    }),
  };
}
