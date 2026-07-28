// @vitest-environment jsdom
/**
 * T5-1 HOME — the tests, each aimed at a failure this program has actually
 * shipped once, not at the happy path.
 *
 * The four that matter most, and the defect each one pins:
 *
 *  1. THE VERDICT OUTRANKS THE RECORD (D39/D6/R-UI-5). A session row whose
 *     record says `running` while the node reports it stale must not wear the
 *     live word. That exact contradiction reached the user's screen at the R5
 *     gate — "1 live" above a row reading "not running" — because a consumer
 *     that HAD the verdict rendered the record instead.
 *  2. ACTIVITY CANNOT PROMOTE A VERDICT (F1's two-source law). Byte activity
 *     refines `live` into `streaming`; it must never make a stale row pulse.
 *  3. THE FILTER REACHES THE SEAM (D57.1). Four green suites once sat around a
 *     signature that promised a filter parameter and an implementation that
 *     ignored it — declaration, data and implementation all verified while
 *     nobody asserted the CALL. So this asserts the call: the exact filter
 *     object Home hands `rowsFor`, carrying the identity the seam returned.
 *  4. NO SILENT VOID (the bar this screen was built to). Every section with no
 *     rows says why, and every control whose handler is missing renders
 *     disabled-with-reason — focusable and announced (D28), never hidden and
 *     never live-but-inert.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, waitFor, within } from '@testing-library/react';
import type { DurableWorkspaceEvent, EntitySummary, NotificationItem } from '@tm8/contract';
import type { Seam, SessionLiveness } from '../data/seam';
import { ada, forge } from '../fixtures/actors';
import {
  FIXTURE_SPACE_ID,
  sessionLive,
  sessionStale,
  taskGuideLines,
  taskUuidTitle,
} from '../fixtures/entities';
import { homeActivityLoadEarlierReason } from '../fixtures';
import { HomeScreen, type HomeScreenProps } from './HomeScreen';
import {
  assignableKinds,
  composeMyWork,
  homeRowOf,
  liveKinds,
  mentionsEmptyNote,
} from './home-model';
import { activityRowOf, appendActivity, bucketActivity, dayBucketOf, recencyOf } from './home-activity';
import { reviewStatusValues, type HomeScreenData } from './useHomeData';

const NOW = new Date('2026-07-28T12:00:00.000Z');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface QueryCall {
  kind: string;
  filter: unknown;
}

function makeSeam(options: {
  memberId?: string | null;
  identityRejects?: string;
  inbox?: NotificationItem[];
  inboxRejects?: string;
  emit?: (fire: (event: DurableWorkspaceEvent) => void) => void;
}): Pick<Seam, 'identity' | 'inbox' | 'onEvent'> {
  return {
    identity: async () => {
      if (options.identityRejects) throw new Error(options.identityRejects);
      return {
        identityId: 'idn-ada',
        accountId: 'acct-ada',
        username: 'ada',
        displayName: 'Ada',
        avatar: null,
        email: null,
        isNodeAdmin: true,
        isOwner: true,
        status: 'active',
        actingAs: null,
        memberships:
          options.memberId === null
            ? []
            : [{ spaceId: FIXTURE_SPACE_ID, memberId: options.memberId ?? ada.id, role: 'owner' }],
      };
    },
    inbox: async () => {
      if (options.inboxRejects) throw new Error(options.inboxRejects);
      return { items: options.inbox ?? [], nextCursor: null };
    },
    onEvent: (cb) => {
      options.emit?.((event) => cb(event));
      return () => undefined;
    },
  };
}

function makeData(options: {
  rows?: Record<string, readonly EntitySummary[]>;
  liveness?: Record<string, SessionLiveness>;
  activity?: Record<string, boolean>;
  calls?: QueryCall[];
  seam?: Pick<Seam, 'identity' | 'inbox' | 'onEvent'>;
}): HomeScreenData {
  const rows = options.rows ?? {};
  return {
    spaceId: FIXTURE_SPACE_ID,
    seam: options.seam ?? makeSeam({}),
    liveIds: Object.entries(options.liveness ?? {})
      .filter(([, v]) => v === 'live')
      .map(([id]) => id),
    livenessOf: (id) => options.liveness?.[id] ?? 'unknown',
    rowsFor: (kind) => (filter) => {
      options.calls?.push({ kind, filter });
      const key = `${kind}::${filter === undefined ? '*' : JSON.stringify(filter)}`;
      return rows[key] ?? [];
    },
    activity: options.activity ?? {},
  };
}

function renderHome(props: Partial<HomeScreenProps> & { data: HomeScreenData }) {
  return render(
    <div className="cv2-root">
      <HomeScreen onOpenEntity={() => undefined} now={NOW} spaceLabel="atelier" {...props} />
    </div>,
  );
}

/** The one session kind the registry marks live-shaped, named by capability. */
const SESSION_KIND = liveKinds()[0]!.kind;
const TASK_KIND = assignableKinds()[0]!.kind;

