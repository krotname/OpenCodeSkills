import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const name of ["opencode-parallel-agents", "powershell-invocation", "gh-fix-ci"]) {
  const skill = await readFile(path.join(root, name, "SKILL.md"), "utf8");
  const manifestName = /^name:[ \t]*(?:"([^"]+)"|'([^']+)'|([a-z0-9-]+))[ \t]*\r?$/m.exec(skill);
  if (!/^---\r?\n/.test(skill) || !manifestName || (manifestName[1] || manifestName[2] || manifestName[3]) !== name || !/^description:\s+\S/m.test(skill)) throw new Error(`Invalid native skill: ${name}`);
}
for (const test of ["test.mjs", "test-provider-failure.mjs", "test-lifecycle.mjs"]) {
  const result = await exec(process.execPath, [path.join(root, "mcp", "opencode-subagents", test)], { cwd: root, timeout: 90000, maxBuffer: 2_000_000, windowsHide: true });
  process.stdout.write(result.stdout);
}
const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const result = await exec(python, ["-m", "unittest", "discover", "-s", "gh-fix-ci/tests"], { cwd: root, timeout: 30000, windowsHide: true });
process.stdout.write(result.stdout + result.stderr);
console.log("Three native OpenCode skills and portable core checks passed");
