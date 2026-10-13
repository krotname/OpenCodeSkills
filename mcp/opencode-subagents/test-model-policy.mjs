import assert from "node:assert/strict";
import { executionModels, freeModels, gptFallbackActive, GPT_FALLBACK, modelEnvironment, MODEL_ORDER } from "./model-policy.mjs";

export function catalogFor(ids = MODEL_ORDER) {
  return ids.map((id) => `${id}\n${JSON.stringify({
    id: id.split("/")[1], providerID: "opencode", capabilities: { toolcall: true },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  })}\n`).join("");
}

assert.deepEqual(freeModels(catalogFor([...MODEL_ORDER].reverse())), MODEL_ORDER);
for (const patch of [
  { cost: { input: 1, output: 0 } }, { cost: { input: 0, output: 0, cache: { read: 1 } } },
  { cost: {} }, { capabilities: { toolcall: false } }, { status: "deprecated" }, { providerID: "openai" },
]) {
  const catalog = JSON.parse(catalogFor([MODEL_ORDER[0]]).split("\n")[1]);
  assert.throws(() => freeModels(`${MODEL_ORDER[0]}\n${JSON.stringify({ ...catalog, ...patch })}`), /Нет доступных/);
}
assert.throws(() => freeModels(catalogFor(["opencode/paid-alias", "opencode/jev-latest"])), /Нет доступных/);
const now = Date.parse("2030-01-01T00:00:00Z");
const policy = { gptFallbackUntil: "2030-01-01T00:00:01Z" };
assert.deepEqual(executionModels(catalogFor(), policy, now), [MODEL_ORDER[0], GPT_FALLBACK, ...MODEL_ORDER.slice(1)]);
assert.deepEqual(executionModels(catalogFor(), policy, now + 1000), MODEL_ORDER);
assert.deepEqual(executionModels(catalogFor(), {}, now), MODEL_ORDER);
assert.equal(gptFallbackActive({ gptFallbackUntil: "invalid" }, now), false);
assert.equal(gptFallbackActive({ gptFallbackUntil: 9999999999999 }, now), false);
assert.deepEqual(executionModels(catalogFor([MODEL_ORDER[1]]), policy, now), [GPT_FALLBACK, MODEL_ORDER[1]]);
assert.deepEqual(executionModels("", policy, now), [GPT_FALLBACK]);
assert.throws(() => executionModels("", policy, now + 1000), /Нет доступных/);
const env = modelEnvironment({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "paid/model", small_model: "paid/helper", permission: { edit: "allow", task: "allow" }, agent: { explore: { model: "paid/agent", description: "existing" }, title: { model: "opencode/paid-title" }, custom: { model: "opencode/paid-custom" } } }) }, MODEL_ORDER[0]);
const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
assert.equal(config.model, MODEL_ORDER[0]);
assert.equal(config.small_model, MODEL_ORDER[0]);
assert.equal(config.agent.explore.model, MODEL_ORDER[0]);
assert.equal(config.agent.explore.description, "existing");
for (const name of ["build", "plan", "general", "explore", "scout", "compaction", "title", "summary", "custom"]) {
  assert.equal(config.agent[name].model, MODEL_ORDER[0]);
}
assert.deepEqual(config.enabled_providers, ["opencode"]);
assert.equal(config.permission.edit, "allow");
assert.equal(config.permission.task, "deny");
const gptConfig = JSON.parse(modelEnvironment({}, GPT_FALLBACK).OPENCODE_CONFIG_CONTENT);
assert.deepEqual(gptConfig.enabled_providers, ["openai"]);
assert.equal(gptConfig.agent.title.model, GPT_FALLBACK);
assert.equal(gptConfig.small_model, GPT_FALLBACK);
assert.equal(gptConfig.provider.openai.models["gpt-6.1-sol"].name, "GPT-6.1 Sol");
for (const permissions of ["deny", { "*": "deny", edit: "deny", bash: "ask" }]) {
  const preserved = JSON.parse(modelEnvironment({}, MODEL_ORDER[0], permissions).OPENCODE_CONFIG_CONTENT).permission;
  assert.deepEqual(preserved, { ...(typeof permissions === "string" ? { "*": permissions } : permissions), task: "deny" });
}
assert.deepEqual(JSON.parse(modelEnvironment({OPENCODE_CONFIG_CONTENT:'{"permission":"deny"}'}, MODEL_ORDER[0]).OPENCODE_CONFIG_CONTENT).permission, {"*":"deny",task:"deny"});
console.log("Model policy passed: free costs, timed GPT fallback, expiry and helper overrides");
