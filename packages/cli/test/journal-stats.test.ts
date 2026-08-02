/**
 * The journal arithmetic (F8) — the numbers the spend line and the standalone
 * report both print. One module computes them (`src/journal-stats.ts`)
 * precisely so these tests pin BOTH consumers at once.
 */
import { describe, expect, it } from 'vitest';
import {
  classOf,
  computeStats,
  formatSpend,
  parseJournalText,
  resolveJournalClass,
  sessionSpend,
  type StatsRecord,
} from '../src/journal-stats.js';

const S1 = '019fbbcd-cef8-7701-ae98-3d5f1d459ed8';
const S2 = '019fbbcd-cef8-7701-ae98-3d5f1d459ed9';

function rec(over: Partial<StatsRecord> & { argv?: string[] }): StatsRecord {
  const { argv, ...rest } = over;
  return {
    sessionId: S1,
    startedAt: '2026-08-02T10:00:00.000Z',
    command: { path: ['entity', 'get'], argv: argv ?? ['entity', 'get', 'x'], cwd: '/work' },
    calls: [],
    result: { exitCode: 0 },
    tokens: { agentToCli: 5, cliToAgent: 100 },
    ...rest,
  };
}

describe('class resolution precedence', () => {
  it('explicit env wins; an invalid value falls through', () => {
    expect(resolveJournalClass({ TM8_JOURNAL_CLASS: 'human' }, [], '/work')).toBe('human');
    expect(resolveJournalClass({ TM8_JOURNAL_CLASS: 'robot' }, [], '/work')).toBe('agent');
  });

  it('ephemeral port → harness; stable port → agent; unparseable proves nothing', () => {
    expect(resolveJournalClass({}, [{ baseUrl: 'http://127.0.0.1:53211' }], '/work')).toBe('harness');
    expect(resolveJournalClass({}, [{ baseUrl: 'http://127.0.0.1:7777' }], '/work')).toBe('agent');
    expect(resolveJournalClass({}, [{ baseUrl: 'not a url' }], '/work')).toBe('agent');
  });

  it('a repo-test cwd is harness even with no calls', () => {
    expect(resolveJournalClass({}, [], '/repo/packages/cli')).toBe('harness');
    expect(resolveJournalClass({}, [], '/somewhere/else')).toBe('agent');
  });

  it('classOf: a written class is the answer; a legacy record gets the heuristics', () => {
    expect(classOf(rec({ class: 'harness' }))).toBe('harness');
    expect(classOf(rec({ calls: [{ baseUrl: 'http://127.0.0.1:53211' }] }))).toBe('harness');
    expect(classOf(rec({}))).toBe('agent');
  });
});

describe('parsing counts what it drops', () => {
  it('malformed lines are counted, never silently skipped', () => {
    const text = `${JSON.stringify(rec({}))}\nnot json\n{"sessionId":42}\n\n`;
    const { records, malformed } = parseJournalText(text);
    expect(records).toHaveLength(1);
    expect(malformed).toBe(2); // the blank line is a blank line, not a record
  });
});

describe('stats arithmetic', () => {
  it('re-fetch share: second and later identical argv in one session, cli→agent tokens', () => {
    const stats = computeStats([
      rec({}), // first fetch — honest
      rec({}), // byte-identical re-fetch
      rec({}), // and again
      rec({ argv: ['entity', 'get', 'y'] }), // different argv — not a re-fetch
      rec({ sessionId: S2 }), // same argv, DIFFERENT session — not a re-fetch
    ]);
    expect(stats.refetch.records).toBe(2);
    expect(stats.refetch.estTokens).toBe(200);
    expect(stats.refetch.share).toBeCloseTo(200 / 500);
  });

  it('per-command rows aggregate count, tokens, and failure rate', () => {
    const stats = computeStats([
      rec({}),
      rec({ result: { exitCode: 4 } }),
      rec({ command: { path: ['message', 'list'], argv: ['message', 'list'], cwd: '' } }),
      rec({ command: { path: [], argv: ['garbage'], cwd: '' } }),
    ]);
    const get = stats.perCommand.find((c) => c.command === 'entity get')!;
    expect(get.count).toBe(2);
    expect(get.failed).toBe(1);
    expect(get.failureRate).toBeCloseTo(0.5);
    expect(stats.perCommand.map((c) => c.command)).toContain('(unparsed)');
  });

  it('top-N is ordered by est tokens and bounded', () => {
    const stats = computeStats(
      [
        rec({ tokens: { agentToCli: 0, cliToAgent: 10 } }),
        rec({ tokens: { agentToCli: 0, cliToAgent: 999 } }),
        rec({ tokens: { agentToCli: 0, cliToAgent: 50 } }),
      ],
      { topN: 2 },
    );
    expect(stats.topExpensive.map((t) => t.estTokens)).toEqual([999, 50]);
  });

  it('poll-loop signatures: same argv ≥5× in one session, with the mean gap', () => {
    const everyMinute = Array.from({ length: 5 }, (_, i) =>
      rec({ startedAt: `2026-08-02T10:0${i}:00.000Z`, argv: ['event', 'list'] }),
    );
    const stats = computeStats([...everyMinute, rec({ argv: ['entity', 'get', 'once'] })]);
    expect(stats.pollLoops).toHaveLength(1);
    expect(stats.pollLoops[0]!.count).toBe(5);
    expect(stats.pollLoops[0]!.meanGapMs).toBe(60_000);
  });

  it('class filter splits legacy rows by heuristic, and byClass counts the WHOLE corpus', () => {
    const corpus = [
      rec({ class: 'agent' }),
      rec({ calls: [{ baseUrl: 'http://127.0.0.1:53211' }] }), // legacy, heuristic → harness
      rec({ class: 'harness' }),
    ];
    const agents = computeStats(corpus, { classFilter: 'agent' });
    expect(agents.invocations).toBe(1);
    expect(agents.byClass).toEqual({ agent: 1, harness: 2, human: 0 });
  });

  it('an empty corpus divides by nothing', () => {
    const stats = computeStats([]);
    expect(stats.failureRate).toBe(0);
    expect(stats.refetch.share).toBe(0);
  });
});

describe('the spend line numbers', () => {
  it('sessionSpend rounds the re-fetch share to whole percent', () => {
    const { estTokens, refetchPct } = sessionSpend([rec({}), rec({}), rec({})]);
    expect(estTokens).toBe(315);
    expect(refetchPct).toBe(67); // 200/300 cli→agent, rounded
  });

  it('formatSpend keeps small totals exact and rounds big ones to k', () => {
    expect(formatSpend(412)).toBe('~412');
    expect(formatSpend(412_345)).toBe('~412k');
  });
});
