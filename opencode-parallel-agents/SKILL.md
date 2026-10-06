---
name: opencode-parallel-agents
description: Run independent development tasks concurrently with the opencode-subagents MCP server, using isolated Git worktrees, bounded parallelism, explicit cancellation and verified output artifacts.
license: Apache-2.0
compatibility: OpenCode with Node.js 22+, Git and the opencode-subagents MCP server.
---

# Parallel development with OpenCode

Use this skill when a task has independent parts that can be implemented or checked concurrently. Use the `opencode-subagents` MCP tools for child runs.

## Before spawning

- Check the current Git branch and working tree. Each child receives a new worktree and branch from the current committed HEAD; uncommitted edits are not copied.
- Give each child a self-contained task: exact scope, expected files, acceptance command and output artifact.
- Keep at most four active runs. The model is selected by the server, never by a tool request.
- Use separate directories for non-Git tasks. The server prevents two active writers from sharing one such directory.
- Keep approvals, publishing and secrets with the coordinating agent unless the user explicitly delegated them.

## Run and collect

1. Call `spawn` for each independent task with `prompt`, `directory` and a bounded `timeout_seconds`.
2. Retain every returned run ID and workspace path.
3. Call `wait` with that ID and at most 60 seconds. A timeout from `wait` means the task may still be running.
4. Call `result` after completion. Inspect status, exit code, stdout, stderr and the requested output file.
5. Inspect each worktree's diff before integrating its commit. Run the relevant combined check after integration.

If the provider reports a terminal quota or API error, collect the failed run and stop dependent work. Do not treat empty output, a spawned process or a queued task as completion, and do not retry an ambiguous run blindly.

Use `cancel` with the exact ID for obsolete work. Wait for its terminal status before reusing a non-Git directory. Keep worktrees while their artifacts are needed; remove branches and directories only after checking integration and active references.

## Reproducible example

Run `node examples/parallel-demo.mjs` from the repository root. It submits two tasks before waiting: one writes a text artifact, the other a JSON artifact in another Git worktree. The command reports both run IDs, workspaces and artifact results. It requires a working OpenCode provider account and consumes two small model calls.
