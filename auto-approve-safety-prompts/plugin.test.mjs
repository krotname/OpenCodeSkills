import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from './index.js';

async function setup() {
  const hooks = {};
  const register = prefix => ({ hook: (name, fn) => { hooks[`${prefix}.${name}`] = fn; } });
  await plugin.setup({ tool: register('tool'), shell: register('shell'), permission: register('permission') });
  const before = (id, command) => hooks['tool.execute.before']({ tool: 'shell', sessionID: 's', messageID: 'm', id, input: { command } });
  const check = (id, effect = 'ask') => {
    const event = { action: 'shell', effect, sessionID: 's', source: { type: 'tool', messageID: 'm', id } };
    hooks['permission.evaluate'](event);
    return event.effect;
  };
  return { hooks, before, check };
}

test('allows only a uniquely associated safe shell request', async () => {
  const { hooks, before, check } = await setup();
  before('1', 'git status --short');
  hooks['shell.create.before']({ command: 'git status --short' });
  assert.equal(check('1'), 'allow');
  assert.equal(check('1', 'deny'), 'deny');
  assert.equal(check('unknown'), 'ask');
  hooks['tool.execute.after']({ sessionID: 's', messageID: 'm', id: '1' });
  assert.equal(check('1'), 'ask');
});

test('leaves commands with shell syntax, changed or ambiguous invocations for the user', async () => {
  const { hooks, before, check } = await setup();
  for (const command of ['echo ok; rm -rf /', 'echo $(id)', 'git status > output', 'rm file']) {
    before(command, command);
    hooks['shell.create.before']({ command });
    assert.equal(check(command), 'ask');
  }
  before('changed', 'pwd');
  hooks['shell.create.before']({ command: 'whoami' });
  assert.equal(check('changed'), 'ask');
  before('a', 'whoami'); before('b', 'whoami');
  hooks['shell.create.before']({ command: 'whoami' });
  assert.equal(check('a'), 'ask'); assert.equal(check('b'), 'ask');
});

test('disable switch leaves an otherwise safe request unchanged', async () => {
  const { hooks, before, check } = await setup();
  before('1', 'pwd'); hooks['shell.create.before']({ command: 'pwd' });
  process.env.OPENCODE_AUTO_APPROVE_DISABLE = '1';
  try { assert.equal(check('1'), 'ask'); } finally { delete process.env.OPENCODE_AUTO_APPROVE_DISABLE; }
});
