import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-failure-test-"));
const log = path.join(directory, "provider.log");
await writeFile(log, "");
await writeFile(path.join(directory, "run"), `
const fs = require('node:fs');
require('node:assert/strict').equal(process.argv[process.argv.indexOf('--model') + 1], 'openai/gpt-6.1-sol');
require('node:assert/strict').equal(process.argv[process.argv.indexOf('--variant') + 1], 'xhigh');
const title = process.argv[process.argv.indexOf('--title') + 1];
fs.appendFileSync(process.env.OPENCODE_SUBAGENTS_LOG_FILE,
  'level=ERROR run=foreign message="Go usage limit exceeded"\\n' +
  'level=INFO run=own message=created title="' + title + '"\\n');
setTimeout(() => fs.appendFileSync(process.env.OPENCODE_SUBAGENTS_LOG_FILE,
  'level=ERROR run=own message="Go usage limit exceeded"\\n'), 1500);
setInterval(() => {}, 1000);
`);
const child = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")], {
  env: { ...process.env, OPENCODE_SUBAGENTS_OPENCODE: process.execPath, OPENCODE_SUBAGENTS_LOG_FILE: log },
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
  assert.equal(state.detail, "Go usage limit exceeded");
  assert.ok(Date.parse(state.finishedAt) - Date.parse(state.startedAt) < 10000);
  assert.equal((await readFile(log, "utf8")).includes('run=own message="Go usage limit exceeded"'), true);
  console.log("provider quota failure detected, exact child stopped, detail retained");
} finally {
  if (run) await call("tools/call", { name: "cancel", arguments: { id: run.id } });
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  lines.close();
  await rm(path.join(directory, "run"));
  await rm(log);
  await rmdir(directory);
}