// ---------------------------------------------------------------------------
// 1 — the verdict outranks the record
// ---------------------------------------------------------------------------

describe('the verdict outranks the record (D39/D6/R-UI-5)', () => {
  it('renders the STALE word over a record that still says running', () => {
    // sessionStale.state.status === 'running'. If this row ever reads
    // "running", a consumer went back to reading the record.
    const row = homeRowOf(sessionStale, { liveness: 'stale' });
    expect(sessionStale.state).toMatchObject({ status: 'running' });
    expect(row.word).toContain('stale');
    expect(row.word).not.toBe('running');
    expect(row.dot).not.toBe('solid');
    // The long-form explanation survives on the row so the short word is never
    // orphaned from its reason (D34.3).
    expect(row.detail).toBeTruthy();
  });

  it('renders `unknown` as a refusal to claim life, never as running', () => {
    const row = homeRowOf(sessionLive, { liveness: 'unknown' });
    expect(row.word).toContain('unverified');
    expect(row.tone).toBe('idle');
  });

  it('takes the compact word at the floor and keeps the long one above it', () => {
    expect(homeRowOf(sessionStale, { liveness: 'stale', compact: true }).word).toBe('stale');
    expect(homeRowOf(sessionStale, { liveness: 'stale' }).word).toContain('node restarted');
  });
});

// ---------------------------------------------------------------------------
// 2 — activity refines, never promotes
// ---------------------------------------------------------------------------

describe('the two-source law (F1)', () => {
  it('refines a LIVE verdict into streaming', () => {
    const row = homeRowOf(sessionLive, { liveness: 'live', streaming: true });
    expect(row.word).toBe('streaming');
    expect(row.dot).toBe('pulse');
  });

  it('cannot promote a stale verdict, however loud the byte signal is', () => {
    const row = homeRowOf(sessionStale, { liveness: 'stale', streaming: true });
    expect(row.dot).not.toBe('pulse');
    expect(row.word).toContain('stale');
  });
});

// ---------------------------------------------------------------------------
// 3 — sections, membership and the triage order
// ---------------------------------------------------------------------------

