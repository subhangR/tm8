// @vitest-environment jsdom
/**
 * THE ATTACHMENT STRIP MUST ACTUALLY REFRESH — proved by execution, not by
 * reading the JSX.
 *
 * === WHAT WAS BROKEN, AND WHY EVERY GATE STAYED GREEN ===
 *
 * All four production hosts wired `onAttachmentUploaded={() => data.pull?.(id)}`
 * and the panel bound `onDetached` to the same callback. That callback is a
 * NO-OP for the only case it is ever invoked in:
 *
 *   needsDetail = details[id] === undefined && !pulledDetails.has(id)
 *
 * An OPEN PANEL ALWAYS HAS ITS DETAIL CACHED — that is why it renders at all —
 * so `needsDetail` is false. `needsMessages` requires the anchor's message
 * counter to advance, and attaching a file advances no counter. Both halves
 * read fresh, `pull` early-returns, and no request is made. After a successful
 * upload the new row never appeared; after a successful detach the row never
 * went away. No spinner, no error — a dead button.
 *
 * Three separate guards did not catch it:
 *
 *  - `panel-host-wiring.test.ts` string-matched the PROP NAME in the mount
 *    block, so it passed while the callback did nothing.
 *  - `AttachmentStrip.test.tsx` asserts the strip CALLS `onUploaded`, which it
 *    always did. Whether the callback then changed anything is out of its
 *    frame.
 *  - `e2e/attachments-harness.tsx` runs its own `load()` calling `seam.entity`
 *    directly, so it exercises a refetch the product does not have.
 *
 * The gap sat exactly between them: nothing rendered a real `useGateData`
 * behind a real strip and asked whether the rows changed. That is this file.
 *
 * === WHAT EACH TEST PINS ===
 *
 * 1. `pull` still early-returns on a cached detail. This is NOT incidental —
 *    `renderPanel` calls `pull` FROM RENDER, so that early return is what
 *    stands between this app and an unbounded request loop. The fix had to be a
 *    second verb, and this test fails if someone "fixes" B1 by widening `pull`.
 * 2. `refetchDetail` re-reads unconditionally.
 * 3. THE EFFECT: a landed upload puts a row in the strip, through the same
 *    composition a host uses.
 * 4. THE EFFECT, other direction: a landed detach takes the row away.
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, renderHook, waitFor, within } from '@testing-library/react';
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
import { useGateData } from './useGateData';

const SPACE = 'spc-attach' as SpaceId;
const ANCHOR = 'ent-anchor' as EntityId;

const REASONS: DetailReasons = {
  presenceHollow: 'Presence isn’t measured yet.',
  versionHistory: 'Version history isn’t available yet.',
  provenanceHollow: 'Authorship provenance isn’t available yet.',
  shareUnavailable: 'Sharing into a session isn’t available yet.',
  withdrawUnavailable: 'Withdrawing a handoff isn’t available yet.',
};

function summary(id: string, over: Partial<EntitySummary> = {}): EntitySummary {
  return {
    id: id as EntitySummary['id'],
    spaceId: SPACE,
    kind: 'task' as EntitySummary['kind'],
    title: id,
    parentId: null,
    position: 0,
    visibility: 'space' as EntitySummary['visibility'],
    version: 1,
    activityAt: '2026-08-01T10:00:00.000Z',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    deletedAt: null,
    createdBy: { id: 'act-1', kind: 'member', displayName: 'me', isAgent: false } as EntitySummary['createdBy'],
    counters: { children: 0, comments: 0, reactions: 0, points: 0, messages: 0, viewerReaction: null },
    state: {
      kind: 'task',
      status: 'open',
      priority: 'medium',
      axes: {},
      assignees: [],
      acceptance: { total: 0, completed: 0 },
    },
    badges: {},
    ...over,
  } as EntitySummary;
}

/** A file ENTITY — the peer an `attached_to` edge points at. */
function fileSummary(id: string, name: string): EntitySummary {
  return summary(id, {
    title: name,
    kind: 'file' as EntitySummary['kind'],
    state: { kind: 'file', name, mimeType: 'application/pdf', sizeBytes: 4096 },
  } as Partial<EntitySummary>);
}

/**
 * The anchor's detail carrying `attached` files on real `attached_to` edges.
 *
 * The edges carry IDS, unlike some older fixtures: the id is what the store
 * keys its normalized edge family by, and it is the only handle `detach`
 * accepts. A fixture without one cannot exercise either path.
 */
