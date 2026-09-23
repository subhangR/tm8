// WHY A SESSION ENDED, in a form a human can read (171).
//
// The incident this exists for: 2026-08-22 11:04:16 UTC, a deploy SIGKILLed
// the server with four live agents and all four were recorded as ordinary
// exits. PR #510 made the STATUS honest. This suite pins the REASON — and,
// more importantly, pins that the reasons are produced from DIFFERENT evidence
// on each path. A single reason string applied everywhere would read like an
// improvement and discriminate nothing, which is the failure mode to guard.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { oomKillObserved, readOomKillCount } from '../src/spawn/oom-witness.js';
import { encodeClaudeProjectDir } from '../src/transcript/read-transcript.js';
import type { WorkSessionResumeInfo } from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const AUTH = { identityId: 'id-owner', nodeAdmin: true };
const NODE = '127.0.0.1:4620';

const endingFor = (graph: FakeGraph, sessionId: string) => {
  const t = graph.transitions.filter((x) => x.sessionId === sessionId).at(-1);
  return { kind: t?.endedKind ?? null, reason: t?.endedReason ?? null, status: t?.status ?? null };
};

/**
 * The reason is read by someone who is not a developer. These are the words
 * that would make it useless to them, and every one of them has a rightful
 * home in `error` instead — which is why this asserts on the reason only.
 */
const JARGON = [
  'SIGKILL', 'SIGTERM', 'SIGHUP', 'sigkill', 'signal', 'exit code', 'exitCode',
  'PTY', 'pty', 'cgroup', 'errno', 'stack', 'null', 'undefined', 'node-pty',
];
const expectPlainEnglish = (reason: string | null): void => {
  expect(reason, 'a terminal ending must carry a sentence').toBeTruthy();
  const text = reason as string;
  for (const word of JARGON) expect(text, `leaked jargon: ${word}`).not.toContain(word);
  // A sentence, not a token: starts with a capital and ends with a full stop.
  expect(text).toMatch(/^[A-Z].*\.$/s);
};

describe('a session records why it ended', () => {
  let graph: FakeGraph;
  let pty: PtyHostService;
  let service: SpawnService;

  beforeEach(() => {
    graph = new FakeGraph({ workingDir: '/tmp' });
    pty = new PtyHostService({ logger: quiet });
    service = new SpawnService({
      graph, pty, baseUrl: 'http://127.0.0.1:4620', nodeId: NODE, logger: quiet,
    });
  });
  afterEach(() => pty.shutdownAll());

  // --- the shutdown sweep: the reason is OBSERVED, not inferred -------------

  it('annotates every live session from inside the dying process', async () => {
    pty.spawn({ sessionId: 'a', command: 'sleep 30', cwd: '/tmp', env: {} });
    pty.spawn({ sessionId: 'b', command: 'sleep 30', cwd: '/tmp', env: {} });

    expect(await service.recordShutdown(AUTH, 'SIGTERM')).toBe(2);

    for (const id of ['a', 'b']) {
      const { kind, reason, status } = endingFor(graph, id);
      expect(kind).toBe('server_restart');
      expect(status).toBe('failed');
      expectPlainEnglish(reason);
      // It must say the session itself was fine, because it was — this is the
      // difference between "your agent crashed" and "we restarted the server",
      // and only one of those should make somebody go looking for a bug.
      expect(reason).toContain('resumed');
    }
  });

  it('is a no-op with nothing live, and never throws when the graph refuses', async () => {
    expect(await service.recordShutdown(AUTH, 'SIGTERM')).toBe(0);
    expect(graph.transitions).toHaveLength(0);

    pty.spawn({ sessionId: 'doomed', command: 'sleep 30', cwd: '/tmp', env: {} });
    graph.failTransitionFor.add('doomed');
    // A shutdown that throws because bookkeeping failed is strictly worse than
    // one that exits having recorded less — the process is going away anyway.
    await expect(service.recordShutdown(AUTH, 'SIGTERM')).resolves.toBe(0);
  });

  // --- the ghost path: the backstop, for when no handler ran ---------------

  it('names a restart when the kernel did NOT kill anything for memory', async () => {
    // The negative OOM reading is unambiguous even though the counter is
    // per-cgroup: nothing was OOM-killed, so this was not a memory problem.
    // (This node's counter is 0 — asserted below so the test states its own
    // precondition rather than depending on an unstated environment.)
    expect(await readOomKillCount()).toBe(0);

    graph.nodeActiveSessions = [{ sessionId: 'ghost', status: 'running' }];
    await service.reconcileNodeGhosts(AUTH);

    const { kind, reason, status } = endingFor(graph, 'ghost');
    expect(kind).toBe('server_restart');
    expect(status).toBe('failed');
    expectPlainEnglish(reason);
    expect(reason).not.toContain('memory');
  });

  // --- the two halves are not the same sentence ----------------------------

  it('says something DIFFERENT on each path, from different evidence', async () => {
    pty.spawn({ sessionId: 'live', command: 'sleep 30', cwd: '/tmp', env: {} });
    await service.recordShutdown(AUTH, 'SIGTERM');
    const observed = endingFor(graph, 'live').reason;

    graph.nodeActiveSessions = [{ sessionId: 'ghost', status: 'running' }];
    await service.reconcileNodeGhosts(AUTH);
    const inferred = endingFor(graph, 'ghost').reason;

    await service.terminate(AUTH, 'cancelled');
    const asked = endingFor(graph, 'cancelled');

    // An operator cancelling is an ordinary end, and must NOT be dressed up as
    // a failure — otherwise every terminal row is 'failed' and the signal that
    // PR #510 added is worth nothing.
    expect(asked.status).toBe('exited');
    expect(asked.kind).toBe('stopped_by_operator');
    expectPlainEnglish(asked.reason);

    // Three endings, three sentences. If any two collapse together, a reader
    // cannot tell the situations apart — which is the whole defect.
    expect(new Set([observed, inferred, asked.reason]).size).toBe(3);
  });
});

