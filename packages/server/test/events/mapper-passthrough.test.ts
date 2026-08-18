/**
 * Passthrough arm unit tests — no database. Lands at
 * packages/server/test/events/mapper-passthrough.test.ts on GO-EDIT.
 *
 * Delta 1: RPC-authored rows whose stored payload IS the contract event body
 * (RPC_AUTHORED_PASSTHROUGH) project verbatim through the shared
 * assertWorkspaceEvent tripwire; everything else keeps the fail-loud default.
 * The Postgres-backed proof of the same path is Delta 3's e2e harness
 * (menu.updated asserted DB→WS there); this file tells you WHICH rule broke.
 */
import { describe, expect, it } from 'vitest';
import { WorkspaceEventSchema, type EntitySummary } from '@tm8/contract';

import {
  RPC_AUTHORED_PASSTHROUGH,
  UnprojectableEventError,
  WorkspaceEventMapper,
  type WorkspaceEventRow,
} from '../../src/events/mapper.js';
import type { EntityProjector } from '../../src/events/projector.js';
import type { Querier } from '../../src/db/types.js';

const SPACE = '019f9896-928d-79b6-ba1c-1cdcc1d30a6f';
const TASK = '019f9896-928d-7a24-848b-4c8fdd82b761';
const MEMBER = '019f9896-928d-7a09-aac0-021c7d4652c6';
const CHANNEL = '019f9896-928d-7a30-9c11-3f2ab8d1c001';

/** A menu exactly as internal.w2_render_menu (029:205) emits one. */
const MENU = {
  schemaVersion: 1,
  revision: 3,
  groups: [
    { id: 'main', label: 'Main', items: [{ type: 'view', ref: 'settings' }] },
  ],
} as const;

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
      status: 'open',
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

function fixedProjector(entities: Map<string, EntitySummary>): EntityProjector {
  return { entitySummaries: () => Promise.resolve(entities) };
}

/** None of the passthrough types touch messages, so no query ever runs. */
const NO_QUERIER = {} as Querier;

function row(over: Partial<WorkspaceEventRow> = {}): WorkspaceEventRow {
  return {
    id: 'evt_1',
    space_id: SPACE,
    seq: '1',
    event_type: 'menu.updated',
    payload: { type: 'menu.updated', menu: MENU },
    client_mutation_id: null,
    recipient_member_id: null,
    occurred_at: '2026-07-25T00:00:00.000Z',
    schema_version: 1,
    ...over,
  };
}

