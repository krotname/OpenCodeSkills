# OpenCode subagents MCP

The coordinator starts independent OpenCode CLI runs over a JSON-RPC stdio MCP connection. Every Git task receives a new branch and worktree; non-Git directories have a single-writer lock. No task is merged automatically.

## Configure

Requirements: Node.js 22+, Git and a working OpenCode CLI. By default the server uses explicitly free, tool-capable models from the `opencode` provider, at most four active runs and a default timeout of 30 minutes (maximum 120 minutes). It checks zero input, output and cache prices in `opencode models opencode --verbose` before starting. Requests cannot change the model policy.

The fallback order is Muse Spark 1.3 Contributor Free, Space Bunny Free, Step 5 Preview Free, Exo Free, Cat Jam Free, MiMo V2.6 Flash Free, LongCat 2.5 Preview Free, Ling 3.1 Flash Free and Big Pickle. Missing, paid and unsupported models are excluded. Each model is tried once after a provider error, limit, empty response or 120 seconds before the first response event. Once a response starts, long generation and tools are governed only by the overall timeout. Attempts resume the same session and workspace; after tool activity, a missing session ID prevents replay. Cancellation and the overall timeout stop the whole run.

An explicit temporary exception can enable fixed `openai/gpt-6.1-sol` immediately after Muse, or first when Muse is missing. Put `{"gptFallbackUntil":"<ISO-8601 UTC>"}` in `~/.local/share/krt/opencode-subagents/fallback-policy.json` outside Git. GPT failures continue to the free chain. The server rechecks authorization before a GPT attempt and skips it after expiry, including in a run already in progress. Missing or expired authorization leaves the free policy intact. Tests can override the file path with `OPENCODE_SUBAGENTS_POLICY_FILE`.

Each child process overrides its main and helper models with the selected model. Other providers and nested Task calls are disabled in that child, without changing the user's global OpenCode configuration. Permission denials from the resolved `opencode debug config --pure` configuration, including scalar deny-all, are preserved. The timed GPT exception adds its model definition only in the child, so older provider catalogs do not require a global configuration edit.

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
| `result` | id | Status, actual model, session ID, attempts, exit code, stdout and stderr |
| `cancel` | id | Cancellation status for that exact run |

The server uses `OPENCODE_SUBAGENTS_OPENCODE` for a custom CLI executable, `OPENCODE_SUBAGENTS_STATE_DIR` for worktree storage and `OPENCODE_SUBAGENTS_LOG_FILE` for its provider log. Legacy `MUSE_SUBAGENTS_*` command/state aliases remain accepted. Defaults use the current user's home directory. No credential is stored by this server; OpenCode handles provider authentication.

## Verify

From the repository root, run `node scripts/verify.mjs`. Tests verify the free model policy, distinct Git worktrees, overlapping processes, the four-run cap, cancellation, non-Git locking, malformed requests, fallbacks and safe session continuation. These tests do not call a provider.

Run `node examples/parallel-demo.mjs` for two real model calls and verified artifacts. An error or quota failure is a failed demo, not evidence of completed work. Keep each returned worktree while its artifacts are needed; inspect the diff before integrating or cleaning it.
