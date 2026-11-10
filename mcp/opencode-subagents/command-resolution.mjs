import path from "node:path";

// npm shims use Windows paths even when the tests run on Linux.
export function windowsExecutableCandidates(shim, content) {
  const directory = path.win32.dirname(shim);
  const candidates = [];
  for (const match of content.matchAll(/"((?:%dp0%|%~dp0)[^"\r\n]*[\\/]opencode\.exe)"/gi)) {
    candidates.push(path.win32.resolve(directory, match[1].replace(/^(?:%dp0%|%~dp0)[\\/]*/i, "")));
  }
  candidates.push(...["@opencode\\cli", "opencode-ai"].map((name) =>
    path.win32.join(directory, "node_modules", name, "bin", "opencode.exe")));
  return [...new Set(candidates)];
}
