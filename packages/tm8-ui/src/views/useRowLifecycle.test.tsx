// @vitest-environment jsdom
/**
 * THE EXECUTOR BEHIND THE EXPANDED ROW'S CONTROLS — the file that decides what
 * a click MEANS as a seam call.
 *
 * === WHY THIS FILE EXISTS ===
 *
 * It did not, and that is how the unassign shipped broken.
 *
 * The change that made the task tile's status / priority / assign chips real
 * controls arrived with ~20 tests, and every one of them sat at the panel, the
 * fixture, the registry or the ops layer. Those layers are all honest: the
 * panel dispatches the right callback, `ops.deleteEdge` sends the body it is
 * handed, the fixture removes the edge. NONE of them observes the argument
 * this hook actually passes. So `seam.commands.deleteEdge(edge.id)` — no
 * command context — went out green.
 *
 * On a default-configured node that call cannot succeed. `edges.delete` binds
 * `RequiredCommandContextSchema` (server `input-schemas.ts:165`), which is
 * `.strict()` with `clientMutationId: z.string().min(1)`. The server
 * synthesizes a mutation id ONLY when idempotency is OFF
 * (`http/idempotency.ts:23`) and `TM8_IDEMPOTENCY_ENABLED` defaults to TRUE
 * (`http/config.ts:239`). So the body arrived as `{}`, the node answered 400
 * `invalid_input`, and the user was told "Could not unassign" — a control you
 * could turn on and could not turn off. `entities.delete` and
 * `entities.restore` bind the same schema (`input-schemas.ts:149,150`), so
 * archive and restore were quietly broken the same way, and had been.
 *
 * The rule this file encodes: the three writes this hook OWNS — which seam
 * call fires, at what version, carrying what context, and how the connections
 * lookup behaves — are observed HERE, at the layer that chooses them, and not
 * inferred from a layer that only forwards them.
 *
 * Every assertion below is on a call the hook makes, never on a call a test
 * makes on its behalf.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { ActorSummary, EntityDetail, EntitySummary } from '@tm8/contract';
import type { Notice } from '../shell/notices';
import type { GateData } from './useGateData';
import { useRowLifecycle, type RowLifecycle } from './useRowLifecycle';

const TASK = 'task-1';
const ADA: ActorSummary = { id: 'member-ada', kind: 'member', displayName: 'Ada', avatar: 'ada.png', isAgent: false };
const BEE: ActorSummary = { id: 'tm-bee', kind: 'team_member', displayName: 'Bee', avatar: 'bee.png', isAgent: true };

function row(id: string, kind: string, title: string): EntitySummary {
  return { id, kind, title } as unknown as EntitySummary;
}

interface HarnessOptions {
  /** Absent ⇒ the detail is NOT hydrated, which is the refusal arm. */
  version?: number;
  members?: readonly ActorSummary[];
  rows?: Record<string, EntitySummary[]>;
  connections?: unknown[];
  /** Reject the next command instead of resolving it. */
  fail?: Error;
  connectionsFail?: Error;
}

function harness(options: HarnessOptions = {}) {
  const notices: Notice[] = [];
  const seam = {
    commands: {
      work: vi.fn(async () => ({ patches: [] })),
      complete: vi.fn(async () => ({ patches: [] })),
      patchEntity: vi.fn(async () => {
        if (options.fail) throw options.fail;
        return { patches: [] };
      }),
      createEdge: vi.fn(async () => {
        if (options.fail) throw options.fail;
        return { patches: [] };
      }),
      deleteEdge: vi.fn(async () => ({ patches: [] })),
      deleteEntity: vi.fn(async () => ({ patches: [] })),
      restoreEntity: vi.fn(async () => ({ patches: [] })),
    },
    connections: vi.fn(async () => {
      if (options.connectionsFail) throw options.connectionsFail;
      return { items: options.connections ?? [], nextCursor: null };
    }),
    /* Present ONLY so that a call to it would be visible. The version fallback
       it used to serve is gone; if it is ever called again, a test says so. */
    entity: vi.fn(async () => ({ version: 99 }) as unknown as EntityDetail),
  };

  const rows = options.rows ?? {};
  const data = {
    seam,
    reconcileCommand: vi.fn(),
    members: options.members ?? [],
    detailOf: (id: string) =>
      options.version === undefined || id !== TASK
        ? undefined
        : ({ version: options.version } as unknown as EntityDetail),
    rowsFor: (kind: string) => () => rows[kind] ?? [],
  } as unknown as GateData;

  let handle!: RowLifecycle;
  function Probe() {
    handle = useRowLifecycle({
      data,
      viewerMemberId: ADA.id,
      onNotice: (n) => void notices.push(n),
    });
    return null;
  }
  render(<Probe />);
  return { seam, data, notices, get lifecycle() { return handle; } };
}

