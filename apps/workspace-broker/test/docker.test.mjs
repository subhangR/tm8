// Run inside the broker: docker compose ... exec -T workspace-broker node --input-type=module < this-file
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WorkspaceBroker } from '/opt/tm8/src/broker.mjs';
const broker = new WorkspaceBroker({ machineId: randomUUID(), stateDir: '/tmp' });
const limits = { cpus: 2, memoryMiB: 512, pids: 64 };
const alice = { workspaceId: randomUUID(), accountId: randomUUID(), limits };
const bob = { workspaceId: randomUUID(), accountId: randomUUID(), limits };
const projectId = randomUUID();
const operation = (user, action, extra = {}) => broker.operation({ ...user, projectId, action, ...extra });
try {
  await broker.provision(alice); await broker.provision(bob);
  console.log('PASS: two private Ubuntu workspaces provisioned');
  await assert.rejects(broker.requireWorkspace(alice.workspaceId, bob.accountId), /identity_mismatch/);
  const a = await broker.docker.inspect(broker.name(alice.workspaceId));
  assert.equal(a.Config.User, '1000:1000'); assert.equal(a.HostConfig.ReadonlyRootfs, true);
  assert.equal(a.HostConfig.Memory, 512 * 1024 * 1024); assert.equal(a.HostConfig.PidsLimit, 64);
  assert.equal(a.Mounts.length, 1); assert.equal(a.Mounts[0].Destination, '/home/user');
  assert.ok(a.HostConfig.CapDrop.includes('ALL'));
  const secrets = await broker.docker.exec(broker.name(alice.workspaceId), ['bash', '-c', 'test ! -e /workspace/tm8 && test ! -e /var/run/docker.sock && test -z "$TM8_DATABASE_URL" && test ! -e /home/user/.tm8-dev']);
  assert.equal(secrets.exitCode, 0);
  console.log('PASS: identities, mounts, resource limits and service secrets isolated');
  await operation(alice, 'project-create', { source: { kind: 'init' } });
  await operation(alice, 'files-write', { path: 'shared.txt', content: Buffer.from('first commit\n').toString('base64') });
  await operation(alice, 'git-commit', { message: 'Share first file' });
  await operation(alice, 'git-sync', { remote: 'tm8', verb: 'push' });
  await operation(bob, 'checkout-create');
  assert.equal(Buffer.from((await operation(bob, 'files-read', { path: 'shared.txt' })).content, 'base64').toString(), 'first commit\n');
  await operation(alice, 'files-write', { path: 'private.txt', content: Buffer.from('private edits').toString('base64') });
  await assert.rejects(operation(bob, 'files-read', { path: 'private.txt' }));
  await assert.rejects(operation(alice, 'files-read', { path: '../../etc/passwd' }), /invalid_path/);
  console.log('PASS: shared commits synchronize while uncommitted files stay private');
  await assert.rejects(operation(alice, 'git-sync', { remote: 'tm8', verb: 'pull' }), /dirty_worktree/);
  await broker.docker.request('POST', `/containers/${broker.name(alice.workspaceId)}/restart?t=1`);
  assert.equal(Buffer.from((await operation(alice, 'files-read', { path: 'private.txt' })).content, 'base64').toString(), 'private edits');
  console.log('PASS: dirty pull refused and user files survive container restart');
  const blocked = await broker.docker.exec(broker.name(alice.workspaceId), ['curl', '--max-time', '5', '-fsS', 'http://169.254.169.254/latest/meta-data/']);
  assert.notEqual(blocked.exitCode, 0);
  const publicNet = await broker.docker.exec(broker.name(alice.workspaceId), ['curl', '--max-time', '20', '-fsSI', 'https://github.com']);
  assert.equal(publicNet.exitCode, 0, publicNet.stderr.toString());
  console.log('PASS: cloud metadata denied; public GitHub egress works');
  const terminal = await broker.terminal({ ...alice, projectId });
  const session = broker.session(terminal.sessionId, alice.workspaceId, alice.accountId);
  await assert.rejects(async () => broker.session(terminal.sessionId, bob.workspaceId, bob.accountId), /not_found/);
  session.socket.write('echo TM8_TERMINAL_ACCEPTANCE\r');
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('terminal output timeout')), 5000); session.socket.on('data', data => { if (data.includes('TM8_TERMINAL_ACCEPTANCE')) { clearTimeout(timer); resolve(); } }); });
  session.socket.write('exit\r');
  console.log('PASS: interactive terminal stays bound to its owner');
} finally {
  for (const user of [alice, bob]) {
    const name = broker.name(user.workspaceId);
    if (await broker.docker.inspect(name)) await broker.docker.request('DELETE', `/containers/${name}?force=true`);
    try { await broker.docker.request('POST', `/networks/${name}-private/disconnect`, { Container: broker.egressContainer, Force: true }); } catch {}
    try { await broker.docker.request('DELETE', `/networks/${name}-private`); } catch {}
    try { await broker.docker.request('DELETE', `/volumes/${name}-home`); } catch {}
  }
  if (await broker.docker.inspect(broker.repositoryContainer)) await broker.docker.request('DELETE', `/containers/${broker.repositoryContainer}?force=true`);
  try { await broker.docker.request('DELETE', `/volumes/${broker.repositoryContainer}-data`); } catch {}
}
