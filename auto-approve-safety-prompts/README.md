# OpenCode v2: safe permission prompts

This plugin approves individual `ask` decisions for a deliberately small set of read-only shell commands: `pwd`, `whoami`, `git status`, `git status --short`, and `echo` with letters, digits, spaces, dots, underscores or hyphens. All other requests retain the configured permission decision. Existing `deny` decisions are never changed. It requires OpenCode v2's `tool`, `shell` and `permission` plugin hooks.

Copy `index.js` into a dedicated directory under `~/.config/opencode/plugins/auto-approve-safety-prompts/`, then restart OpenCode. Configure shell permissions as usual; the plugin acts only on decisions that would ask. Set `OPENCODE_AUTO_APPROVE_DISABLE=1` to disable automatic approval. It does not include a machine-specific browser guard or modify saved permission rules.

Run the regression checks with `node --test plugin.test.mjs`.
