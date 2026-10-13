import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { catalogFor } from "./test-model-policy.mjs";

const exec = promisify(execFile);
const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-mcp-lifecycle-"));
const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.mjs");
const fake = path.join(directory, "fake-opencode.mjs");
const policyFile = path.join(directory, "fallback-policy.json");
await writeFile(fake, `
import assert from 'node:assert/strict';
import { access, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
if (process.argv[2] === 'models') {
  console.log(${JSON.stringify(catalogFor(["opencode/muse-spark-1.3-contributor-free", "opencode/step-5-preview-free"]))});
  process.exit(0);
}
if (process.argv[2] === 'debug') {
  console.log(JSON.stringify({permission:{'*':'ask',edit:'deny'}}));
  process.exit(0);
}
const model = process.argv[process.argv.indexOf('--model') + 1];
const resumed = process.argv.includes('--session');
const prompt = resumed ? await readFile('fixture-session.txt', 'utf8') : process.argv.at(-1);
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
assert.equal(config.model, model);
assert.equal(config.small_model, model);
assert.equal(config.agent.explore.model, model);
assert.deepEqual(config.enabled_providers, [model.split('/')[0]]);
assert.deepEqual(config.permission, {'*':'ask',edit:'deny',task:'deny'});
assert.equal(process.argv.includes('--variant'), false);
const first = model.endsWith('muse-spark-1.3-contributor-free');
const emit = (type, part, session = true) => console.log(JSON.stringify({ type, part, ...(session ? {sessionID:'ses_fixture'} : {}) }));
if (!resumed) await writeFile('fixture-session.txt', prompt);
if (prompt.startsWith('gpt-') && (first || (prompt === 'gpt-failure' && model.startsWith('openai/')))) {
  if (prompt === 'gpt-expiry') await writeFile(process.env.OPENCODE_SUBAGENTS_POLICY_FILE, JSON.stringify({gptFallbackUntil:'2000-01-01T00:00:00Z'}));
  emit('tool_use', {state:{status:'completed'}});
  console.log(JSON.stringify({type:'error',sessionID:'ses_fixture',error:{message:'model not found'}}));
  process.exit(1);
} else if (prompt === 'provider-failure') {
  console.log(JSON.stringify({type:'error',sessionID:'ses_fixture',error:{message:'Go usage limit exceeded'}}));
  setInterval(() => {}, 1000);
} else if (prompt === 'hold' || (prompt === 'idle-first' && first)) {
  if (prompt === 'hold') emit('step_start', {});
  setInterval(() => {}, 1000);
} else if ((prompt === 'fallback-success' || prompt === 'no-session') && first) {
  await writeFile('once.txt', 'done');
  emit('tool_use', {state:{status:'completed'}}, prompt !== 'no-session');
  console.log(JSON.stringify({type:'error',...(prompt === 'no-session' ? {} : {sessionID:'ses_fixture'}),error:{message:'HTTP 429 Too Many Requests'}}));
  setInterval(() => {}, 1000);
} else if (prompt === 'empty-first' && first) {
  process.exit(0);
} else if (prompt === 'bad-exit') {
  process.exit(7);
} else if (prompt === 'long-tool') {
  emit('step_start', {});
  setTimeout(async () => { await writeFile('artifact.txt', 'long-tool'); emit('tool_use', {state:{status:'completed'}}); process.exit(0); }, 7000);
} else {
  emit('step_start', {});
  if (prompt === 'alpha' || prompt === 'beta') {
    const peer = path.join(process.env.OPENCODE_SUBAGENTS_FIXTURE_DIR, (prompt === 'alpha' ? 'beta' : 'alpha') + '.ready');
    await writeFile(path.join(process.env.OPENCODE_SUBAGENTS_FIXTURE_DIR, prompt + '.ready'), 'ready');
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await access(peer).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await access(peer);
  }
  if (prompt === 'fallback-success') {
    assert.equal(resumed, true);
    assert.equal(process.argv[process.argv.indexOf('--session') + 1], 'ses_fixture');
    assert.equal(await readFile('once.txt', 'utf8'), 'done');
  }
  await writeFile('artifact.txt', prompt + '\\n');
  setTimeout(() => { emit('text', {text:'artifact ready'}); process.exit(0); }, 2000);
}
`);
await chmod(fake, 0o755);
const repository = path.join(directory, "project");
await mkdir(repository);
await exec("git", ["init", "-q", repository]);
await writeFile(path.join(repository, "README.md"), "fixture\n");
await exec("git", ["add", "README.md"], { cwd: repository });
await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Fixture"], { cwd: repository });
const child = spawn(process.execPath, [server], {
  env: { ...process.env, OPENCODE_SUBAGENTS_FIXTURE_DIR: directory, OPENCODE_SUBAGENTS_POLICY_FILE: policyFile, OPENCODE_SUBAGENTS_IDLE_SECONDS: "5", OPENCODE_SUBAGENTS_OPENCODE: fake, OPENCODE_SUBAGENTS_STATE_DIR: path.join(directory, "state"), OPENCODE_SUBAGENTS_LOG_FILE: path.join(directory, "absent.log") },
  stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
let stderr = "";
child.stderr.on("data", (data) => { stderr += data; });
const pending = new Map();
const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});
let next = 1;
function call(name, args) {
  const id = next++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP response timed out: ${name}; ${stderr}`)); }, 15000);
    pending.set(id, (message) => { clearTimeout(timer); resolve({ ...JSON.parse(message.result.content[0].text), isError: message.result.isError }); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
}
const active = new Set();
async function start(args) {
  const run = await call("spawn", args);
  if (!run.isError) active.add(run.id);
  return run;
}
async function terminal(id) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const run = await call("wait", { id, wait_seconds: 1 });
    if (!["running", "cancelling"].includes(run.status)) { active.delete(id); return run; }
  }
  throw new Error("Run did not finish in the bounded wait");
}
try {
  const [first, second] = await Promise.all([
    start({ prompt: "alpha", directory: repository, timeout_seconds: 15 }),
    start({ prompt: "beta", directory: repository, timeout_seconds: 15 }),
  ]);
  assert.equal(first.status, "running");
  assert.equal(second.status, "running");
  assert.notEqual(first.workspace.directory, second.workspace.directory);
  assert.notEqual(first.workspace.branch, second.workspace.branch);
  assert.equal((await call("result", { id: first.id })).status, "running", "Both child processes must overlap");
  assert.equal((await terminal(first.id)).status, "completed");
  assert.equal((await terminal(second.id)).status, "completed");
  assert.equal(await readFile(path.join(first.workspace.directory, "artifact.txt"), "utf8"), "alpha\n");
  assert.equal(await readFile(path.join(second.workspace.directory, "artifact.txt"), "utf8"), "beta\n");
  const held = [];
  for (let index = 0; index < 4; index++) held.push(await start({ prompt: "hold", directory: repository, timeout_seconds: 30 }));
  assert.equal(held.every((run) => run.status === "running"), true);
  assert.equal((await start({ prompt: "hold", directory: repository })).isError, true, "A fifth run must be rejected");
  for (const run of held) { await call("cancel", { id: run.id }); assert.equal((await terminal(run.id)).status, "cancelled"); }
  const plain = path.join(directory, "plain");
  await mkdir(plain);
  const lock = await start({ prompt: "hold", directory: plain });
  assert.equal((await start({ prompt: "hold", directory: plain })).isError, true);
  await call("cancel", { id: lock.id });
  assert.equal((await terminal(lock.id)).status, "cancelled");
  const afterLock = await start({ prompt: "after-lock", directory: plain });
  assert.equal((await terminal(afterLock.id)).status, "completed");
  const provider = await start({ prompt: "provider-failure", directory: plain });
  const failed = await terminal(provider.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.detail, "Разрешённые модели исчерпаны: Go usage limit exceeded");
  assert.equal(failed.attempts.length, 2);
  for (const prompt of ["fallback-success", "empty-first", "idle-first"]) {
    const run = await start({ prompt, directory: plain, timeout_seconds: 15 });
    const result = await terminal(run.id);
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.modelID, "step-5-preview-free");
    assert.equal(result.attempts.length, 2);
    assert.equal(await readFile(path.join(plain, "artifact.txt"), "utf8"), prompt + "\n");
  }
  const unsafe = await start({ prompt: "no-session", directory: plain });
  const stopped = await terminal(unsafe.id);
  assert.equal(stopped.status, "failed");
  assert.equal(stopped.attempts.length, 1, "No replay after tool side effects without a session");
  const badExit = await start({ prompt: "bad-exit", directory: plain });
  assert.equal((await terminal(badExit.id)).attempts.length, 1, "CLI faults are not provider failovers");
  const deadline = await start({ prompt: "hold", directory: plain, timeout_seconds: 1 });
  const expired = await terminal(deadline.id);
  assert.equal(expired.status, "failed");
  assert.equal(expired.detail, "timeout 1s");
  assert.equal(expired.attempts.length, 1);
  assert.equal((await start({ prompt: "bad-timeout", timeout_seconds: 0 })).isError, true);
  assert.equal((await start({ prompt: "bad-model", model: "unapproved" })).isError, true);
  for (const prompt of ["gpt-success", "gpt-failure", "gpt-expiry"]) {
    await writeFile(policyFile, JSON.stringify({ gptFallbackUntil: new Date(Date.now() + 60_000).toISOString() }));
    const run = await start({ prompt, directory: plain, timeout_seconds: 15 });
    const result = await terminal(run.id);
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.sessionID, "ses_fixture");
    assert.equal(result.providerID, prompt === "gpt-success" ? "openai" : "opencode");
    assert.deepEqual(result.attempts.map(({model}) => model), [
      "opencode/muse-spark-1.3-contributor-free",
      ...(prompt === "gpt-expiry" ? [] : ["openai/gpt-6.1-sol"]),
      ...(prompt === "gpt-success" ? [] : ["opencode/step-5-preview-free"]),
    ]);
  }
  const expiredPolicy = await start({ prompt: "after-expiry", directory: plain, timeout_seconds: 15 });
  assert.equal(expiredPolicy.models.some((model) => model.startsWith("openai/")), false);
  assert.equal((await terminal(expiredPolicy.id)).status, "completed");
  const longTool = await start({ prompt: "long-tool", directory: plain, timeout_seconds: 15 });
  const longResult = await terminal(longTool.id);
  assert.equal(longResult.status, "completed", JSON.stringify(longResult));
  assert.equal(longResult.attempts.length, 1, "Active tools must survive the first-response timeout");
  console.log("MCP lifecycle passed: parallel artifacts, isolation, cap, cancellation, provider/empty/idle fallback, session resume and no unsafe replay");
} finally {
  for (const id of active) { await call("cancel", { id }); await terminal(id); }
  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));
  lines.close();
  await rm(directory, { recursive: true, force: true });
}
