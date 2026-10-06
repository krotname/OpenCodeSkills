# OpenCode subagents MCP

The coordinator starts independent OpenCode CLI runs over a JSON-RPC stdio MCP connection. Every Git task receives a new branch and worktree; non-Git directories have a single-writer lock. No task is merged automatically.

## Configure

Requirements: Node.js 22+, Git and a working OpenCode CLI/provider login. The server currently pins `openai/gpt-6.1-sol` with variant `xhigh`, at most four active runs and a default timeout of 30 minutes (maximum 120 minutes). Check model availability in your account before a live run. Changing the server's fixed constants is an administrator decision; the tool schema does not accept a model argument.

Add an MCP entry to your OpenCode configuration. Replace the server path with the absolute path of your clone. On Windows, forward slashes work in JSON paths.

```json
{
  "mcp": {
    "opencode-subagents": {
      "type": "local",
      "command": ["node", "<absolute-clone-path>/mcp/opencode-subagents/server.mjs"],
      "enabled": true
    }
  }
}
```

The same stdio server can be registered in any compatible MCP client. The repository supplies the server rather than a client-specific installer.

| Tool | Input | Result |
| --- | --- | --- |
| `spawn` | prompt, directory, optional timeout_seconds | Run ID and isolated workspace |
| `wait` | id, optional wait_seconds (0–60) | Current status |
| `result` | id | Status, exit code, stdout and stderr |
| `cancel` | id | Cancellation status for that exact run |

The server uses `OPENCODE_SUBAGENTS_OPENCODE` for a custom CLI executable, `OPENCODE_SUBAGENTS_STATE_DIR` for worktree storage and `OPENCODE_SUBAGENTS_LOG_FILE` for its provider log. Legacy `MUSE_SUBAGENTS_*` command/state aliases remain accepted. Defaults use the current user's home directory. No credential is stored by this server; OpenCode handles provider authentication.

## Verify

From the repository root, run `node scripts/verify.mjs`. Lifecycle tests verify distinct Git worktrees, two overlapping processes, the four-run cap, cancellation, non-Git locking, malformed requests and terminal provider errors. These tests do not call a paid provider.

Run `node examples/parallel-demo.mjs` for two real model calls and verified artifacts. An error or quota failure is a failed demo, not evidence of completed work. Keep each returned worktree while its artifacts are needed; inspect the diff before integrating or cleaning it.
