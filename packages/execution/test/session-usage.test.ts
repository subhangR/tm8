// The exit-time usage reader — each case pins one way the measurement was
// WRONG on real prod files before this existed (2026-09-15, 311 transcripts):
//   - one streamed message is several records with identical usage; summing
//     per record read 2.09x the real numbers
//   - cost-state is a per-PROCESS cumulative snapshot; a resumed session has
//     several, and summing snapshots of one process multiplies
//   - codex reports a running total, newest wins
//   - the cache-write tiers are itemised on some records and absent on others,
//     and "absent" must not read as zero
//   - a missing file is an explained empty, never a throw and never a zero

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeClaudeProjectDir } from '../src/transcript/read-transcript.js';
import { readSessionUsage } from '../src/transcript/session-usage.js';

const temps: string[] = [];

async function makeHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tm8-usage-'));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const CWD = '/Users/x/.local/share/tm8-data/scratch/019fdc4f';

async function writeClaude(home: string, nativeId: string, lines: unknown[]): Promise<string> {
  const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(CWD));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${nativeId}.jsonl`);
  await writeFile(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  return path;
}

async function writeCodex(home: string, name: string, lines: unknown[]): Promise<void> {
  const dir = join(home, '.codex', 'sessions', '2026', '09', '08');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), lines.map((l) => JSON.stringify(l)).join('\n'));
}

const claudeOpts = (home: string, nativeSessionId = 'nat-1') => ({
  sessionId: 'sess-1',
  agentTool: 'claude-code',
  nativeSessionId,
  cwd: CWD,
  home,
});

/** One record of a claude API message. The same `id` across records is one message. */
const assistant = (
  id: string,
  usage: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  content: unknown[] = [{ type: 'text', text: 'hi' }],
) => ({
  type: 'assistant',
  timestamp: '2026-09-15T10:00:00.000Z',
  isSidechain: false,
  ...extra,
  message: { id, role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content, usage, ...(extra.message as object ?? {}) },
});

const user = (text: string) => ({
  type: 'user',
  timestamp: '2026-09-15T09:59:00.000Z',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

describe('readSessionUsage — claude transcript half', () => {
  it('counts a streamed message ONCE — two block records of one message.id are one message', async () => {
    const home = await makeHome();
    const usage = { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 };
    await writeClaude(home, 'nat-1', [
      user('go'),
      // The harness's shape: a tool_use block record, then a text block record,
      // both carrying the SAME cumulative usage under one id.
      assistant('msg_1', usage, {}, [{ type: 'tool_use', name: 'Read', input: {} }]),
      assistant('msg_1', usage),
      assistant('msg_2', { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 1200 }),
    ]);
    const read = await readSessionUsage(claudeOpts(home));
    expect(read.available).toBe(true);
    if (!read.available) return;
    expect(read.source).toBe('claude_transcript');
    const t = read.usage.transcript;
    expect(t.messages).toBe(2);
    expect(t.usageRecords).toBe(3);
    expect(t.turns).toBe(2);
    expect(t.userPrompts).toBe(1);
    expect(t.totals).toMatchObject({
      inputTokens: 4, outputTokens: 50, cacheReadTokens: 2200, cacheCreationTokens: 200, messages: 2,
    });
    expect(t.toolCalls).toBe(1);
    expect(t.tools).toEqual([{ name: 'Read', count: 1 }]);
    expect(t.models).toEqual(['claude-opus-5']);
    expect(t.firstTurnContextTokens).toBe(1203);
    expect(t.lastTurnContextTokens).toBe(1201);
    expect(t.maxContextTokens).toBe(1203);
    expect(t.lastStopReason).toBe('end_turn');
    expect(read.usage.partial).toBe(false);
    expect(read.usage.harness).toBeNull();
  });

  it('the LAST record of a message wins — a later record with larger cumulative usage replaces the earlier', async () => {
    const home = await makeHome();
    await writeClaude(home, 'nat-1', [
      assistant('msg_1', { input_tokens: 1, output_tokens: 5, cache_read_input_tokens: 100 }),
      assistant('msg_1', { input_tokens: 1, output_tokens: 50, cache_read_input_tokens: 100 }),
    ]);
    const read = await readSessionUsage(claudeOpts(home));
    if (!read.available) throw new Error('expected a read');
    expect(read.usage.transcript.totals.outputTokens).toBe(50);
  });

  it('splits tokens by model and by cache-write tier; an un-itemised record leaves the tiers null', async () => {
    const home = await makeHome();
    await writeClaude(home, 'nat-1', [
      assistant('msg_a', {
        input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 300,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 300 },
      }),
      assistant('msg_b', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10 },
        { message: { model: 'claude-haiku-4-5-20251001' } }),
    ]);
    const read = await readSessionUsage(claudeOpts(home));
    if (!read.available) throw new Error('expected a read');
    const t = read.usage.transcript;
    expect(t.models).toEqual(['claude-opus-5', 'claude-haiku-4-5-20251001']);
    expect(t.byModel['claude-opus-5']).toMatchObject({
      cacheCreationTokens: 300, cacheCreation5mTokens: 0, cacheCreation1hTokens: 300, messages: 1,
    });
    // The haiku record carried no `cache_creation` block: null, not 0 — the
    // tier was never itemised, which is a different claim from "zero".
    expect(t.byModel['claude-haiku-4-5-20251001']).toMatchObject({
      cacheReadTokens: 10, cacheCreation5mTokens: null, cacheCreation1hTokens: null, messages: 1,
    });
    // Totals itemise what WAS itemised.
    expect(t.totals.cacheCreation1hTokens).toBe(300);
    expect(t.totals.cacheCreation5mTokens).toBe(0);
  });

  it('counts sidechain traffic in tokens but not in turns, stop_reason or first/last context', async () => {
    const home = await makeHome();
    await writeClaude(home, 'nat-1', [
      assistant('main_1', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 100 },
        { message: { stop_reason: 'tool_use' } }),
      assistant('side_1', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 9000 },
        { isSidechain: true, message: { stop_reason: 'end_turn' } }),
    ]);
    const read = await readSessionUsage(claudeOpts(home));
    if (!read.available) throw new Error('expected a read');
    const t = read.usage.transcript;
    expect(t.messages).toBe(2);
    expect(t.turns).toBe(1);
    expect(t.sidechainMessages).toBe(1);
    expect(t.totals.cacheReadTokens).toBe(9100);
    expect(t.lastStopReason).toBe('tool_use');
    expect(t.lastTurnContextTokens).toBe(101);
    // maxContextTokens is the largest prefix ANY message carried — spend, not thread.
    expect(t.maxContextTokens).toBe(9001);
  });

  it('counts compactions from isCompactSummary and keeps the boundary metadata beside them', async () => {
    const home = await makeHome();
    await writeClaude(home, 'nat-1', [
      assistant('m1', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 218_000 }),
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 218_979, postTokens: 9_334 } },
      { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued…' } },
      assistant('m2', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 9_400 }),
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 50_000, postTokens: 8_000 } },
      { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Summary…' } },
      assistant('m3', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 8_100 }),
    ]);
    const read = await readSessionUsage(claudeOpts(home));
    if (!read.available) throw new Error('expected a read');
    const t = read.usage.transcript;
    expect(t.compactions).toBe(2);
    expect(t.compactBoundaries).toEqual({ auto: 1, manual: 1, maxPreTokens: 218_979 });
    // The compaction summary is re-injected as a "user" turn; it is not a prompt.
    expect(t.userPrompts).toBe(0);
    expect(t.turns).toBe(3);
  });

  it('keeps a trailing API error as ending-state evidence, and drops one the session recovered from', async () => {
    const home = await makeHome();
    const apiError = (text: string) => ({
      type: 'assistant',
      isApiErrorMessage: true,
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
    });
    await writeClaude(home, 'nat-1', [
      apiError('API Error: 529 Overloaded'),
      assistant('m1', { input_tokens: 1, output_tokens: 1 }),
    ]);
    const recovered = await readSessionUsage(claudeOpts(home));
    if (!recovered.available) throw new Error('expected a read');
    expect(recovered.usage.transcript.lastApiError).toBeNull();
    expect(recovered.usage.transcript.models).toEqual(['claude-opus-5']);

    await writeClaude(home, 'nat-2', [
      assistant('m1', { input_tokens: 1, output_tokens: 1 }),
      apiError("You've hit your session limit · resets 11:10pm (UTC)"),
    ]);
    const ended = await readSessionUsage(claudeOpts(home, 'nat-2'));
    if (!ended.available) throw new Error('expected a read');
    expect(ended.usage.transcript.lastApiError).toBe("You've hit your session limit · resets 11:10pm (UTC)");
  });
});

describe('readSessionUsage — the harness half (cost-state)', () => {
  const costState = (startTime: number, totalCostUSD: number, cacheRead: number) => ({
    type: 'cost-state',
    startTime,
    totalCostUSD,
    hasUnknownModelCost: false,
    modelUsage: {
      'claude-opus-5[1m]': {
        inputTokens: 100, outputTokens: 50, thinkingTokens: 5,
        cacheReadInputTokens: cacheRead, cacheCreationInputTokens: 10, webSearchRequests: 0, costUSD: totalCostUSD,
      },
    },
  });

  it('takes the LAST snapshot per process and SUMS across processes', async () => {
    const home = await makeHome();
    await writeClaude(home, 'nat-1', [
      assistant('m1', { input_tokens: 1, output_tokens: 1 }),
      // Process A wrote two cumulative snapshots: the second supersedes the first.
      costState(1_000, 1.0, 1_000),
      costState(1_000, 2.5, 3_000),
      // Process B (a resume) restarted its snapshot: it ADDS.
      costState(2_000, 0.5, 400),
    ]);
    const read = await readSessionUsage(claudeOpts(home));
    if (!read.available) throw new Error('expected a read');
    const h = read.usage.harness;
    expect(h).not.toBeNull();
    expect(h?.costSource).toBe('claude_cost_state');
    expect(h?.processes).toBe(2);
    expect(h?.costUsd).toBeCloseTo(3.0, 6);
    expect(h?.totals.cacheReadTokens).toBe(3_400);
    expect(h?.byModel['claude-opus-5[1m]']?.costUsd).toBeCloseTo(3.0, 6);
    expect(h?.hasUnknownModelCost).toBe(false);
  });

  it('is null when the file carries no cost-state — and no USD is ever computed in its place', async () => {
    const home = await makeHome();
    await writeClaude(home, 'nat-1', [
      assistant('m1', { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    ]);
    const read = await readSessionUsage(claudeOpts(home));
    if (!read.available) throw new Error('expected a read');
    expect(read.usage.harness).toBeNull();
    expect(JSON.stringify(read.usage)).not.toMatch(/costUsd":[0-9]/);
  });
});

describe('readSessionUsage — codex rollout', () => {
  const tokenCount = (total: Record<string, number>, last: Record<string, number>) => ({
    type: 'event_msg',
    timestamp: '2026-09-08T05:19:11.025Z',
    payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 258_400 } },
  });

  it('newest running total wins; the last turn, the window and compactions are recorded', async () => {
    const home = await makeHome();
    await writeCodex(home, 'rollout-2026-09-08T05-18-51-abc.jsonl', [
      { type: 'session_meta', payload: { id: 'abc', cwd: CWD, timestamp: '2026-09-08T05:18:51.475Z' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<tm8_session_id>sess-1</tm8_session_id>' }] } },
      { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
      tokenCount({ input_tokens: 17_184, cached_input_tokens: 11_264, cache_write_input_tokens: 0, output_tokens: 272 },
        { input_tokens: 17_184, cached_input_tokens: 11_264, cache_write_input_tokens: 0, output_tokens: 272, total_tokens: 17_456 }),
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } },
      { type: 'event_msg', payload: { type: 'context_compacted' } },
      { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
      tokenCount({ input_tokens: 15_892_401, cached_input_tokens: 15_322_112, cache_write_input_tokens: 0, output_tokens: 36_235 },
        { input_tokens: 57_569, cached_input_tokens: 48_000, cache_write_input_tokens: 0, output_tokens: 112, total_tokens: 57_681 }),
    ]);
    const read = await readSessionUsage({ sessionId: 'sess-1', agentTool: 'codex', nativeSessionId: null, cwd: CWD, home });
    expect(read.available).toBe(true);
    if (!read.available) return;
    expect(read.source).toBe('codex_rollout');
    const t = read.usage.transcript;
    expect(t.totals).toMatchObject({
      inputTokens: 15_892_401, cacheReadTokens: 15_322_112, outputTokens: 36_235,
      cacheCreation5mTokens: null, cacheCreation1hTokens: null,
    });
    expect(t.turns).toBe(2);
    expect(t.messages).toBe(1);
    expect(t.toolCalls).toBe(1);
    expect(t.models).toEqual(['gpt-5.6-sol']);
    expect(t.compactions).toBe(1);
    expect(t.contextWindow).toBe(258_400);
    expect(t.lastTurnContextTokens).toBe(57_681);
    expect(t.byModel).toEqual({});
    expect(read.usage.harness).toBeNull();
  });
});

describe('readSessionUsage — honesty at the edges', () => {
  it('a missing file is an explained empty, never a throw', async () => {
    const home = await makeHome();
    const read = await readSessionUsage(claudeOpts(home, 'never-written'));
    expect(read).toMatchObject({ available: false, reason: 'no_transcript_file' });
    if (read.available) return;
    expect(read.searchedPaths.length).toBeGreaterThan(0);
  });

  it('no native id, and an unsupported tool, are named rather than guessed', async () => {
    const home = await makeHome();
    expect(await readSessionUsage({ ...claudeOpts(home), nativeSessionId: null }))
      .toMatchObject({ available: false, reason: 'no_native_session_id' });
    expect(await readSessionUsage({ ...claudeOpts(home), agentTool: 'gemini' }))
      .toMatchObject({ available: false, reason: 'unsupported_agent_tool' });
  });

  it('reads the WHOLE file — a 5 MiB single record past any tail window still counts, and a torn last line is only malformed', async () => {
    const home = await makeHome();
    const big = 'x'.repeat(5 * 1024 * 1024);
    const path = await writeClaude(home, 'nat-1', [
      assistant('m1', { input_tokens: 7, output_tokens: 1 }, {}, [{ type: 'text', text: big }]),
      assistant('m2', { input_tokens: 1, output_tokens: 1 }),
      '{"type":"assistant","message":{"id":"torn","usage":{"input_tokens":999',
    ]);
    const read = await readSessionUsage(claudeOpts(home));
    if (!read.available) throw new Error('expected a read');
    expect(read.usage.transcriptPath).toBe(path);
    expect(read.usage.transcript.messages).toBe(2);
    expect(read.usage.transcript.totals.inputTokens).toBe(8);
    expect(read.usage.malformedLines).toBe(1);
    expect(read.usage.transcriptBytes).toBeGreaterThan(5 * 1024 * 1024);
  });
});
