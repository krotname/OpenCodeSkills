import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const server = spawn(process.execPath, [path.join(root, "mcp", "opencode-subagents", "server.mjs")], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
const pending = new Map();
const lines = readline.createInterface({ input: server.stdout });
lines.on("line", (line) => { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); });
let next = 1;
function call(name, args) {
  const id = next++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP response timeout: ${name}`)); }, 65000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      const value = JSON.parse(message.result.content[0].text);
      if (message.result.isError) reject(new Error(value.error)); else resolve(value);
    });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
}
const runs = [];
try {
  for (const prompt of [
    'Create only parallel-demo.txt containing exactly PARALLEL_TEXT_OK followed by a newline. Use a file-writing tool; do not commit or change any other file.',
    'Create only parallel-demo.json containing the JSON object {"ok":true,"task":"parallel-json"}. Use a file-writing tool; do not commit or change any other file.',
  ]) runs.push(await call("spawn", { prompt, directory: root, timeout_seconds: 300 }));
  const overlap = await call("result", { id: runs[0].id });
  for (const started of runs) {
    let status = started;
    for (let attempt = 0; attempt < 11 && ["running", "cancelling"].includes(status.status); attempt++) status = await call("wait", { id: started.id, wait_seconds: 30 });
    const result = await call("result", { id: started.id });
    if (result.status !== "completed" || result.exitCode !== 0) throw new Error(`Task ${started.id} failed: ${result.detail || result.stderr || result.status}`);
  }
  if (runs[0].workspace.directory === runs[1].workspace.directory) throw new Error("Tasks shared a worktree");
  const text = await readFile(path.join(runs[0].workspace.directory, "parallel-demo.txt"), "utf8");
  const object = JSON.parse(await readFile(path.join(runs[1].workspace.directory, "parallel-demo.json"), "utf8"));
  if (text.trim() !== "PARALLEL_TEXT_OK" || object.ok !== true || object.task !== "parallel-json") throw new Error("Artifact validation failed");
  console.log(JSON.stringify({ verified: true, observedOverlap: overlap.status === "running", runs: runs.map((run) => ({ id: run.id, workspace: run.workspace.directory })), artifacts: ["parallel-demo.txt", "parallel-demo.json"] }, null, 2));
} finally {
  for (const run of runs) { await call("cancel", { id: run.id }); }
  server.stdin.end();
  await new Promise((resolve) => server.once("close", resolve));
  lines.close();
}
