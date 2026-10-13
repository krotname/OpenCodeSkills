#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import { inspectLogLines, inspectOutputLines, providerFailure } from "./provider-failure.mjs";
import { executionModels, gptFallbackActive, GPT_FALLBACK, modelEnvironment } from "./model-policy.mjs";

const execFileAsync = promisify(execFile);
const MAX_ACTIVE = 4;
const DEFAULT_TIMEOUT_SECONDS = 30 * 60;
const MAX_TIMEOUT_SECONDS = 120 * 60;
const stateRoot = process.env.OPENCODE_SUBAGENTS_STATE_DIR || process.env.MUSE_SUBAGENTS_STATE_DIR || path.join(os.homedir(), ".muse-subagents");
const opencodeCommand = process.env.OPENCODE_SUBAGENTS_OPENCODE || process.env.MUSE_SUBAGENTS_OPENCODE || (process.platform === "win32" ? "opencode.cmd" : "opencode");
const runs = new Map();
const directoryLocks = new Map();
const logFile = process.env.OPENCODE_SUBAGENTS_LOG_FILE || path.join(os.homedir(), ".local", "share", "opencode", "log", "opencode.log");
const idleTimeoutMs = Math.max(1000, Math.min(300_000, (Number(process.env.OPENCODE_SUBAGENTS_IDLE_SECONDS) || 120) * 1000));
let catalogCache = null;
const policyFile = process.env.OPENCODE_SUBAGENTS_POLICY_FILE || path.join(os.homedir(), ".local", "share", "krt", "opencode-subagents", "fallback-policy.json");

