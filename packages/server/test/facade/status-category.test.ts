/**
 * Phase 1 of "Kind, Status, Category, Workflow": the category on the wire.
 *
 * Three things are under test, and the SECOND is the one this file exists for.
 *
 * 1. `buildWhere` grows a category predicate — on `e`, not on `t`, because the
 *    whole reason the column was denormalized onto the envelope is that a
 *    predicate needing the task join could never serve the twenty kinds that
 *    gain a status in a later phase.
 *
 * 2. **`EntitySummary.category` is projected by BOTH copies of the read path.**
 *    `facade/entity-read.ts` and `events/projector.ts` are two hand-maintained
 *    assemblers of the same DTO, and "someone updated one and not the other" is
 *    this program's NAMED recurring risk — it surfaces as the socket and the
 *    REST read disagreeing about one entity, for one kind, which reads like a
 *    caching bug for a week. So every assertion below runs against both, from
 *    one table of cases, and adding a case to one path without the other is a
 *    red test rather than a discovery in production.
 *
 * 3. The narrowing posture, now SHARED (`facade/status.ts`). Phase 0 made the
 *    event path raise on an unrecognised `work_status` while the read path
 *    still cast it unchecked (`(row.work_status ?? 'open') as WorkStatus`), so
 *    the two paths disagreed about what an impossible value means. Phase 1
 *    settles it loud, in both.
 *
 * The migration is not mocked where it can be read: the `work_status ->
 * category` mapping is a product decision written down in TWO artifacts, and
 * the last test holds the TypeScript copy against the SQL one by parsing the
 * migration file. A drift between them would silently file rows under the
 * wrong tab, and neither artifact can catch that alone.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { StatusCategory } from '@tm8/contract';
import { EntitySummarySchema } from '@tm8/contract';
import {
  toEntitySummary,
  type AssemblyContext,
  type EntityRow,
} from '../../src/facade/entity-read.js';
import { PgEntityProjector } from '../../src/events/projector.js';
import {
  SESSION_STATUS_CATEGORY,
  StatusCategoryDriftError,
  WorkStatusDriftError,
  WORK_STATUS_CATEGORY,
} from '../../src/facade/status.js';
import { queryCollection } from '../../src/facade/handlers/collections.js';
import type { Querier } from '../../src/db/types.js';

const SPACE = '33333333-3333-4333-8333-333333333333';
const TASK = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const VIEWER = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-08-18T00:00:00.000Z';

// ---------------------------------------------------------------------------
// The two assemblers, behind one interface
// ---------------------------------------------------------------------------

/** The columns both assemblers read for a task, under each one's own names. */
interface Fixture {
  status: string | null;
  statusCategory: string | null;
}

// `ownerMemberId` is OMITTED, not null: `ActorSummarySchema` types it as an
// optional string, so a null here fails the summary parse below for a reason
// that has nothing to do with categories.
const actor = {
  id: ACTOR,
  kind: 'member' as const,
  displayName: 'A member',
  avatar: null,
  role: null,
  isAgent: false,
};

const assembly: AssemblyContext = {
  actors: new Map([[ACTOR, actor]]),
  // Every field of EntityRelations, empty — `badgesOf` and the task arm of
  // `stateOf` index these maps directly, so an omitted field is a TypeError at
  // read time rather than a missing badge.
  relations: {
    attention: new Map(),
    assignees: new Map(),
    assignments: new Map(),
    members: new Map(),
    childCounts: new Map(),
    blockedBy: new Map(),
    pulls: new Map(),
    workingOn: new Map(),
    completedBy: new Map(),
    itemCounts: new Map(),
    marks: new Map(),
    defaultProfiles: new Map(),
  },
  viewerReactions: new Map(),
};

