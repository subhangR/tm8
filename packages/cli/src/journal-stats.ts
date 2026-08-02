/**
 * Journal arithmetic — the read side of the measurement subsystem (F8).
 *
 * PURE FUNCTIONS OVER PARSED RECORDS, deliberately: the same arithmetic backs
 * the spend line `finish()` prints, the standalone `scripts/journal-stats.mjs`
 * report, and the unit tests that pin both. No filesystem, no process state —
 * callers hand in text or records and get numbers back.
 *
 * TOLERANT PARSING IS A CORRECTNESS RULE HERE, not a convenience. Journals are
 * appended by concurrent short-lived processes across CLI versions: a line may
 * be torn, pre-`class`, or from a newer writer with fields this reader has
 * never seen. Every count this module emits therefore carries `malformed`
 * alongside it — a number computed over silently dropped lines reads exactly
 * like a good one.
 */
import type { SessionJournalCall } from '@tm8/contract';

export const JOURNAL_CLASSES = ['agent', 'harness', 'human'] as const;
export type JournalClass = (typeof JOURNAL_CLASSES)[number];

/**
 * The subset of a journal record this module needs. Structural on purpose:
 * legacy records (no `class`) and future records (unknown extras) both fit.
 */
export interface StatsRecord {
  sessionId: string;
  class?: string;
  startedAt: string;
  command: { path: string[]; argv: string[]; cwd: string };
  calls: Pick<SessionJournalCall, 'baseUrl'>[];
  result: { exitCode: number };
  tokens: { agentToCli: number; cliToAgent: number };
}

/**
 * Ports a real, durable tm8 node answers on. Anything OS-assigned (the
 * ephemeral range) is a scratch server some harness started — the port
 * heuristic the journey analysis validated against 3,018 records.
 */
const STABLE_PORTS = new Set([80, 443, 4610, 7777, 7778, 8888]);
const EPHEMERAL_FLOOR = 32_768;

/**
 * Decide who a record is, at write time or after the fact.
 *
 * Precedence: an explicit `TM8_JOURNAL_CLASS` wins (an invalid value falls
 * through rather than inventing a fourth class); then the validated
 * heuristics — an ephemeral target port or a repo-test cwd is harness; the
 * remainder is an agent, because only the spawn path injects the journal env
 * at all. `human` is never guessed: a human at their own terminal writes no
 * journal, so the label exists only for someone who explicitly asked for it.
 */
export function resolveJournalClass(
  env: NodeJS.ProcessEnv,
  calls: readonly Pick<SessionJournalCall, 'baseUrl'>[],
  cwd: string,
): JournalClass {
  const explicit = env.TM8_JOURNAL_CLASS;
  if ((JOURNAL_CLASSES as readonly string[]).includes(explicit ?? '')) {
    return explicit as JournalClass;
  }
  if (calls.some((c) => targetsEphemeralPort(c.baseUrl))) return 'harness';
  if (/[/\\]packages[/\\]cli$/.test(cwd)) return 'harness';
  return 'agent';
}

function targetsEphemeralPort(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.port === '') return false; // default port — stable by definition
    const port = Number(url.port);
    return !STABLE_PORTS.has(port) && port >= EPHEMERAL_FLOOR;
  } catch {
    return false; // an unparseable baseUrl proves nothing
  }
}

/** A written `class` is the answer; a legacy record gets the same heuristics. */
export function classOf(record: StatsRecord): JournalClass {
  if ((JOURNAL_CLASSES as readonly string[]).includes(record.class ?? '')) {
    return record.class as JournalClass;
  }
  return resolveJournalClass({}, record.calls ?? [], record.command?.cwd ?? '');
}

