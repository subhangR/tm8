/**
 * Mapper unit tests — no database.
 *
 * These cover the projection rules and the failure policy, which are pure
 * functions of a row plus a hydration map. The Postgres-backed proof lives in
 * poll.pg.test.ts; this file is what tells you WHICH rule broke when that one
 * goes red.
 */
import { describe, expect, it } from 'vitest';
import { WorkspaceEventSchema, type EntitySummary } from '@tm8/contract';

import { OffContractEventError } from '../../src/events/emitter.js';
import {
  UnprojectableEventError,
  WorkspaceEventMapper,
  type WorkspaceEventRow,
} from '../../src/events/mapper.js';
import type { EntityProjector } from '../../src/events/projector.js';
import type { Querier } from '../../src/db/types.js';

const SPACE = '019f9896-928d-79b6-ba1c-1cdcc1d30a6f';
const TASK = '019f9896-928d-7a24-848b-4c8fdd82b761';
const MEMBER = '019f9896-928d-7a09-aac0-021c7d4652c6';

function summary(over: Partial<EntitySummary> = {}): EntitySummary {
  return {
    id: TASK,
    spaceId: SPACE,
    kind: 'task',
    title: 'A task',
    parentId: null,
    position: 1,
    visibility: 'space',
    version: 1,
    activityAt: '2026-07-25T00:00:00.000Z',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    deletedAt: null,
    createdBy: { id: MEMBER, kind: 'member', displayName: 'Owner', avatar: null, role: 'owner', isAgent: false },
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
    ...over,
  };
}

/** A projector that returns exactly what it was constructed with. */
function fixedProjector(entities: Map<string, EntitySummary>): EntityProjector {
  return { entitySummaries: () => Promise.resolve(entities) };
}

const NO_QUERIER = {} as Querier;

function row(over: Partial<WorkspaceEventRow> = {}): WorkspaceEventRow {
  return {
    id: 'evt_1',
    space_id: SPACE,
    seq: '1',
    event_type: 'entity.upsert',
    payload: { id: TASK },
    client_mutation_id: null,
    recipient_member_id: null,
    occurred_at: '2026-07-25T00:00:00.000Z',
    schema_version: 1,
    ...over,
  };
}

