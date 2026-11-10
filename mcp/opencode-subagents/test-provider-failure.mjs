import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { catalogFor } from "./test-model-policy.mjs";
import { inspectErrorLogLines } from "./provider-failure.mjs";

assert.equal(inspectErrorLogLines(['timestamp=2026-11-10 level=ERROR run=private message="HTTP 429 Too Many Requests"']), "Provider rate or usage limit");
assert.equal(inspectErrorLogLines(['level=INFO message="HTTP 429 in tool output"']), null);

const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-failure-test-"));
const log = path.join(directory, "provider.log");
await writeFile(path.join(directory, "serve"), `const server=require('node:http').createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(${JSON.stringify(catalogFor(["opencode/muse-spark-1.3-contributor-free"]))});});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port})));const stdinGuardTimer=setTimeout(()=>process.exit(2),15000);stdinGuardTimer.unref();process.stdin.resume();process.stdin.on('end',()=>server.close(()=>process.exit(0)));`);
await writeFile(log, "");
await writeFile(path.join(directory, "api"), `console.log(process.argv.at(-1) === '/api/model' ? ${JSON.stringify(catalogFor(["opencode/muse-spark-1.3-contributor-free"]))} : JSON.stringify([{type:'document',info:{permissions:[{action:'*',resource:'*',effect:'deny'}]}}]));`);
await writeFile(path.join(directory, "run"), `
const fs = require('node:fs');
require('node:assert/strict').equal(process.argv[process.argv.indexOf('--model') + 1], 'opencode/muse-spark-1.3-contributor-free');
require('node:assert/strict').equal(process.argv.includes('--variant'), false);
const title = process.argv[process.argv.indexOf('--title') + 1];
if (process.env.MUSE_FAILURE_MODE === 'stderr') {
  process.stderr.write('level=INFO message="HTTP 429 in tool output"\\n');
  setTimeout(() => process.stderr.write('level=ERROR run=private message="Go usage '), 100);
  setTimeout(() => process.stderr.write('limit exceeded"\\n'), 300);
} else {
fs.appendFileSync(process.env.OPENCODE_SUBAGENTS_LOG_FILE,
  'level=ERROR run=foreign message="Go usage limit exceeded"\\n' +
  'level=INFO run=own message=created title="' + title + '"\\n');
setTimeout(() => fs.appendFileSync(process.env.OPENCODE_SUBAGENTS_LOG_FILE,
  'level=ERROR run=own message="Go usage limit exceeded"\\n'), 1500);
}
setInterval(() => {}, 1000);
`);
for (const mode of ["legacy", "stderr"]) {
const child = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")], {
  env: { ...process.env, MUSE_FAILURE_MODE: mode, OPENCODE_SUBAGENTS_POLICY_FILE: path.join(directory, "absent-policy.json"), OPENCODE_SUBAGENTS_OPENCODE: process.execPath, OPENCODE_SUBAGENTS_LOG_FILE: mode === "legacy" ? log : "" },
  stdio: ["pipe", "pipe", "inherit"], windowsHide: true,
});
let nextId = 1;
const pending = new Map();
const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  pending.get(msg.id)?.(msg.result);
  pending.delete(msg.id);
});
function call(method, params) {
  const id = nextId++;
  const promise = new Promise((resolve) => pending.set(id, resolve));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return promise;
}
let run;
try {
  await call("initialize", { protocolVersion: "2025-03-26" });
  const started = await call("tools/call", { name: "spawn", arguments: { directory, prompt: "fixture", timeout_seconds: 30 } });
  run = JSON.parse(started.content[0].text);
  assert.equal(started.isError, false);
  const result = await call("tools/call", { name: "wait", arguments: { id: run.id, wait_seconds: 10 } });
  const state = JSON.parse(result.content[0].text);
  assert.equal(state.status, "failed", JSON.stringify(state));
  assert.equal(state.detail, "Разрешённые модели исчерпаны: Go usage limit exceeded");
  assert.equal(state.attempts.length, 1);
  assert.ok(Date.parse(state.finishedAt) - Date.parse(state.startedAt) < 10000);
  assert.equal((await readFile(log, "utf8")).includes('run=own message="Go usage limit exceeded"'), true);
  console.log(`${mode}: provider quota failure detected, exact child stopped, detail retained`);
} finally {
  if (run) await call("tools/call", { name: "cancel", arguments: { id: run.id } });
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  lines.close();
}
}
  await rm(path.join(directory, "run"));
  await rm(path.join(directory, "api"));
  await rm(path.join(directory, "serve"));
  await rm(log);
  await rmdir(directory);