async function readPolicy() {
  try { return JSON.parse(await readFile(policyFile, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw new Error("Некорректный локальный fallback-policy.json"); }
}

function commandSpec(command, args) {
  return /\.(?:mjs|js)$/i.test(command) ? [process.execPath, [command, ...args]] : [command, args];
}

async function availableModels(command, directory) {
  if (!catalogCache || catalogCache.directory !== directory || Date.now() >= catalogCache.expiresAt) {
    const [file, args] = commandSpec(command, ["models", "opencode", "--verbose", "--pure"]);
    const promise = execFileAsync(file, args, { cwd: directory, windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
      .then(({ stdout }) => stdout);
    catalogCache = { directory, expiresAt: Date.now() + 60_000, promise };
    promise.catch(() => { if (catalogCache?.promise === promise) catalogCache = null; });
  }
  return catalogCache.promise;
}

async function resolvedPermissions(command, directory) {
  const [file, args] = commandSpec(command, ["debug", "config", "--pure"]);
  const { stdout } = await execFileAsync(file, args, { cwd: directory, windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout).permission;
}

async function inspectRunLog(run, attempt) {
  if (!attempt || attempt.logBusy || attempt.failure || run.status !== "running") return;
  attempt.logBusy = true;
  let handle;
  try {
    handle = await open(logFile, "r");
    const info = await handle.stat();
    if (info.size < attempt.logOffset) { attempt.logOffset = 0; attempt.logTail = ""; }
    const size = Math.min(info.size - attempt.logOffset, 2 * 1024 * 1024);
    if (!size) return;
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, attempt.logOffset);
    attempt.logOffset += bytesRead;
    const lines = (attempt.logTail + buffer.subarray(0, bytesRead).toString("utf8")).split(/\r?\n/);
    attempt.logTail = lines.pop();
    const failure = inspectLogLines(attempt, lines, attempt.title);
    if (failure && run.attempt === attempt) await failProvider(run, failure);
  } catch { /* Missing/rotating log: stdout and the bounded timeout still apply. */ }
  finally { await handle?.close(); attempt.logBusy = false; }
}

async function failProvider(run, failure) {
  if (run.status !== "running" || run.attempt.failure) return;
  run.attempt.failure = failure;
  run.detail = failure;
  await stopAttempt(run.attempt);
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
  clearInterval(run.logTimer);
  clearInterval(run.attempt?.idleTimer);
  clearTimeout(run.attempt?.killTimer);
  if (run.workspace.kind === "directory") directoryLocks.delete(run.workspace.directory);
  for (const waiter of run.waiters.splice(0)) waiter();
}

function snapshot(run, includeOutput = false) {
  const value = {
    id: run.id,
    status: run.status,
    providerID: run.model?.split("/")[0] ?? null,
    modelID: run.model?.split("/")[1] ?? null,
    variant: null,
    sessionID: run.sessionID,
    models: run.models,
    gptFallbackUntil: run.policy.gptFallbackUntil ?? null,
    attempts: run.attempts.map(({ model, startedAt, finishedAt, failure, exitCode, signal }) => ({ model, startedAt, finishedAt, failure, exitCode, signal })),
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
  const policy = await readPolicy();
  const directory = path.resolve(args.directory || process.cwd());
  const models = executionModels(await availableModels(command, directory), policy);
  const permissions = await resolvedPermissions(command, directory);
  modelEnvironment(process.env, models[0], permissions);
  const workspace = await prepareWorkspace(args.directory || process.cwd(), id);
  const run = {
    id, command, models, policy, permissions, nextModel: 0, model: models[0], prompt: args.prompt.trim(), sessionID: null, sideEffects: false,
    attempt: null, attempts: [], workspace, status: "running", startedAt: new Date().toISOString(), finishedAt: null,
    timeoutSeconds, stdout: "", stderr: "", exitCode: null, signal: null, detail: null, waiters: [], timer: null,
    logTimer: null, timedOut: false,
  };
  runs.set(id, run);
  run.timer = setTimeout(() => {
    run.timedOut = true;
    run.detail = `timeout ${timeoutSeconds}s`;
    cancelRun(run).catch(() => finish(run, "failed", run.detail));
  }, timeoutSeconds * 1000);
  run.logTimer = setInterval(() => inspectRunLog(run, run.attempt).catch(() => {}), 1000);
  try { await startAttempt(run); }
  catch (error) { finish(run, "failed", error.message); }
  return snapshot(run);
}

function inspectEvents(run, attempt, lines) {
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type !== "error" && (event.sessionID || ["step_start", "text", "reasoning", "tool_use"].includes(event.type))) attempt.streamStarted = true;
      if (typeof event.sessionID === "string" && /^ses_[\w-]+$/.test(event.sessionID)) run.sessionID = event.sessionID;
      if (event.type === "tool_use") run.sideEffects = true;
      if ((event.type === "text" && event.part?.text?.trim()) || event.type === "tool_use") attempt.usefulOutput = true;
      if (event.type === "error") attempt.failure = inspectOutputLines([line]) || "Provider stream error";
    } catch { /* CLI banners are not proof of a useful response. */ }
  }
}

async function startAttempt(run) {
  if (run.status !== "running") return;
  let model;
  while (run.nextModel < run.models.length) {
    const candidate = run.models[run.nextModel++];
    if (candidate !== GPT_FALLBACK || (gptFallbackActive(run.policy) && gptFallbackActive(await readPolicy()))) {
      model = candidate;
      break;
    }
  }
  if (!model) return finish(run, "failed", `Разрешённые модели исчерпаны: ${run.detail ?? "fallback отключён"}`);
  const attempt = {
    model, startedAt: new Date().toISOString(), finishedAt: null,
    failure: null, exitCode: null, signal: null, usefulOutput: false, streamStarted: false, outputTail: "", stderr: "",
    lastActivityAt: Date.now(), logOffset: await stat(logFile).then((info) => info.size).catch(() => 0),
    logTail: "", logBusy: false, idleTimer: null, killTimer: null,
    title: `OpenCode subagent ${run.id.slice(0, 8)} attempt ${run.attempts.length + 1}`,
  };
  if (run.status !== "running") return;
  if (model === GPT_FALLBACK && !gptFallbackActive(run.policy)) return startAttempt(run);
  run.attempt = attempt;
  run.attempts.push(attempt);
  run.model = attempt.model;
  run.detail = null;
  const commandArgs = ["run", "--pure", "--format", "json", "--model", attempt.model, "--dir", run.workspace.directory,
    "--auto", "--title", attempt.title];
  if (run.sessionID) commandArgs.push("--session", run.sessionID);
  commandArgs.push(run.sessionID ? "Продолжи исходное поручение в этой сессии после отказа предыдущей модели. Сначала проверь уже выполненные действия и файлы; не повторяй завершённые внешние операции." : run.prompt);
  const [command, argv] = commandSpec(run.command, commandArgs);
  const child = spawn(command, argv, {
    cwd: run.workspace.directory, env: modelEnvironment(process.env, attempt.model, run.permissions), windowsHide: true,
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  attempt.child = child;
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    run.stdout += text;
    attempt.lastActivityAt = Date.now();
    const lines = (attempt.outputTail + text).split(/\r?\n/);
    attempt.outputTail = lines.pop();
    inspectEvents(run, attempt, lines);
    if (attempt.failure) stopAttempt(attempt).catch(() => {});
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    run.stderr += text;
    attempt.stderr += text;
    const failure = providerFailure(text);
    if (failure) failProvider(run, failure).catch(() => {});
  });
  child.on("error", (error) => finish(run, "failed", error.message));
  child.on("close", (code, signal) => {
    closeAttempt(run, attempt, code, signal).catch((error) => finish(run, "failed", error.message));
  });
  attempt.idleTimer = setInterval(() => {
    if (!attempt.streamStarted && Date.now() - attempt.lastActivityAt >= idleTimeoutMs) failProvider(run, "Provider response timeout").catch(() => {});
  }, Math.min(idleTimeoutMs, 1000));
}

async function closeAttempt(run, attempt, code, signal) {
  clearInterval(attempt.idleTimer);
  clearTimeout(attempt.killTimer);
  inspectEvents(run, attempt, [attempt.outputTail]);
  Object.assign(attempt, { finishedAt: new Date().toISOString(), exitCode: code, signal });
  run.exitCode = code;
  run.signal = signal;
  if (run.status === "cancelling") return finish(run, run.timedOut ? "failed" : "cancelled");
  if (run.status !== "running") return;
  const failure = attempt.failure || providerFailure(attempt.stderr) || (code === 0 && !attempt.usefulOutput ? "Empty provider response" : null);
  attempt.failure = failure;
  if (!failure) return finish(run, code === 0 ? "completed" : "failed", code === 0 ? null : `OpenCode exit ${code}`);
  if (run.sideEffects && !run.sessionID) return finish(run, "failed", `${failure}; продолжение без sessionID запрещено после работы инструментов`);
  if (run.nextModel >= run.models.length) return finish(run, "failed", `Разрешённые модели исчерпаны: ${failure}`);
  await startAttempt(run);
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
  if (!run.attempt?.child) { finish(run, run.timedOut ? "failed" : "cancelled"); return snapshot(run); }
  await stopAttempt(run.attempt);
  return snapshot(run);
}

async function stopAttempt(attempt) {
  if (attempt.stopping) return;
  attempt.stopping = true;
  const child = attempt.child;
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try { await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 }); }
    catch { child.kill(); }
  } else {
    try { process.kill(-child.pid, "SIGTERM"); }
    catch { child.kill("SIGTERM"); }
    attempt.killTimer = setTimeout(() => {
      if (attempt.finishedAt) return;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch { child.kill("SIGKILL"); }
    }, 2000);
  }
}

const tools = [
  {
    name: "spawn",
    description: "Запустить сабагента на закреплённой сервером цепочке моделей с автоматическим fallback. Git-проект получает отдельные worktree и ветку.",
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
  if (method === "initialize") return reply(id, { result: { protocolVersion: params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "opencode-subagents", version: "1.1.0" } } });
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
