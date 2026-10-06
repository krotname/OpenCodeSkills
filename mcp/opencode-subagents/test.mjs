import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { inspectLogLines, inspectOutputLines, providerFailure } from "./provider-failure.mjs";

assert.equal(providerFailure("AI_APICallError: Go usage limit exceeded"), "Go usage limit exceeded");
assert.equal(providerFailure("connection timeout"), null);
assert.equal(inspectOutputLines(['{"type":"tool_use","part":{"output":"Go usage limit exceeded"}}']), null);
assert.equal(inspectOutputLines(['{"type":"error","error":{"message":"Go usage limit exceeded"}}']), "Go usage limit exceeded");
const logState = {};
assert.equal(inspectLogLines(logState, [
  'level=ERROR run=foreign message="Go usage limit exceeded"',
  'level=INFO run=own message=created title="Muse subagent 12345678"',
  'level=ERROR run=foreign message="Go usage limit exceeded"',
], "Muse subagent 12345678"), null);
assert.equal(inspectLogLines(logState, ['level=ERROR run=own message="Go usage limit exceeded"'], "Muse subagent 12345678"), "Go usage limit exceeded");

const root = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(root, "server.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const resolve = pending.get(message.id);
  if (resolve) { pending.delete(message.id); resolve(message); }
});
let nextId = 1;
function call(method, params = {}) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

const initialized = await call("initialize", { protocolVersion: "2025-03-26" });
assert.equal(initialized.result.serverInfo.name, "opencode-subagents");
const listed = await call("tools/list");
assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["spawn", "wait", "result", "cancel"]);
const spawnSchema = listed.result.tools.find((tool) => tool.name === "spawn").inputSchema;
assert.equal(spawnSchema.properties.model, undefined);
assert.equal(spawnSchema.properties.timeout_seconds.maximum, 7200);

if (process.env.OPENCODE_SUBAGENTS_INTEGRATION === "1") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-subagent-test-"));
  try {
    const spawned = await call("tools/call", {
      name: "spawn",
      arguments: {
        directory,
        timeout_seconds: 300,
        prompt: "Create a UTF-8 file named muse-proof.txt in the current directory containing exactly MUSE_WRITE_OK followed by one newline. Do not modify anything else.",
      },
    });
    const started = JSON.parse(spawned.result.content[0].text);
    assert.equal(spawned.result.isError, false, JSON.stringify(started));
    assert.equal(started.providerID, "openai");
    assert.equal(started.modelID, "gpt-6.1-sol");
    assert.equal(started.variant, "xhigh");
    let status = started;
    while (status.status === "running") {
      const waited = await call("tools/call", {
        name: "wait",
        arguments: { id: started.id, wait_seconds: 30 },
      });
      status = JSON.parse(waited.result.content[0].text);
    }
    assert.equal(status.status, "completed", JSON.stringify(status));
    assert.equal(await readFile(path.join(directory, "muse-proof.txt"), "utf8"), "MUSE_WRITE_OK\n");
  } finally {
    await rm(directory, { recursive: true });
  }
}
child.stdin.end();
await new Promise((resolve) => child.on("close", resolve));
console.log("opencode-subagents MCP contract passed");