function readPathSummary({ status, statusCategory }: Fixture) {
  const row = {
    id: TASK,
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
    created_by: ACTOR,
    status_category: statusCategory,
    likes: 0,
    dislikes: 0,
    stars: 0,
    points: 0,
    messages: 0,
    task_title: 'A task',
    work_status: status,
    priority: 'medium',
    completion_gate: 'none',
    acceptance_criteria: [],
    ws_pin_revision: null,
    ws_pin_template_key: null,
    ws_pin_template_version: null,
    ws_pin_resolved_snapshot: null,
  } as unknown as EntityRow;
  return toEntitySummary(row, assembly);
}

/** The one marker unique to the projector's wide hydration join. */
const SUMMARY_MARKER = 't.work_status, t.priority';

async function eventPathSummary({ status, statusCategory }: Fixture) {
  const row: Record<string, unknown> = {
    id: TASK,
    space_id: SPACE,
    kind: 'task',
    parent_id: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activity_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    created_by: ACTOR,
    status_category: statusCategory,
    likes: 0,
    dislikes: 0,
    stars: 0,
    points: 0,
    messages: 0,
    human_messages: 0,
    agent_messages: 0,
    docs: 0,
    memories: 0,
    task_title: 'A task',
    task_description: null,
    work_status: status,
    priority: 'medium',
    completion_gate: 'none',
    axes: null,
    due_date: null,
    acceptance_criteria: [],
    custom_fields: null,
  };
  const querier = {
    query: async (sql: string) => (sql.includes(SUMMARY_MARKER) ? [row] : []),
    rpc: async () => {
      throw new Error('the projector must not write');
    },
  } as unknown as Querier;
  const summaries = await new PgEntityProjector().entitySummaries(querier, [TASK]);
  const summary = summaries.get(TASK);
  if (!summary) throw new Error('the projector dropped the row');
  return summary;
}

/**
 * Both assemblers, as one list. Every projection assertion below runs over this
 * — which is the mechanism, not a style choice: a case added for one path and
 * not the other cannot pass.
 */
const PATHS = [
  { name: 'entity-read (REST)', summarise: async (f: Fixture) => readPathSummary(f) },
  { name: 'projector (events)', summarise: eventPathSummary },
] as const;

// ---------------------------------------------------------------------------
// 1. buildWhere
// ---------------------------------------------------------------------------

/** Runs a collection query against a Querier that answers nothing, and returns every SQL it saw. */
async function sqlFor(filters: Record<string, unknown>): Promise<{ sql: string[]; params: unknown[][] }> {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const querier = {
    query: async (text: string, values: unknown[] = []) => {
      sql.push(text);
      params.push(values);
      return [];
    },
    rpc: async () => {
      throw new Error('a read must not write');
    },
  } as unknown as Querier;
  await queryCollection(querier, { spaceId: SPACE, filters } as never, VIEWER);
  return { sql, params };
}

describe('buildWhere: the category predicate', () => {
  it('binds the categories as one array against the ENVELOPE column', async () => {
    const { sql, params } = await sqlFor({ category: ['to_do', 'in_progress'] });
    const page = sql.find((s) => s.includes('e.status_category'));
    expect(page, 'no query carried a status_category predicate').toBeDefined();
    // On `e`, not on `t`: a category filter that needed the task join could not
    // serve the kinds that gain a status later.
    expect(page).toContain('e.status_category = any(');
    expect(page).not.toContain('t.status_category');
    expect(params.flat()).toContainEqual(['to_do', 'in_progress']);
  });

  // The column is in the SELECT list unconditionally (every summary carries the
  // category), so these look for the PREDICATE, not the identifier — asserting
  // on the bare word would go green against a buildWhere that never ran.
  const PREDICATE = 'e.status_category = any(';

  it('is absent entirely when the filter is', async () => {
    const { sql } = await sqlFor({});
    expect(sql.some((s) => s.includes(PREDICATE))).toBe(false);
    // ...but the column is still selected, or no summary could carry a category.
    expect(sql.some((s) => s.includes('e.status_category'))).toBe(true);
  });

  it('is absent when the filter is present but EMPTY — an empty list is not "match nothing"', async () => {
    const { sql } = await sqlFor({ category: [] });
    expect(sql.some((s) => s.includes(PREDICATE))).toBe(false);
  });

  it('sits beside the soft-delete posture, not instead of it', async () => {
    const { sql } = await sqlFor({ category: ['done'] });
    const page = sql.find((s) => s.includes('e.status_category'));
    // Archived is an ORTHOGONAL axis: asking for the `done` CATEGORY must not
    // start including tombstones, and must not stop excluding them.
    expect(page).toContain('e.deleted_at is null');
  });
});

