// Run with deploy/docker/test.sh --docker node <this file>. Uses only a
// disposable workspace and controlled provider image, never real credentials.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { WorkspaceBroker } from '../src/broker.mjs';
import { WorkspaceExecution } from '../src/execution.mjs';
if (process.env.TM8_TEST_DOCKER !== '1') throw new Error('Disposable Docker test launcher required');
const dir = await fs.mkdtemp('/tmp/tm8-execution-');
const machineId = randomUUID(), broker = new WorkspaceBroker({ machineId, stateDir: dir, image: 'tm8-workspace-task-fixture:test' });
const execution = new WorkspaceExecution(broker);
const owner = { workspaceId: randomUUID(), accountId: randomUUID(), limits: { cpus: 2, memoryMiB: 2048, pids: 128 } };
const name = broker.name(owner.workspaceId), projectId = randomUUID();
const base = { ...owner, identityId: randomUUID(), spaceId: randomUUID(), agentTool: 'claude-code', model: 'claude-sonnet-5', accessMode: 'auto', prompt: 'Assignment: Execute the test task, literally $(touch /tmp/escape).' };
const waitFor = async predicate => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Timed out'); };
try {
  await execution.init(); await broker.provision(owner);
  await broker.docker.exec(name, ['node', '-e', 'require("fs").writeFileSync("/home/user/.claude.json",JSON.stringify({theme:"light",fixturePreference:"preserved"}),{mode:384})']);
  await broker.operation({ ...owner, projectId, action: 'project-create', source: { kind: 'init' } });
  const before = (await broker.docker.exec(name, ['git', '-C', `/home/user/projects/${projectId}`, 'rev-parse', 'HEAD'])).stdout.toString();
  const input = { ...base, sessionId: randomUUID(), workdirId: randomUUID(), projectId, workdirMode: 'worktree', action: 'start' };
  const run = await execution.request(input);
  await execution.request(input);
  const session = broker.session(run.sessionId, owner.workspaceId, owner.accountId);
  await waitFor(() => session.replay.includes('TM8_TASK_EXECUTED'));
  const result = JSON.parse((await broker.docker.exec(name, ['cat', `${run.cwd}/tm8-task-result.txt`])).stdout.toString());
  assert.equal(result.uid, 1000); assert.equal(result.model, base.model); assert.equal(result.cwd, `/home/user/worktrees/${input.workdirId}`);
  const config = JSON.parse((await broker.docker.exec(name, ['cat', '/home/user/.claude.json'])).stdout.toString());
  assert.equal(config.hasCompletedOnboarding, true);
  assert.equal(config.projects[run.cwd].hasTrustDialogAccepted, true);
  assert.equal(config.theme, 'light'); assert.equal(config.fixturePreference, 'preserved');
  assert.equal((await broker.docker.exec(name, ['test', '-e', '/tmp/escape'])).exitCode, 1);
  assert.equal((await broker.docker.exec(name, ['git', '-C', `/home/user/projects/${projectId}`, 'rev-parse', 'HEAD'])).stdout.toString(), before);
  session.socket.write('PING\n'); await waitFor(() => session.replay.includes('TM8_TASK_PONG'));
  await assert.rejects(execution.request({ ...input, action: 'stop', accountId: randomUUID() }), /identity_mismatch/);
  const stopped = await execution.request({ ...input, action: 'stop' }); assert.equal(stopped.exited, true); assert.equal(stopped.reason, 'stopped_by_operator');
  await waitFor(async () => (await broker.docker.exec(name, ['test', '-d', `/proc/${result.childPid}`])).exitCode === 1);
  console.log('PASS: worktree task executes as user 1000, receives literal prompt and input, preserves project HEAD, and Stop kills its child process');
  const restartedBroker = new WorkspaceBroker({ machineId, stateDir: dir, image: broker.image });
  const recovered = new WorkspaceExecution(restartedBroker); await recovered.init();
  assert.ok(restartedBroker.session(run.sessionId, owner.workspaceId, owner.accountId).replay.includes('TM8_TASK_EXECUTED'));
  assert.equal((await recovered.request({ ...input, action: 'status' })).exited, true);
  console.log('PASS: stopped session output and exit evidence survive broker restart');
  const codexInput = { ...base, sessionId: randomUUID(), workdirId: randomUUID(), workdirMode: 'scratch', agentTool: 'codex', model: 'gpt-6-astra', action: 'start' };
  const codex = await execution.request(codexInput);
  const codexSession = broker.session(codex.sessionId, owner.workspaceId, owner.accountId);
  await waitFor(() => codexSession.replay.includes('model=gpt-6-astra'));
  codexSession.socket.write('EXIT\n'); await waitFor(() => execution.records.get(codex.sessionId).exited);
  assert.equal(execution.records.get(codex.sessionId).exitCode, 0);
  console.log('PASS: Codex uses the selected GPT model in a private Git scratch directory and records normal exit');
} finally {
  for (const session of broker.sessions.values()) session.socket.destroy();
  for (const container of [name, broker.repositoryContainer]) if (await broker.docker.inspect(container)) await broker.docker.request('DELETE', `/containers/${container}?force=true`);
  await broker.docker.request('POST', `/networks/${name}-private/disconnect`, { Container: broker.egressContainer, Force: true }).catch(() => {});
  await broker.docker.request('DELETE', `/networks/${name}-private`).catch(() => {});
  for (const volume of [`${name}-home`, `${broker.repositoryContainer}-data`]) await broker.docker.request('DELETE', `/volumes/${volume}`).catch(() => {});
  await fs.rm(dir, { recursive: true, force: true });
}
