import assert from "node:assert/strict";
import { windowsExecutableCandidates } from "./command-resolution.mjs";

const shim = String.raw`C:\Program Files\npm\opencode.cmd`;
const v2 = String.raw`C:\Program Files\npm\node_modules\@opencode\cli\bin\opencode.exe`;
const v1 = String.raw`C:\Program Files\npm\node_modules\opencode-ai\bin\opencode.exe`;
assert.deepEqual(windowsExecutableCandidates(shim, String.raw`"%dp0%\node_modules\@opencode\cli\bin\opencode.exe" %*`), [v2, v1]);
assert.deepEqual(windowsExecutableCandidates(shim, String.raw`"%dp0%\node_modules\opencode-ai\bin\opencode.exe" %*`), [v1, v2]);
assert.deepEqual(windowsExecutableCandidates(shim, String.raw`"%~dp0../portable/opencode.exe" %*`), [String.raw`C:\Program Files\portable\opencode.exe`, v2, v1]);
assert.deepEqual(windowsExecutableCandidates(shim, "@echo off\r\n"), [v2, v1]);
assert.deepEqual(windowsExecutableCandidates(shim, String.raw`"%DP0%\custom folder\opencode.EXE" %*`), [String.raw`C:\Program Files\npm\custom folder\opencode.EXE`, v2, v1]);
assert.deepEqual(windowsExecutableCandidates(shim, '"%OTHER%\\opencode.exe"'), [v2, v1]);
console.log("Windows shim resolution passed on the host platform");
