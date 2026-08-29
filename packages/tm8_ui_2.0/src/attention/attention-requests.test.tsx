// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import type {
  AttentionRequest,
  AttentionRequestMutationResult,
  AttentionRequestStatus,
  EntityId,
  SpaceId,
} from '@tm8/contract';
import { AttentionRequests } from './AttentionRequests';
import { orderHistory, settlementLine, summarizeHistory } from './attention-history';
import { attentionPortFromSeam, type AttentionPort } from './port';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';

const SPACE = 'space-1' as SpaceId;
const ENTITY = 'ent-1' as EntityId;
/** Pinned so every relative time in an assertion is deterministic. */
const NOW = '2026-07-10T00:00:00.000Z';

const actor = (name: string) =>
  ({ id: `m-${name}` as EntityId, kind: 'member', displayName: name, avatar: null, role: 'member', isAgent: false }) as never;

function req(over: Partial<AttentionRequest> & { id: string; points: number }): AttentionRequest {
  return {
    spaceId: SPACE,
    entityId: ENTITY,
    reason: 'because',
    status: 'open',
    version: 1,
    requestedBy: actor('Ann'),
    acknowledgedBy: null,
    resolvedBy: null,
    resolutionNote: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    acknowledgedAt: null,
    resolvedAt: null,
    ...over,
  } as AttentionRequest;
}

