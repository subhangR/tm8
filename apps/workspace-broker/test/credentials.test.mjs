import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseProviderStatus, providerConfig, loginFile } from '../runner/providers.mjs';
import { WorkspaceCredentials } from '../src/credentials.mjs';
import { KeyedLock } from '../src/broker.mjs';

test('provider probes distinguish no login, unavailable, unknown and authenticated without exposing key output', () => {
  assert.equal(parseProviderStatus('anthropic', { code: 0, stdout: '{"loggedIn":false}' }).connected, false);
  assert.equal(parseProviderStatus('anthropic', { code: 0, stdout: '{"loggedIn":true,"email":"alice@example.test","authMethod":"oauth"}' }).login, 'alice@example.test');
  assert.equal(parseProviderStatus('openai', { code: 1, stderr: 'Not logged in' }).status, 'revoked');
  assert.equal(parseProviderStatus('openai', { code: 'ENOENT' }).status, 'unavailable');
  assert.equal(parseProviderStatus('openai', { code: 0, stderr: 'An unfamiliar answer' }).status, 'stale');
  const connected = parseProviderStatus('openai', { code: 0, stderr: 'Logged in using an API key - sk-secret-value' });
  assert.equal(connected.connected, true); assert.equal(connected.authMethod, 'api_key');
  assert.equal(JSON.stringify(connected).includes('sk-secret'), false);
  assert.equal(parseProviderStatus('openai', { code: 0, stderr: 'Logged in using ChatGPT' }).authMethod, 'chatgpt');
  assert.throws(() => providerConfig('__proto__')); assert.throws(() => providerConfig('openai;env'));
  assert.throws(() => loginFile('../../etc/passwd'));
});

function fixture() {
  const owner = { workspaceId: randomUUID(), accountId: randomUUID() };
  const calls = [];
  const broker = {
    locks: new KeyedLock(), sessions: new Map(),
    async requireWorkspace(workspaceId, accountId) { assert.equal(workspaceId, owner.workspaceId); if (accountId !== owner.accountId) throw new Error('workspace_identity_mismatch'); return 'private-runner'; },
    async runner(name, input) { assert.equal(name, 'private-runner'); calls.push(input); return { connected: false, status: 'revoked', stored: false, login: null, authMethod: null }; },
    async terminal(input, options) { calls.push({ action: 'terminal', ...options }); },
    docker: { async request() { calls.push({ action: 'restart' }); } },
  };
  return { owner, calls, credentials: new WorkspaceCredentials(broker) };
}
test('login argv is fixed, only one login starts, and completion is scoped to the owner', async () => {
  const { owner, calls, credentials } = fixture();
  const results = await Promise.allSettled([1,2].map(() => credentials.request({ ...owner, action: 'start', provider: 'openai', command: 'env' })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal(results[0].value.workSessionId, results[1].value.workSessionId);
  assert.equal(calls.filter(call => call.action === 'terminal').length, 1);
  const started = results.find(result => result.status === 'fulfilled').value;
  try {
    const terminal = calls.find(call => call.action === 'terminal');
    assert.deepEqual(terminal.argv, ['node', '/opt/tm8/provider-login.mjs', 'openai', started.workSessionId]);
    await assert.rejects(credentials.request({ ...owner, accountId: randomUUID(), action: 'finish', sessionId: started.workSessionId }), /identity_mismatch/);
    await assert.rejects(credentials.request({ ...owner, action: 'finish', sessionId: randomUUID() }), /not_found/);
    const finished = await credentials.request({ ...owner, action: 'finish', sessionId: started.workSessionId });
    assert.equal(finished.connected, false); assert.equal(finished.stored, false);
    assert.equal(credentials.logins.size, 0);
  } finally { for (const login of credentials.logins.values()) clearTimeout(login.timer); }
});
test('disconnect stops the owner processes before logout and clears live logins', async () => {
  const { owner, calls, credentials } = fixture();
  await credentials.request({ ...owner, action: 'start', provider: 'anthropic' });
  const result = await credentials.request({ ...owner, action: 'disconnect', provider: 'anthropic' });
  assert.equal(result.revoked, true);
  assert.ok(calls.findIndex(call => call.action === 'restart') < calls.findIndex(call => call.action === 'provider-disconnect'));
  assert.equal(credentials.logins.size, 0);
});
