import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClaudeHarnessAdapter,
  type HarnessSession,
  type LaunchMaterial,
} from '../src/runtime/index.js';
import { command, input, Recorder } from './harness-test-support.js';
const fixture = fileURLToPath(new URL('../harness/headless-agent.mjs', import.meta.url));
let root: string,
  sessions: HarnessSession[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tm8-claude-harness-'));
  await writeFile(join(root, 'mcp.json'), '{}');
});
afterEach(async () => {
  await Promise.all(sessions.map((s) => s.close('shutdown')));
  sessions = [];
  await rm(root, { recursive: true, force: true });
});
function material(env: Record<string, string> = {}): LaunchMaterial {
  return {
    harness: 'claude',
    command: process.execPath,
    argvPrefix: [fixture],
    cwd: root,
    modelConfigDir: root,
    env: { TM8_FAKE_ARGV_FILE: join(root, 'argv.json'), ...env },
    instructionText: 'trusted policy',
    providerConfig: {},
    mcpConfigPath: join(root, 'mcp.json'),
    mcpServers: [],
    nativeTools: [],
    allowedTools: ['mcp__tm8__read'],
  };
}
const adapter = () =>
  new ClaudeHarnessAdapter({ nodeId: 'node1', bootSettlementMs: 150, closeGraceMs: 100 });
