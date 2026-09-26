import { describe, expect, it } from 'vitest';
import type { SessionTranscriptContext, SessionTranscriptPage } from '@tm8/contract';
import { formatContext, readContext } from './context-reading';
import type { TailSnapshot } from './tail-resource';

const NOW = Date.parse('2026-09-25T10:00:08.000Z');

function sample(over: Partial<SessionTranscriptContext> = {}): SessionTranscriptContext {
  return {
    usedTokens: 48_000,
    capacityTokens: 200_000,
    cacheReadTokens: 38_400,
    requestInputTokens: 48_000,
    model: 'claude-opus-5-5',
    observedAt: '2026-09-25T10:00:00.000Z',
    source: 'claude_request_usage',
    capacitySource: 'provider',
    unavailableReason: null,
    ...over,
  };
}

function snap(context: SessionTranscriptContext | null, error: string | null = null): TailSnapshot {
  const page = { available: true, context } as unknown as SessionTranscriptPage;
  return { page, error, errorAt: error === null ? null : NOW, receivedAt: NOW };
}

describe('formatContext — one reading, no transcript', () => {
  it('says a measured reading in the strip\'s words', () => {
    const reading = formatContext(sample(), NOW);
    expect(reading).toMatchObject({
      tone: 'ok',
      used: '48k',
      percent: '24%',
      cache: '80%',
      age: '8s ago',
      lastKnown: false,
    });
    expect(reading.details).toContainEqual({ term: 'Capacity', value: '200,000 tokens (reported by provider)' });
  });

  it('marks a reading nothing is updating as last known, with why', () => {
    const reading = formatContext(sample(), NOW, { stale: 'the runtime is stopped' });
    expect(reading.lastKnown).toBe(true);
    expect(reading.label).toMatch(/^Last known: Context 48,000 tokens/);
    expect(reading.details).toContainEqual({ term: 'Status', value: 'last known — the runtime is stopped' });
  });

  it('never calls a count that was not reported last known, or zero', () => {
    const cleared = formatContext(
      sample({ usedTokens: null, cacheReadTokens: null, requestInputTokens: null, unavailableReason: 'awaiting_new_sample' }),
      NOW,
      { stale: 'the runtime is stopped' },
    );
    expect(cleared).toMatchObject({ tone: 'unknown', used: '—', lastKnown: false, percent: null });
    expect(cleared.label).toContain('compacted');

    expect(formatContext(null, NOW)).toMatchObject({ tone: 'unknown', used: '—' });
    expect(formatContext(null, NOW, { missing: 'no reading yet' }).label).toBe('Context unknown: no reading yet');
  });

  it('shows no percentage without a capacity', () => {
    expect(formatContext(sample({ capacityTokens: null, capacitySource: null }), NOW)).toMatchObject({
      used: '48k',
      percent: null,
    });
  });

  it('turns delayed, with the detail, when an update is late', () => {
    const delay = { term: 'Update', value: 'delayed — offline' };
    const reading = formatContext(sample(), NOW, { delay });
    expect(reading.tone).toBe('delayed');
    expect(reading.details.at(-1)).toEqual(delay);
  });
});

describe('readContext — the strip is formatContext over the tail read', () => {
  it('agrees with formatContext for a page reading', () => {
    const current = sample();
    expect(readContext(snap(current), null, NOW)).toEqual(formatContext(current, NOW));
  });

  it('falls back to the previous sample for a window that holds none, as last known', () => {
    const reading = readContext(
      snap(sample({ usedTokens: null, unavailableReason: 'sample_outside_window' })),
      sample({ usedTokens: 30_000 }),
      NOW,
    );
    expect(reading).toMatchObject({ used: '30k', lastKnown: true });
    expect(reading.details).toContainEqual({
      term: 'Status',
      value: 'last known — the newest transcript window holds no request usage',
    });
  });

  it('keeps its own loading and failure words before any page lands', () => {
    const empty = { page: null, error: null, errorAt: null, receivedAt: null };
    expect(readContext(empty, null, NOW)).toMatchObject({ tone: 'loading', used: '…' });
    expect(readContext({ ...empty, error: 'boom', errorAt: NOW }, null, NOW).label).toBe(
      'Context unknown: transcript read failed — boom',
    );
  });

  it('carries a failed poll as a delayed reading', () => {
    const reading = readContext(snap(sample(), 'offline'), null, NOW);
    expect(reading.tone).toBe('delayed');
    expect(reading.details.at(-1)?.value).toMatch(/^delayed — offline/);
  });
});