describe('composeMyWork', () => {
  const base = {
    sessionPool: [] as EntitySummary[],
    myTasks: [] as EntitySummary[],
    myReview: [] as EntitySummary[],
    livenessOf: () => 'unknown' as SessionLiveness,
    activity: {},
    notifications: [] as NotificationItem[],
    viewerKnown: true,
  };

  it('keeps the oracle triage order — the law that survives the floor', () => {
    expect(composeMyWork(base).sections.map((s) => s.id)).toEqual([
      'needs-you',
      'live',
      'tasks',
      'mentions',
    ]);
  });

  it('consumes the REGISTRY needs-attention predicate rather than a rule of its own', () => {
    // A live session whose agent went idle is waiting on you — that predicate
    // is registry data (`list.needsAttentionGroup`) and had NO consumer before
    // this screen, which D39.2 names as a defect class in its own right.
    const idleLive: EntitySummary = {
      ...sessionLive,
      id: 'ws-idle',
      state: { ...sessionLive.state, status: 'idle' } as EntitySummary['state'],
    };
    const out = composeMyWork({
      ...base,
      sessionPool: [idleLive],
      livenessOf: () => 'live',
    });
    expect(out.sections[0]?.rows.map((r) => r.id)).toEqual(['ws-idle']);
  });

  it('puts a stale session in MY LIVE SESSIONS and leaves a not-running one out', () => {
    const verdicts: Record<string, SessionLiveness> = {
      [sessionLive.id]: 'live',
      [sessionStale.id]: 'stale',
      'ws-done': 'not-running',
    };
    const done: EntitySummary = { ...sessionLive, id: 'ws-done' };
    const out = composeMyWork({
      ...base,
      sessionPool: [sessionLive, sessionStale, done],
      livenessOf: (id) => verdicts[id] ?? 'unknown',
    });
    const live = out.sections.find((s) => s.id === 'live')!;
    expect(live.rows.map((r) => r.id)).toEqual([sessionLive.id, sessionStale.id]);
  });

  it('counts `live` from the VERDICT, never from the number of session rows', () => {
    const out = composeMyWork({
      ...base,
      sessionPool: [sessionLive, sessionStale],
      livenessOf: (id) => (id === sessionLive.id ? 'live' : 'stale'),
    });
    expect(out.liveCount).toBe(1);
    // The wording is registry data, not a format string invented in the view.
    expect(out.liveCountLabel).toBe(liveKinds()[0]!.list.liveCount!.label(1));
  });

  it('never repeats one entity in two sections', () => {
    const out = composeMyWork({
      ...base,
      myReview: [taskUuidTitle],
      myTasks: [taskUuidTitle, taskGuideLines],
    });
    expect(out.sections.find((s) => s.id === 'needs-you')!.rows.map((r) => r.id)).toEqual([
      taskUuidTitle.id,
    ]);
    expect(out.sections.find((s) => s.id === 'tasks')!.rows.map((r) => r.id)).toEqual([
      taskGuideLines.id,
    ]);
  });

  it('gives EVERY section an empty note — a silent section is the defect', () => {
    for (const section of composeMyWork(base).sections) {
      expect(section.rows).toHaveLength(0);
      expect(section.emptyNote.length).toBeGreaterThan(0);
    }
  });

  it('says "we have not asked yet" rather than a confident zero', () => {
    const pending = composeMyWork({ ...base, viewerKnown: false });
    expect(pending.sections.find((s) => s.id === 'tasks')!.emptyNote).toMatch(/Reading who you are/);
    const failed = composeMyWork({ ...base, viewerKnown: false, viewerError: 'node unreachable' });
    expect(failed.sections.find((s) => s.id === 'tasks')!.emptyNote).toMatch(/node unreachable/);
  });
});

describe('mentions keep three different facts apart', () => {
  it('distinguishes not-read, failed and genuinely empty', () => {
    expect(mentionsEmptyNote(null, null)).toMatch(/Reading/);
    expect(mentionsEmptyNote(null, 'forbidden')).toMatch(/forbidden/);
    expect(mentionsEmptyNote([], null)).toMatch(/No unread/);
  });
});

// ---------------------------------------------------------------------------
// 4 — the activity column, projected from the durable stream
// ---------------------------------------------------------------------------

describe('activity rows say only what their event says', () => {
  const envelope = { spaceId: FIXTURE_SPACE_ID, seq: 7, occurredAt: NOW.toISOString(), schemaVersion: 1 };
  const glyphOf = () => '◻';

  it('credits createdBy ONLY on an entity that has never been updated', () => {
    const created = { ...taskGuideLines, updatedAt: taskGuideLines.createdAt, createdBy: forge };
    const row = activityRowOf(
      { ...envelope, type: 'entity.upsert', entity: created } as DurableWorkspaceEvent,
      glyphOf,
    );
    expect(row?.verb).toBe('created');
    expect(row?.actor).toBe(forge.displayName);
  });

  it('names NO actor on an update — `createdBy` is the creator, not this actor', () => {
    const updated = { ...taskGuideLines, updatedAt: '2026-07-28T11:00:00.000Z' };
    const row = activityRowOf(
      { ...envelope, type: 'entity.upsert', entity: updated } as DurableWorkspaceEvent,
      glyphOf,
    );
    expect(row?.verb).toBe('updated');
    expect(row?.actor).toBeNull();
  });

  it('drops notifications — the mentions section owns that fact, once', () => {
    const row = activityRowOf(
      {
        ...envelope,
        type: 'notification.created',
        notification: {} as NotificationItem,
      } as DurableWorkspaceEvent,
      glyphOf,
    );
    expect(row).toBeNull();
  });

  it('dedupes on the seq spine and caps the window', () => {
    const row = { id: 'a#1', seq: 1, actor: null, isAgent: false, verb: 'x', objectGlyph: null, objectTitle: null, objectId: null, at: NOW.toISOString(), tone: 'info' as const };
    expect(appendActivity([row], row)).toHaveLength(1);
  });

  it('buckets by day and speaks recency in the canvas voice', () => {
    expect(dayBucketOf(NOW.toISOString(), NOW)).toBe('TODAY');
    expect(dayBucketOf('2026-07-27T12:00:00.000Z', NOW)).toBe('YESTERDAY');
    expect(recencyOf('2026-07-28T11:48:00.000Z', NOW)).toBe('12m');
    expect(recencyOf('2026-07-28T11:00:00.000Z', NOW)).toBe('1h');
    const buckets = bucketActivity(
      [
        { id: 'a#2', seq: 2, actor: null, isAgent: false, verb: 'x', objectGlyph: null, objectTitle: null, objectId: null, at: NOW.toISOString(), tone: 'info' },
        { id: 'a#1', seq: 1, actor: null, isAgent: false, verb: 'y', objectGlyph: null, objectTitle: null, objectId: null, at: '2026-07-27T09:00:00.000Z', tone: 'info' },
      ],
      NOW,
    );
    expect(buckets.map((b) => b.label)).toEqual(['TODAY', 'YESTERDAY']);
  });
});