/**
 * THE USAGE INSTRUMENT RIDES BEHIND THE ENDING (185).
 *
 * Every exit path records the ending FIRST and then reads the transcript,
 * best-effort. These pin the three things that make it safe to have added:
 * it lands after the transition (never before, never instead), a transcript
 * that cannot be read leaves the ending exactly as it was, and a stalled
 * read cannot hold the shutdown sweep hostage.
 */
describe('a session records what it cost, after it records why it ended', () => {
  let graph: FakeGraph;
  let pty: PtyHostService;
  let home: string;
  let dataDir: string;

  const CWD = '/srv/checkout';
  const resumeInfo = (sessionId: string, overrides: Partial<WorkSessionResumeInfo> = {}): WorkSessionResumeInfo => ({
    sessionId,
    spaceId: 'space-1',
    parentSessionId: null,
    teamMemberId: 'tm-1',
    projectId: 'proj-1',
    taskIds: [],
    workdirMode: 'project',
    workdirPath: CWD,
    mode: 'worker',
    model: 'opus',
    agentTool: 'claude-code',
    title: 'A run',
    status: 'running',
    nativeSessionId: 'nat-1',
    agentConfigDir: null,
    ...overrides,
  });

  async function writeTranscript(nativeId: string): Promise<void> {
    const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(CWD));
    await mkdir(dir, { recursive: true });
    const usage = { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 1000 };
    const rec = (id: string) => JSON.stringify({
      type: 'assistant',
      message: { id, role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [], usage },
    });
    // Two records, one message: the instrument must count it once.
    await writeFile(join(dir, `${nativeId}.jsonl`), [rec('msg_1'), rec('msg_1')].join('\n'));
  }

  function service(): SpawnService {
    return new SpawnService({
      graph, pty, baseUrl: 'http://127.0.0.1:4620', nodeId: NODE, logger: quiet, dataDir,
      env: { HOME: home },
    });
  }

  beforeEach(async () => {
    graph = new FakeGraph({ workingDir: '/tmp' });
    pty = new PtyHostService({ logger: quiet });
    home = await mkdtemp(join(tmpdir(), 'tm8-usage-home-'));
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-usage-data-'));
  });
  afterEach(async () => {
    pty.shutdownAll();
    await rm(home, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it('terminate() records the de-duplicated usage AFTER the ending is on record', async () => {
    graph.resumeInfo = resumeInfo('cancelled');
    await writeTranscript('nat-1');

    await service().terminate(AUTH, 'cancelled');

    expect(endingFor(graph, 'cancelled').kind).toBe('stopped_by_operator');
    expect(graph.usageRecords).toHaveLength(1);
    const rec = graph.usageRecords[0]!;
    expect(rec.sessionId).toBe('cancelled');
    expect(rec.source).toBe('claude_transcript');
    // After, not before: the transition was already there when this wrote.
    expect(rec.afterTransitions).toBe(1);
    expect(rec.usage.transcript.messages).toBe(1);
    expect(rec.usage.transcript.totals.outputTokens).toBe(40);
    expect(rec.usage.harness).toBeNull();
  });

  it('the exit sink records it too, on a natural exit with the spawner claims', async () => {
    // handlePtyExit needs claims captured at spawn; `recordShutdown` and the
    // ghost path cover the other two writers. This one goes through the sink
    // the way createExecutionPtyHost wires it, with the fake graph answering
    // the row facts a real spawn would have written.
    graph.resumeInfo = resumeInfo('natural', { workdirMode: 'scratch', workdirPath: null });
    const scratchCwd = join(dataDir, 'scratch', 'natural');
    const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(scratchCwd));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'nat-1.jsonl'), JSON.stringify({
      type: 'assistant',
      message: { id: 'm', role: 'assistant', model: 'claude-opus-5', content: [], usage: { input_tokens: 1, output_tokens: 2 } },
    }));
    const svc = service();
    // The claims a spawn would have captured, without a spawn: the sink is
    // keyed on them and refuses to write without them (see handlePtyExit).
    (svc as unknown as { sessionAuth: Map<string, unknown> }).sessionAuth.set('natural', AUTH);

    await svc.handlePtyExit('natural', 'completed', { exitCode: 0, signal: null });

    expect(endingFor(graph, 'natural')).toMatchObject({ kind: 'completed', status: 'exited' });
    expect(graph.usageRecords).toHaveLength(1);
    expect(graph.usageRecords[0]?.afterTransitions).toBe(1);
    // The scratch cwd is re-derived from the data dir, exactly as execution.transcript does.
    expect(graph.usageRecords[0]?.usage.transcriptPath).toBe(join(dir, 'nat-1.jsonl'));
  });

  it('a session with no readable transcript keeps its ending and records NO usage — never a zero', async () => {
    graph.resumeInfo = resumeInfo('blind', { nativeSessionId: null });
    await service().terminate(AUTH, 'blind');
    expect(endingFor(graph, 'blind').kind).toBe('stopped_by_operator');
    expect(graph.usageRecords).toHaveLength(0);
  });

  it('a graph that refuses the usage write leaves the ending intact and does not throw', async () => {
    graph.resumeInfo = resumeInfo('refused');
    await writeTranscript('nat-1');
    graph.usageError = new Error('42501 injected');
    await expect(service().terminate(AUTH, 'refused')).resolves.toMatchObject({ outcome: 'not_found' });
    expect(endingFor(graph, 'refused').kind).toBe('stopped_by_operator');
    expect(graph.usageRecords).toHaveLength(0);
  });

  it('the shutdown sweep is still bounded when the usage read stalls', async () => {
    pty.spawn({ sessionId: 'stalled', command: 'sleep 30', cwd: '/tmp', env: {} });
    graph.resumeLookupHangs = true;
    const started = Date.now();
    expect(await service().recordShutdown(AUTH, 'SIGTERM')).toBe(1);
    // Two seconds per session is the bound; well under the process's own
    // shutdown window, and the ending was recorded before the read began.
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(endingFor(graph, 'stalled').kind).toBe('server_restart');
    expect(graph.usageRecords).toHaveLength(0);
  }, 10_000);
});

