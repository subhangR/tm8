import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntitySummary } from '@tm8/contract';
import { allKinds, getKind } from '../../domain';
import { HANDLED_SOURCES, dueLabel, renderBadge } from './tile-badges';

/**
 * W3E BADGE SANITY — the registry × renderer meeting point, both directions.
 *
 * A badge source a kind declares but nobody renders is a LYING CARD: the
 * registry promises a fact and the tile silently drops it, which is exactly
 * the defect that once left all 35 sources dead behind one kind that happened
 * to work (see tile-badges.ts's module header). `panels.test.tsx` already
 * asserts the UNION of declared sources is handled; these tests add the two
 * things that assertion cannot say:
 *
 *  1. PER-KIND ATTRIBUTION — when a kind ships an unhandled source, the
 *     failure names the kind, not "some kind somewhere".
 *  2. `HANDLED_SOURCES` MUST NOT LIE — membership in the set is only a claim.
 *     A source added to the set without a `renderBadge` arm falls through to
 *     `default: return null` and passes every subset check while rendering
 *     nothing. The rich-row half below feeds each handled source a row that
 *     CARRIES its fact and requires a real slot back.
 */

describe('tile badge totality — every kind resolves through HANDLED_SOURCES', () => {
  const kinds = allKinds();

  it('walks the real registry (a zero-kind walk proves nothing)', () => {
    // The 17 spine kinds plus the non-spine rows (voice_channel, message,
    // interaction_profile, graph, the c:* fallback…). Meaningful only if the
    // registry really enumerates them all.
    expect(kinds.length).toBeGreaterThanOrEqual(17);
  });

  for (const config of kinds) {
    it(`${config.kind}: every declared badge source has a renderer`, () => {
      const unhandled = config.list.tile.badges
        .map((badge) => badge.source)
        .filter((source) => !HANDLED_SOURCES.has(source));
      expect(
        unhandled,
        `${config.kind} declares badge source(s) nothing renders: ${unhandled.join(', ')}`,
      ).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// The rich row: one summary carrying EVERY fact any handled source reads, so
// each source's arm has something to render. Kind literals are legal here —
// tests are excluded from §15.2's scan for exactly this reason — and the shape
// is cast because CoreEntityState is a discriminated union no single honest
// row could satisfy; presence of the fields is all renderBadge reads.
// ---------------------------------------------------------------------------

const actorFixture = {
  id: 'a-rich',
  kind: 'team_member',
  displayName: 'Ada',
  isAgent: false,
  avatar: null,
};

const richRow = {
  id: 'e-rich',
  spaceId: 'sp-rich',
  kind: 'task',
  title: 'a row carrying every badge fact at once',
  parentId: null,
  position: 0,
  visibility: 'space',
  version: 1,
  activityAt: '2026-08-29T00:00:00.000Z',
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
  deletedAt: null,
  createdBy: actorFixture,
  category: 'in_progress',
  counters: { likes: 0, dislikes: 0, stars: 0, points: 3, messages: 5, viewerReaction: null },
  badges: {
    workingActors: [{ actor: actorFixture }],
    blocked: { unresolvedHardDependencyCount: 2 },
    pulls: [{ actor: actorFixture }],
    restricted: true,
  },
  state: {
    kind: 'task',
    status: 'working',
    state: 'open',
    priority: 'urgent',
    axes: { lane: 'build' },
    assignees: [actorFixture],
    acceptance: { total: 4, completed: 2 },
    dueDate: '2026-09-01',
    liveWork: { actor: actorFixture },
    owner: actorFixture,
    author: actorFixture,
    agentTool: 'claude-code',
    model: 'claude-opus-5',
    shareMode: 'space',
    topic: 'a topic',
    unreadCount: 3,
    workingAgentCount: 1,
    format: 'markdown',
    childCount: 2,
    role: 'admin',
    score: 9,
    taskDoneCount: 4,
    repository: 'tm8/tm8',
    sha: 'abcdef1234567',
    mimeType: 'text/plain',
    sizeBytes: 2048,
    equipped: true,
    collectionType: 'set',
    itemCount: 7,
    materializedVersion: 3,
    activeVersion: 2,
    fields: { one: 1 },
  },
} as unknown as EntitySummary;

describe('tile badge totality — HANDLED_SOURCES does not lie', () => {
  for (const source of [...HANDLED_SOURCES].sort()) {
    it(`'${source}' renders a slot when the row carries its fact`, () => {
      // Null is the legitimate answer for an ABSENT fact; this row carries
      // them all, so null here means the source sits in the set while the
      // switch falls through to `default` — the silent unhandled badge.
      expect(renderBadge(source, richRow)).not.toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// I3 — THE SLOT IS THE TYPOGRAPHY CHANNEL. Consumers render `meta` into the
// mono data span and `status` into the toned word pill — two elements, two
// classes, so the split lives HERE, in which slot a source chooses. These pins
// keep a machine fact from ever being routed to the word channel (a model id
// dressed as a state) and a state from the mono channel (a status reading as
// debug output). If a source below changes slot, that is a deliberate
// re-voicing and this block moves with it — say so in the change.
// ---------------------------------------------------------------------------

describe('slot routing — data speaks mono meta, states speak the status word', () => {
  // dueDate is deliberately absent: its channel depends on the real clock
  // (past → tag) and is already pinned under fake timers below.
  const DATA_SOURCES = ['model', 'agentTool', 'sha', 'messages', 'repository'] as const;
  for (const source of DATA_SOURCES) {
    it(`'${source}' is a machine fact and renders the mono meta channel`, () => {
      expect(renderBadge(source, richRow)).toMatchObject({ slot: 'meta' });
    });
  }

  it("'model' carries the id verbatim into the meta channel", () => {
    expect(renderBadge('model', richRow)).toEqual({ slot: 'meta', text: 'claude-opus-5' });
  });

  const STATUS_SOURCES = ['status', 'sessionStatus', 'profileStatus'] as const;
  for (const source of STATUS_SOURCES) {
    it(`'${source}' is a state and renders the non-mono status word, toned`, () => {
      const slot = renderBadge(source, richRow);
      expect(slot).toMatchObject({ slot: 'status' });
      // The word channel always carries a tone — that is what 600 + tone
      // colour hangs on; a status without one would render as gray data.
      expect((slot as { tone?: unknown }).tone).toBeDefined();
    });
  }

  it("'prState' routes to the status word channel too (reads state, not status)", () => {
    const prRow = {
      ...richRow,
      state: { ...(richRow.state as object), state: 'open' },
    } as unknown as EntitySummary;
    expect(renderBadge('prState', prRow)).toMatchObject({ slot: 'status', word: 'open' });
  });
});

// ---------------------------------------------------------------------------
// Status tone — the registry declaration is the ONLY source (§15.2).
// tile-badges used to keep its own WORK_STATUS_TONE table, and it had drifted:
// in_review 'info' / done 'run' against the registry's 'wait' / 'idle', so the
// collapsed row disagreed with the state picker mounted on its own dot and
// with the detail pill. These pins hold the repaired agreement.
// ---------------------------------------------------------------------------

const statusRow = (status: string): EntitySummary =>
  ({ ...richRow, state: { ...(richRow.state as object), status } }) as unknown as EntitySummary;

describe('status badge tone — resolved from the kind’s registry declaration', () => {
  it('every tone the task row declares reaches its collapsed row unchanged', () => {
    const declared = getKind('task').panel.statusPill?.tones ?? {};
    expect(Object.keys(declared).length).toBeGreaterThan(0);
    for (const [value, tone] of Object.entries(declared)) {
      expect(renderBadge('status', statusRow(value)), value).toMatchObject({ slot: 'status', tone });
    }
  });

  it('pins the two values the deleted component copy had drifted on', () => {
    expect(renderBadge('status', statusRow('in_review'))).toMatchObject({ tone: 'wait', word: 'in review' });
    expect(renderBadge('status', statusRow('done'))).toMatchObject({ tone: 'idle' });
  });

  it('a value the registry does not declare renders neutral, never invented', () => {
    expect(renderBadge('status', statusRow('triaged'))).toMatchObject({ tone: 'idle' });
  });
});

// ---------------------------------------------------------------------------
// dueDate — humanized, never raw ISO, block-toned when past. `dueLabel` takes
// `today` as a parameter so the calendar arithmetic is tested without faking
// the clock; the renderer arm (which defaults `today` to now) gets fake-timer
// coverage for both sides of the verdict.
// ---------------------------------------------------------------------------

describe('dueDate — a humanized calendar fact', () => {
  const today = new Date(2026, 7, 29); // Aug 29 2026, local — the audit’s own date.

  it('a date this year reads month-day, no year, no ISO', () => {
    expect(dueLabel('2026-09-01', today)).toEqual({ label: 'due Sep 1', past: false });
  });

  it('another year names the year, and an elapsed one is past', () => {
    expect(dueLabel('2025-12-31', today)).toEqual({ label: 'due Dec 31 2025', past: true });
  });

  it('due TODAY is due, not past', () => {
    expect(dueLabel('2026-08-29', today)).toEqual({ label: 'due Aug 29', past: false });
  });

  it('a datetime ISO humanizes from its leading day', () => {
    expect(dueLabel('2026-09-01T12:00:00.000Z', today)).toEqual({ label: 'due Sep 1', past: false });
  });

  it('garbage is nobody’s calendar fact', () => {
    expect(dueLabel('soonish', today)).toBeNull();
  });

  describe('the renderer arm', () => {
    afterEach(() => vi.useRealTimers());

    const dueRow = (dueDate: string): EntitySummary =>
      ({ ...richRow, state: { ...(richRow.state as object), dueDate } }) as unknown as EntitySummary;

    it('upcoming renders a toneless meta with the humanized label', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 29));
      expect(renderBadge('dueDate', dueRow('2026-09-01'))).toEqual({ slot: 'meta', text: 'due Sep 1' });
    });

    it('past renders the tone-bearing tag slot with tone block', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 29));
      expect(renderBadge('dueDate', dueRow('2026-08-01'))).toEqual({
        slot: 'tag',
        label: 'due Aug 1',
        tone: 'block',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Acceptance — the fraction names itself, in the expanded card's own spelling.
// ---------------------------------------------------------------------------

describe('acceptance badge', () => {
  it("labels the fraction — '2/4 criteria', one spelling with the expanded card", () => {
    expect(renderBadge('acceptance', richRow)).toEqual({ slot: 'meta', text: '2/4 criteria' });
  });
});