function detailWith(attached: readonly EntitySummary[]): EntityDetail {
  const anchor = summary(ANCHOR);
  return {
    ...anchor,
    content: { kind: 'task', body: 'the anchor body' },
    hierarchy: { parent: null, children: { items: [], nextCursor: null }, path: [] },
    connections: {
      outgoing: [],
      incoming:
        attached.length === 0
          ? []
          : [
              {
                type: 'attached_to',
                direction: 'incoming',
                label: 'Attached to',
                edges: attached.map((file) => ({
                  id: `edge-${file.id}`,
                  type: 'attached_to',
                  source: file,
                  target: anchor,
                  props: {},
                  createdBy: anchor.createdBy,
                  createdAt: '2026-08-01T10:00:00.000Z',
                  updatedAt: '2026-08-01T10:00:00.000Z',
                })),
              },
            ],
      unresolvedHardDependencyCount: 0,
    },
    capabilities: {},
  } as unknown as EntityDetail;
}

interface Harness {
  seam: Seam;
  entityCalls: () => number;
  /** What the NEXT `seam.entity(ANCHOR)` will answer with. */
  setAttached: (files: readonly EntitySummary[]) => void;
}

function harness(initial: readonly EntitySummary[] = []): Harness {
  let attached = [...initial];
  let entityCalls = 0;
  const rows = [summary(ANCHOR)];

  const seam = {
    async openSpace() {},
    closeSpace() {},
    dispose() {},
    onEvent() { return () => {}; },
    onConnection() { return () => {}; },
    getConnection() { return { phase: 'live' as const }; },
    onResync() { return () => {}; },
    async identity() { throw new Error('not read by this test'); },
    async spaces() { return [{ id: SPACE, name: 'Attach', slug: 'attach' }] as never; },
    async menu() { return null; },
    async spaceSettings() { return { defaultInteractionProfileId: null } as never; },
    async projects() { return []; },
    async counts() { return {} as never; },
    async query(input: CollectionQuery) {
      const kinds = input.kinds ?? [];
      return {
        query: input,
        page: { items: rows.filter((r) => kinds.includes(r.kind)), nextCursor: undefined },
      } as never;
    },
    async graph() { return { nodes: rows, edges: [], clusters: [] }; },
    async entity(id: string) {
      entityCalls += 1;
      if (id !== ANCHOR) throw new Error(`unexpected read of ${id}`);
      return detailWith(attached) as never;
    },
    async connections() { return { items: [], nextCursor: null, total: 0 } as never; },
    async messages() { return { items: [], nextCursor: null, total: 0 } as never; },
    liveness: {
      async refresh() {
        return { spaceId: SPACE, liveEntityIds: [], nodeBootId: 'boot', checkedAt: '2026-08-01T10:00:00.000Z' };
      },
      onChange() { return () => {}; },
      statusOf() { return 'unknown' as const; },
    },
    realControls: { setSessionSurfaceVisible() {} },
    commands: {},
  } as unknown as Seam;

  return {
    seam,
    entityCalls: () => entityCalls,
    setAttached: (files) => { attached = [...files]; },
  };
}

/**
 * `useGateData` DECLARES `GateData` as its return type, and `GateData` does not
 * mention `pull` — the primitive is bolted on at the return as an intersection
 * and the hosts reach it through their own local prop declarations. This suite
 * is ABOUT `pull`, so it names the shape here rather than widening a shared
 * interface that no production file needs widened. `refetchDetail` needs no
 * such help: it is on `GateData`, deliberately and REQUIRED, because a host
 * that forgets it draws a control that changes nothing.
 */
function pull(data: ReturnType<typeof useGateData>, id: string): void {
  (data as ReturnType<typeof useGateData> & { pull(id: string): void }).pull(id);
}

describe('pull fills a cache; refetchDetail invalidates one', () => {
  it('pull() is a NO-OP once the detail is cached — and must stay one', async () => {
    const h = harness();
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => { pull(result.current, ANCHOR); await Promise.resolve(); });
    await waitFor(() => expect(result.current.detailOf(ANCHOR)).toBeDefined());
    const afterHydration = h.entityCalls();
    expect(afterHydration).toBeGreaterThan(0);

    // Ten more calls, exactly as a re-rendering panel produces them.
    for (let i = 0; i < 10; i += 1) {
      await act(async () => { pull(result.current, ANCHOR); await Promise.resolve(); });
    }

    expect(
      h.entityCalls(),
      'pull() must keep early-returning on a cached detail — renderPanel calls it FROM RENDER, ' +
        'so relaxing this is an unbounded request loop, not a fix for the strip',
    ).toBe(afterHydration);
  });

  it('refetchDetail() re-reads a cached detail and lands the new edge', async () => {
    const h = harness();
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => { pull(result.current, ANCHOR); await Promise.resolve(); });
    await waitFor(() => expect(result.current.detailOf(ANCHOR)).toBeDefined());
    const before = h.entityCalls();

    // The upload landed on the server: the next read carries the new edge.
    h.setAttached([fileSummary('file-1', 'spec.pdf')]);
    await act(async () => { result.current.refetchDetail(ANCHOR); await Promise.resolve(); });

    await waitFor(() => {
      expect(
        result.current.connectionsOf(ANCHOR)?.incoming.flatMap((g) => g.edges).length,
        'the anchor must be genuinely re-read, cached or not',
      ).toBe(1);
    });
    expect(h.entityCalls()).toBeGreaterThan(before);
  });
});

