// The live context reading: how full the session's context was at its newest
// request, and how much of that request was served from cache.
//
// Each assertion pins one way the number could lie:
//   - occupancy is ONE request's input, never the running or summed total
//   - the cache ratio's numerator and denominator come from that same request
//   - an unreported cache part is unknown, not zero
//   - capacity is only ever a provider-reported or runtime-proven figure
//   - compaction and a model change retire the old sample instead of showing it

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectContext,
  encodeClaudeProjectDir,
  modelSwitchedBefore,
  readSessionTranscript,
} from '../src/transcript/read-transcript.js';

const AT = '2026-09-23T10:00:00.000Z';
const LATER = '2026-09-23T10:00:08.000Z';

const claudeUsage = (
  usage: Record<string, unknown>,
  opts: { at?: string; model?: string; sidechain?: boolean } = {},
) => ({
  type: 'assistant',
  timestamp: opts.at ?? AT,
  ...(opts.sidechain ? { isSidechain: true } : {}),
  message: {
    id: 'msg_1',
    role: 'assistant',
    model: opts.model ?? 'claude-opus-5-5',
    content: [{ type: 'text', text: 'hi' }],
    usage,
  },
});

const tokenCount = (
  last: Record<string, unknown> | null,
  opts: { at?: string; window?: number; total?: Record<string, unknown> } = {},
) => ({
  type: 'event_msg',
  timestamp: opts.at ?? AT,
  payload: {
    type: 'token_count',
    info: last === null
      ? null
      : {
          last_token_usage: last,
          total_token_usage: opts.total ?? { input_tokens: 9_999_999, cached_input_tokens: 9_000_000 },
          ...(opts.window !== undefined ? { model_context_window: opts.window } : {}),
        },
  },
});
const turnContext = (model: string) => ({ type: 'turn_context', timestamp: AT, payload: { model } });