/** Let the hook's `.then`/`.catch` chains settle before asserting on them. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useRowLifecycle — assign: the edge writes', () => {
  it('assigning creates the edge the registry named, with no read first', async () => {
    const h = harness();
    h.lifecycle.assign(TASK, ADA.id, 'assigned_to', true);
    await flush();

    expect(h.seam.commands.createEdge).toHaveBeenCalledWith({
      srcId: TASK,
      dstId: ADA.id,
      type: 'assigned_to',
    });
    // `write_edge` UPSERTS on (src, dst, type), so an add needs no lookup —
    // and a read here would be a round trip bought for nothing.
    expect(h.seam.connections).not.toHaveBeenCalled();
  });

  /**
   * THE REGRESSION THIS FILE WAS WRITTEN FOR.
   *
   * `edges.delete` binds `RequiredCommandContextSchema` and idempotency is ON
   * by default, so a `deleteEdge` with no second argument is a guaranteed 400.
   * The ops-layer test that pins the wire body passes its OWN explicit
   * `{clientMutationId}` — a path production never took. This one asserts on
   * what the HOOK passes, which is the only place the omission could live.
   */
  it('unassigning carries a command context — without one the node answers 400 invalid_input', async () => {
    const h = harness({ connections: [{ id: 'edge-9', type: 'assigned_to', source: { id: TASK }, target: { id: ADA.id } }] });
    h.lifecycle.assign(TASK, ADA.id, 'assigned_to', false);
    await flush();

    expect(h.seam.commands.deleteEdge).toHaveBeenCalledTimes(1);
    const [edgeId, ctx] = h.seam.commands.deleteEdge.mock.calls[0]!;
    expect(edgeId).toBe('edge-9');
    expect(ctx).toBeDefined();
    expect(typeof (ctx as { clientMutationId?: unknown }).clientMutationId).toBe('string');
    expect((ctx as { clientMutationId: string }).clientMutationId.length).toBeGreaterThan(0);
  });

  it('mints a FRESH mutation id per write — a reused id is refused as a replay', async () => {
    const h = harness({ connections: [{ id: 'edge-9', type: 'assigned_to', source: { id: TASK }, target: { id: ADA.id } }] });
    h.lifecycle.assign(TASK, ADA.id, 'assigned_to', false);
    await flush();
    h.lifecycle.assign(TASK, ADA.id, 'assigned_to', false);
    await flush();

    const ids = h.seam.commands.deleteEdge.mock.calls.map(
      (call) => (call[1] as { clientMutationId: string }).clientMutationId,
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  /**
   * The read is FILTERED. Unfiltered, the server pages this at DEFAULT_LIMIT
   * 50 across every edge type on the entity, so on a busy task the assignment
   * sits off the page and the arm below reports it as gone — a false statement
   * to the user. Naming the type and direction is what makes "absent from the
   * page" mean "absent from the node".
   */
  it('reads connections filtered by the edge type and direction, fresh at click', async () => {
    const h = harness({ connections: [{ id: 'edge-9', type: 'assigned_to', source: { id: TASK }, target: { id: ADA.id } }] });
    h.lifecycle.assign(TASK, ADA.id, 'assigned_to', false);
    await flush();

    expect(h.seam.connections).toHaveBeenCalledTimes(1);
    const [id, opts] = h.seam.connections.mock.calls[0]!;
    expect(id).toBe(TASK);
    expect(opts).toMatchObject({ types: ['assigned_to'], direction: 'outgoing' });
    expect((opts as { limit: number }).limit).toBeGreaterThan(50);
  });

  it('an edge that is genuinely gone is REPORTED, never silently swallowed', async () => {
    const h = harness({ connections: [] });
    h.lifecycle.assign(TASK, ADA.id, 'assigned_to', false);
    await flush();

    expect(h.seam.commands.deleteEdge).not.toHaveBeenCalled();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.title).toBe('Could not unassign');
    expect(h.notices[0]!.body).toContain('no longer on this node');
  });

  it('an edge to a DIFFERENT actor is not mistaken for this one', async () => {
    const h = harness({ connections: [{ id: 'edge-bee', type: 'assigned_to', source: { id: TASK }, target: { id: BEE.id } }] });
    h.lifecycle.assign(TASK, ADA.id, 'assigned_to', false);
    await flush();

    expect(h.seam.commands.deleteEdge).not.toHaveBeenCalled();
    expect(h.notices[0]!.title).toBe('Could not unassign');
  });

  it('a refused create surfaces as a notice rather than a row that did not move', async () => {
    const h = harness({ fail: new Error('forbidden: cannot link') });
    h.lifecycle.assign(TASK, ADA.id, 'assigned_to', true);
    await flush();

    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.title).toBe('Could not assign');
    expect(h.notices[0]!.body).toContain('cannot link');
    expect(h.data.reconcileCommand).not.toHaveBeenCalled();
  });

  it('a connections read that fails surfaces too — it is half of the unassign', async () => {
    const h = harness({ connectionsFail: new Error('node unreachable') });
    h.lifecycle.assign(TASK, ADA.id, 'assigned_to', false);
    await flush();

    expect(h.notices[0]!.title).toBe('Could not unassign');
    expect(h.notices[0]!.body).toContain('node unreachable');
  });

  it('a successful write reconciles — the row moves because the node said so', async () => {
    const h = harness();
    h.lifecycle.assign(TASK, ADA.id, 'assigned_to', true);
    await flush();
    expect(h.data.reconcileCommand).toHaveBeenCalledTimes(1);
  });
});

