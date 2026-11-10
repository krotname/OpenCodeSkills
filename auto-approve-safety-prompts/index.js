// OpenCode v2 permission hook. Only exact, read-only commands are auto-approved.
const allowed = /^(?:pwd|whoami|git status(?: --short)?|echo [A-Za-z0-9_. -]+)$/;

export default {
  id: 'auto-approve-safety-prompts',
  async setup(ctx) {
    const active = new Map();
    const key = (session, message, call) => JSON.stringify([session, message, call]);
    await ctx.tool.hook('execute.before', event => {
      if (event.tool === 'shell') active.set(key(event.sessionID, event.messageID, event.id), { event });
    });
    await ctx.shell.hook('create.before', invocation => {
      const matches = [...active.values()].filter(call =>
        typeof call.event.input?.command === 'string' && call.event.input.command === invocation.command);
      if (matches.length === 1) matches[0].invocation = invocation;
    });
    await ctx.tool.hook('execute.after', event => active.delete(key(event.sessionID, event.messageID, event.id)));
    await ctx.permission.hook('evaluate', event => {
      if (process.env.OPENCODE_AUTO_APPROVE_DISABLE === '1' || event.effect !== 'ask' ||
          !['shell', 'external_directory'].includes(event.action) || event.source?.type !== 'tool') return;
      const call = active.get(key(event.sessionID, event.source.messageID, event.source.id));
      const command = call?.event?.input?.command;
      if (typeof command === 'string' && call.invocation?.command === command && allowed.test(command)) event.effect = 'allow';
    });
  },
};