/** Parse journal text. Bad lines are COUNTED, never silently dropped. */
export function parseJournalText(text: string): { records: StatsRecord[]; malformed: number } {
  const records: StatsRecord[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as StatsRecord;
      if (
        typeof parsed.sessionId !== 'string'
        || typeof parsed.tokens?.agentToCli !== 'number'
        || typeof parsed.tokens?.cliToAgent !== 'number'
        || !Array.isArray(parsed.command?.argv)
      ) {
        malformed += 1;
        continue;
      }
      records.push(parsed);
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
}

function estOf(r: StatsRecord): number {
  return r.tokens.agentToCli + r.tokens.cliToAgent;
}

function argvKey(r: StatsRecord): string {
  return `${r.sessionId} ${r.command.argv.join(' ')}`;
}

export interface CommandStats {
  command: string;
  count: number;
  failed: number;
  failureRate: number;
  estTokens: number;
}

export interface PollLoopSignature {
  sessionId: string;
  argv: string[];
  count: number;
  meanGapMs: number;
}

export interface JournalStats {
  invocations: number;
  estTokens: number;
  failed: number;
  failureRate: number;
  /** Share of est tokens spent on byte-identical within-session re-fetches. */
  refetch: { records: number; estTokens: number; share: number };
  perCommand: CommandStats[];
  topExpensive: { command: string; argv: string[]; estTokens: number; startedAt: string }[];
  pollLoops: PollLoopSignature[];
  byClass: Record<JournalClass, number>;
}

/** The whole report. `classFilter` compares via `classOf`, so legacy rows split too. */
export function computeStats(
  all: readonly StatsRecord[],
  opts: { classFilter?: JournalClass; topN?: number; pollLoopMin?: number } = {},
): JournalStats {
  const topN = opts.topN ?? 10;
  const pollLoopMin = opts.pollLoopMin ?? 5;

  const byClass: Record<JournalClass, number> = { agent: 0, harness: 0, human: 0 };
  for (const r of all) byClass[classOf(r)] += 1;

  const records =
    opts.classFilter === undefined ? [...all] : all.filter((r) => classOf(r) === opts.classFilter);

  const estTokens = records.reduce((n, r) => n + estOf(r), 0);
  const failed = records.filter((r) => r.result?.exitCode !== 0).length;

  // Byte-identical re-fetch: the SECOND and later occurrences of one argv
  // within one session. The first fetch was the honest one.
  const seen = new Set<string>();
  let refetchRecords = 0;
  let refetchTokens = 0;
  for (const r of records) {
    const key = argvKey(r);
    if (seen.has(key)) {
      refetchRecords += 1;
      refetchTokens += r.tokens.cliToAgent;
    } else {
      seen.add(key);
    }
  }
  const cliToAgentTotal = records.reduce((n, r) => n + r.tokens.cliToAgent, 0);

  const perCommand = new Map<string, CommandStats>();
  for (const r of records) {
    const name = r.command.path.length > 0 ? r.command.path.join(' ') : '(unparsed)';
    const row = perCommand.get(name) ?? { command: name, count: 0, failed: 0, failureRate: 0, estTokens: 0 };
    row.count += 1;
    row.estTokens += estOf(r);
    if (r.result?.exitCode !== 0) row.failed += 1;
    perCommand.set(name, row);
  }
  for (const row of perCommand.values()) row.failureRate = row.failed / row.count;

  const topExpensive = [...records]
    .sort((a, b) => estOf(b) - estOf(a))
    .slice(0, topN)
    .map((r) => ({
      command: r.command.path.length > 0 ? r.command.path.join(' ') : '(unparsed)',
      argv: r.command.argv,
      estTokens: estOf(r),
      startedAt: r.startedAt,
    }));

  const runs = new Map<string, StatsRecord[]>();
  for (const r of records) {
    const key = argvKey(r);
    runs.set(key, [...(runs.get(key) ?? []), r]);
  }
  const pollLoops: PollLoopSignature[] = [];
  for (const group of runs.values()) {
    if (group.length < pollLoopMin) continue;
    const times = group
      .map((r) => Date.parse(r.startedAt))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    const meanGapMs = gaps.length === 0 ? 0 : Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
    pollLoops.push({
      sessionId: group[0]!.sessionId,
      argv: group[0]!.command.argv,
      count: group.length,
      meanGapMs,
    });
  }
  pollLoops.sort((a, b) => b.count - a.count);

  return {
    invocations: records.length,
    estTokens,
    failed,
    failureRate: records.length === 0 ? 0 : failed / records.length,
    refetch: {
      records: refetchRecords,
      estTokens: refetchTokens,
      share: cliToAgentTotal === 0 ? 0 : refetchTokens / cliToAgentTotal,
    },
    perCommand: [...perCommand.values()].sort((a, b) => b.estTokens - a.estTokens),
    topExpensive,
    pollLoops,
    byClass,
  };
}

/** The two numbers the spend line prints. One session's records only. */
export function sessionSpend(records: readonly StatsRecord[]): {
  estTokens: number;
  refetchPct: number;
} {
  const stats = computeStats(records);
  return { estTokens: stats.estTokens, refetchPct: Math.round(stats.refetch.share * 100) };
}

/** `12345` -> `~12k`; small totals stay exact so early sessions read honestly. */
export function formatSpend(estTokens: number): string {
  return estTokens >= 1_000 ? `~${Math.round(estTokens / 1_000)}k` : `~${estTokens}`;
}