describe('WorkspaceEventMapper', () => {
  const mapper = new WorkspaceEventMapper(fixedProjector(new Map([[TASK, summary()]])));
  const entities = new Map([[TASK, summary()]]);

  it('re-projects the AM-2 §3 envelope from the row, not from the clock', () => {
    const event = mapper.mapRow(
      row({ seq: '42', occurred_at: '2026-07-25T12:00:00.000Z', schema_version: 1 }),
      entities,
    );
    expect(event.spaceId).toBe(SPACE);
    expect(event.seq).toBe(42);
    expect(event.occurredAt).toBe('2026-07-25T12:00:00.000Z');
    expect(event.schemaVersion).toBe(1);
    expect(WorkspaceEventSchema.safeParse(event).success).toBe(true);
  });

  /**
   * `seq` is a bigint, which node-postgres returns as a STRING. If it were left
   * as one, `'10' < '9'` would be true and both ordering and the `since`
   * comparison would be wrong for any space past nine events — while every log
   * line still looked correct.
   */
  it('converts the bigint seq to a number exactly once', () => {
    const event = mapper.mapRow(row({ seq: '10' }), entities);
    expect(event.seq).toBe(10);
    expect(typeof event.seq).toBe('number');
  });

  it('threads clientMutationId when the row has one, and omits it when not', () => {
    const withCmid = mapper.mapRow(row({ client_mutation_id: 'cmid_abc' }), entities);
    expect(withCmid.clientMutationId).toBe('cmid_abc');

    const without = mapper.mapRow(row({ client_mutation_id: null }), entities);
    // Omitted, not null: the schemas are .strict() and the field is optional.
    expect('clientMutationId' in without).toBe(false);
  });

  it('normalizes an offset timestamp from the captured payload to UTC', () => {
    const event = mapper.mapRow(
      row({
        event_type: 'activity.created',
        payload: {
          id: 'act_1',
          entity_id: TASK,
          verb: 'created',
          summary: {},
          // `to_jsonb` renders timestamptz in the session zone, with an offset.
          created_at: '2026-07-25T14:53:52.583962+05:30',
        },
      }),
      entities,
    );
    if (event.type !== 'activity.created') throw new Error('unreachable');
    expect(event.activity.createdAt).toBe('2026-07-25T09:23:52.583Z');
    expect(WorkspaceEventSchema.safeParse(event).success).toBe(true);
  });

  it('projects a message with its anchor and body, needing no refetch', () => {
    const msgSummary = summary({
      id: 'msg_1',
      kind: 'message',
      title: 'hello',
      state: {
        kind: 'message',
        anchorId: TASK,
        rootMessageId: null,
        author: summary().createdBy,
        editedAt: null,
      },
    });
    const m = new WorkspaceEventMapper(fixedProjector(new Map([['msg_1', msgSummary]])));
    const event = m.mapRow(
      row({
        event_type: 'message.created',
        // The payload body is deliberately DIFFERENT from the live content below.
        // The projection must use the live row, so this stale text must not
        // appear — that is the redaction fix in miniature.
        payload: { entity_id: 'msg_1', anchor_id: TASK, body: 'stale payload text', mentions: [], attachments: [] },
      }),
      new Map([['msg_1', msgSummary]]),
      new Map(),
      new Map([['msg_1', { body: 'hello', mentions: [], attachments: [] }]]),
    );
    if (event.type !== 'message.created') throw new Error('unreachable');
    expect(event.anchorId).toBe(TASK);
    expect(event.message.content.body).toBe('hello');
    expect(event.message.content.body, 'the frozen payload must not be the source').not.toBe(
      'stale payload text',
    );
    expect(WorkspaceEventSchema.safeParse(event).success).toBe(true);
  });

  /**
   * The privacy guarantee, at the unit level: with no live row available the
   * mapper must SKIP rather than fall back to the captured payload. A fallback
   * would serve pre-redaction text, since `message.created`'s payload froze the
   * original body at insert time.
   */
  it('refuses to serve a message from its captured payload when the live row is gone', () => {
    const msgSummary = summary({
      id: 'msg_1',
      kind: 'message',
      state: { kind: 'message', anchorId: TASK, rootMessageId: null, author: summary().createdBy, editedAt: null },
    });
    const m = new WorkspaceEventMapper(fixedProjector(new Map([['msg_1', msgSummary]])));
    expect(() =>
      m.mapRow(
        row({
          event_type: 'message.created',
          payload: { entity_id: 'msg_1', anchor_id: TASK, body: 'secret', mentions: [], attachments: [] },
        }),
        new Map([['msg_1', msgSummary]]),
        new Map(),
        new Map(), // no live content
      ),
    ).toThrow(UnprojectableEventError);
  });

  it('SKIPS a row whose entity is unreadable, and says so', async () => {
    const skips: string[] = [];
    const empty = new WorkspaceEventMapper(fixedProjector(new Map()));
    const out = await empty.mapRows(NO_QUERIER, [row()], (err) => skips.push(err.message));
    expect(out).toEqual([]);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatch(/not readable/);
  });

  it('a skipped row does not take the rest of the page with it', async () => {
    const out = await mapper.mapRows(
      NO_QUERIER,
      [row({ seq: '1', payload: { id: 'missing-entity' } }), row({ seq: '2' })],
      () => {},
    );
    expect(out.map((e) => e.seq)).toEqual([2]);
  });

  it('refuses to invent a projection for an unknown captured event_type', () => {
    expect(() => mapper.mapRow(row({ event_type: 'entity.exploded' }), entities)).toThrow(
      UnprojectableEventError,
    );
  });

  /**
   * The tripwire, from the mapper's side. A payload that hydrates to a summary
   * the contract rejects must fail HERE rather than reach a client — the whole
   * reason the check is shared with the publisher instead of living in it.
   */
  it('fires the contract tripwire on an off-contract projection', () => {
    const bad = new Map([[TASK, { ...summary(), counters: 'not-counters' } as unknown as EntitySummary]]);
    const m = new WorkspaceEventMapper(fixedProjector(bad));
    expect(() => m.mapRow(row(), bad)).toThrow(OffContractEventError);
  });

  it('maps an empty page without touching the projector', async () => {
    const exploding: EntityProjector = {
      entitySummaries: () => {
        throw new Error('projector must not be called for an empty page');
      },
    };
    const out = await new WorkspaceEventMapper(exploding).mapRows(NO_QUERIER, []);
    expect(out).toEqual([]);
  });
});
