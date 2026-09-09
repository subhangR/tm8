// Execute with: docker compose ... exec -T workspace-broker node --input-type=module < this-file
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WorkspaceBroker } from '/opt/tm8/src/broker.mjs';
import { WorkspaceCredentials } from '/opt/tm8/src/credentials.mjs';
const broker = new WorkspaceBroker({ machineId: randomUUID(), stateDir: '/tmp' });
const credentials = new WorkspaceCredentials(broker);
const owner = { workspaceId: randomUUID(), accountId: randomUUID(), limits: { cpus: 2, memoryMiB: 2048, pids: 128 } };
const name = broker.name(owner.workspaceId);
try {
  await broker.provision(owner);
  const status = await credentials.request({ ...owner, action: 'status' });
  for (const provider of ['anthropic', 'openai']) {
    const entry = status.providers.find(entry => entry.provider === provider);
    assert.equal(entry.status, 'revoked'); assert.equal(entry.connected, false);
    const started = await credentials.request({ ...owner, action: 'start', provider });
    const session = broker.session(started.workSessionId, owner.workspaceId, owner.accountId);
    assert.throws(() => broker.session(started.workSessionId, owner.workspaceId, randomUUID()), /not_found/);
    const deadline = Date.now() + 35000;
    const authorization = /https:\/\/(?:claude\.com\/cai\/oauth\/authorize|claude\.ai\/oauth\/authorize|(?:console\.anthropic\.com|platform\.claude\.com)\/oauth\/authorize|auth\.openai\.com\/codex\/device)/;
    while (!authorization.test(session.replay.toString()) && Date.now() < deadline && !session.exited) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(authorization.test(session.replay.toString()), `${provider} must print its real authorization URL`);
    console.log(`PASS: ${provider} opens real provider authorization through restricted workspace egress`);
    const finished = await credentials.request({ ...owner, action: 'finish', sessionId: started.workSessionId });
    assert.equal(finished.connected, false); assert.equal(finished.stored, false);
    assert.equal(broker.sessions.has(started.workSessionId), false);
  }
  // Controlled cache fixture tests persistence and logout without signing in
  // to a real provider account or spending inference credits.
  await broker.docker.exec(name, ['node', '-e', 'const fs=require("node:fs");fs.mkdirSync("/home/user/.codex",{recursive:true,mode:448});fs.writeFileSync("/home/user/.codex/auth.json",JSON.stringify({OPENAI_API_KEY:"tm8-synthetic-provider-test-key"}),{mode:384});']);
  const before = await broker.runner(name, { action: 'provider-probe', provider: 'openai' });
  assert.equal(before.connected, true); assert.equal(before.stored, true);
  await broker.docker.request('POST', `/containers/${name}/restart?t=1`);
  const after = await broker.runner(name, { action: 'provider-probe', provider: 'openai' });
  assert.equal(after.connected, true); assert.equal(after.stored, true);
  const disconnected = await credentials.request({ ...owner, action: 'disconnect', provider: 'openai' });
  assert.equal(disconnected.revoked, true);
  assert.equal((await broker.runner(name, { action: 'provider-probe', provider: 'openai' })).connected, false);
  console.log('PASS: private provider cache survives restart; disconnect removes it (controlled cache fixture)');
} finally {
  for (const login of credentials.logins.values()) clearTimeout(login.timer);
  if (await broker.docker.inspect(name)) await broker.docker.request('DELETE', `/containers/${name}?force=true`);
  try { await broker.docker.request('POST', `/networks/${name}-private/disconnect`, { Container: broker.egressContainer, Force: true }); } catch {}
  try { await broker.docker.request('DELETE', `/networks/${name}-private`); } catch {}
  try { await broker.docker.request('DELETE', `/volumes/${name}-home`); } catch {}
}