/**
 * THE COMPOSITION UNDER TEST is the one every host writes: the panel is fed
 * `detailOf` and a refetch bound to the strip's two completion callbacks. If
 * any link in that chain is a no-op, the row count below does not move.
 *
 * `connections` is passed because every real host passes it, but note that the
 * STRIP does not read it — see `attachedFiles`. The rows come off the detail
 * snapshot, so only a genuine re-read can change them, which is precisely what
 * these two tests are here to force.
 */
function Host({ data, port }: { data: ReturnType<typeof useGateData>; port: unknown }) {
  const detail = data.detailOf(ANCHOR);
  if (!detail) return <div data-testid="host-waiting" />;
  return (
    <EntityDetailPanel
      detail={detail}
      reasons={REASONS}
      ctx={{ spaceId: SPACE }}
      connections={data.connectionsOf(ANCHOR)}
      attachments={port as never}
      onAttachmentUploaded={() => data.refetchDetail(ANCHOR)}
    />
  );
}

function rowCount(container: HTMLElement): number {
  const strip = container.querySelector('[data-testid="attachment-strip"]');
  if (!strip) return 0;
  return within(strip as HTMLElement).queryAllByTestId('attachment-item').length;
}

describe('the strip changes on screen, without reopening the panel', () => {
  it('gains the row an upload just created', async () => {
    const h = harness();
    let resolveUpload: (value: { fileEntityId: string; name: string; mime: string }) => void = () => {};
    const port = {
      downloadHref: (id: string) => `/v2/files/${id}/download`,
      startUpload: () => ({
        result: new Promise((resolve) => { resolveUpload = resolve as typeof resolveUpload; }),
        cancel: () => {},
      }),
      detach: async () => {},
    };

    function Screen() {
      const data = useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam });
      const detail = data.detailOf(ANCHOR);
      if (data.ready && !detail) pull(data, ANCHOR);
      return <Host data={data} port={port} />;
    }

    const { container } = render(<Screen />);
    // The tiles live inside the description block (2026-08-16 addendum) and
    // are always present while an upload path is wired — the ＋ tile is the
    // empty state, so the input is reachable with nothing to reveal.
    await waitFor(() => expect(container.querySelector('[data-testid="attachment-strip"]')).toBeTruthy());
    expect(rowCount(container), 'nothing is attached yet').toBe(0);

    // Pick a file. The strip starts the upload and shows its pending tile.
    const input = container.querySelector('[data-testid="attachment-file-input"]') as HTMLInputElement;
    const file = new File(['bytes'], 'spec.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });

    // The server now holds the edge, and the upload resolves.
    h.setAttached([fileSummary('file-1', 'spec.pdf')]);
    await act(async () => {
      resolveUpload({ fileEntityId: 'file-1', name: 'spec.pdf', mime: 'application/pdf' });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        rowCount(container),
        'the uploaded file must appear WITHOUT reopening the panel — this is the whole defect',
      ).toBe(1);
    });
  });

  it('loses the row a detach just removed', async () => {
    const h = harness([fileSummary('file-1', 'spec.pdf')]);
    let resolveDetach: () => void = () => {};
    const port = {
      downloadHref: (id: string) => `/v2/files/${id}/download`,
      startUpload: () => ({ result: new Promise(() => {}), cancel: () => {} }),
      detach: () => new Promise<void>((resolve) => { resolveDetach = resolve; }),
    };

    function Screen() {
      const data = useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam });
      const detail = data.detailOf(ANCHOR);
      if (data.ready && !detail) pull(data, ANCHOR);
      return <Host data={data} port={port} />;
    }

    const { container } = render(<Screen />);
    await waitFor(() => expect(rowCount(container)).toBe(1));

    // Remove lives in the lightbox now — open the tile first (open before
    // asserting, never delete an assertion).
    fireEvent.click(container.querySelector('[data-testid="attachment-item"]')!);
    const button = container.querySelector('[data-testid="attachment-detach"]') as HTMLButtonElement;
    expect(button, 'a row read through an edge must offer a detach control').toBeTruthy();
    await act(async () => { button.click(); });

    // The edge is gone on the server; the command resolves.
    h.setAttached([]);
    await act(async () => { resolveDetach(); await Promise.resolve(); });

    await waitFor(() => {
      expect(
        rowCount(container),
        'a detached file must disappear WITHOUT reopening the panel',
      ).toBe(0);
    });
  });
});
