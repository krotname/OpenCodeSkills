import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { promisify } from "node:util";

// Keep the same private server alive across activation retries. The v2 API
// returns 503 after five seconds while location plugins can still be starting.
export async function readRuntimeApi([file, args], directory, environment, route, timeout = 30_000) {
  const password = randomUUID();
  const deadline = Date.now() + timeout;
  const child = spawn(file, args, {
    cwd: directory, env: { ...environment, OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password },
    windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  const closed = new Promise((resolve) => child.once("close", resolve));
  const lines = readline.createInterface({ input: child.stdout });
  const abort = AbortSignal.timeout(timeout);
  try {
    const url = await new Promise((resolve, reject) => {
      const fail = () => reject(new Error("Приватный API OpenCode не запустился"));
      child.once("error", fail);
      child.once("close", fail);
      abort.addEventListener("abort", fail, { once: true });
      lines.on("line", (line) => {
        try {
          const value = new URL(JSON.parse(line).url);
          if (value.protocol !== "http:" || value.hostname !== "127.0.0.1" || value.username || value.password) return fail();
          resolve(value);
        } catch { /* Ignore CLI banners before the stdio handshake. */ }
      });
    });
    while (!abort.aborted) {
      const response = await fetch(new URL(route, url), {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "x-opencode-directory": encodeURIComponent(directory) },
        redirect: "error", signal: abort,
      });
      const body = await response.text();
      if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error("Слишком большой ответ API OpenCode");
      if (response.ok) return body;
      let error;
      try { error = JSON.parse(body); } catch { /* Unexpected HTTP responses fail closed. */ }
      if (response.status !== 503 || error?.service !== "plugin") throw new Error(`API OpenCode: HTTP ${response.status}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))));
    }
    throw new Error("Истекло время активации API OpenCode");
  } finally {
    lines.close();
    child.stdin.end();
    let timer;
    const stopped = await Promise.race([closed.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 3000); })]);
    clearTimeout(timer);
    if (!stopped && child.pid) {
      if (process.platform === "win32") {
        try { await promisify(execFile)("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }); }
        catch { child.kill(); }
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
      await closed;
    }
  }
}