async function open(data: ReturnType<typeof input>) {
  const session = await adapter().open(data);
  sessions.push(session);
  return session;
}
describe('Claude shared-port conformance', () => {
  it('preserves confirmed exit when owned-resource release rejects and permits an exact-owner retry', async () => {
    let releases = 0;
    const data = input(material(), () => {
      if (++releases === 1) throw new Error('private cleanup diagnostic');
    });
    const session = await open(data), record = new Recorder(session);
    const receipt = await session.close('shutdown');
    expect(receipt).toMatchObject({ exited: true, nativeUsable: null, cleanup: 'pending' });
    expect(await session.close('shutdown')).toBe(receipt);
    await record.finished;
    expect(record.events.some(event => event.payload.kind === 'runtime_exit')).toBe(true);
    expect(releases).toBe(1);
    await data.launch.release();
    expect(releases).toBe(2);
    expect(JSON.stringify(receipt)).not.toContain('private cleanup diagnostic');
  });

  it('keeps CLI recipe, validates native init and emits paired tools and one provider terminal', async () => {
    const data = input(material()),
      session = await open(data),
      record = new Recorder(session);
    expect(session.opened.nativeConfirmed).toBe(false);
    expect(await session.submit(command(data.config, 'tool'))).toMatchObject({
      delivery: 'sent',
      acknowledgement: 'local_write',
      nativeTurnId: null,
    });
    await record.terminal();
    expect(record.events.some((e) => e.payload.kind === 'native_confirmed')).toBe(true);
    expect(
      record.events
        .filter((e) => e.payload.kind === 'tool')
        .map((e) => (e.payload.kind === 'tool' ? e.payload.tool.state : null)),
    ).toEqual(['running', 'completed']);
    expect(record.events.find((e) => e.payload.kind === 'terminal')?.payload).toEqual({
      kind: 'terminal',
      outcome: 'completed',
      evidence: 'provider_terminal',
    });
    const argv = JSON.parse(await readFile(join(root, 'argv.json'), 'utf8')).args as string[];
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).toContain('--setting-sources');
    expect(argv[argv.indexOf('--effort') + 1]).toBe('high');
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(session.opened.native.nativeId);
    expect(
      record.events.every(
        (e) => e.fence.bindingId === 'binding1' && e.attempt?.attemptId === 'attempt-1',
      ),
    ).toBe(true);
  });
  it('injects inert bootstrap at launch and replaces repeated assistant snapshots without duplicate text', async () => {
    const event = (text: string) => ({
      type: 'assistant',
      message: { id: 'same-message', content: [{ type: 'text', text }] },
    });
    const fixturePath = join(root, 'snapshots.json');
    await writeFile(
      fixturePath,
      JSON.stringify({
        snapshots: [
          event('old partial'),
          event('correct complete'),
          { type: 'result', subtype: 'success', is_error: false, result: 'correct complete' },
        ],
      }),
    );
    const data = input(material({ TM8_FAKE_STREAM_FIXTURE: fixturePath }));
    const context = {
      schemaVersion: 1 as const,
      snapshotId: 'seed1',
      coverage: {
        throughTurnOrdinal: 1,
        captureHighWater: 9,
        projectionPolicyVersion: '1',
        authorityScopeDigest: 'scope',
        logicalHistoryDigest: 'history',
      },
      contentHash: 'hash',
      renderedContext: 'UNTRUSTED readonly historical call',
      manifest: [],
    };
    const session = await open({ ...data, mode: { kind: 'bootstrap', context } }),
      record = new Recorder(session);
    expect(session.opened.seed?.acknowledgement).toBe('launch_materialized');
    await session.submit(command(data.config, 'snapshots'));
    await record.terminal();
    const texts = record.events.filter((e) => e.payload.kind === 'text').map((e) => e.payload);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toMatchObject({
      text: 'correct complete',
      operation: 'replace',
      revision: 2,
      itemId: 'same-message/0',
    });
    const argv = JSON.parse(await readFile(join(root, 'argv.json'), 'utf8')).args as string[];
    expect(argv[argv.indexOf('--system-prompt') + 1]).toContain(context.renderedContext);
    expect(
      record.events.find((e) => e.payload.kind === 'seed_acknowledged')?.payload,
    ).toMatchObject({ seed: { acknowledgement: 'protocol_echo' } });
  });
  it('requires exact available native transcript and never silently starts fresh', async () => {
    const data = input(material()),
      native = {
        schemaVersion: 1 as const,
        harness: 'claude' as const,
        nativeId: '550e8400-e29b-41d4-a716-446655440000',
        nodeId: 'node1',
        storageScopeId: 'history1',
        nativeStorageGeneration: 1,
        cwdIdentity: 'cwd1',
        historyFormat: 'claude-stream-json/v1',
      };
    const mode = {
      kind: 'resume' as const,
      native,
      expectedCoverage: {
        throughTurnOrdinal: 1,
        captureHighWater: 3,
        projectionPolicyVersion: '1',
        authorityScopeDigest: 'scope',
        logicalHistoryDigest: 'history',
      },
    };
    await expect(open({ ...data, mode })).rejects.toMatchObject({
      failure: { code: 'continuity_required' },
    });
    await mkdir(join(root, 'projects', 'project'), { recursive: true });
    await writeFile(join(root, 'projects', 'project', `${native.nativeId}.jsonl`), '');
    const session = await open({ ...data, mode }),
      record = new Recorder(session);
    await session.submit(command(data.config, 'resumed'));
    await record.terminal();
    const argv = JSON.parse(await readFile(join(root, 'argv.json'), 'utf8')).args as string[];
    expect(argv).toContain('--resume');
    expect(argv).not.toContain('--session-id');
    expect(session.opened.native.nativeId).toBe(native.nativeId);
  });
  it('serializes attempts, waits for interruption evidence and closes/release idempotently', async () => {
    let released = 0;
    const data = input(material(), () => {
        released++;
      }),
      session = await open(data),
      record = new Recorder(session),
      first = command(data.config, 'hang');
    await session.submit(first);
    await record.until((events) => events.some((e) => e.payload.kind === 'tool'));
    await expect(session.submit(command(data.config, 'later', 2))).rejects.toThrow(
      'already active',
    );
    expect(await session.cancel(first.attempt, 'user')).toMatchObject({ disposition: 'requested' });
    await record.terminal();
    expect(record.events.find((e) => e.payload.kind === 'terminal')?.payload).toMatchObject({
      outcome: 'interrupted',
      evidence: 'provider_terminal',
    });
    await session.close('shutdown');
    await session.close('shutdown');
    expect(released).toBe(1);
    await record.finished;
  });
  it('reports loss on invalid stream/crash and preserves natural success in a cancellation race', async () => {
    for (const text of ['crash', 'invalid-json']) {
      const data = input(material()),
        session = await open(data),
        record = new Recorder(session);
      await session.submit(command(data.config, text));
      await record.terminal();
      expect(record.events.filter((e) => e.payload.kind === 'terminal')).toHaveLength(1);
      expect(record.events.find((e) => e.payload.kind === 'terminal')?.payload).toMatchObject({
        outcome: 'runtime_lost',
      });
    }
    // The fixture sends a success result immediately; intent may race it, but cannot rewrite success.
    const data = input(material()),
      session = await open(data),
      record = new Recorder(session),
      request = command(data.config, 'cancel-success');
    await session.submit(request);
    await record.until((events) => events.some((e) => e.payload.kind === 'tool'));
    await session.cancel(request.attempt, 'user');
    await record.terminal();
    expect(record.events.find((e) => e.payload.kind === 'terminal')?.payload).toMatchObject({
      outcome: 'completed',
    });
  });
  it('refuses target changes requiring restart and missing backend routes before dispatch', async () => {
    const data = input(material()),
      session = await open(data),
      next = { ...data.config, revision: 2, target: { ...data.config.target, model: 'new-model' } };
    await expect(session.submit(command(next))).rejects.toMatchObject({
      failure: { code: 'continuity_required' },
    });
    await expect(
      open({
        ...data,
        config: { ...data.config, target: { ...data.config.target, provider: 'moonshot' } },
      }),
    ).rejects.toMatchObject({ failure: { code: 'unsupported_capability' } });
  });
});
