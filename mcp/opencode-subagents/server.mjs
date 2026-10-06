#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import { inspectLogLines, inspectOutputLines } from "./provider-failure.mjs";

const execFileAsync = promisify(execFile);
const MODEL = "openai/gpt-6.1-sol";
const VARIANT = "xhigh";
const [PROVIDER_ID, MODEL_ID] = MODEL.split("/");
const MAX_ACTIVE = 4;
const DEFAULT_TIMEOUT_SECONDS = 30 * 60;
const MAX_TIMEOUT_SECONDS = 120 * 60;
const stateRoot = process.env.OPENCODE_SUBAGENTS_STATE_DIR || process.env.MUSE_SUBAGENTS_STATE_DIR || path.join(os.homedir(), ".muse-subagents");
const opencodeCommand = process.env.OPENCODE_SUBAGENTS_OPENCODE || process.env.MUSE_SUBAGENTS_OPENCODE || (process.platform === "win32" ? "opencode.cmd" : "opencode");
const runs = new Map();
const directoryLocks = new Map();
const logFile = process.env.OPENCODE_SUBAGENTS_LOG_FILE || path.join(os.homedir(), ".local", "share", "opencode", "log", "opencode.log");

async function inspectRunLog(run) {
  if (run.logBusy || run.status !== "running") return;
  run.logBusy = true;
  let handle;
  try {
    handle = await open(logFile, "r");
    const info = await handle.stat();
    if (info.size < run.logOffset) { run.logOffset = 0; run.logTail = ""; }
    const size = Math.min(info.size - run.logOffset, 2 * 1024 * 1024);
    if (!size) return;
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, run.logOffset);
    run.logOffset += bytesRead;
    const lines = (run.logTail + buffer.subarray(0, bytesRead).toString("utf8")).split(/\r?\n/);
    run.logTail = lines.pop();
    const failure = inspectLogLines(run, lines, `Muse subagent ${run.id.slice(0, 8)}`);
    if (failure) await failProvider(run, failure);
  } catch { /* Missing/rotating log: stdout and the bounded timeout still apply. */ }
  finally { await handle?.close(); run.logBusy = false; }
}

async function failProvider(run, failure) {
  if (run.status !== "running") return;
  run.providerError = failure;
  run.detail = failure;
  await cancelRun(run);
}

async function resolveOpenCodeCommand() {
  if (process.platform !== "win32" || !opencodeCommand.toLowerCase().endsWith(".cmd")) return opencodeCommand;
  let shim = opencodeCommand;
  if (!path.isAbsolute(shim)) {
    const { stdout } = await execFileAsync("where.exe", [shim], { windowsHide: true, timeout: 10_000 });
    shim = stdout.split(/\r?\n/).find(Boolean)?.trim();
  }
  if (!shim) throw new Error(`OpenCode command not found: ${opencodeCommand}`);
  const executable = path.join(path.dirname(shim), "node_modules", "opencode-ai", "bin", "opencode.exe");
  try { await access(executable); }
  catch { throw new Error(`OpenCode executable not found next to shim: ${executable}`); }
  return executable;
}

function reply(id, value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...value })}\n`);
}

function textResult(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd, windowsHide: true, timeout: 30_000 });
}

async function prepareWorkspace(requestedDirectory, id) {
  const directory = path.resolve(requestedDirectory || process.cwd());
  let root = null;
  try {
    const { stdout } = await git(["-C", directory, "rev-parse", "--show-toplevel"], directory);
    root = stdout.trim();
  } catch {
    root = null;
  }
  if (root) {
    const branch = `feature/opencode-subagent-${id.slice(0, 8)}`;
    const worktree = path.join(stateRoot, "worktrees", `${path.basename(root)}-${id.slice(0, 8)}`);
    await mkdir(path.dirname(worktree), { recursive: true });
    await git(["-C", root, "worktree", "add", "-b", branch, worktree, "HEAD"], root);
    return { kind: "git", requestedDirectory: directory, root, directory: worktree, branch };
  }
  if (directoryLocks.has(directory)) {
    throw new Error(`Негитовый каталог уже изменяет OpenCode-сабагент ${directoryLocks.get(directory)}`);
  }
  directoryLocks.set(directory, id);
  return { kind: "directory", requestedDirectory: directory, root: directory, directory, branch: null };
}

function activeCount() {
  return [...runs.values()].filter((run) => ['running', 'cancelling'].includes(run.status)).length;
}

function finish(run, status, detail = null) {
  if (!['running', 'cancelling'].includes(run.status)) return;
  run.status = status;
  run.finishedAt = new Date().toISOString();
  run.detail = detail ?? run.detail;
  clearTimeout(run.timer);
  clearTimeout(run.killTimer);
  clearInterval(run.logTimer);
  if (run.workspace.kind === "directory") directoryLocks.delete(run.workspace.directory);
  for (const waiter of run.waiters.splice(0)) waiter();
}

function snapshot(run, includeOutput = false) {
  const value = {
    id: run.id,
    status: run.status,
    providerID: PROVIDER_ID,
    modelID: MODEL_ID,
    variant: VARIANT,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    timeoutSeconds: run.timeoutSeconds,
    workspace: run.workspace,
    exitCode: run.exitCode,
    signal: run.signal,
    detail: run.detail,
  };
  if (includeOutput) {
    value.stdout = run.stdout;
    value.stderr = run.stderr;
  }
  return value;
}

async function spawnRun(args) {
  if (activeCount() >= MAX_ACTIVE) throw new Error(`Достигнут предел параллелизма ${MAX_ACTIVE}`);
  if (!args || typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("prompt обязателен");
  if (Object.keys(args).some((key) => !['prompt', 'directory', 'timeout_seconds'].includes(key))) throw new Error("Неизвестный параметр spawn");
  const timeoutSeconds = args.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeout_seconds должен быть целым числом от 1 до ${MAX_TIMEOUT_SECONDS}`);
  }
  const id = randomUUID();
  // Команду разрешаем до подготовки каталога: иначе ошибка поиска opencode оставляла
  // навсегда занятую блокировку негитового каталога и лишний worktree с веткой.
  const command = await resolveOpenCodeCommand();
  const logOffset = await stat(logFile).then((info) => info.size).catch(() => 0);
  const workspace = await prepareWorkspace(args.directory || process.cwd(), id);
  const commandArgs = [
    "run", "--format", "json", "--model", MODEL, "--variant", VARIANT, "--dir", workspace.directory,
    "--auto", "--title", `Muse subagent ${id.slice(0, 8)}`, args.prompt.trim(),
  ];
  const scriptCommand = /\.(?:mjs|js)$/i.test(command);
  const child = spawn(scriptCommand ? process.execPath : command, scriptCommand ? [command, ...commandArgs] : commandArgs, {
    cwd: workspace.directory,
    env: process.env,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const run = {
    id, child, workspace, status: "running", startedAt: new Date().toISOString(), finishedAt: null,
    timeoutSeconds, stdout: "", stderr: "", exitCode: null, signal: null, detail: null, waiters: [], timer: null,
    logOffset, logTail: "", logBusy: false, logTimer: null, killTimer: null, providerError: null, outputTail: "",
  };
  runs.set(id, run);
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    run.stdout += text;
    const lines = (run.outputTail + text).split(/\r?\n/);
    run.outputTail = lines.pop();
    const failure = inspectOutputLines(lines);
    if (failure) failProvider(run, failure).catch(() => {});
  });
  child.stderr.on("data", (chunk) => {
    run.stderr += chunk.toString("utf8");
  });
  child.on("error", (error) => finish(run, "failed", error.message));
  child.on("close", (code, signal) => {
    run.exitCode = code;
    run.signal = signal;
    finish(run, run.providerError ? "failed" : run.status === "cancelling" ? "cancelled" : code === 0 ? "completed" : "failed");
  });
  run.timer = setTimeout(() => {
    run.detail = `timeout ${timeoutSeconds}s`;
    cancelRun(run).catch(() => finish(run, "failed", run.detail));
  }, timeoutSeconds * 1000);
  run.logTimer = setInterval(() => inspectRunLog(run).catch(() => {}), 1000);
  return snapshot(run);
}