describe('useRowLifecycle — setValue: the content patch', () => {
  it('patches ONE field, sparsely, guarded by the CACHED version', async () => {
    const h = harness({ version: 7 });
    h.lifecycle.setValue(TASK, { priority: 'high' }, 'Priority');
    await flush();

    expect(h.seam.commands.patchEntity).toHaveBeenCalledWith(TASK, {
      expectedVersion: 7,
      content: { priority: 'high' },
    });
    // The fallback `entity()` read is GONE, and it was unreachable: the panel
    // refuses with CheckingPermission whenever `capabilitiesOf(row.id)` is
    // undefined (`EntityListPanel.tsx:1472`), and all three call sites wire
    // that to `detailOf(id)?.capabilities` — so capabilities present implies
    // detail present implies version defined.
    expect(h.seam.entity).not.toHaveBeenCalled();
  });

  /**
   * A `ValueOption` may carry companion keys (`ValueOption.also` — a
   * teammate's `agentTool` moves with its `model`). They must ride the SAME
   * patch: two patches means two versions, so the second earns a
   * `version_conflict` against the first and the pair lands half-applied.
   */
  it('sends companion keys in ONE patch, not a second write', async () => {
    const h = harness({ version: 7 });
    h.lifecycle.setValue(TASK, { model: 'gpt-5-codex', agentTool: 'codex' }, 'Model');
    await flush();

    expect(h.seam.commands.patchEntity).toHaveBeenCalledTimes(1);
    expect(h.seam.commands.patchEntity).toHaveBeenCalledWith(TASK, {
      expectedVersion: 7,
      content: { model: 'gpt-5-codex', agentTool: 'codex' },
    });
  });

  it('refuses rather than guessing when the version is not loaded', async () => {
    const h = harness();
    h.lifecycle.setValue(TASK, { priority: 'high' }, 'Priority');
    await flush();

    expect(h.seam.commands.patchEntity).not.toHaveBeenCalled();
    expect(h.seam.entity).not.toHaveBeenCalled();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.title).toBe('Priority could not be changed');
  });

  /**
   * The notice is USER copy. Titling it with `source` produced "priority could
   * not be changed" — the wire field name, lowercase, mid-sentence. `label` is
   * the same registry control's display name.
   */
  it('titles its failure with the control LABEL, not the wire field name', async () => {
    const h = harness({ version: 7, fail: new Error('version_conflict') });
    h.lifecycle.setValue(TASK, { priority: 'high' }, 'Priority');
    await flush();

    expect(h.notices[0]!.title).toBe('Priority could not be changed');
    expect(h.notices[0]!.title).not.toContain('priority could');
  });

  it('surfaces a 409 rather than retrying it — the user chose against a state', async () => {
    const h = harness({ version: 7, fail: new Error('version_conflict: entity moved') });
    h.lifecycle.setValue(TASK, { priority: 'high' }, 'Priority');
    await flush();

    expect(h.seam.commands.patchEntity).toHaveBeenCalledTimes(1);
    expect(h.notices[0]!.body).toContain('version_conflict');
    expect(h.data.reconcileCommand).not.toHaveBeenCalled();
  });
});

