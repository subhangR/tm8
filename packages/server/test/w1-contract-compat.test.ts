import { describe, expect, it, vi } from 'vitest';
import {
  EdgeViewSchema,
  EntitySummarySchema,
  WorkspaceEventSchema,
  getOperation,
  type ActorSummary,
  type EntitySummary,
  type OperationName,
} from '@tm8/contract';

import type { Db, Querier } from '../src/db/types.js';
import { WorkspaceEventMapper, type WorkspaceEventRow } from '../src/events/mapper.js';
import { PgEntityProjector, type EntityProjector } from '../src/events/projector.js';
import { contentOf, toEntitySummary, type AssemblyContext, type EntityRow } from '../src/facade/entity-read.js';
import { registerExecutionHandlers } from '../src/facade/execution-handlers.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import { registerW2MessagesHandoffsHandlers } from '../src/facade/handlers/w2/messages-handoffs.js';
import { toCommandResult } from '../src/facade/handlers/entities.js';
import { toWireError } from '../src/http/errors.js';
import type { RequestContext } from '../src/http/types.js';

const SPACE = '019f9896-928d-79b6-ba1c-1cdcc1d30a6f';
const SOURCE = '019f9896-928d-7a24-848b-4c8fdd82b761';
const TARGET = '019f9896-928d-7a09-aac0-021c7d4652c6';
const MEMBER = '019f9896-928d-7b09-aac0-021c7d4652c6';
const TEAMMATE = '019f9896-928d-7c09-aac0-021c7d4652c6';
const MESSAGE = '019f9896-928d-7d09-aac0-021c7d4652c6';
const PROJECT = '019f9896-928d-7e09-aac0-021c7d4652c6';
const PROFILE = '019f9896-928d-7f09-aac0-021c7d4652c6';
const NOW = '2026-07-26T10:00:00.000Z';
const UPDATED = '2026-07-26T11:00:00.000Z';

const member: ActorSummary = {
  id: MEMBER,
  kind: 'member',
  displayName: 'Owner',
  avatar: null,
  role: 'owner',
  isAgent: false,
};

const teammate: ActorSummary = {
  id: TEAMMATE,
  kind: 'team_member',
  displayName: 'Builder',
  avatar: null,
  role: null,
  isAgent: true,
  ownerMemberId: MEMBER,
};

function summary(id: string): EntitySummary {
  return {
    id,
    spaceId: SPACE,
    kind: 'task',
    title: `Task ${id.slice(-4)}`,
    parentId: null,
    position: 1,
    visibility: 'space',
    version: 1,
    activityAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    createdBy: member,
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: {
      kind: 'task',
      workStatus: 'open',
      priority: 'medium',
      axes: {},
      dueDate: null,
      assignees: [],
      acceptance: { total: 0, completed: 0 },
    },
    badges: {},
  };
}

function eventRow(overrides: Partial<WorkspaceEventRow>): WorkspaceEventRow {
  return {
    id: 'event-1',
    space_id: SPACE,
    seq: '1',
    event_type: 'entity.upsert',
    payload: { id: SOURCE },
    client_mutation_id: null,
    recipient_member_id: null,
    occurred_at: NOW,
    schema_version: 1,
    ...overrides,
  };
}

function row(overrides: Partial<EntityRow>): EntityRow {
  return {
    id: SOURCE,
    space_id: SPACE,
    kind: 'task',
    parent_id: null,
    position: 1,
    visibility: 'space',
    version: 1,
    activity_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    created_by: MEMBER,
    likes: 0,
    dislikes: 0,
    stars: 0,
    points: 0,
    messages: 0,
    ...overrides,
  } as EntityRow;
}

const assembly: AssemblyContext = {
  actors: new Map([[MEMBER, member]]),
  relations: {
    assignees: new Map(),
    childCounts: new Map(),
    blockedBy: new Map(),
    pulls: new Map(),
    workingOn: new Map(),
    itemCounts: new Map(),
  },
  viewerReactions: new Map(),
};