function getRun(id) {
  const run = runs.get(id);
  if (!run) throw new Error(`Неизвестный run id: ${id}`);
  return run;
}

async function waitRun(args) {
  const run = getRun(args?.id);
  const waitSeconds = Math.min(Math.max(args?.wait_seconds ?? 30, 0), 60);
  if (["running", "cancelling"].includes(run.status) && waitSeconds > 0) {
    await Promise.race([
      new Promise((resolve) => run.waiters.push(resolve)),
      new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000)),
    ]);
  }
  return snapshot(run);
}

async function cancelRun(run) {
  if (run.status !== "running") return snapshot(run);
  run.status = "cancelling";
  if (process.platform === "win32") {
    try { await execFileAsync("taskkill", ["/PID", String(run.child.pid), "/T", "/F"], { windowsHide: true }); }
    catch { run.child.kill(); }
  } else {
    try { process.kill(-run.child.pid, "SIGTERM"); }
    catch { run.child.kill("SIGTERM"); }
    run.killTimer = setTimeout(() => {
      if (run.status !== "cancelling") return;
      try { process.kill(-run.child.pid, "SIGKILL"); }
      catch { run.child.kill("SIGKILL"); }
    }, 2000);
  }
  return snapshot(run);
}

const tools = [
  {
    name: "spawn",
    description: "Запустить пишущего сабагента на закреплённой модели. Git-проект получает отдельные worktree и ветку.",
    inputSchema: { type: "object", required: ["prompt"], additionalProperties: false, properties: {
      prompt: { type: "string" }, directory: { type: "string" }, timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SECONDS },
    } },
  },
  { name: "wait", description: "Подождать завершения запуска не более 60 секунд.", inputSchema: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string" }, wait_seconds: { type: "integer", minimum: 0, maximum: 60 } } } },
  { name: "result", description: "Получить статус и полный stdout/stderr запуска.", inputSchema: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string" } } } },
  { name: "cancel", description: "Остановить точный запуск и его дочерние процессы.", inputSchema: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string" } } } },
];

async function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") return reply(id, { result: { protocolVersion: params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "opencode-subagents", version: "1.0.0" } } });
  if (method === "notifications/initialized") return;
  if (method === "ping") return reply(id, { result: {} });
  if (method === "tools/list") return reply(id, { result: { tools } });
  if (method === "tools/call") {
    try {
      const name = params?.name;
      const args = params?.arguments || {};
      let value;
      if (name === "spawn") value = await spawnRun(args);
      else if (name === "wait") value = await waitRun(args);
      else if (name === "result") value = snapshot(getRun(args.id), true);
      else if (name === "cancel") value = await cancelRun(getRun(args.id));
      else throw new Error(`Неизвестный инструмент: ${name}`);
      return reply(id, { result: textResult(value) });
    } catch (error) {
      return reply(id, { result: textResult({ error: error.message }, true) });
    }
  }
  if (id !== undefined) reply(id, { error: { code: -32601, message: `Method not found: ${method}` } });
}

await mkdir(stateRoot, { recursive: true });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  try { await handle(JSON.parse(line)); }
  catch (error) { process.stderr.write(`${error.stack || error.message}\n`); }
}