describe('OOM is kernel evidence, never a guess', () => {
  it('reads the real counter, and treats absence as absence', async () => {
    // A live read against this machine's own cgroup. Number or null — never a
    // throw, because an unreadable counter must degrade to "no evidence".
    const n = await readOomKillCount();
    expect(n === null || Number.isInteger(n)).toBe(true);
  });

  it('only an ADVANCE is a positive', () => {
    expect(oomKillObserved(0, 1)).toBe(true);
    expect(oomKillObserved(4, 9)).toBe(true);
    // Equal: nothing was killed in the window.
    expect(oomKillObserved(2, 2)).toBe(false);
    // Unreadable at either end is NO EVIDENCE, and must never read as a
    // positive — that would launder a deploy kill into an infrastructure fact.
    expect(oomKillObserved(null, 5)).toBe(false);
    expect(oomKillObserved(5, null)).toBe(false);
    expect(oomKillObserved(null, null)).toBe(false);
    // The counter is monotonic; a decrease means the cgroup was recreated
    // underneath us, which is not evidence of anything.
    expect(oomKillObserved(9, 4)).toBe(false);
  });

  it('cannot be read from a path that is not a cgroup v2 line', async () => {
    expect(await readOomKillCount('/dev/null')).toBeNull();
    expect(await readOomKillCount('/nonexistent/cgroup')).toBeNull();
  });
});