function context(opName: OperationName, body: unknown): RequestContext {
  const op = getOperation(opName);
  return {
    op,
    opName,
    params: {},
    query: new URLSearchParams(),
    body,
    requestId: 'request-w1-compat',
    identity: { kind: 'auto-owner' },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

async function rejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error('expected operation to reject');
}

describe('W1 contract-to-Server DTO compatibility', () => {
  it('projects truthful edge timestamps in event and command EdgeViews', async () => {
    const entities = new Map([
      [SOURCE, summary(SOURCE)],
      [TARGET, summary(TARGET)],
    ]);
    const mapper = new WorkspaceEventMapper({ entitySummaries: async () => entities });
    const mapped = mapper.mapRow(
      eventRow({
        event_type: 'edge.upsert',
        payload: {
          id: 'edge-1',
          src_id: SOURCE,
          dst_id: TARGET,
          type: 'relates_to',
          props: {},
          created_by: MEMBER,
          created_at: NOW,
          updated_at: UPDATED,
        },
      }),
      entities,
      new Map([[MEMBER, member]]),
    );
    expect(mapped.type).toBe('edge.upsert');
    if (mapped.type !== 'edge.upsert') throw new Error('unreachable');
    expect(mapped.edge.updatedAt).toBe(UPDATED);
    expect(WorkspaceEventSchema.safeParse(mapped).success).toBe(true);

    const rows = [row({ id: SOURCE }), row({ id: TARGET })];
    const q = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('where e.id = any')) return rows;
        return [];
      }),
      rpc: vi.fn(),
    } as unknown as Querier;
    const result = await toCommandResult(
      q,
      {
        patches: [{ id: SOURCE }, { id: TARGET }],
        edge: {
          id: 'edge-1',
          src_id: SOURCE,
          dst_id: TARGET,
          type: 'relates_to',
          props: {},
          created_by: MEMBER,
          created_at: NOW,
          updated_at: UPDATED,
        },
      },
      'identity-owner',
    );
    expect(result.edge?.updatedAt).toBe(UPDATED);
    expect(EdgeViewSchema.safeParse(result.edge).success).toBe(true);
  });

  it('projects the notification recipient discriminator from the captured row', async () => {
    const target = summary(TARGET);
    const actors = new Map([
      [MEMBER, member],
      [TEAMMATE, teammate],
    ]);
    const projector: EntityProjector = {
      entitySummaries: async (_q, ids) =>
        new Map(ids.includes(TARGET) ? [[TARGET, target]] : []),
      actorSummaries: async (_q, ids) =>
        new Map([...actors].filter(([id]) => ids.includes(id))),
    };
    const mapper = new WorkspaceEventMapper(projector);
    const events = await mapper.mapRows({} as Querier, [
      eventRow({
        seq: '2',
        event_type: 'notification.created',
        recipient_member_id: MEMBER,
        payload: {
          id: 'notification-member',
          kind: 'mention',
          actor_id: MEMBER,
          target_entity_id: TARGET,
          recipient_member_id: MEMBER,
          recipient_team_member_id: null,
          payload: {},
          read_at: null,
          created_at: NOW,
        },
      }),
      eventRow({
        seq: '3',
        event_type: 'notification.created',
        recipient_member_id: MEMBER,
        payload: {
          id: 'notification-teammate',
          kind: 'mention',
          actor_id: MEMBER,
          target_entity_id: TARGET,
          recipient_member_id: MEMBER,
          recipient_team_member_id: TEAMMATE,
          payload: {},
          read_at: null,
          created_at: NOW,
        },
      }),
    ]);
    expect(events).toHaveLength(2);
    const recipients = events.map((event) => {
      if (event.type !== 'notification.created') throw new Error('unreachable');
      expect(WorkspaceEventSchema.safeParse(event).success).toBe(true);
      return event.notification.recipient;
    });
    expect(recipients).toEqual([member, teammate]);
  });

  it('projects message batch correlation and immutable launch-project provenance from storage', () => {
    const messageSummary = toEntitySummary(
      row({
        id: MESSAGE,
        kind: 'message',
        anchor_id: SOURCE,
        root_message_id: null,
        author_id: MEMBER,
        message_batch_id: 'mutation-batch-1',
        message_body: 'hello',
      }),
      assembly,
    );
    expect(messageSummary.state).toMatchObject({
      kind: 'message',
      messageBatchId: 'mutation-batch-1',
    });

    const sessionContent = contentOf(
      row({
        id: TARGET,
        kind: 'work_session',
        ws_node_id: 'node-1',
        ws_project_id: PROJECT,
      }),
    );
    expect(sessionContent).toMatchObject({
      kind: 'work_session',
      launchProjectId: PROJECT,
    });
    expect(sessionContent).not.toHaveProperty('projectId');
  });

  /**
   * The read-side halves of the projector parity arms (378e167): before them,
   * a `project` or `interaction_profile` row fell through to the custom-kind
   * default and came back titled by its kind string with a `c:*`-shaped empty
   * state — off-contract for a core kind. Titles and states here must MIRROR
   * projector.ts titleOf/stateOf exactly; parity between the event feed and
   * the read path is the assertion, not just schema validity.
   */
  it('reads project and interaction_profile rows with real state and title (projector parity)', () => {
    const project = toEntitySummary(
      row({
        id: PROJECT,
        kind: 'project',
        ppd_name: 'Alpha',
        ppd_project_id: 'proj-alpha-1',
        ppd_materialized_version: 3,
      }),
      assembly,
    );
    expect(project.title).toBe('Alpha');
    expect(project.state).toEqual({
      kind: 'project',
      projectId: 'proj-alpha-1',
      materializedVersion: 3,
    });
    expect(EntitySummarySchema.safeParse(project).success).toBe(true);

    const profile = toEntitySummary(
      row({
        id: PROFILE,
        kind: 'interaction_profile',
        ip_status: 'active',
        ip_current_draft_version: 2,
        ip_active_version: 2,
        ip_active_hash: 'hash-v2',
        ip_retired_at: null,
      }),
      assembly,
    );
    // The projector's honest answer for a nameless projection, mirrored.
    expect(profile.title).toBe('');
    expect(profile.state).toEqual({
      kind: 'interaction_profile',
      status: 'active',
      currentDraftVersion: 2,
      activeVersion: 2,
      activeHash: 'hash-v2',
      retiredAt: null,
    });
    expect(EntitySummarySchema.safeParse(profile).success).toBe(true);

    // An unknown status is defaulted, not trusted (projector's oneOf).
    const drifted = toEntitySummary(
      row({ id: PROFILE, kind: 'interaction_profile', ip_status: 'bogus' }),
      assembly,
    );
    expect(drifted.state).toMatchObject({ kind: 'interaction_profile', status: 'draft' });
  });

  it('projects nullable messageBatchId through the event-side database projector', async () => {
    const messageRow = {
      id: MESSAGE,
      space_id: SPACE,
      kind: 'message',
      parent_id: null,
      position: 1,
      visibility: 'space',
      version: 1,
      activity_at: NOW,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      created_by: MEMBER,
      msg_anchor_id: SOURCE,
      msg_root_id: null,
      msg_author_id: MEMBER,
      msg_batch_id: 'mutation-batch-2',
      msg_body: 'hello',
      msg_edited_at: null,
      msg_redacted_at: null,
    };
    const q = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        if (sql.includes('from public.edges')) return [];
        const ids = (params?.[0] ?? []) as string[];
        return ids.includes(MESSAGE) ? [messageRow] : [];
      }),
      rpc: vi.fn(),
    } as unknown as Querier;
    const projected = await new PgEntityProjector().entitySummaries(q, [MESSAGE]);
    expect(projected.get(MESSAGE)?.state).toMatchObject({
      kind: 'message',
      messageBatchId: 'mutation-batch-2',
    });
  });
});