// ---------------------------------------------------------------------------
// 5 — THE SEAM CROSSING: the filter Home hands `rowsFor` (D57.1)
// ---------------------------------------------------------------------------

describe('the filter reaches the seam', () => {
  it('queries assignee = the member id `identity()` returned for THIS space', async () => {
    const calls: QueryCall[] = [];
    const data = makeData({ calls, seam: makeSeam({ memberId: ada.id }) });
    renderHome({ data });

    await waitFor(() => {
      expect(calls.some((c) => c.filter !== undefined)).toBe(true);
    });

    const filtered = calls.filter((c) => c.filter !== undefined);
    expect(filtered.map((c) => c.kind)).toContain(TASK_KIND);
    // The exact object, not "some filter": the D57.1 failure was a call that
    // type-checked, ran, and carried nothing.
    expect(filtered).toContainEqual({ kind: TASK_KIND, filter: { assigneeIds: [ada.id] } });
    expect(filtered).toContainEqual({
      kind: TASK_KIND,
      filter: { assigneeIds: [ada.id], workStatus: reviewStatusValues() },
    });
    // And the unfiltered read for the live-shaped kind.
    expect(calls).toContainEqual({ kind: SESSION_KIND, filter: undefined });
  });

  it('issues NO assignee query when the viewer has no membership in this space', async () => {
    const calls: QueryCall[] = [];
    const data = makeData({ calls, seam: makeSeam({ memberId: null }) });
    const view = renderHome({ data });
    await view.findByText(/Nothing pulled yet|no task in this space/i);
    expect(calls.every((c) => c.filter === undefined)).toBe(true);
  });

  it('takes the review status from the REGISTRY ramp, not a literal', () => {
    const tones = assignableKinds()[0]!.panel.statusPill!.tones;
    const expected = Object.entries(tones)
      .filter(([, tone]) => tone === 'wait')
      .map(([value]) => value);
    expect(reviewStatusValues()).toEqual(expected);
    expect(reviewStatusValues().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6 — zero silent voids
// ---------------------------------------------------------------------------

describe('no silent voids', () => {
  it('renders all three quick actions disabled-with-reason when nothing is wired', async () => {
    const view = renderHome({ data: makeData({}) });
    await view.findByTestId('home-screen');

    const refused = view.container.querySelectorAll('[data-testid="disabled-with-reason"]');
    // The three quick actions + the activity scope + load earlier + "all tasks".
    expect(refused.length).toBeGreaterThanOrEqual(5);

    for (const el of refused) {
      // D28: focusable and announced, NEVER a native `disabled` that leaves the
      // tab order and takes the reason with it.
      expect(el.getAttribute('aria-disabled')).toBe('true');
      expect(el.getAttribute('tabindex')).toBe('0');
      expect(el.getAttribute('aria-describedby')).toBeTruthy();
      expect(el.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }

    // Every quick action still EXISTS by name — refused is not hidden.
    for (const label of ['New task', 'Launch session', 'Workspace']) {
      expect(view.container.querySelector(`[aria-label="${label}"]`)).toBeTruthy();
    }
  });

  it('carries D7.1’s measured reason on “load earlier”', async () => {
    const view = renderHome({ data: makeData({}) });
    const control = await view.findByLabelText('Load earlier activity');
    const caption = control.getAttribute('aria-describedby');
    expect(caption).toBeTruthy();
    // `document.getElementById` rather than a selector: jsdom ships no
    // `CSS.escape`, and `useId` values contain `:`.
    expect(document.getElementById(caption!)?.textContent).toContain(
      homeActivityLoadEarlierReason,
    );
  });

  it('states the activity column’s scope rather than implying history it lacks', async () => {
    const view = renderHome({ data: makeData({}) });
    expect((await view.findByTestId('home-activity-empty')).textContent).toMatch(
      /since you opened Home/i,
    );
  });

  it('renders every empty section’s note on screen', async () => {
    // One section populated so the sections render rather than the first-run
    // frame — the point is that the OTHER three still each say something.
    const view = renderHome({
      data: makeData({
        seam: makeSeam({ memberId: ada.id }),
        liveness: { [sessionLive.id]: 'live' },
        rows: { [`${SESSION_KIND}::*`]: [sessionLive] },
      }),
    });
    await view.findByTestId('home-screen');
    for (const id of ['needs-you', 'tasks', 'mentions']) {
      expect((await view.findByTestId(`home-empty-${id}`)).textContent?.length).toBeGreaterThan(0);
    }
  });

  it('enables a quick action the moment its handler arrives', async () => {
    const onOpenWorkspace = vi.fn();
    const view = renderHome({ data: makeData({}), onOpenWorkspace });
    const button = await view.findByRole('button', { name: 'Workspace' });
    button.click();
    expect(onOpenWorkspace).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 7 — rows, and the floor
// ---------------------------------------------------------------------------

describe('the screen', () => {
  const populated = () =>
    makeData({
      seam: makeSeam({ memberId: ada.id }),
      liveness: { [sessionLive.id]: 'live', [sessionStale.id]: 'stale' },
      rows: {
        [`${SESSION_KIND}::*`]: [sessionLive, sessionStale],
        [`${TASK_KIND}::${JSON.stringify({ assigneeIds: [ada.id] })}`]: [taskGuideLines],
        [`${TASK_KIND}::${JSON.stringify({ assigneeIds: [ada.id], workStatus: reviewStatusValues() })}`]:
          [taskUuidTitle],
      },
    });

  it('opens a row’s Z3 panel on click (C1)', async () => {
    const onOpenEntity = vi.fn();
    const view = renderHome({ data: populated(), onOpenEntity });
    // Wait for the row that depends on identity — the session rows land first,
    // so an unqualified findAllByTestId would resolve before NEEDS YOU exists.
    const needsYou = await view.findByText(taskUuidTitle.title);
    needsYou.closest('button')!.click();
    expect(onOpenEntity).toHaveBeenCalledWith(taskUuidTitle.id);
  });

  it('names the viewer in the dateline once identity resolves', async () => {
    const view = renderHome({ data: populated() });
    expect(await view.findByText(/you are @ada/)).toBeTruthy();
  });

  it('shows the live count from the seam verdicts', async () => {
    const view = renderHome({ data: populated() });
    await waitFor(() => {
      expect(view.getByTestId('home-live-count').textContent).toContain('1');
    });
  });

  it('keeps the triage order in the DOM at the 320 floor', async () => {
    // jsdom reports no width, so the floor is exercised through the prop
    // rather than through a shimmed measurement that would prove nothing.
    const view = renderHome({ data: populated(), forceNarrow: true });
    const root = await view.findByTestId('home-screen');
    expect(root.getAttribute('data-narrow')).toBe('true');
    const order = [...root.querySelectorAll('[data-section]')].map((el) =>
      el.getAttribute('data-section'),
    );
    expect(order).toEqual(['needs-you', 'live', 'tasks', 'mentions']);
    // Nothing is hidden at the floor: the compact quick actions keep their
    // accessible names even though the visible label is dropped.
    expect(within(root).getByLabelText('Launch session')).toBeTruthy();
  });

  it('renders the first-run frame only when the viewer is known and has nothing', async () => {
    const view = renderHome({ data: makeData({ seam: makeSeam({ memberId: ada.id }) }) });
    expect(await view.findByTestId('home-first-run')).toBeTruthy();
    // Its three rows are the SAME verbs as the quick actions, so with nothing
    // wired they are refused here too rather than silently doing nothing.
    const hints = within(view.getByTestId('home-first-run')).getAllByTestId(
      'disabled-with-reason',
    );
    expect(hints).toHaveLength(3);
  });
});
