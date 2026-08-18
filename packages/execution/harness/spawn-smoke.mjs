#!/usr/bin/env node
// tm8 spawn smoke — the G1A loop, printed.
//
//   cd packages/execution && bun run build && node harness/spawn-smoke.mjs
//
// Runs SpawnService against a fake graph and a REAL PTY with the built-in
// echo-agent, then dumps the raw terminal bytes so a human can see the loop
// work rather than trust a green tick. No database, no API key, no model spend.
//
// The line that matters is `TM8-ECHO: <text>`: the echo-agent only writes that
// prefix after reading the line off its own stdin, so its presence proves the
// prompt physically traversed SpawnService → deliverPrompt → the FIFO → the pty
// master → the tty line discipline → the agent's stdin → back out through the
// pty → the 16ms coalescer → the output ring. A `delivered: true` flag proves
// none of that, which is exactly why it is not what we look at.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PtyHostService, SpawnService } from '../dist/index.js';

const fakeGraph = (workingDir) => ({
  transitions: [],
  commands: [],
  async loadSpawnContext(_auth, input) {
    return {
      spaceId: input.spaceId,
      project: { id: 'proj-smoke', name: 'smoke', workingDir, trust: 'trusted' },
      teamMember: {
        id: input.teamMemberId,
        name: 'Draco',
        role: 'PTY engineer',
        identity: 'You own the terminal seam.',
        memories: [],
        model: 'opus',
        agentTool: null,
        mode: 'worker',
        permissionMode: null,
        avatar: '🖥️',
        capabilities: {},
        commandPermissions: {},
      },
      tasks: (input.taskIds ?? []).map((id) => ({
        id,
        version: 1,
        title: 'prove the G1A loop',
        description: '',
        priority: 'high',
        status: 'open',
        acceptanceCriteria: [],
      })),
    };
  },
  async createWorkSession() {
    const sessionId = randomUUID();
    return { sessionId, commandResult: { entity: { id: sessionId } } };
  },
  async issueWorkSessionAgentToken(_auth, sessionId) {
    return `tm8s_${sessionId}.smoke-token`;
  },
  async recordManifest() {},
  async transition(_auth, input) {
    this.transitions.push(input.status);
  },
  async recordCommand(_auth, input) {
    this.commands.push(input.operation);
    return {};
  },
});

const waitFor = async (pty, id, needle, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const slice = pty.getReplay(id, 0);
    const text = slice ? slice.data.toString('utf8') : '';
    if (text.includes(needle)) return text;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${JSON.stringify(needle)}`);
};

const dataDir = await mkdtemp(join(tmpdir(), 'tm8-smoke-data-'));
const projectDir = await mkdtemp(join(tmpdir(), 'tm8-smoke-proj-'));
const graph = fakeGraph(projectDir);

let service;
const pty = new PtyHostService({ onSessionStatus: (id, s) => service.handlePtyExit(id, s) });
service = new SpawnService({
  graph,
  pty,
  baseUrl: 'http://127.0.0.1:4610',
  dataDir,
  nodeId: 'smoke',
  env: { ...process.env, TM8_AGENT_CMD: 'echo-agent' },
});

try {
  const result = await service.spawn(
    { identityId: 'smoke-identity', actorId: 'smoke-actor' },
    { spaceId: randomUUID(), teamMemberId: randomUUID(), taskIds: [randomUUID()] },
  );

  console.log(`session   ${result.sessionId}`);
  console.log(`command   ${result.command}`);
  console.log(`cwd       ${result.cwd}`);
  console.log(`manifest  ${result.manifestPath}`);
  console.log(`env names ${result.envVarNames.join(', ')}\n`);

  await waitFor(pty, result.sessionId, 'TM8-ECHO-READY');

  const message = `smoke-prompt-${Date.now().toString(36)}`;
  await service.prompt({ identityId: 'smoke-identity' }, result.sessionId, message);
  const output = await waitFor(pty, result.sessionId, `TM8-ECHO: ${message}`);

  console.log('--- RAW PTY OUTPUT -------------------------------------------');
  process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  console.log('--------------------------------------------------------------\n');

  const proven = output.includes(`TM8-ECHO: ${message}`);
  console.log(`prompt echoed by the agent process: ${proven ? 'YES' : 'NO'}`);
  console.log(`graph transitions: ${graph.transitions.join(' -> ')}`);
  console.log(`ledgered commands: ${graph.commands.join(', ') || '(none)'}`);

  await service.terminate({ identityId: 'smoke-identity' }, result.sessionId, { force: true });
  console.log(`after terminate:   ${graph.transitions.join(' -> ')}`);

  console.log(proven ? '\nSMOKE GREEN' : '\nSMOKE FAILED');
  process.exitCode = proven ? 0 : 1;
} finally {
  pty.shutdownAll();
  await rm(dataDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
}