describe('W1 honest W2-only skeletons', () => {
  /**
   * messages.post WAS an honest 501 skeleton and IS NOT ONE ANY MORE.
   *
   * This case used to import `messagesPost` from `handlers/messages.js` and
   * assert it refused with `not_implemented` before touching identity or the
   * database. That stub has been deleted: `messages.post` is registered to
   * G04's real service handler, and the stub survived only as a trap — its
   * message said the live one was mounted elsewhere, which reads as
   * documentation of a seam rather than as an epitaph, so anyone grepping
   * `not_implemented` in that file concluded the operation was unimplemented.
   *
   * REWRITTEN TO READ THE REGISTRY RATHER THAN IMPORT A FACTORY. The old form
   * coupled this control to a module export, so DELETING THAT EXPORT DISARMED
   * THE CONTROL — and silently, because `bun run typecheck` covers `src` only
   * and type-checks no test file, so the tree stayed exit 0 while this was red.
   * Asking the registration seam what is actually bound cannot fail that way:
   * if the binding disappears, `get` returns undefined and this fails loudly.
   */
  it('has retired the messages.post skeleton — the seam binds a real handler', () => {
    const registry = new HandlerRegistry();
    const owner = vi.fn();
    const tx = vi.fn();
    registerW2MessagesHandoffsHandlers(registry, {
      owner: owner as never,
      db: { tx } as unknown as Db,
      config: {} as never,
    });

    // Bound at all — the control this file exists to provide.
    expect(registry.get('messages.post')).toBeTypeOf('function');
    // And bound to something that is NOT the old skeleton. Registering a
    // handler that still refused with not_implemented would satisfy the line
    // above and mean nothing.
    expect(registry.get('messages.post')).not.toBe(registry.get('messages.list'));
    // Constructing the seam must not have reached identity or the database;
    // that half of the original assertion is still worth keeping.
    expect(owner).not.toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled();

    // NEGATIVE CONTROL, in-file and permanent. A control that cannot be shown
    // to fail is not a control, and the seam is shared source that two waves
    // compile at once — so its sensitivity is proven against an EMPTY registry
    // here rather than by temporarily breaking the real registration, which
    // would false-red a sibling's concurrent run.
    expect(new HandlerRegistry().get('messages.post')).toBeUndefined();
  });

  function executionFixture() {
    const owner = vi.fn(async () => ({
      identityId: 'identity-owner',
      accountId: 'account-owner',
      username: 'owner',
      isNodeAdmin: true,
      isOwner: true,
    }));
    const q = { query: vi.fn(async () => []), rpc: vi.fn() } as unknown as Querier;
    const tx = vi.fn(async (_claims, fn: (querier: Querier) => Promise<unknown>) => fn(q));
    const db = {
      tx,
      rpc: vi.fn(),
      query: vi.fn(),
      end: vi.fn(),
    } as unknown as Db;
    const registry = new HandlerRegistry();
    const runtime = registerExecutionHandlers(registry, {
      db,
      pty: {} as never,
      config: {
        host: '127.0.0.1',
        port: 4610,
        uiDir: undefined,
        maxBodyBytes: 1024,
        databaseUrl: undefined,
      },
      owner,
    });
    const spawn = vi.spyOn(runtime.spawnService, 'spawn').mockResolvedValue({ commandResult: {} } as never);
    return { registry, owner, spawn, tx };
  }

  it.each([
    ['scratch workdir', { workdir: { mode: 'scratch' as const } }],
    ['interaction profile selection', { interactionProfileId: PROFILE }],
  ])('refuses unsupported %s before owner, DB, or spawn-service access', async (_label, extra) => {
    const fixture = executionFixture();
    const handler = fixture.registry.get('execution.spawn');
    if (!handler) throw new Error('execution.spawn was not registered');
    const error = await rejection(
      Promise.resolve(
        handler(
          context('execution.spawn', {
            clientMutationId: 'mutation-spawn-refused',
            spaceId: SPACE,
            teamMemberId: TEAMMATE,
            ...extra,
          }),
        ),
      ),
    );
    expect(toWireError(error, 'request-w1-compat')).toMatchObject({
      status: 501,
      body: { error: { code: 'not_implemented', requestId: 'request-w1-compat' } },
    });
    expect(fixture.owner).not.toHaveBeenCalled();
    expect(fixture.tx).not.toHaveBeenCalled();
    expect(fixture.spawn).not.toHaveBeenCalled();
  });

  it('forwards supported untrusted-project consent without weakening it', async () => {
    const fixture = executionFixture();
    const handler = fixture.registry.get('execution.spawn');
    if (!handler) throw new Error('execution.spawn was not registered');
    await handler(
      context('execution.spawn', {
        clientMutationId: 'mutation-spawn-supported',
        spaceId: SPACE,
        teamMemberId: TEAMMATE,
        projectId: PROJECT,
        confirmUntrusted: true,
      }),
    );
    expect(fixture.spawn).toHaveBeenCalledOnce();
    expect(fixture.spawn.mock.calls[0]?.[1]).toMatchObject({ confirmUntrusted: true });
  });
});
