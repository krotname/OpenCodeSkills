---
name: powershell-invocation
description: Execute PowerShell reliably across Windows PowerShell 5.1 and PowerShell 7, SSH, WinRM and nested shells; preserve literal arguments, Unicode text and useful exit codes.
license: Apache-2.0
compatibility: Windows PowerShell 5.1 or PowerShell 7; SSH and WinRM are optional.
---

# Reliable PowerShell invocation

Use this skill when PowerShell commands cross a shell, process or remote-session boundary, especially when quoting or text encoding breaks a command.

## Choose and verify the runtime

Check `$PSVersionTable.PSVersion` and the available command before changing dependencies. Prefer an existing absolute executable path when PATH is stale. Use `pwsh` for PowerShell 7 and `powershell.exe` only when the target needs Windows PowerShell 5.1. Start helper scripts with `-NoLogo -NoProfile -NonInteractive`.

Do not assume .NET methods from PowerShell 7 exist in 5.1. Check capabilities before using overloads such as process-tree termination. When launching 5.1 from 7, avoid carrying a PowerShell-7-only module search path into the child runtime.

## Keep the script out of nested quoting

Prefer, in order:

1. A saved `.ps1` file with named parameters.
2. A script block passed to `Invoke-Command` with `-ArgumentList`.
3. Script text over stdin to an explicitly selected PowerShell runtime.
4. `-EncodedCommand`, encoded as UTF-16LE, when the transport cannot preserve stdin or script files.

PowerShell uses the backtick as its escape character; a backslash does not escape a quote. Single-quoted strings preserve `$`, backticks and `$(...)`. A single quote inside a single-quoted literal is doubled. Pass external program arguments as an array instead of concatenating a command string.

```powershell
$programArguments = @('status', '--short')
& git @programArguments
if ($LASTEXITCODE -ne 0) { throw 'Git status failed' }
```

For WinRM, keep data in parameters rather than interpolating it into remote code. Obtain a session through the environment's approved authentication mechanism.

```powershell
Invoke-Command -Session $session -ArgumentList $projectDirectory -ScriptBlock {
    param([string]$projectDirectory)
    Set-Location -LiteralPath $projectDirectory
    & git status --short
    if ($LASTEXITCODE -ne 0) { throw 'Remote Git status failed' }
}
```

## Text and exit codes

Specify UTF-8 when reading and writing text; PowerShell 5.1's default redirection encoding differs from PowerShell 7. Use explicit console and native-process encoding when the transport corrupts non-ASCII text. Test one representative Unicode argument through the actual transport.

Interpret nonzero codes by the command's contract: for example, a search command can use 1 for no match. Capture `$LASTEXITCODE` immediately after the relevant native program. Avoid a later successful command masking the failure.

After a quoting/parser failure, simplify the boundary or save the script; do not add another layer of escaping. Verify the final file or server-side state, not merely successful script startup.