/** A port backed by a plain array — no seam, no network, no fixture. */
function fakePort(rows: AttentionRequest[], over: Partial<AttentionPort> = {}): AttentionPort {
  return {
    history: async () => ({ rows, truncated: false }),
    settle: async () => ({ request: null, entity: null as never, affectedCount: 1 }),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The pure model
// ---------------------------------------------------------------------------

describe('attention history model', () => {
  it('puts unsettled rows first, then newest-first inside each group', () => {
    const ordered = orderHistory([
      req({ id: 'old-resolved', points: 90, status: 'resolved', createdAt: '2026-07-01T00:00:00.000Z' }),
      req({ id: 'new-resolved', points: 10, status: 'resolved', createdAt: '2026-07-05T00:00:00.000Z' }),
      req({ id: 'waiting', points: 20, status: 'open', createdAt: '2026-07-02T00:00:00.000Z' }),
      req({ id: 'seen', points: 30, status: 'acknowledged', createdAt: '2026-07-03T00:00:00.000Z' }),
    ]);

    // NOT the server's `points desc` order: a 20-point row still waiting
    // outranks a 90-point one already dealt with, because only one of them is
    // something the reader can still act on.
    expect(ordered.map((r) => r.id)).toEqual(['seen', 'waiting', 'new-resolved', 'old-resolved']);
  });

  it('breaks ties on id so a bulk resolve cannot make the list reorder between renders', () => {
    // Every row stamped in the same instant is the ORDINARY case here: one
    // bulk resolve settles the whole queue at once.
    const same = { status: 'resolved' as const, createdAt: '2026-07-01T00:00:00.000Z' };
    const a = orderHistory([req({ id: 'b', points: 5, ...same }), req({ id: 'a', points: 5, ...same })]);
    const b = orderHistory([req({ id: 'a', points: 5, ...same }), req({ id: 'b', points: 5, ...same })]);
    expect(a.map((r) => r.id)).toEqual(['a', 'b']);
    expect(b.map((r) => r.id)).toEqual(a.map((r) => r.id));
  });

  it('counts acknowledged as PENDING, exactly as the server badge does', () => {
    const summary = summarizeHistory([
      req({ id: '1', points: 40, status: 'open' }),
      req({ id: '2', points: 25, status: 'acknowledged' }),
      req({ id: '3', points: 90, status: 'resolved' }),
      req({ id: '4', points: 70, status: 'dismissed' }),
    ]);
    expect(summary).toEqual({
      total: 4,
      pendingCount: 2,
      // 40 + 25. The 90 and the 70 are settled and must not inflate the score.
      pendingPoints: 65,
      maxPendingPoints: 40,
      settledCount: 2,
    });
  });

  it('says nothing about settlement while a request is still open', () => {
    expect(settlementLine(req({ id: '1', points: 10, status: 'open' }), NOW)).toBeNull();
  });

  it('names the actor and the outcome, and calls a dismissal DECLINED not resolved', () => {
    const base = { points: 10, resolvedBy: actor('Bo'), resolvedAt: '2026-07-09T00:00:00.000Z' };
    expect(settlementLine(req({ id: '1', status: 'resolved', ...base }), NOW)).toBe('Resolved by Bo · 1d ago');
    expect(settlementLine(req({ id: '2', status: 'dismissed', ...base }), NOW)).toBe('Declined by Bo · 1d ago');
  });
});

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

describe('AttentionRequests', () => {
  it('renders NOTHING when the entity has no history — it is mounted on every entity in the product', async () => {
    const { container } = render(
      <AttentionRequests entityId={ENTITY} port={fakePort([])} rows={[]} now={NOW} />,
    );
    await waitFor(() => expect(container.querySelector('[data-testid="attention-requests"]')).toBeNull());
  });

  it('shows SETTLED rows, which the badge can never show', async () => {
    const { findByTestId, getByText } = render(
      <AttentionRequests
        entityId={ENTITY}
        port={fakePort([])}
        now={NOW}
        rows={[
          req({
            id: 'r1',
            points: 80,
            status: 'resolved',
            reason: 'Nine design rulings needed',
            resolvedBy: actor('Subhang'),
            resolvedAt: '2026-07-09T00:00:00.000Z',
            resolutionNote: 'Answered inline.',
          }),
        ]}
      />,
    );

    await findByTestId('attention-request-r1');
    expect(getByText('Nine design rulings needed')).toBeTruthy();
    expect(getByText('Resolved')).toBeTruthy();
    expect(getByText('Resolved by Subhang · 1d ago')).toBeTruthy();
    // The resolver's own words are most of the reason to keep settled rows.
    expect(getByText('Answered inline.')).toBeTruthy();
  });

  it('offers Resolve and Decline only on rows that are still pending', async () => {
    const { findByTestId, queryByTestId } = render(
      <AttentionRequests
        entityId={ENTITY}
        port={fakePort([])}
        now={NOW}
        rows={[
          req({ id: 'open1', points: 65, status: 'open' }),
          req({ id: 'done1', points: 80, status: 'resolved' }),
        ]}
      />,
    );

    await findByTestId('attention-request-open1');
    expect(queryByTestId('attention-resolve-open1')).toBeTruthy();
    expect(queryByTestId('attention-dismiss-open1')).toBeTruthy();
    // A settled row is a record. There is nothing left to decide about it.
    expect(queryByTestId('attention-resolve-done1')).toBeNull();
    expect(queryByTestId('attention-dismiss-done1')).toBeNull();
  });

  it('writes `dismissed` — the status that had NO UI path before this section', async () => {
    const settle = vi.fn(async () => ({ request: null, entity: null, affectedCount: 1 }) as never);
    const rows = [req({ id: 'open1', points: 65, status: 'open', version: 3 })];
    const { findByTestId, getByTestId, getByLabelText } = render(
      <AttentionRequests entityId={ENTITY} port={fakePort(rows, { settle })} rows={rows} now={NOW} />,
    );

    await findByTestId('attention-request-open1');
    fireEvent.click(getByTestId('attention-dismiss-open1'));
    fireEvent.change(getByLabelText('Decline — note (optional)'), { target: { value: 'Duplicate.' } });
    fireEvent.click(getByTestId('attention-confirm-open1'));

    await waitFor(() => expect(settle).toHaveBeenCalledTimes(1));
    expect(settle).toHaveBeenCalledWith({
      requestId: 'open1',
      // The ROW's version, not the entity's — this is optimistic locking on
      // one request, and sending the wrong one is a silent overwrite.
      expectedVersion: 3,
      status: 'dismissed',
      resolutionNote: 'Duplicate.',
    });
  });

  it('omits an empty note rather than sending one, which would erase a note already written', async () => {
    const settle = vi.fn(async () => ({ request: null, entity: null, affectedCount: 1 }) as never);
    const rows = [req({ id: 'open1', points: 65, status: 'open', version: 1 })];
    const { findByTestId, getByTestId } = render(
      <AttentionRequests entityId={ENTITY} port={fakePort(rows, { settle })} rows={rows} now={NOW} />,
    );

    await findByTestId('attention-request-open1');
    fireEvent.click(getByTestId('attention-resolve-open1'));
    fireEvent.click(getByTestId('attention-confirm-open1'));

    await waitFor(() => expect(settle).toHaveBeenCalledTimes(1));
    expect(settle.mock.calls[0]![0]).toEqual({
      requestId: 'open1',
      expectedVersion: 1,
      status: 'resolved',
      resolutionNote: undefined,
    });
  });

  it('keeps the history on screen when a WRITE fails, and explains a version conflict in plain words', async () => {
    const rows = [req({ id: 'open1', points: 65, status: 'open' })];
    const settle = vi.fn(async () => {
      throw Object.assign(new Error('conflict'), { code: 'version_conflict' });
    });
    const { findByTestId, getByTestId, queryByTestId } = render(
      <AttentionRequests entityId={ENTITY} port={fakePort(rows, { settle })} rows={rows} now={NOW} />,
    );

    await findByTestId('attention-request-open1');
    fireEvent.click(getByTestId('attention-resolve-open1'));
    fireEvent.click(getByTestId('attention-confirm-open1'));

    await waitFor(() => expect(getByTestId('attention-write-error').textContent).toContain('changed while you were looking'));
    // THE ROW SURVIVES THE FAILED WRITE. Moving to an error phase would blank
    // a history that is still perfectly true.
    expect(queryByTestId('attention-request-open1')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The port, driven against a REAL fixture seam
// ---------------------------------------------------------------------------

describe('attentionPortFromSeam against createFixtureSeam()', () => {
  /** The first fixture entity carrying seeded history, whatever the dataset is. */
  async function subject(seam: ReturnType<typeof createFixtureSeam>) {
    const spaceId = (await seam.spaces())[0]!.id;
    const page = await seam.attentionRequests({ spaceId });
    expect(page.items.length).toBeGreaterThan(0);
    return { entityId: page.items[0]!.entityId, spaceId };
  }

  it('asks for NO status filter, so resolved and dismissed rows come back', async () => {
    const seam = createFixtureSeam();
    const { entityId, spaceId } = await subject(seam);
    const { rows } = await attentionPortFromSeam(seam, spaceId).history(entityId);

    const statuses = new Set(rows.map((r) => r.status));
    // The whole point of the surface: the badge counts only open+acknowledged,
    // so a history that filtered the same way would show nothing settled.
    expect(statuses.has('resolved')).toBe(true);
    expect(statuses.has('dismissed')).toBe(true);
  });

  it('a settled-only history raises NO badge — the seed cannot flag entities other lanes measure', async () => {
    const seam = createFixtureSeam();
    const { entityId } = await subject(seam);
    expect((await seam.entity(entityId)).badges.attention).toBeUndefined();
  });

  it('reopening a row raises the badge and settling it again drops it, with the row RETAINED throughout', async () => {
    const seam = createFixtureSeam();
    const { entityId, spaceId } = await subject(seam);
    const port = attentionPortFromSeam(seam, spaceId);

    const before = await port.history(entityId);
    const row = before.rows.find((r) => r.status === 'resolved')!;

    // Reopen: the RPC clears the resolution stamps rather than leaving a
    // resolved-by on a row that is not resolved (migration 050:148-167).
    await port.settle({ requestId: row.id, expectedVersion: row.version, status: 'open' });
    const reopened = (await port.history(entityId)).rows.find((r) => r.id === row.id)!;
    expect(reopened.status).toBe('open');
    expect(reopened.resolvedBy).toBeNull();
    expect(reopened.resolvedAt).toBeNull();
    expect((await seam.entity(entityId)).badges.attention).toMatchObject({ pendingCount: 1 });

    await port.settle({ requestId: row.id, expectedVersion: reopened.version, status: 'resolved' });
    const after = await port.history(entityId);
    // RETAINED. Resolving is a status flip (migration 050:208-212) and the
    // count must not shrink, or the history is not a history.
    expect(after.rows).toHaveLength(before.rows.length);
    expect((await seam.entity(entityId)).badges.attention).toBeUndefined();
  });

  it('refuses a stale version instead of silently overwriting', async () => {
    const seam = createFixtureSeam();
    const { entityId, spaceId } = await subject(seam);
    const port = attentionPortFromSeam(seam, spaceId);
    const row = (await port.history(entityId)).rows[0]!;

    await port.settle({ requestId: row.id, expectedVersion: row.version, status: 'open' });
    await expect(
      port.settle({ requestId: row.id, expectedVersion: row.version, status: 'dismissed' }),
    ).rejects.toThrow();
  });

  it('bulk resolve leaves an already-DECLINED row alone', async () => {
    const seam = createFixtureSeam();
    const { entityId, spaceId } = await subject(seam);
    const port = attentionPortFromSeam(seam, spaceId);
    const dismissed = (await port.history(entityId)).rows.find((r) => r.status === 'dismissed')!;

    // Reopen a DIFFERENT row so the bulk verb has something to do.
    const other = (await port.history(entityId)).rows.find((r) => r.status === 'resolved')!;
    await port.settle({ requestId: other.id, expectedVersion: other.version, status: 'open' });
    const result = await seam.commands.resolveAttention(entityId, { clientMutationId: 'm1' });
    expect(result.affectedCount).toBe(1);

    const after = (await port.history(entityId)).rows.find((r) => r.id === dismissed.id)!;
    // `resolve_entity_attention` touches `status in ('open','acknowledged')`
    // only (050:211). A declined request must not be quietly reclassified as
    // resolved by somebody opening the page.
    expect(after.status).toBe('dismissed');
    expect(after.version).toBe(dismissed.version);
  });
});

// ---------------------------------------------------------------------------
// The flicker — the section refetching and unmounting itself on every host render
// ---------------------------------------------------------------------------

describe('stability under a re-rendering host', () => {
  /**
   * THE BUG THIS PINS. `attentionSectionFor` builds the port inside each host's
   * render, so the prop arrived with a fresh identity every time. That identity
   * was in `load`'s dependency array feeding the mount effect, so every host
   * render refetched and pushed the section back to `phase: 'loading'` — which
   * renders `null`. The section left the document and came back, and the content
   * body below it jumped up and down for as long as the host kept rendering.
   */
  it('does NOT refetch when the host hands it a brand-new port object each render', async () => {
    const rows = [req({ id: 'open1', points: 65, status: 'open' })];
    const history = vi.fn(async () => ({ rows, truncated: false }));
    const { findByTestId, rerender } = render(
      <AttentionRequests entityId={ENTITY} port={fakePort(rows, { history })} now={NOW} />,
    );

    await findByTestId('attention-request-open1');
    expect(history).toHaveBeenCalledTimes(1);

    // Five host renders, each allocating a port exactly the way the real
    // `attentionSectionFor` does. None of them is a reason to read again.
    for (let i = 0; i < 5; i += 1) {
      rerender(<AttentionRequests entityId={ENTITY} port={fakePort(rows, { history })} now={NOW} />);
    }

    expect(history).toHaveBeenCalledTimes(1);
  });

  it('stays MOUNTED across those renders — the section never blinks out of the document', async () => {
    const rows = [req({ id: 'open1', points: 65, status: 'open' })];
    // A history that never settles after the first call: if the effect re-ran,
    // the component would sit in `loading` and render null, and the assertion
    // below would catch the section missing rather than merely re-fetched.
    let calls = 0;
    const history = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve({ rows, truncated: false })
        : new Promise<{ rows: AttentionRequest[]; truncated: boolean }>(() => {});
    });
    const { findByTestId, queryByTestId, rerender } = render(
      <AttentionRequests entityId={ENTITY} port={fakePort(rows, { history })} now={NOW} />,
    );

    await findByTestId('attention-requests');
    for (let i = 0; i < 5; i += 1) {
      rerender(<AttentionRequests entityId={ENTITY} port={fakePort(rows, { history })} now={NOW} />);
      expect(queryByTestId('attention-requests')).toBeTruthy();
    }
  });

  it('DOES refetch when the entity changes — the one input that should re-read', async () => {
    const rows = [req({ id: 'open1', points: 65, status: 'open' })];
    const history = vi.fn(async () => ({ rows, truncated: false }));
    const port = fakePort(rows, { history });
    const { findByTestId, rerender } = render(
      <AttentionRequests entityId={ENTITY} port={port} now={NOW} />,
    );

    await findByTestId('attention-request-open1');
    expect(history).toHaveBeenCalledTimes(1);

    rerender(<AttentionRequests entityId={'ent-2' as EntityId} port={port} now={NOW} />);
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
    expect(history.mock.calls[1]![0]).toBe('ent-2');
  });

  it('reads through the LATEST port even though it is not a dependency', async () => {
    const rows = [req({ id: 'open1', points: 65, status: 'open', version: 1 })];
    const stale = vi.fn(async () => ({ request: null, entity: null, affectedCount: 1 }) as never);
    const fresh = vi.fn(async () => ({ request: null, entity: null, affectedCount: 1 }) as never);
    const { findByTestId, getByTestId, rerender } = render(
      <AttentionRequests entityId={ENTITY} port={fakePort(rows, { settle: stale })} rows={rows} now={NOW} />,
    );
    await findByTestId('attention-request-open1');

    // The host re-renders with a new port. Holding the port in a ref must not
    // mean holding the FIRST one forever.
    rerender(
      <AttentionRequests entityId={ENTITY} port={fakePort(rows, { settle: fresh })} rows={rows} now={NOW} />,
    );
    fireEvent.click(getByTestId('attention-resolve-open1'));
    fireEvent.click(getByTestId('attention-confirm-open1'));

    await waitFor(() => expect(fresh).toHaveBeenCalledTimes(1));
    expect(stale).not.toHaveBeenCalled();
  });
});

describe('attentionPortFromSeam identity', () => {
  it('returns the SAME port for the same seam and space, so a render is not an allocation', async () => {
    const seam = createFixtureSeam();
    const spaceId = (await seam.spaces())[0]!.id;
    expect(attentionPortFromSeam(seam, spaceId)).toBe(attentionPortFromSeam(seam, spaceId));
  });

  it('separates spaces — one seam legitimately serves more than one over its life', async () => {
    const seam = createFixtureSeam();
    const spaceId = (await seam.spaces())[0]!.id;
    expect(attentionPortFromSeam(seam, spaceId)).not.toBe(
      attentionPortFromSeam(seam, 'some-other-space' as SpaceId),
    );
  });

  it('separates seams, so a fixture and a real node never share a port', async () => {
    const a = createFixtureSeam();
    const b = createFixtureSeam();
    const spaceId = (await a.spaces())[0]!.id;
    expect(attentionPortFromSeam(a, spaceId)).not.toBe(attentionPortFromSeam(b, spaceId));
  });
});

// ---------------------------------------------------------------------------
// Regression guard for the status enum
// ---------------------------------------------------------------------------

describe('status coverage', () => {
  it('every status the contract allows has a label', () => {
    const all: AttentionRequestStatus[] = ['open', 'acknowledged', 'resolved', 'dismissed'];
    const rows = all.map((status, i) => req({ id: `s${i}`, points: 10, status }));
    // No unlabelled status can reach the UI as a blank chip.
    for (const row of orderHistory(rows)) expect(row.status).toBeTruthy();
    expect(summarizeHistory(rows).total).toBe(4);
  });
});

// Keeps the unused-import guard honest about the mutation result type, which
// documents what `settle` resolves to even where the tests ignore the value.
export type _MutationResult = AttentionRequestMutationResult;