// ---------------------------------------------------------------------------
// 2. EntitySummary.category — in BOTH copies of the read path
// ---------------------------------------------------------------------------

describe.each(PATHS)('EntitySummary.category — $name', ({ summarise }) => {
  it.each(['to_do', 'in_progress', 'done', 'cancelled'] as StatusCategory[])(
    'projects %s from the column',
    async (category) => {
      const summary = await summarise({ status: 'open', statusCategory: category });
      expect(summary.category).toBe(category);
    },
  );

  it('OMITS the key when the entity has no status — absence, not a default', async () => {
    const summary = await summarise({ status: 'open', statusCategory: null });
    // `in`, not `=== undefined`: the contract schema is `.strict()` and an
    // explicit `category: undefined` is a different object on the wire, in
    // Object.keys, and to the event feed's structural comparisons.
    expect('category' in summary).toBe(false);
  });

  it('stays a legal EntitySummary either way', async () => {
    for (const statusCategory of ['done', null]) {
      const summary = await summarise({ status: 'open', statusCategory });
      expect(EntitySummarySchema.safeParse(summary).success).toBe(true);
    }
  });

  it('RAISES on a category outside the closed four, rather than passing it through', async () => {
    // Categories are closed FOREVER — that is the bargain paid for open
    // statuses. So unlike a status, an unknown category can never be "one we
    // have not heard of yet"; it can only be a migration that broke the
    // bargain past a DDL CHECK.
    await expect(summarise({ status: 'open', statusCategory: 'archived' }))
      .rejects.toThrow(StatusCategoryDriftError);
  });
});

// ---------------------------------------------------------------------------
// 3. The narrowing posture, settled the same way in both paths
// ---------------------------------------------------------------------------

describe.each(PATHS)('work_status narrowing — $name', ({ summarise }) => {
  it('RAISES on a status the contract does not name', async () => {
    // This is the Phase 1 decision the handoff asked for explicitly. The event
    // path already raised (phase 0); the read path cast unchecked, so a drifted
    // status reached clients as a lie about a closed union. Both are loud now.
    await expect(summarise({ status: 'needs_triage', statusCategory: 'to_do' }))
      .rejects.toThrow(WorkStatusDriftError);
  });

  it('still treats NULL as open — a missing detail join is not drift', async () => {
    const summary = await summarise({ status: null, statusCategory: null });
    expect(summary.state).toMatchObject({ kind: 'task', status: 'open' });
  });
});

// ---------------------------------------------------------------------------
// 4. The mapping, held against its OTHER copy
// ---------------------------------------------------------------------------

