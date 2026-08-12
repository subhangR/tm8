/**
 * The one timestamp helper, and the surfaces that must use it.
 *
 * The failure mode this task guards against is not difficulty, it is drift:
 * five surfaces each growing their own date format. So this file tests the
 * helper's behaviour AND greps the shipped source for a second formatter.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntityCard } from '../../entity';
import { Timestamp } from '../../kit';
import { RELATIVE_WINDOW_MS, absTime, relTime } from '../../kit/time';
import { MessageRow } from '../../subsystems/thread/MessageRow';
import type { ActorSummary, EntitySummary, MessageView } from '../../types/contract';

const NOW = Date.parse('2026-08-12T12:00:00.000Z');

const ACTOR: ActorSummary = {
  id: 'mem_1', kind: 'member', displayName: 'Ada', avatar: null,
  role: 'member', isAgent: false,
};

function taskSummary(over: Partial<EntitySummary> = {}): EntitySummary {
  return {
    id: 'ent_1', spaceId: 'spc_1', kind: 'task', title: 'A task',
    parentId: null, position: 0, visibility: 'space', version: 2,
    activityAt: new Date(NOW - 60_000).toISOString(),
    createdAt: new Date(NOW - 5 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    deletedAt: null, createdBy: ACTOR,
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: {
      kind: 'task', workStatus: 'open', priority: 'medium', axes: {},
      dueDate: null, assignees: [], acceptance: { total: 0, completed: 0 },
    },
    badges: {},
    ...over,
  } as EntitySummary;
}

function messageView(createdAt: string, activityAt: string): MessageView {
  return {
    id: 'msg_1', spaceId: 'spc_1', kind: 'message', title: 'm',
    parentId: null, position: 0, visibility: 'space', version: 1,
    activityAt, createdAt, updatedAt: activityAt, deletedAt: null, createdBy: ACTOR,
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: { kind: 'message', anchorId: 'ent_1', rootMessageId: null, author: ACTOR, editedAt: null },
    badges: {},
    content: { kind: 'message', body: 'hello', mentions: [], attachments: [] },
    replyCount: 0,
  } as MessageView;
}

function renderMessage(message: MessageView) {
  return render(
    <MessageRow
      node={{ message, depth: 0, children: [], missingReplies: 0 } as never}
      expanded={false}
      onToggleReplies={() => {}}
      onReply={() => {}}
      onEdit={() => Promise.resolve()}
      onDelete={() => {}}
    />,
  );
}

afterEach(() => { vi.useRealTimers(); });

describe('relTime / absTime — the shared formatter', () => {
  it('reads relative inside the window and absolute past it', () => {
    expect(relTime(NOW - 10_000, NOW)).toBe('just now');
    expect(relTime(NOW - 4 * 60_000, NOW)).toBe('4m ago');
    expect(relTime(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(relTime(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
    // Past the 7-day window the relative label stops informing: show the date.
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

  it('renders nothing at all for input it cannot parse', () => {
    for (const bad of ['', 'not a date', null, undefined, Number.NaN]) {
      expect(relTime(bad as never, NOW)).toBe('');
      expect(absTime(bad as never)).toBe('');
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

    // A minute passes. Nothing re-renders the tree, nothing reloads — the
    // clock alone moves the label on.
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
    // The machine-readable instant travels with the label.
    expect(el?.getAttribute('dateTime')).toBe(at);
  });

  it('renders a two-year-old stamp and a non-UTC offset as valid local dates', () => {
    const cases = ['2024-08-12T12:00:00.000Z', '2024-08-12T17:30:00.000+05:30'];
    for (const at of cases) {
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
});

describe('each surface shows the field it means', () => {
  it('a task row shows last activity; a message shows when it was said', () => {
    const created = new Date(NOW - 3 * 86_400_000).toISOString();
    const active = new Date(NOW - 60_000).toISOString();

    const card = render(<EntityCard entity={taskSummary({ createdAt: created, activityAt: active })} />);
    expect(card.container.querySelector('.cv2-card__when')?.getAttribute('dateTime')).toBe(active);
    card.unmount();

    // A message that was replied to has a later activityAt; the row must still
    // read as the moment it was posted.
    const msg = renderMessage(messageView(created, active));
    expect(msg.container.querySelector('.cv2-thread__time')?.getAttribute('dateTime')).toBe(created);
  });
});

/* ── the constraint, enforced ───────────────────────────────────────────── */

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = join(here, '..', '..', '..');

/** kit/time.ts IS the formatter; everything else must go through it. */
const FORMATTER_HOME = join('collab-v2', 'kit', 'time.ts');

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
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('exactly one date formatter in the shipped UI', () => {
  it('no surface formats a date for itself', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(uiSrc)) {
      const rel = relative(uiSrc, file);
      if (rel.split(sep).join(sep) === FORMATTER_HOME) continue;
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const { name, re } of DATE_FORMATTING) {
        if (re.test(text)) offenders.push(`${rel}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
