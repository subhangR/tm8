// @vitest-environment jsdom
/**
 * The one timestamp helper, and the constraint that keeps it one.
 *
 * The failure mode here is not difficulty, it is drift: this app had EIGHT
 * private date formatters before `kit/time`, two of which had written the
 * problem down in their own comments. So this file tests the helper's
 * behaviour AND greps the shipped source for a second formatter.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from './Timestamp';
import { RELATIVE_WINDOW_MS, absTime, dayLabel, elapsed, relTime } from './time';

const NOW = Date.parse('2026-08-12T12:00:00.000Z');

afterEach(() => { vi.useRealTimers(); });

describe('relTime / absTime — the shared formatter', () => {
  it('reads relative inside the window and absolute past it', () => {
    expect(relTime(NOW - 10_000, NOW)).toBe('just now');
    expect(relTime(NOW - 4 * 60_000, NOW)).toBe('4m ago');
    expect(relTime(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(relTime(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
    // Past the 7-day window a relative label stops informing: show the date.
    const old = NOW - RELATIVE_WINDOW_MS - 86_400_000;
    expect(relTime(old, NOW)).not.toMatch(/ago/);
    expect(relTime(old, NOW)).toBe(
      new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date(old)),
    );
  });

  it('reads a future instant forward instead of pretending it has passed', () => {
    expect(relTime(NOW + 4 * 60_000, NOW)).toBe('in 4m');
    expect(relTime(NOW + 5_000, NOW)).toBe('in a moment');
  });

  it('elapsed is the bare magnitude the caller supplies a preposition for', () => {
    expect(elapsed(NOW - 12 * 60_000, NOW)).toBe('12m');
    expect(elapsed(NOW - 10_000, NOW)).toBe('<1m');
  });

  it('dayLabel names today and yesterday before it names a date', () => {
    expect(dayLabel(NOW, NOW)).toBe('Today');
    expect(dayLabel(NOW - 86_400_000, NOW)).toBe('Yesterday');
    expect(dayLabel(NOW - 5 * 86_400_000, NOW)).toMatch(/\d/);
  });

  it('renders nothing at all for input it cannot parse', () => {
    for (const bad of ['', 'not a date', null, undefined, Number.NaN]) {
      expect(relTime(bad as never, NOW)).toBe('');
      expect(absTime(bad as never)).toBe('');
      expect(dayLabel(bad as never, NOW)).toBe('');
    }
  });
});

describe('Timestamp — the rendered label', () => {
  it('ticks without a reload, off one shared clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const setInterval = vi.spyOn(globalThis, 'setInterval');

    render(
      <>
        <Timestamp at={new Date(NOW - 10_000).toISOString()} />
        <Timestamp at={new Date(NOW - 10_000).toISOString()} />
        <Timestamp at={new Date(NOW - 10_000).toISOString()} />
      </>,
    );
    expect(screen.getAllByText('just now')).toHaveLength(3);

    // Three rows on screen, ONE interval — a per-row timer is the performance
    // bug this component exists to avoid.
    expect(setInterval).toHaveBeenCalledTimes(1);

    // A minute passes. Nothing re-renders the tree, nothing reloads.
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getAllByText('1m ago')).toHaveLength(3);
    expect(screen.queryByText('just now')).toBeNull();
  });

  it('reveals the full absolute local time on inspect', () => {
    const at = new Date(NOW - 60_000).toISOString();
    const { container } = render(<Timestamp at={at} />);
    const el = container.querySelector('time');

    expect(el?.getAttribute('title')).toBe(absTime(at));
    expect(el?.getAttribute('title')).toMatch(/2026/);
    expect(el?.getAttribute('dateTime')).toBe(at);
    // Screen readers get the absolute time, not the relative shorthand.
    expect(el?.getAttribute('aria-label')).toBe(absTime(at));
  });

  it('renders a two-year-old stamp and a non-UTC offset as valid local dates', () => {
    for (const at of ['2024-08-12T12:00:00.000Z', '2024-08-12T17:30:00.000+05:30']) {
      const { container, unmount } = render(<Timestamp at={at} />);
      const el = container.querySelector('time');
      const text = el?.textContent ?? '';
      expect(text).not.toBe('');
      expect(text).not.toMatch(/Invalid Date/);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // never a raw ISO string
      expect(el?.getAttribute('title')).not.toMatch(/Invalid Date/);
      // Same instant, same local rendering, whichever offset it arrived in.
      expect(el?.getAttribute('dateTime')).toBe('2024-08-12T12:00:00.000Z');
      unmount();
    }
  });

  it('renders nothing rather than a broken label when the instant is unusable', () => {
    const { container } = render(<Timestamp at="not a date" />);
    expect(container.querySelector('time')).toBeNull();
  });

  it('honours a pinned clock so a fixture reads the same on every run', () => {
    const { container } = render(
      <Timestamp at={new Date(NOW - 12 * 60_000).toISOString()} now={new Date(NOW).toISOString()} />,
    );
    expect(container.querySelector('time')?.textContent).toBe('12m ago');
  });
});

/* ── the constraint, enforced ───────────────────────────────────────────── */

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = join(here, '..');

/** kit/time.ts IS the formatter; everything else must go through it. */
const FORMATTER_HOME = join('kit', 'time.ts');

/** Number formatting (`toLocaleString` on a count) is not date formatting. */
const DATE_FORMATTING = [
  { name: 'Intl.DateTimeFormat', re: /Intl\.DateTimeFormat/ },
  { name: 'toLocaleDateString/toLocaleTimeString', re: /toLocale(Date|Time)String/ },
  { name: 'Date#toDateString/toTimeString', re: /\.to(Date|Time)String\(/ },
  { name: 'hand-rolled relative label', re: /['"`][^'"`]*\bago\b/ },
];

/** Prose about dates is not a date format; only code counts. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'fixtures') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) {
      // `specimen.ts` files are static design copy ("2d ago" as a mock string),
      // not formatters — they never see a real instant.
      if (e.name !== 'specimen.ts') out.push(full);
    }
  }
  return out;
}

describe('exactly one date formatter in the shipped UI', () => {
  it('no surface formats a date for itself', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(appSrc)) {
      const rel = relative(appSrc, file);
      if (rel === FORMATTER_HOME) continue;
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const { name, re } of DATE_FORMATTING) {
        if (re.test(text)) offenders.push(`${rel}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
