// @vitest-environment jsdom
/**
 * AN OPEN PANEL CONVERGES ON SOMEONE ELSE'S EDIT — proved by rendering it.
 *
 * === WHAT WAS BROKEN, AND WHY NO GATE SAW IT ===
 *
 * `entity.upsert` carries an `EntitySummary` and no content, and the store
 * overlays it on the cached detail to keep the heavy sections. So an open doc,
 * drawing or artifact showed the new VERSION and the old CONTENT, and kept
 * showing it: `refetchDetail` only runs after the viewer's own actions, and
 * `pull` is a cache-fill that early-returns on a cached detail — which an open
 * panel always has, by construction. Nothing re-read on an incoming bump.
 *
 * The existing suites could not catch it. `reducers.test.ts` asserts the merge
 * KEEPS the heavy sections (which is the behaviour, not the bug);
 * `DrawingBlock.test.tsx` feeds the block details by hand, so the re-read it
 * waits for is supplied by the test. Nothing rendered a real `useGateData`
 * behind a real panel, pushed an event through the real stream, and asked
 * whether the words on screen changed. That is this file.
 *
 * === WHAT EACH TEST PINS ===
 *
 * 1. THE EFFECT: a remote edit lands the new body in an open doc, no reload.
 * 2. ONE READ PER BUMP, and it is caused by the EVENT, not by render — a
 *    re-rendering panel with nothing stale issues no requests at all. The
 *    comments on `pull` explain why that distinction is the difference between
 *    a fix and an unbounded request loop against the node.
 * 3. A BURST COALESCES to one read of the newest version.
 * 4. CONTENT ARRIVES PAIRED WITH ITS VERSION — the precondition
 *    `DrawingBlock`'s adopt-guard is written against (QA: v14 banked over
 *    white, the yellow v14 never drawn).
 * 5. NOTHING IS ASKED FOR AN ENTITY NOBODY HAS OPEN.
 */
import { describe, expect, it } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import type {
  CollectionQuery,
  DurableWorkspaceEvent,
  EntityDetail,
  EntityId,
  EntitySummary,
  SpaceId,
} from '@tm8/contract';
import type { Seam } from '../data/seam';
import { EntityDetailPanel, type DetailReasons } from '../panels';
import { DetailFreshnessProvider, FRESHEN_DEBOUNCE_MS } from '../panels/detail/freshness';
import { useGateData } from './useGateData';

const SPACE = 'spc-stale' as SpaceId;
const DOC = 'doc-live' as EntityId;
/** Comfortably past the settle, so a missing re-read fails rather than races. */
const SETTLED = FRESHEN_DEBOUNCE_MS + 600;

const REASONS: DetailReasons = {
  presenceHollow: 'Presence isn’t measured yet.',
  versionHistory: 'Version history isn’t available yet.',
  provenanceHollow: 'Authorship provenance isn’t available yet.',
  shareUnavailable: 'Sharing into a session isn’t available yet.',
  withdrawUnavailable: 'Withdrawing a handoff isn’t available yet.',
};

function docSummary(id: string, version: number, over: Partial<EntitySummary> = {}): EntitySummary {
  return {
    id: id as EntitySummary['id'],
    spaceId: SPACE,
    kind: 'doc' as EntitySummary['kind'],
    title: 'Layout spec',
    parentId: null,
    position: 0,
    visibility: 'space' as EntitySummary['visibility'],
    version,
    activityAt: '2026-10-18T10:00:00.000Z',
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
    deletedAt: null,
    createdBy: { id: 'act-1', kind: 'member', displayName: 'me', isAgent: false } as EntitySummary['createdBy'],
    counters: { children: 0, comments: 0, reactions: 0, points: 0, messages: 0, viewerReaction: null },
    state: { kind: 'doc', format: 'markdown', childCount: 0 },
    badges: {},
    ...over,
  } as EntitySummary;
}

function docDetail(version: number, body: string): EntityDetail {
  return {
    ...docSummary(DOC, version),
    content: { kind: 'doc', body, format: 'markdown' },
    hierarchy: { parent: null, children: { items: [], nextCursor: null }, path: [] },
    connections: { outgoing: [], incoming: [], unresolvedHardDependencyCount: 0 },
    capabilities: {},
  } as unknown as EntityDetail;
}

interface Harness {
  seam: Seam;
  reads: () => number;
  /** What the NEXT `seam.entity(DOC)` answers with — the server's state. */
  publish: (version: number, body: string) => void;
  /** Announce the version over the live stream, carrying NO content. */
  announce: (version: number) => void;
  /** The same, for an id this client has never opened. */
  announceOther: (id: string, version: number) => void;
}

