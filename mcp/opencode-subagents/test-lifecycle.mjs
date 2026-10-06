import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-mcp-lifecycle-"));
const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.mjs");
const fake = path.join(directory, "fake-opencode.mjs");
await writeFile(fake, `
import { writeFile } from 'node:fs/promises';
const prompt = process.argv.at(-1);
if (prompt === 'provider-failure') {
  console.log(JSON.stringify({type:'error',error:{message:'Go usage limit exceeded'}}));
  setInterval(() => {}, 1000);
} else if (prompt === 'hold') {
  setInterval(() => {}, 1000);
} else {
  await writeFile('artifact.txt', prompt + '\\n');
  setTimeout(() => { console.log('artifact ready'); process.exit(0); }, 2000);
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
  env: { ...process.env, OPENCODE_SUBAGENTS_OPENCODE: fake, OPENCODE_SUBAGENTS_STATE_DIR: path.join(directory, "state"), OPENCODE_SUBAGENTS_LOG_FILE: path.join(directory, "absent.log") },
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
  for (let attempt = 0; attempt < 10; attempt++) {
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
  assert.equal(failed.detail, "Go usage limit exceeded");
  assert.equal((await start({ prompt: "bad-timeout", timeout_seconds: 0 })).isError, true);
  assert.equal((await start({ prompt: "bad-model", model: "unapproved" })).isError, true);
  console.log("MCP lifecycle passed: parallel artifacts, isolation, cap, cancellation, directory lock and provider failure");
} finally {
  for (const id of active) { await call("cancel", { id }); await terminal(id); }
  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));
  lines.close();
  await rm(directory, { recursive: true, force: true });
}
