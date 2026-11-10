import assert from "node:assert/strict";
import { executionModels, freeModels, gptFallbackActive, GPT_FALLBACK, modelEnvironment, MODEL_ORDER } from "./model-policy.mjs";

export function catalogFor(ids = MODEL_ORDER) {
  return JSON.stringify({ data: ids.map((id) => ({
    id: id.split("/")[1], providerID: "opencode", enabled: true, capabilities: { tools: true },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  })) });
}

assert.deepEqual(freeModels(catalogFor([...MODEL_ORDER].reverse())), MODEL_ORDER);
for (const patch of [
  { cost: [{ input: 1, output: 0 }] }, { cost: [{ input: 0, output: 0, cache: { read: 1 } }] },
  { cost: [{ input: 0, output: 0 }, { input: 1, output: 0 }] },
  { cost: [] }, { cost: [{}] }, { cost: { input: 0, output: 0 } }, { cost: null },
  { capabilities: { tools: false } }, { capabilities: { toolcall: true } },
  { status: "deprecated" }, { enabled: false }, { providerID: "openai" },
]) {
  const model = JSON.parse(catalogFor([MODEL_ORDER[0]])).data[0];
  assert.throws(() => freeModels({ data: [{ ...model, ...patch }] }), /Нет доступных/);
}
assert.throws(() => freeModels(catalogFor(["opencode/paid-alias"])), /Нет доступных/);
assert.throws(() => freeModels({}), /каталог/);
const now = Date.parse("2030-01-01T00:00:00Z");
const policy = { gptFallbackUntil: "2030-01-01T00:00:01Z" };
assert.deepEqual(executionModels(catalogFor(), policy, now), [MODEL_ORDER[0], GPT_FALLBACK, ...MODEL_ORDER.slice(1)]);
assert.deepEqual(executionModels(catalogFor(), policy, now + 1000), MODEL_ORDER);
assert.deepEqual(executionModels(catalogFor(), {}, now), MODEL_ORDER);
assert.equal(gptFallbackActive({ gptFallbackUntil: "invalid" }, now), false);
assert.equal(gptFallbackActive({ gptFallbackUntil: 9999999999999 }, now), false);
assert.deepEqual(executionModels(catalogFor([MODEL_ORDER[1]]), policy, now), [GPT_FALLBACK, MODEL_ORDER[1]]);
assert.deepEqual(executionModels("", policy, now), [GPT_FALLBACK]);
assert.throws(() => executionModels("", policy, now + 1000));

const originalPermission = { action: "edit", resource: "*", effect: "deny" };
const entries = [{ type: "directory", path: "/config" }, { type: "document", info: {
  permissions: [originalPermission], agents: { custom: { model: "paid/agent", description: "existing" } },
} }];
const original = { OPENCODE_CONFIG_CONTENT: JSON.stringify({
  model: { providerID: "paid", model: "model", variant: "xhigh" },
  permissions: [{ action: "subagent", resource: "*", effect: "allow" }],
  agents: { explore: { model: "paid/agent", description: "explorer" } },
  experimental: { subagent_depth: 10 },
}) };
const env = modelEnvironment(original, MODEL_ORDER[0], entries);
const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
const selection = { providerID: "opencode", model: MODEL_ORDER[0].split("/")[1] };
assert.deepEqual(config.model, selection);
assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
assert.equal(config.default_agent, "build");
for (const name of ["build", "plan", "general", "explore", "scout", "compaction", "title", "summary", "custom"]) {
  assert.deepEqual(config.agents[name].model, selection);
  assert.deepEqual(config.agents[name].permissions.slice(-2).map((rule) => rule.action), ["task", "subagent"]);
}
assert.equal(config.agents.custom.description, "existing");
assert.equal(config.agents.explore.description, "explorer");
assert.deepEqual(config.permissions[0], originalPermission);
assert.deepEqual(config.permissions.slice(-2), ["task", "subagent"].map((action) => ({ action, resource: "*", effect: "deny" })));
assert.deepEqual(config.policies.slice(-2), [
  { action: "provider.use", resource: "*", effect: "deny" },
  { action: "provider.use", resource: "opencode", effect: "allow" },
]);
assert.equal(config.experimental.subagent_depth, 0);
assert.equal(JSON.parse(original.OPENCODE_CONFIG_CONTENT).experimental.subagent_depth, 10);
const gptConfig = JSON.parse(modelEnvironment({}, GPT_FALLBACK).OPENCODE_CONFIG_CONTENT);
assert.deepEqual(gptConfig.model, { providerID: "openai", model: "gpt-6.1-sol" });
assert.equal(gptConfig.providers.openai.models["gpt-6.1-sol"].name, "GPT-6.1 Sol");
assert.equal(gptConfig.policies.at(-1).resource, "openai");
assert.throws(() => modelEnvironment({}, MODEL_ORDER[0], [{ type: "document", info: {
  policies: [{ action: "provider.use", resource: "*", effect: "allow" }],
} }]), /изоляция Muse невозможна/);
assert.doesNotThrow(() => modelEnvironment({}, MODEL_ORDER[0], [{ type: "document", info: {
  policies: [{ action: "provider.use", resource: "opencode", effect: "allow" }],
} }]));
console.log("Model policy passed: v2 prices, tool capability, timed fallback, pinned agents and nested-agent denial");