describe('WorkspaceEventMapper passthrough arm', () => {
  const entities = new Map([[TASK, summary()]]);
  const mapper = new WorkspaceEventMapper(fixedProjector(entities));

  // (a) each membership type projects VERBATIM under the row envelope.

  it('projects menu.updated verbatim: stored payload is the event body', () => {
    const event = mapper.mapRow(
      row({ seq: '7', payload: { type: 'menu.updated', menu: MENU, clientMutationId: 'cmid_menu' }, client_mutation_id: 'cmid_menu' }),
      entities,
    );
    if (event.type !== 'menu.updated') throw new Error('unreachable');
    expect(event.menu).toEqual(MENU);
    expect(event.spaceId).toBe(SPACE);
    expect(event.seq).toBe(7);
    expect(typeof event.seq).toBe('number');
    expect(event.occurredAt).toBe('2026-07-25T00:00:00.000Z');
    expect(event.clientMutationId).toBe('cmid_menu');
    expect(WorkspaceEventSchema.safeParse(event).success).toBe(true);
  });

  it('projects space.default_channel.updated verbatim, including the null-channel state', () => {
    for (const channelId of [CHANNEL, null]) {
      const event = mapper.mapRow(
        row({
          event_type: 'space.default_channel.updated',
          payload: { type: 'space.default_channel.updated', channelId, settingsRevision: 4 },
        }),
        entities,
      );
      if (event.type !== 'space.default_channel.updated') throw new Error('unreachable');
      expect(event.channelId).toBe(channelId);
      expect(event.settingsRevision).toBe(4);
      expect(WorkspaceEventSchema.safeParse(event).success).toBe(true);
    }
  });

  // (e) envelope integrity: cmid omitted (not null) when the row column is NULL.

  it('omits clientMutationId when the row has none', () => {
    const event = mapper.mapRow(row(), entities);
    expect('clientMutationId' in event).toBe(false);
    expect(WorkspaceEventSchema.safeParse(event).success).toBe(true);
  });

  // (b) unknown types still fail loudly — the tripwire stays armed.

  it('still refuses a genuinely unknown event_type', () => {
    expect(() => mapper.mapRow(row({ event_type: 'totally.unknown', payload: {} }), entities))
      .toThrow(UnprojectableEventError);
    expect(() => mapper.mapRow(row({ event_type: 'totally.unknown', payload: {} }), entities))
      .toThrow(/no projection for captured event_type/);
  });

  /**
   * Contract drift, DOCUMENTED until master rules on the fix: migration 027
   * authors 'interaction_profile.teammate_default_updated' (027:1189) and
   * 'interaction_profile.space_default_updated' (027:1244), but the contract
   * declares only 'interaction_profile.default_updated' (schemas.ts:702).
   * These names must hit the default throw — adding them to the passthrough
   * set could never emit them (no contract arm exists to validate against).
   */
  it('routes the 027-authored off-contract type names to the default throw', () => {
    const drifted: Array<[string, Record<string, unknown>]> = [
      ['interaction_profile.teammate_default_updated',
        { teamMemberId: TASK, profileId: TASK, version: 2, selectedBy: MEMBER }],
      ['interaction_profile.space_default_updated',
        { spaceId: SPACE, profileId: TASK, settingsRevision: 2, selectedBy: MEMBER }],
    ];
    for (const [event_type, payload] of drifted) {
      expect(RPC_AUTHORED_PASSTHROUGH.has(event_type)).toBe(false);
      expect(() => mapper.mapRow(row({ event_type, payload }), entities))
        .toThrow(/no projection for captured event_type/);
    }
  });

  // (c) a membership-type row whose STORED payload fails strict validation is
  // rejected as a skippable bad row — never emitted, never a page-fatal error.

  it('rejects an off-contract stored payload as UnprojectableEventError, not an emission', () => {
    // The surviving 015-era shape: the rendered menu with no `type` wrapper.
    const legacy = row({ payload: { schemaVersion: 1, revision: 2, groups: [] } });
    expect(() => mapper.mapRow(legacy, entities)).toThrow(UnprojectableEventError);
    expect(() => mapper.mapRow(legacy, entities)).toThrow(/off-contract/);

    // Strictness both ways: one extra key on an otherwise valid payload.
    const extraKey = row({ payload: { type: 'menu.updated', menu: MENU, extra: 'x' } });
    expect(() => mapper.mapRow(extraKey, entities)).toThrow(UnprojectableEventError);
  });

  it('skips a bad stored row in mapRows, reports it, and delivers the rest of the page', async () => {
    const skipped: UnprojectableEventError[] = [];
    const events = await mapper.mapRows(
      NO_QUERIER,
      [
        row({ seq: '10' }),
        row({ seq: '11', payload: { schemaVersion: 1, revision: 2, groups: [] } }),
        row({ seq: '12', event_type: 'space.default_channel.updated',
          payload: { type: 'space.default_channel.updated', channelId: null, settingsRevision: 9 } }),
      ],
      (err) => skipped.push(err),
    );
    expect(events.map((e) => e.seq)).toEqual([10, 12]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.seq).toBe(11);
  });

  // (d) no double-delivery: the set excludes every trigger-authored type, and
  // trigger rows keep their bespoke arms.

  it('contains no trigger-authored (entity-backed) event type', () => {
    const triggerTypes = [
      'entity.upsert', 'entity.deleted',
      'edge.upsert', 'edge.deleted',
      'message.created', 'message.updated', 'message.deleted',
      'counter.changed', 'activity.created',
      'notification.created', 'notification.read',
    ];
    for (const type of triggerTypes) {
      expect(RPC_AUTHORED_PASSTHROUGH.has(type)).toBe(false);
    }
    expect([...RPC_AUTHORED_PASSTHROUGH].sort()).toEqual([
      'git.commit_recorded',
      'git.pr_state_changed',
      'git.worktree_status_changed',
      'menu.updated',
      'space.default_channel.updated',
    ]);
  });

  // 082's git facts: authored by capture triggers on the FACTS tables
  // (commits / pull_requests / worktrees — none 003-covered), but PASSTHROUGH
  // members because the trigger builds the payload contract-shaped, `type`
  // included — unlike 003's raw to_jsonb(row) captures.

  it('projects git.commit_recorded verbatim', () => {
    const event = mapper.mapRow(
      row({
        event_type: 'git.commit_recorded',
        payload: {
          type: 'git.commit_recorded',
          commitEntityId: TASK,
          repo: 'acme/repo',
          sha: 'a'.repeat(40),
          provider: 'github',
        },
      }),
      entities,
    );
    if (event.type !== 'git.commit_recorded') throw new Error('unreachable');
    expect(event.commitEntityId).toBe(TASK);
    expect(event.sha).toBe('a'.repeat(40));
    expect(WorkspaceEventSchema.safeParse(event).success).toBe(true);
  });

  it('projects git.pr_state_changed verbatim, null headSha included', () => {
    const event = mapper.mapRow(
      row({
        event_type: 'git.pr_state_changed',
        payload: {
          type: 'git.pr_state_changed',
          prEntityId: TASK,
          repo: 'acme/repo',
          number: 67,
          previousState: 'open',
          state: 'merged',
          headSha: null,
        },
      }),
      entities,
    );
    if (event.type !== 'git.pr_state_changed') throw new Error('unreachable');
    expect(event.previousState).toBe('open');
    expect(event.state).toBe('merged');
    expect(WorkspaceEventSchema.safeParse(event).success).toBe(true);
  });

  it('projects git.worktree_status_changed verbatim', () => {
    const event = mapper.mapRow(
      row({
        event_type: 'git.worktree_status_changed',
        payload: {
          type: 'git.worktree_status_changed',
          worktreeEntityId: TASK,
          projectId: SPACE,
          branch: 'feat/lane',
          previousStatus: 'active',
          status: 'merged',
        },
      }),
      entities,
    );
    if (event.type !== 'git.worktree_status_changed') throw new Error('unreachable');
    expect(event.status).toBe('merged');
    expect(WorkspaceEventSchema.safeParse(event).success).toBe(true);
  });

  it('still projects a trigger-captured entity.upsert through the entity arm, not verbatim', () => {
    const event = mapper.mapRow(
      row({ event_type: 'entity.upsert', payload: { id: TASK } }),
      entities,
    );
    if (event.type !== 'entity.upsert') throw new Error('unreachable');
    // The hydrated summary, not the raw captured row — passthrough did not
    // swallow the entity arm.
    expect(event.entity.id).toBe(TASK);
    expect(event.entity.title).toBe('A task');
  });
});
