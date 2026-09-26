/**
 * What the panel bar's context number SAYS, derived from the shared tail read.
 *
 * Pure, so every rule below is a unit test rather than a screenshot:
 *
 *  · UNKNOWN IS NOT ZERO. A missing count renders '—' and says why; '0' is
 *    only ever a count the provider actually reported as zero.
 *  · A PERCENTAGE NEEDS A KNOWN CAPACITY. Capacity is the provider's own
 *    window, or a 1M window the launch model proves — never a guess from a
 *    model name. Without one the number is the count alone.
 *  · CACHE REUSE IS ONE REQUEST'S RATIO: cache-read over that same request's
 *    whole input. Never a ratio of running totals.
 *  · THE AGE IS THE SAMPLE'S, NOT THE POLL'S. `observedAt` is the provider
 *    record's own timestamp; an HTTP poll that finds nothing new leaves it
 *    where it was, so '8s ago' keeps counting up instead of resetting.
 *  · A LAST-KNOWN SAMPLE IS SAID TO BE ONE. When a newer tail window holds no
 *    usage record, the previous sample is still the newest truth, and is
 *    shown with that qualifier. Compaction and a model change are the
 *    opposite: the old sample is wrong now, so it is dropped, not kept.
 *
 * `formatContext` is those rules over one reading, with no transcript in
 * sight, so a chat (whose reading arrives on the chat entity and a WS frame)
 * says exactly what the session strip says. `readContext` is the strip's
 * wrapper: the tail read's loading, failure and delay states around it.
 */
import type { SessionTranscriptContext, SessionTranscriptPage } from '@tm8/contract';
import { absTime, ageAgo, ageLabel } from '../kit/time';
import type { TailSnapshot } from './tail-resource';

export type ContextTone = 'loading' | 'unknown' | 'ok' | 'delayed';

export interface ContextDetail {
  term: string;
  value: string;
}

export interface ContextReading {
  tone: ContextTone;
  /** Occupancy, compact — '48k'. '…' loading, '—' unknown. */
  used: string;
  /** '24%', or null when capacity is not known. */
  percent: string | null;
  /** '80%', or '—' when the request's cache split is not known. Null when there is no sample. */
  cache: string | null;
  /** '8s ago', or null when there is no trustworthy sample time. */
  age: string | null;
  /** The same age without its suffix — '8s' — for a bar with less room. */
  ageShort: string | null;
  /** Whether this is an earlier sample carried past a window with none. */
  lastKnown: boolean;
  /** The whole reading in words, for the accessible name and tooltip. */
  label: string;
  details: ContextDetail[];
}

/** The newest sample carrying a count — what "last known" falls back to. */
export function usableSample(ctx: SessionTranscriptContext | null | undefined): SessionTranscriptContext | null {
  return ctx && ctx.usedTokens !== null ? ctx : null;
}

/** '999' · '9.6k' · '48k' · '1.2M' — occupancy at a glance. */
export function compactTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 10_000) return `${trim1(n / 1_000)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${trim1(n / 1_000_000)}M`;
}