describe('useRowLifecycle — archive: the tombstone, and its context', () => {
  /**
   * `entities.delete` binds the SAME `RequiredCommandContextSchema` as
   * `edges.delete`. This defect pre-dated the row-controls change: archive has
   * been a guaranteed 400 on any node with idempotency left at its default.
   */
  it('archive carries a command context — the same schema, the same 400 without it', async () => {
    const h = harness();
    h.lifecycle.archive('archive', TASK);
    await flush();

    const [id, ctx] = h.seam.commands.deleteEntity.mock.calls[0]!;
    expect(id).toBe(TASK);
    expect(typeof (ctx as { clientMutationId?: unknown }).clientMutationId).toBe('string');
  });

  it('restore carries one too', async () => {
    const h = harness();
    h.lifecycle.archive('restore', TASK);
    await flush();

    const [id, ctx] = h.seam.commands.restoreEntity.mock.calls[0]!;
    expect(id).toBe(TASK);
    expect(typeof (ctx as { clientMutationId?: unknown }).clientMutationId).toBe('string');
  });
});

describe('useRowLifecycle — setState: the verb, not the value', () => {
  it('a plain state goes through work(), unversioned', async () => {
    const h = harness({ version: 7 });
    h.lifecycle.setState(TASK, 'working', 'set-state');
    await flush();
    expect(h.seam.commands.work).toHaveBeenCalledWith(TASK, { status: 'working' });
    expect(h.seam.commands.complete).not.toHaveBeenCalled();
  });

  it('done goes through complete(), version-guarded and attributed', async () => {
    const h = harness({ version: 7 });
    h.lifecycle.setState(TASK, 'done', 'complete');
    await flush();
    expect(h.seam.commands.complete).toHaveBeenCalledWith(TASK, {
      expectedVersion: 7,
      completerIds: [ADA.id],
    });
    expect(h.seam.commands.work).not.toHaveBeenCalled();
  });

  it('complete on an unhydrated row is refused, never fabricated', async () => {
    const h = harness();
    h.lifecycle.setState(TASK, 'done', 'complete');
    await flush();
    expect(h.seam.commands.complete).not.toHaveBeenCalled();
    expect(h.notices[0]!.title).toBe('Cannot complete this task yet');
  });
});

describe('useRowLifecycle — the assignable roster', () => {
  /**
   * `avatar: null` for every entry meant the assign menu drew blank faces
   * forever, discarding the avatars merged in PR #12. `GateData.members` is
   * the real membership projection and already carries them.
   */
  it('prefers the loaded member actor, so real avatars survive', () => {
    const h = harness({
      members: [ADA],
      rows: { member: [row(ADA.id, 'member', 'stale title')], team_member: [] },
    });
    expect(h.lifecycle.assignable).toEqual([ADA]);
    expect(h.lifecycle.assignable[0]!.avatar).toBe('ada.png');
  });

  /**
   * `members` is `public.members` — the HUMAN rows. Building the roster from
   * it alone would drop every agent from a menu the registry says agents
   * belong in, so the rows still supply the population.
   */
  it('still offers team_members, which the members projection does not contain', () => {
    const h = harness({
      members: [ADA],
      rows: { member: [row(ADA.id, 'member', 'Ada')], team_member: [row(BEE.id, 'team_member', 'Bee')] },
    });
    const ids = h.lifecycle.assignable.map((a) => a.id);
    expect(ids).toContain(ADA.id);
    expect(ids).toContain(BEE.id);
  });

  /**
   * The kind comes from the REGISTRY key the group was read under, not from
   * `row.kind as ActorSummary['kind']` — a cast that would mislabel a third
   * kind silently, and a mislabelled actor is drawn with the wrong provenance
   * mark: an agent shown as a human.
   */
  it('labels an unloaded actor from its roster kind, not from an unchecked cast', () => {
    const h = harness({
      members: [],
      rows: { member: [], team_member: [row(BEE.id, 'team_member', 'Bee')] },
    });
    expect(h.lifecycle.assignable).toEqual([
      { id: BEE.id, kind: 'team_member', displayName: 'Bee', avatar: null, isAgent: true },
    ]);
  });

  it('empty means NOT LOADED — the panel refuses in those words rather than drawing an empty menu', () => {
    const h = harness();
    expect(h.lifecycle.assignable).toEqual([]);
  });
});