describe('the ruled work_status -> category mapping', () => {
  /** `internal.work_status_category`'s CASE arms, read out of the migration. */
  function mappingFromMigration(): Record<string, string> {
    const path = fileURLToPath(
      new URL('../../../../db/migrations/147_entity_status_category.sql', import.meta.url),
    );
    const sql = readFileSync(path, 'utf8');
    const body = sql.slice(sql.indexOf('function internal.work_status_category'));
    const arms: Record<string, string> = {};
    for (const match of body.matchAll(/when '(\w+)'\s+then '(\w+)'/g)) {
      const [, status, category] = match;
      // Both groups are non-optional in the pattern, so this only skips if the
      // regex stopped matching what it was written for — in which case an EMPTY
      // table is the honest result and the comparison below goes red, rather
      // than a partial one quietly agreeing about the arms it did find.
      if (status === undefined || category === undefined) return {};
      arms[status] = category;
    }
    return arms;
  }

  it('is the same table in the migration and in the server', () => {
    // The migration is the WRITER — the server reads the column and never
    // computes it — so a disagreement here does not fail anything at runtime.
    // It just files rows under a tab the code says they are not in.
    expect(mappingFromMigration()).toEqual(WORK_STATUS_CATEGORY);
  });

  it('rules the two judgement calls the way the owner did', () => {
    // Not derivable, and visible to every user on migration day: a CLAIMED task
    // has not been started, and a BLOCKED task has been started and is stuck.
    expect(WORK_STATUS_CATEGORY.pulled).toBe('to_do');
    expect(WORK_STATUS_CATEGORY.blocked).toBe('in_progress');
  });

  it('keeps cancelled out of done', () => {
    // Abandoned work and finished work are the same thing only to a progress
    // bar. `cancelled` gets its own permanent tab (addendum §3.4).
    expect(WORK_STATUS_CATEGORY.cancelled).toBe('cancelled');
    expect(WORK_STATUS_CATEGORY.done).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// 5. The SESSION mapping, held against its other copy the same way
//
// 152 seeded every kind's status and 150's bridge kept TASKS in step with their
// detail row; nothing played that part for a session, so `work_session` sat in
// `to_do` from birth to forever (measured: 420 of 420 on this node, exited and
// failed rows included). 155 is that bridge. The mapping is written down in
// three places — the migration, `SESSION_STATUS_CATEGORY`, and the client's
// `SESSION_STATE_CONTROL` — and the migration is the only one that writes.
// ---------------------------------------------------------------------------

describe('the ruled work_session status -> category mapping', () => {
  /** `internal.session_status_category`'s CASE arms, read out of the migration. */
  function sessionMappingFromMigration(): Record<string, string> {
    const path = fileURLToPath(
      new URL('../../../../db/migrations/155_session_status_category.sql', import.meta.url),
    );
    const sql = readFileSync(path, 'utf8');
    const body = sql.slice(sql.indexOf('function internal.session_status_category'));
    const arms: Record<string, string> = {};
    for (const match of body.matchAll(/when '(\w+)'\s+then '(\w+)'/g)) {
      const [, status, category] = match;
      // An EMPTY table is the honest result if the regex stopped matching what
      // it was written for — see the note on the task copy above.
      if (status === undefined || category === undefined) return {};
      arms[status] = category;
    }
    return arms;
  }

  it('is the same table in the migration and in the server', () => {
    expect(sessionMappingFromMigration()).toEqual(SESSION_STATUS_CATEGORY);
  });

  it('files a spawning session under to_do, not in_progress', () => {
    // Two independent reasons, either of which settles it: 147's `pulled ->
    // to_do` ("claimed is not started") is the same shape of fact, and
    // `public.session_resume` moves an exited session back to `spawning` — a
    // legal `done -> to_do` REOPEN under this mapping and a `done ->
    // in_progress` that `category_transition_allowed` refuses under the other.
    expect(SESSION_STATUS_CATEGORY.spawning).toBe('to_do');
    expect(SESSION_STATUS_CATEGORY.idle).toBe('in_progress');
  });

  it('files a failed run under done, and leaves cancelled empty', () => {
    // The client's ruling, mirrored: failure is a runtime fact that gets a
    // badge, and the run reached its end — nobody cancelled it. Nothing in the
    // session lifecycle is a cancellation at all; `terminate` produces `exited`.
    expect(SESSION_STATUS_CATEGORY.failed).toBe('done');
    expect(SESSION_STATUS_CATEGORY.exited).toBe('done');
    expect(Object.values(SESSION_STATUS_CATEGORY)).not.toContain('cancelled');
  });
});
