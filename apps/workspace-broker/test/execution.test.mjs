import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { agentArguments } from '../runner/execution.mjs';

test('provider launch uses literal argv and preserves the selected model and access mode', () => {
  const input = { sessionId: randomUUID(), agentTool: 'claude-code', model: 'claude-sonnet-5', accessMode: 'auto', reasoningEffort: 'high', prompt: 'literal $(touch /tmp/escape) `env`\nAssignment: task' };
  const claude = agentArguments(input);
  assert.equal(claude.binary, '/usr/local/bin/claude');
  assert.equal(claude.args.at(-1), input.prompt);
  assert.ok(claude.args.includes(input.model));
  assert.ok(claude.args.includes('auto'));
  assert.equal(claude.args.includes('--dangerously-skip-permissions'), false);
  const codex = agentArguments({ ...input, agentTool: 'codex', model: 'gpt-6-astra', accessMode: 'plan' });
  assert.ok(codex.args.includes('read-only'));
  assert.ok(codex.args.includes('on-request'));
  assert.equal(codex.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  for (const attack of [{ agentTool: 'bash' }, { model: '--help' }, { sessionId: '../../etc' }, { accessMode: 'invented' }, { reasoningEffort: 'high;env' }]) assert.throws(() => agentArguments({ ...input, ...attack }));
});