function harness(): Harness {
  let served = docDetail(1, 'the original body');
  let reads = 0;
  const listeners = new Set<(e: DurableWorkspaceEvent) => void>();

  const seam = {
    async openSpace() {},
    closeSpace() {},
    dispose() {},
    onEvent(cb: (e: DurableWorkspaceEvent) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onConnection() { return () => {}; },
    getConnection() { return { phase: 'live' as const }; },
    onResync() { return () => {}; },
    async identity() { throw new Error('not read by this test'); },
    async spaces() { return [{ id: SPACE, name: 'Stale', slug: 'stale' }] as never; },
    async menu() { return null; },
    async spaceSettings() { return { defaultInteractionProfileId: null } as never; },
    async projects() { return []; },
    async counts() { return {} as never; },
    async query(input: CollectionQuery) {
      const kinds = input.kinds ?? [];
      const rows = kinds.includes('doc') ? [docSummary(DOC, served.version)] : [];
      return { query: input, page: { items: rows, nextCursor: undefined } } as never;
    },
    async graph() { return { nodes: [], edges: [], clusters: [] }; },
    async entity(id: string) {
      reads += 1;
      if (id !== DOC) throw new Error(`unexpected read of ${id}`);
      return served as never;
    },
    async connections() { return { items: [], nextCursor: null, total: 0 } as never; },
    async messages() { return { items: [], nextCursor: null, total: 0 } as never; },
    liveness: {
      async refresh() {
        return { spaceId: SPACE, liveEntityIds: [], nodeBootId: 'boot', checkedAt: '2026-10-18T10:00:00.000Z' };
      },
      onChange() { return () => {}; },
      statusOf() { return 'unknown' as const; },
    },
    realControls: { setSessionSurfaceVisible() {} },
    commands: {},
  } as unknown as Seam;

  // The real shape of the event: a SUMMARY. There is no `content` member on
  // it, which is the entire reason this bug class is possible.
  const emit = (id: string, version: number) => {
    const e = {
      type: 'entity.upsert',
      spaceId: SPACE,
      seq: version,
      at: '2026-10-18T10:00:00.000Z',
      entity: docSummary(id, version),
    } as unknown as DurableWorkspaceEvent;
    for (const cb of listeners) cb(e);
  };

  return {
    seam,
    reads: () => reads,
    publish: (version, body) => { served = docDetail(version, body); },
    announce: (version) => emit(DOC, version),
    announceOther: (id, version) => emit(id, version),
  };
}

function pull(data: ReturnType<typeof useGateData>, id: string): void {
  (data as ReturnType<typeof useGateData> & { pull(id: string): void }).pull(id);
}

/**
 * THE COMPOSITION UNDER TEST — a host mounting the panel inside the provider,
 * which is what `GateApp` does for every shell. No freshness prop is passed to
 * the panel: the point of the context is that a host wires nothing per panel.
 */
function Screen({ h, onRender }: { h: Harness; onRender?: () => void }) {
  const data = useGateData({ leftKind: 'doc', rightKind: 'work_session', seam: h.seam });
  const detail = data.detailOf(DOC);
  if (data.ready && !detail) pull(data, DOC);
  onRender?.();
  return (
    <DetailFreshnessProvider staleDetails={data.staleDetails} freshenDetail={data.freshenDetail}>
      {detail ? <EntityDetailPanel detail={detail} reasons={REASONS} ctx={{ spaceId: SPACE }} /> : <div data-testid="waiting" />}
    </DetailFreshnessProvider>
  );
}

/** The doc's body as the reader draws it. */
function bodyText(container: HTMLElement): string {
  return container.querySelector('[data-testid="reader-document"]')?.textContent
    ?? container.textContent
    ?? '';
}

describe('an open doc converges on a remote edit', () => {
  it('shows the new body within the settle, without a reload', async () => {
    const h = harness();
    const { container } = render(<Screen h={h} />);
    await waitFor(() => expect(bodyText(container)).toContain('the original body'));

    // Someone else saves. The node holds v2; the stream announces v2 and
    // carries none of it.
    h.publish(2, 'the body SOMEONE ELSE wrote');
    await act(async () => { h.announce(2); await Promise.resolve(); });

    await waitFor(
      () => {
        expect(
          bodyText(container),
          'the open doc must converge on the remote edit without a reload — the whole defect',
        ).toContain('the body SOMEONE ELSE wrote');
      },
      { timeout: SETTLED },
    );
  });

  it('issues ONE read for the bump, and none from render', async () => {
    const h = harness();
    let renders = 0;
    const { container, rerender } = render(<Screen h={h} onRender={() => { renders += 1; }} />);
    await waitFor(() => expect(bodyText(container)).toContain('the original body'));
    const afterHydration = h.reads();

    /* RENDER ALONE ASKS FOR NOTHING. Ten re-renders with no mark outstanding:
       if freshness were consulted from render instead of from an effect keyed
       on the announced version, this is where the loop would show up. */
    const rendersBefore = renders;
    for (let i = 0; i < 10; i += 1) {
      await act(async () => { rerender(<Screen h={h} onRender={() => { renders += 1; }} />); });
    }
    expect(renders).toBeGreaterThan(rendersBefore);
    expect(h.reads(), 'a re-rendering panel with nothing stale must issue no reads').toBe(afterHydration);

    // Now one real bump.
    h.publish(2, 'v2 body');
    await act(async () => { h.announce(2); await Promise.resolve(); });
    await waitFor(() => expect(bodyText(container)).toContain('v2 body'), { timeout: SETTLED });

    expect(h.reads(), 'exactly one re-read answers one version bump').toBe(afterHydration + 1);

    // And it stays settled: no further reads once the mark is answered.
    await act(async () => { await new Promise((r) => setTimeout(r, FRESHEN_DEBOUNCE_MS + 200)); });
    expect(h.reads()).toBe(afterHydration + 1);
  });

  it('coalesces a burst into one read of the newest version', async () => {
    const h = harness();
    const { container } = render(<Screen h={h} />);
    await waitFor(() => expect(bodyText(container)).toContain('the original body'));
    const before = h.reads();

    // Three saves in quick succession — the state the viewer should land on is
    // the last one, and the two it skipped are not worth a round trip each.
    h.publish(4, 'the fourth body');
    await act(async () => {
      h.announce(2);
      h.announce(3);
      h.announce(4);
      await Promise.resolve();
    });

    await waitFor(() => expect(bodyText(container)).toContain('the fourth body'), { timeout: SETTLED });
    expect(h.reads(), 'three bumps inside the settle are one fact, read once').toBe(before + 1);
  });

  it('pairs the new content with the new version — the drawing adopt-guard’s precondition', async () => {
    /* `DrawingBlock` adopts a newer version ONLY with content that was really
       re-read (`detail.content !== bankedContentRef.current`), because banking
       a version against old content turns the real content away when it
       arrives at the same version. That guard is correct and was unreachable:
       nothing re-read. This asserts what it needs — version and content moving
       together, in one detail. */
    const h = harness();
    const seen: { version: number; body: string }[] = [];

    function Watcher({ data }: { data: ReturnType<typeof useGateData> }) {
      const detail = data.detailOf(DOC);
      if (detail) seen.push({ version: detail.version, body: (detail.content as { body: string }).body });
      return null;
    }
    function Host() {
      const data = useGateData({ leftKind: 'doc', rightKind: 'work_session', seam: h.seam });
      if (data.ready && !data.detailOf(DOC)) pull(data, DOC);
      return (
        <DetailFreshnessProvider staleDetails={data.staleDetails} freshenDetail={data.freshenDetail}>
          {data.detailOf(DOC)
            ? <EntityDetailPanel detail={data.detailOf(DOC)!} reasons={REASONS} ctx={{ spaceId: SPACE }} />
            : null}
          <Watcher data={data} />
        </DetailFreshnessProvider>
      );
    }

    render(<Host />);
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));

    h.publish(14, 'the yellow scene');
    await act(async () => { h.announce(14); await Promise.resolve(); });
    await waitFor(
      () => expect(seen.some((s) => s.version === 14 && s.body === 'the yellow scene')).toBe(true),
      { timeout: SETTLED },
    );

    // The interim state (v14 over v13's content) is what the store merges and
    // what the block refuses to bank. What matters is that the PAIRED state
    // arrives at all — it never used to.
    const paired = seen.filter((s) => s.version === 14 && s.body === 'the yellow scene');
    expect(paired.length, 'v14 must become readable WITH v14 content').toBeGreaterThan(0);
  });

  it('asks for nothing when no view is open on the entity that changed', async () => {
    const h = harness();
    const { container } = render(<Screen h={h} />);
    await waitFor(() => expect(bodyText(container)).toContain('the original body'));
    const before = h.reads();

    /* A bump for an id this client holds no content for — a row in a list at
       most. `seam.entity` throws on any id but DOC, so a stray read would fail
       this test loudly rather than quietly inflating the count. */
    await act(async () => { h.announceOther('doc-nobody-opened', 7); await Promise.resolve(); });
    await act(async () => { await new Promise((r) => setTimeout(r, FRESHEN_DEBOUNCE_MS + 200)); });

    expect(h.reads(), 'an entity nobody has open is never re-read').toBe(before);
  });
});