describe('collectContext — claude', () => {
  it('reads the newest request as input + cache read + cache creation', () => {
    const ctx = collectContext(
      [
        claudeUsage({ input_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 }),
        claudeUsage(
          { input_tokens: 2, cache_read_input_tokens: 38_400, cache_creation_input_tokens: 9_598 },
          { at: LATER },
        ),
      ],
      false,
      false,
      null,
    );
    expect(ctx.usedTokens).toBe(48_000);
    expect(ctx.requestInputTokens).toBe(48_000);
    expect(ctx.cacheReadTokens).toBe(38_400);
    expect(ctx.observedAt).toBe(LATER);
    expect(ctx.model).toBe('claude-opus-5-5');
    expect(ctx.source).toBe('claude_request_usage');
    expect(ctx.unavailableReason).toBeNull();
  });

  it('does not sum the repeated usage of one streamed message', () => {
    const usage = { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 };
    const ctx = collectContext([claudeUsage(usage), claudeUsage(usage), claudeUsage(usage)], false, false);
    expect(ctx.usedTokens).toBe(1012);
  });

  it('proves 1M capacity only from a [1m] launch of the same base model', () => {
    const lines = [claudeUsage({ input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })];
    const onem = collectContext(lines, false, false, 'claude-opus-5-5[1m]');
    expect(onem.capacityTokens).toBe(1_000_000);
    expect(onem.capacitySource).toBe('runtime');

    expect(collectContext(lines, false, false, 'claude-opus-5-5').capacityTokens).toBeNull();
    expect(collectContext(lines, false, false, 'claude-sonnet-5[1m]').capacityTokens).toBeNull();
    expect(collectContext(lines, false, false, null).capacitySource).toBeNull();
  });

  it('keeps a zero cache read as zero', () => {
    const ctx = collectContext(
      [claudeUsage({ input_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })],
      false,
      false,
    );
    expect(ctx.cacheReadTokens).toBe(0);
    expect(ctx.usedTokens).toBe(300);
  });

  it('treats a missing cache part as unknown, never as zero', () => {
    const ctx = collectContext([claudeUsage({ input_tokens: 300 })], false, false);
    expect(ctx.usedTokens).toBeNull();
    expect(ctx.cacheReadTokens).toBeNull();
    expect(ctx.unavailableReason).toBe('incomplete_usage');
  });

  it('ignores sidechain and <synthetic> records', () => {
    const main = claudeUsage({ input_tokens: 1, cache_read_input_tokens: 99, cache_creation_input_tokens: 0 });
    const ctx = collectContext(
      [
        main,
        claudeUsage(
          { input_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          { sidechain: true, at: LATER },
        ),
        claudeUsage(
          { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          { model: '<synthetic>', at: LATER },
        ),
      ],
      false,
      false,
    );
    expect(ctx.usedTokens).toBe(100);
    expect(ctx.observedAt).toBe(AT);
  });

  it('retires the sample at a compact boundary until a new request lands', () => {
    const before = claudeUsage({ input_tokens: 1, cache_read_input_tokens: 900_000, cache_creation_input_tokens: 0 });
    const boundary = { type: 'system', subtype: 'compact_boundary', timestamp: LATER };
    const waiting = collectContext([before, boundary], false, false);
    expect(waiting.usedTokens).toBeNull();
    expect(waiting.unavailableReason).toBe('awaiting_new_sample');

    const after = claudeUsage(
      { input_tokens: 1, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0 },
      { at: LATER },
    );
    expect(collectContext([before, boundary, after], false, false).usedTokens).toBe(20_001);
  });

  it('retires the sample at a /model switch, and stops trusting the [1m] launch after it', () => {
    const usage = { input_tokens: 1, cache_read_input_tokens: 47_999, cache_creation_input_tokens: 0 };
    const switched = {
      type: 'user',
      timestamp: LATER,
      message: { role: 'user', content: '<local-command-stdout>Set model to `Opus 5` and saved</local-command-stdout>' },
    };
    const waiting = collectContext([claudeUsage(usage), switched], false, false, 'claude-opus-5-5[1m]');
    expect(waiting.usedTokens).toBeNull();
    expect(waiting.unavailableReason).toBe('awaiting_new_sample');

    // The plain variant records the same message.model, so only the switch says 200k is no longer 1M.
    const after = collectContext(
      [claudeUsage(usage), switched, claudeUsage(usage, { at: LATER })],
      false,
      false,
      'claude-opus-5-5[1m]',
    );
    expect(after.usedTokens).toBe(48_000);
    expect(after.capacityTokens).toBeNull();

    // A picker opened and cancelled is not a switch.
    const kept = { ...switched, message: { role: 'user', content: '<local-command-stdout>Kept model as `Opus 5`</local-command-stdout>' } };
    expect(collectContext([claudeUsage(usage), kept], false, false, 'claude-opus-5-5[1m]').capacityTokens).toBe(1_000_000);
  });

  it('distinguishes a window that holds no sample from a transcript that never reported one', () => {
    expect(collectContext([], false, true).unavailableReason).toBe('sample_outside_window');
    expect(collectContext([], false, false).unavailableReason).toBe('not_reported');
  });
});

describe('collectContext — codex', () => {
  it('reads last_token_usage, never the cumulative total', () => {
    const ctx = collectContext(
      [
        turnContext('gpt-6-astra'),
        tokenCount({ input_tokens: 48_000, cached_input_tokens: 38_400 }, { window: 200_000, at: LATER }),
      ],
      true,
      false,
    );
    expect(ctx.usedTokens).toBe(48_000);
    expect(ctx.requestInputTokens).toBe(48_000);
    expect(ctx.cacheReadTokens).toBe(38_400);
    expect(ctx.capacityTokens).toBe(200_000);
    expect(ctx.capacitySource).toBe('provider');
    expect(ctx.model).toBe('gpt-6-astra');
    expect(ctx.observedAt).toBe(LATER);
    expect(ctx.source).toBe('codex_request_usage');
  });

  it('keeps the previous sample when a token_count carries only rate limits', () => {
    const ctx = collectContext(
      [tokenCount({ input_tokens: 10, cached_input_tokens: 0 }), tokenCount(null, { at: LATER })],
      true,
      false,
    );
    expect(ctx.usedTokens).toBe(10);
    expect(ctx.observedAt).toBe(AT);
  });

  it('leaves capacity unknown when the provider reports no window', () => {
    const ctx = collectContext([tokenCount({ input_tokens: 10, cached_input_tokens: 0 })], true, false);
    expect(ctx.capacityTokens).toBeNull();
    expect(ctx.capacitySource).toBeNull();
  });

  it('retires the sample on compaction and on a model change', () => {
    const sample = tokenCount({ input_tokens: 10, cached_input_tokens: 5 }, { window: 1000 });
    expect(
      collectContext([turnContext('a'), sample, { type: 'compacted', timestamp: LATER }], true, false)
        .unavailableReason,
    ).toBe('awaiting_new_sample');
    expect(
      collectContext(
        [turnContext('a'), sample, { type: 'event_msg', timestamp: LATER, payload: { type: 'context_compacted' } }],
        true,
        false,
      ).usedTokens,
    ).toBeNull();
    expect(collectContext([turnContext('a'), sample, turnContext('b')], true, false).unavailableReason).toBe(
      'awaiting_new_sample',
    );
    // The same model restated every turn is not a change.
    expect(collectContext([turnContext('a'), sample, turnContext('a')], true, false).usedTokens).toBe(10);
  });
});

describe('readSessionTranscript — context', () => {
  const temps: string[] = [];
  afterEach(async () => {
    while (temps.length > 0) {
      const dir = temps.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
  const CWD = '/Users/x/scratch/ctx';

  it('attaches the tail reading with launch-model capacity, and none when paging back', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tm8-context-'));
    temps.push(home);
    const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(CWD));
    await mkdir(dir, { recursive: true });
    const lines = [
      claudeUsage({ input_tokens: 2, cache_read_input_tokens: 2801, cache_creation_input_tokens: 133_914 }),
    ];
    await writeFile(join(dir, 'native.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
    const base = {
      sessionId: 's1',
      agentTool: 'claude-code' as const,
      nativeSessionId: 'native',
      cwd: CWD,
      home,
      runtimeModel: 'claude-opus-5-5[1m]',
    };

    const page = await readSessionTranscript(base);
    expect(page.context).toMatchObject({
      usedTokens: 136_717,
      capacityTokens: 1_000_000,
      cacheReadTokens: 2801,
      observedAt: AT,
    });

    const older = await readSessionTranscript({ ...base, before: 10 });
    expect(older.context).toBeNull();
  });

  it('keeps distrusting the [1m] launch after the /model record scrolls above the window', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tm8-context-'));
    temps.push(home);
    const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(CWD));
    await mkdir(dir, { recursive: true });
    const usage = { input_tokens: 1, cache_read_input_tokens: 47_999, cache_creation_input_tokens: 0 };
    const switched = {
      type: 'user',
      timestamp: AT,
      message: { role: 'user', content: '<local-command-stdout>Set model to `Opus 5` and saved</local-command-stdout>' },
    };
    // Well past the 256 KiB tail, so the switch is NOT in the window.
    const filler = Array.from({ length: 400 }, () => ({ type: 'user', timestamp: AT, message: { role: 'user', content: 'x'.repeat(1_000) } }));
    const write = (lines: unknown[]) => writeFile(join(dir, 'native.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
    const base = { sessionId: 's1', agentTool: 'claude-code' as const, nativeSessionId: 'native', cwd: CWD, home, runtimeModel: 'claude-opus-5-5[1m]' };

    await write([claudeUsage(usage), switched, ...filler, claudeUsage(usage, { at: LATER })]);
    const page = await readSessionTranscript(base);
    expect(page.windowStart).toBeGreaterThan(0);
    expect(page.context).toMatchObject({ usedTokens: 48_000, capacityTokens: null, capacitySource: null });

    // The same history without the switch still proves 1M.
    const clean = join(home, 'clean');
    const cleanDir = join(clean, '.claude', 'projects', encodeClaudeProjectDir(CWD));
    await mkdir(cleanDir, { recursive: true });
    await writeFile(join(cleanDir, 'native.jsonl'), [claudeUsage(usage), ...filler, claudeUsage(usage, { at: LATER })].map((l) => JSON.stringify(l)).join('\n'));
    expect((await readSessionTranscript({ ...base, home: clean })).context?.capacityTokens).toBe(1_000_000);
  });

  it('scans only what it has not, and still sees a marker split across two scans', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tm8-switch-'));
    temps.push(home);
    const file = join(home, 'grow.jsonl');
    const head = '{"type":"user","message":{"role":"user",';
    const marker = '"content":"<local-command-stdout>Set model to `x`"}}\n';
    await writeFile(file, head + marker);
    const cut = head.length + 12; // inside the marker
    expect(await modelSwitchedBefore(file, cut)).toBe(false);
    expect(await modelSwitchedBefore(file, head.length + marker.length)).toBe(true);
    // A quoted phrase mid-message is not a switch record.
    const quoted = join(home, 'quoted.jsonl');
    await writeFile(quoted, '{"type":"user","message":{"content":"see <local-command-stdout>Set model to"}}\n');
    expect(await modelSwitchedBefore(quoted, 200)).toBe(false);
  });
});
