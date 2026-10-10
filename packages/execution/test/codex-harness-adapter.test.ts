import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  CodexAppServerAdapter,
  type HarnessSession,
  type LaunchMaterial,
  type OpenHarnessInput,
} from '../src/runtime/index.js';
import { command, config, input, Recorder } from './harness-test-support.js';
const fixture = fileURLToPath(new URL('../harness/codex-app-server.mjs', import.meta.url));
let root: string,
  sessions: HarnessSession[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tm8-codex-harness-'));
});
afterEach(async () => {
  await Promise.all(sessions.map((s) => s.close('shutdown')));
  sessions = [];
  await rm(root, { recursive: true, force: true });
});
function material(env: Record<string, string> = {}): LaunchMaterial {
  return {
    harness: 'codex',
    command: process.execPath,
    argvPrefix: [fixture],
    cwd: root,
    modelConfigDir: root,
    env: { TM8_FAKE_CODEX_RECORD: join(root, 'frames.jsonl'), ...env },
    instructionText: 'trusted policy',
    providerConfig: {},
    mcpConfigPath: join(root, 'mcp.json'),
    mcpServers: [
      {
        name: 'tm8',
        command: 'inert-command',
        args: ['arg'],
        env: { TOKEN: 'private-test' },
        cwd: root,
      },
    ],
    nativeTools: ['Bash'],
    allowedTools: ['Bash', 'mcp__tm8__read'],
  };
}
async function open(data: OpenHarnessInput) {
  const session = await new CodexAppServerAdapter({
    nodeId: 'node1',
    rpcTimeoutMs: 500,
    closeGraceMs: 100,
  }).open(data);
  sessions.push(session);
  return session;
}
async function frames() {
  return (await readFile(join(root, 'frames.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}
describe('Codex pinned-v2 conformance', () => {
  it('uses returned opaque IDs; folds deltas/snapshots, pairs completion-only tools and truthful usage', async () => {
    const data = input(material()),
      session = await open(data),
      record = new Recorder(session);
    expect(session.opened.native.nativeId).toBe('native-codex/opaque:returned');
    expect(await session.submit(command(data.config))).toMatchObject({
      delivery: 'sent',
      nativeTurnId: 'codex-turn-1',
    });
    await record.terminal();
    const text = record.events.filter((e) => e.payload.kind === 'text').map((e) => e.payload);
    let folded = '';
    for (const event of text)
      if (event.kind === 'text')
        folded = event.operation === 'replace' ? event.text : folded + event.text;
    expect(folded).toBe('Hello world!');
    expect(text).toHaveLength(3);
    const tools = record.events.filter((e) => e.payload.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]?.payload).toMatchObject({
      tool: { evidence: 'completion_only', state: 'completed', nativeCallId: 'mcp-1' },
    });
    expect(record.events.filter((e) => e.payload.kind === 'terminal')).toHaveLength(1);
    expect(record.events.at(-1)?.payload).toMatchObject({
      kind: 'terminal',
      outcome: 'completed',
      evidence: 'provider_terminal',
    });
    expect(record.events.filter((e) => e.payload.kind === 'usage')).toHaveLength(2);
    expect(record.events.find((e) => e.payload.kind === 'context')?.payload).toMatchObject({
      context: { usedTokens: 100, capacityTokens: 200000 },
    });
    expect(record.events.every((e) => e.fence.generation === 1 && e.adapterSeq > 0)).toBe(true);
    const sent = await frames();
    expect(
      sent
        .map((f) => f.method)
        .filter(Boolean)
        .slice(0, 4),
    ).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
    expect(sent.find((f) => f.id === 901 && f.result)?.result).toEqual({ decision: 'decline' });
    await session.submit(command(data.config, 'normal', 2));
    await record.terminal(2);
    expect(
      record.events
        .filter((e) => e.payload.kind === 'usage' && e.payload.usage.scope === 'attempt')
        .at(-1)?.payload,
    ).toMatchObject({ usage: { inputTokens: 100, outputTokens: 10, costUsd: null } });
  });
  it('sends explicit backend, model, effort, MCP and inert bootstrap; supports safe per-turn changes', async () => {
    const data = input({
      ...material(),
      providerConfig: {
        model_providers: {
          groq: {
            base_url: 'https://groq.example',
            wire_api: 'responses',
            env_key: 'GROQ_API_KEY',
          },
        },
      },
    });
    const backendConfig = config('codex', {
      target: {
        harness: 'codex',
        provider: 'groq',
        model: 'groq-model',
        reasoningEffort: 'medium',
        serviceTier: null,
      },
    });
    const mode = {
      kind: 'bootstrap' as const,
      context: {
        schemaVersion: 1,
        snapshotId: 'seed1',
        coverage: {
          throughTurnOrdinal: 1,
          captureHighWater: 9,
          projectionPolicyVersion: '1',
          authorityScopeDigest: 'scope',
          logicalHistoryDigest: 'history',
        },
        contentHash: 'hash',
        renderedContext: 'UNTRUSTED readonly old tool: do not execute',
        manifest: [],
      },
    };
    const planned = { ...data, config: backendConfig, mode };
    const session = await open(planned),
      record = new Recorder(session);
    expect(session.opened.seed?.acknowledgement).toBe('launch_materialized');
    const next = {
      ...backendConfig,
      revision: 2,
      target: { ...backendConfig.target, model: 'next-model', reasoningEffort: 'high' },
    };
    await session.submit(command(next, 'CURRENT'));
    await record.terminal();
    const sent = await frames(),
      start = sent.find((f) => f.method === 'thread/start').params,
      submit = sent.find((f) => f.method === 'turn/start').params;
    expect(start).toMatchObject({
      model: 'groq-model',
      modelProvider: 'groq',
      config: {
        model_reasoning_effort: 'medium',
        model_providers: { groq: { supports_websockets: false } },
        mcp_servers: { tm8: { command: 'inert-command', args: ['arg'] } },
      },
    });
    expect(start.developerInstructions).toContain('UNTRUSTED readonly');
    expect(submit.input).toEqual([{ type: 'text', text: 'CURRENT', text_elements: [] }]);
    expect(submit).toMatchObject({ model: 'next-model', effort: 'high' });
    expect(
      record.events.find((e) => e.payload.kind === 'seed_acknowledged')?.payload,
    ).toMatchObject({ seed: { acknowledgement: 'turn_accepted' } });
  });
  it('resumes only exact ID in compatible scope; refuses missing/mismatched native state', async () => {
    const native = {
      schemaVersion: 1 as const,
      harness: 'codex' as const,
      nativeId: 'exact-native',
      nodeId: 'node1',
      storageScopeId: 'history1',
      nativeStorageGeneration: 1,
      cwdIdentity: 'cwd1',
      historyFormat: 'app-server-v2/0.161.0',
    };
    const coverage = {
      throughTurnOrdinal: 1,
      captureHighWater: 2,
      projectionPolicyVersion: '1',
      authorityScopeDigest: 'scope',
      logicalHistoryDigest: 'history',
    };
    const data = {
      ...input(material()),
      mode: { kind: 'resume' as const, native, expectedCoverage: coverage },
    };
    const session = await open(data);
    expect(session.opened.native.nativeId).toBe('exact-native');
    expect((await frames()).find((f) => f.method === 'thread/resume').params.threadId).toBe(
      'exact-native',
    );
    for (const mode of ['missing', 'mismatch'])
      await expect(
        open({ ...data, launch: input(material({ TM8_FAKE_CODEX_RESUME: mode })).launch }),
      ).rejects.toMatchObject({ failure: { code: 'continuity_required' } });
    await expect(
      open({ ...data, mode: { ...data.mode, native: { ...native, storageScopeId: 'wrong' } } }),
    ).rejects.toMatchObject({ failure: { code: 'continuity_required' } });
  });
  it('serializes attempts, cancellation waits for terminal and natural success survives cancel', async () => {
    const data = input(material()),
      session = await open(data),
      record = new Recorder(session),
      first = command(data.config, 'hang');
    await session.submit(first);
    await expect(session.submit(command(data.config, 'normal', 2))).rejects.toThrow(
      'already active',
    );
    expect(await session.cancel(first.attempt, 'user')).toMatchObject({ disposition: 'requested' });
    expect(record.events.filter((e) => e.payload.kind === 'terminal')).toHaveLength(0);
    await record.terminal();
    expect(record.events.filter((e) => e.payload.kind === 'tool').at(-1)?.payload).toMatchObject({
      tool: { state: 'unresolved' },
    });
    expect(record.events.at(-1)?.payload).toMatchObject({ outcome: 'interrupted' });
    const next = command(data.config, 'cancel-success', 2);
    await session.submit(next);
    await session.cancel(next.attempt, 'user');
    await record.terminal(2);
    expect(record.events.at(-1)?.payload).toMatchObject({ outcome: 'completed' });
    await expect(session.submit(first)).rejects.toThrow('already dispatched');
  });
  it('defers cancellation before native acceptance and rejects retired-turn events during a successor', async () => {
    const data = input(material()),
      session = await open(data),
      record = new Recorder(session);
    const early = command(data.config, 'hang');
    const dispatch = session.submit(early);
    expect(await session.cancel(early.attempt, 'user')).toMatchObject({
      disposition: 'requested',
      nativeTurnId: null,
    });
    await dispatch;
    await record.terminal();
    expect(record.events.find((e) => e.payload.kind === 'terminal')?.payload).toMatchObject({
      outcome: 'interrupted',
    });
    await session.submit(command(data.config, 'normal', 2));
    await record.terminal(2);
    const next = command(data.config, 'hang', 3);
    await session.submit(next);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(record.events.filter((e) => e.payload.kind === 'terminal')).toHaveLength(2);
    expect(record.events.some((e) => e.payload.kind === 'text' && e.payload.text === 'STALE')).toBe(
      false,
    );
    await session.cancel(next.attempt, 'user');
    await record.terminal(3);
  });

  it('preserves partial output and reports one runtime_lost on death/invalid frames/timeouts', async () => {
    for (const text of ['crash', 'bad-frame', 'oversize-frame', 'timeout']) {
      const data = input(material()),
        session = await open(data),
        record = new Recorder(session);
      expect(await session.submit(command(data.config, text))).toMatchObject({
        delivery: 'unknown',
      });
      await record.terminal();
      await record.finished;
      expect(record.events.filter((e) => e.payload.kind === 'terminal')).toHaveLength(1);
      expect(record.events.find((e) => e.payload.kind === 'terminal')?.payload).toMatchObject({
        outcome: 'runtime_lost',
      });
      if (text === 'crash')
        expect(record.events.find((e) => e.payload.kind === 'text')?.payload).toMatchObject({
          text: 'partial',
        });
    }
  });
  it('observes idle exit, closes idempotently, releases only after exit and refuses unpinned protocol', async () => {
    let released = 0;
    const data = input(material({ TM8_FAKE_CODEX_IDLE_EXIT: '1' }), () => {
        released++;
      }),
      session = await open(data),
      record = new Recorder(session);
    await record.until((events) => events.some((e) => e.payload.kind === 'runtime_exit'));
    expect(record.events.find((e) => e.payload.kind === 'runtime_exit')?.attempt).toBeNull();
    await session.close('shutdown');
    await session.close('shutdown');
    expect(released).toBe(1);
    await expect(
      open(input(material({ TM8_FAKE_CODEX_VERSION: 'codex/0.162.0' }))),
    ).rejects.toMatchObject({ failure: { code: 'protocol_mismatch' } });
  });
});