function trim1(x: number): string {
  const s = (Math.floor(x * 10) / 10).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

function exact(n: number): string {
  return n.toLocaleString('en-US');
}

function percentOf(part: number, whole: number): number {
  return Math.round((part / whole) * 100);
}

const REASONS: Record<NonNullable<SessionTranscriptContext['unavailableReason']>, string> = {
  not_reported: 'the transcript has no request usage yet',
  incomplete_usage: 'the newest request did not report its full input split',
  sample_outside_window: 'no request usage in the newest transcript window',
  awaiting_new_sample: 'context was compacted or the model changed; waiting for the next request',
};

const SOURCE_LABEL: Record<NonNullable<SessionTranscriptContext['source']>, string> = {
  claude_request_usage: 'Claude request usage (input + cache read + cache write)',
  codex_request_usage: 'Codex last request usage',
};

function unknown(tone: ContextTone, used: string, why: string, extra: ContextDetail[] = []): ContextReading {
  return {
    tone,
    used,
    percent: null,
    cache: null,
    age: null,
    ageShort: null,
    lastKnown: false,
    label: tone === 'loading' ? 'Context: reading…' : `Context unknown: ${why}`,
    details: [{ term: 'Context', value: tone === 'loading' ? 'reading…' : `unknown — ${why}` }, ...extra],
  };
}

function delayedDetail(snap: TailSnapshot): ContextDetail | null {
  if (snap.error === null) return null;
  const since = snap.errorAt === null ? '' : ` (${absTime(snap.errorAt)})`;
  return { term: 'Update', value: `delayed — ${snap.error}${since}` };
}

function pageReason(page: SessionTranscriptPage): string {
  if (!page.available) return `transcript unavailable (${page.unavailableReason ?? 'unknown reason'})`;
  return 'this node does not report context usage';
}

/**
 * @param snap     the shared tail read
 * @param previous the newest usable sample seen earlier for this session
 * @param now      the seconds clock
 */
export function readContext(
  snap: TailSnapshot,
  previous: SessionTranscriptContext | null,
  now: number,
): ContextReading {
  const page = snap.page;
  if (!page) {
    return snap.error === null
      ? unknown('loading', '…', 'reading')
      : unknown('unknown', '—', `transcript read failed — ${snap.error}`);
  }
  return formatContext(page.available ? page.context ?? null : null, now, {
    previous,
    missing: pageReason(page),
    delay: delayedDetail(snap),
  });
}

export interface FormatContextOptions {
  /** The newest usable sample seen earlier, for a window that holds none. */
  previous?: SessionTranscriptContext | null;
  /**
   * The reading is no longer being updated, and why — a stopped runtime, say.
   * A usable sample is then shown as last known, with this as its status.
   */
  stale?: string | null;
  /** Why there is no reading at all, when `current` is null. */
  missing?: string;
  /** The update is late: the tone becomes 'delayed' and this detail says why. */
  delay?: ContextDetail | null;
}

/** One reading in words, by the rules at the top of this file. Pure. */
export function formatContext(
  current: SessionTranscriptContext | null,
  now: number,
  options: FormatContextOptions = {},
): ContextReading {
  const delay = options.delay ?? null;
  const delayed = delay === null ? [] : [delay];
  if (!current) return unknown('unknown', '—', options.missing ?? REASONS.not_reported, delayed);

  let sample = usableSample(current);
  let lastKnown: string | null = sample && options.stale ? options.stale : null;
  if (!sample && current.unavailableReason === 'sample_outside_window' && options.previous) {
    sample = options.previous;
    lastKnown = 'the newest transcript window holds no request usage';
  }
  if (!sample || sample.usedTokens === null) {
    const why = REASONS[current.unavailableReason ?? 'not_reported'];
    return unknown('unknown', '—', why, delayed);
  }

  const used = sample.usedTokens;
  const capacity = sample.capacityTokens;
  const pct = capacity !== null && capacity > 0 ? percentOf(used, capacity) : null;
  const cachePct =
    sample.cacheReadTokens !== null && sample.requestInputTokens !== null && sample.requestInputTokens > 0
      ? percentOf(sample.cacheReadTokens, sample.requestInputTokens)
      : null;
  const age = ageLabel(sample.observedAt, now);
  const tone: ContextTone = delay !== null ? 'delayed' : 'ok';

  const words = [
    `Context ${exact(used)} tokens`,
    capacity !== null ? `of ${exact(capacity)}, ${String(pct)}%` : 'capacity unknown',
  ].join(' ');
  const label = [
    lastKnown !== null ? `Last known: ${words}` : words,
    cachePct !== null ? `cache reuse ${String(cachePct)}%` : 'cache reuse unknown',
    age !== null ? `sampled ${ageAgo(age)}` : 'sample time unknown',
    tone === 'delayed' ? 'update delayed' : null,
  ]
    .filter(Boolean)
    .join('; ');

  const details: ContextDetail[] = [
    { term: 'Used', value: `${exact(used)} tokens` },
    {
      term: 'Capacity',
      value:
        capacity === null
          ? 'unknown — no percentage shown'
          : `${exact(capacity)} tokens (${sample.capacitySource === 'provider' ? 'reported by provider' : 'from the 1M launch model'})`,
    },
  ];
  if (capacity !== null) {
    details.push({
      term: 'Remaining',
      value: used <= capacity ? `${exact(capacity - used)} tokens` : `none — over by ${exact(used - capacity)} tokens`,
    });
  }
  details.push({
    term: 'Cache reuse',
    value:
      cachePct !== null
        ? `${String(cachePct)}% — ${exact(sample.cacheReadTokens ?? 0)} of ${exact(sample.requestInputTokens ?? 0)} input tokens read from cache`
        : 'unknown — the request did not report its cache split',
  });
  details.push({
    term: 'Sampled',
    value: sample.observedAt && age !== null ? `${absTime(sample.observedAt)} (${ageAgo(age)})` : 'time unknown',
  });
  if (sample.model) details.push({ term: 'Model', value: sample.model });
  if (sample.source) details.push({ term: 'Source', value: SOURCE_LABEL[sample.source] });
  if (lastKnown !== null) details.push({ term: 'Status', value: `last known — ${lastKnown}` });
  details.push(...delayed);

  return {
    tone,
    used: compactTokens(used),
    percent: pct === null ? null : `${String(pct)}%`,
    cache: cachePct === null ? '—' : `${String(cachePct)}%`,
    age: age === null ? null : ageAgo(age),
    ageShort: age,
    lastKnown: lastKnown !== null,
    label,
    details,
  };
}
