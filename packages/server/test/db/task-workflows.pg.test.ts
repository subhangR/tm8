/**
 * W4-PG — migration 132's repeatable database proof.
 *
 * The production-server harness applies `migrationFiles()` itself and exposes
 * the exact list it applied.  This suite therefore runs on the full official
 * chain rather than on a position-pinned slice.  Refusal DETAIL assertions go
 * through the HTTP boundary: PgDb JSON-parses PostgreSQL's RAISE DETAIL and
 * the wire serializer exposes those fields directly under `error.details`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { migrationFiles } from './w1-pg.js';
import {
  startSurfaceServer,
  type SurfaceResponse,
  type SurfaceServer,
} from '../w5/surface/harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const FULL_MIGRATION_CHAIN = migrationFiles();
const CODE_VOCABULARY = ['open', 'working', 'in_review', 'done'] as const;

interface CommandEntity {
  id: string;
  version: number;
  state: { kind: string; workStatus?: string };
  content: { kind: string; axes?: Record<string, string> };
}

interface CommandResult {
  entity?: CommandEntity;
}

interface TaskWorkflow {
  id: string;
  spaceId: string;
  typeValue: string;
  statuses: string[];
}

function dataOf<T>(response: SurfaceResponse): T {
  const envelope = response.json as { data?: T; error?: unknown } | undefined;
  if (response.status < 200 || response.status >= 300 || envelope?.data === undefined) {
    throw new Error(`expected success, received ${response.status}: ${JSON.stringify(response.json)}`);
  }
  return envelope.data;
}

function errorFacts(response: SurfaceResponse): {
  status: number;
  code: string | null;
  details: unknown;
} {
  return {
    status: response.status,
    code: response.errorCode,
    details: response.errorDetails,
  };
}

describe.sequential('W4-PG migration 132 task-workflow semantics', () => {
  let server: SurfaceServer;
  let spaceId = '';
  let memberId = '';
  let codeWorkflowId = '';

  const createTask = async (
    suffix: string,
    content: Record<string, unknown> = {},
    targetSpaceId = spaceId,
  ): Promise<CommandEntity> => {
    const result = dataOf<CommandResult>(await server.request('POST', '/v2/entities', {
      clientMutationId: `w4-pg-task-${suffix}`,
      spaceId: targetSpaceId,
      kind: 'task',
      title: `W4 PG ${suffix}`,
      content,
    }));
    if (!result.entity) throw new Error(`task fixture ${suffix} returned no entity`);
    return result.entity;
  };

  const versionOf = async (taskId: string): Promise<number> => {
    const rows = await server.database.query<{ version: number }>(
      'select version from public.entities where id = $1',
      [taskId],
    );
    if (!rows[0]) throw new Error(`task fixture ${taskId} disappeared`);
    return rows[0].version;
  };

  const work = (
    taskId: string,
    status: string,
    mutationSuffix: string,
  ): Promise<SurfaceResponse> => server.request(
    'POST',
    `/v2/entities/${taskId}/commands/work`,
    { clientMutationId: `w4-pg-work-${mutationSuffix}`, status },
  );

  beforeAll(async () => {
    server = await startSurfaceServer('w4_task_workflows');
    expect(server.appliedMigrations).toEqual(FULL_MIGRATION_CHAIN);
    expect(server.appliedMigrations).toContain('132_task_workflows.sql');

    const created = dataOf<{
      space: { id: string };
      memberId: string;
    }>(await server.request('POST', '/v2/spaces', {
      clientMutationId: 'w4-pg-space-create',
      name: 'W4 migration 132 proof',
    }));
    spaceId = created.space.id;
    memberId = created.memberId;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  }, 180_000);

  it('installs the status-change trigger and refuses a vocabulary missing a structural status', async () => {
    const structure = await server.database.query<{
      constraint_name: string;
      trigger_name: string;
    }>(
      `select constraint_row.conname constraint_name, trigger_row.tgname trigger_name
         from pg_constraint constraint_row
         join pg_class workflow_table on workflow_table.oid = constraint_row.conrelid
         cross join pg_trigger trigger_row
         join pg_class task_table on task_table.oid = trigger_row.tgrelid
        where workflow_table.relname = 'task_workflows'
          and constraint_row.conname = 'task_workflows_structural_statuses'
          and task_table.relname = 'tasks'
          and trigger_row.tgname = 'tasks_validate_workflow'
          and not trigger_row.tgisinternal`,
    );
    expect(structure).toEqual([{
      constraint_name: 'task_workflows_structural_statuses',
      trigger_name: 'tasks_validate_workflow',
    }]);

    await expect(server.database.query(
      `insert into public.task_workflows(space_id, type_value, statuses)
       values ($1, 'missing-done', array['open','working']::text[])`,
      [spaceId],
    )).rejects.toMatchObject({
      code: '23514',
      constraint: 'task_workflows_structural_statuses',
    });
  });

  it('refuses duplicate statuses and replaces one natural-key row without changing its id', async () => {
    const duplicate = await server.request('POST', `/v2/spaces/${spaceId}/task-workflows`, {
      clientMutationId: 'w4-pg-workflow-duplicate',
      typeValue: 'code',
      statuses: ['open', 'working', 'done', 'done'],
    });
    expect(errorFacts(duplicate)).toEqual({
      status: 400,
      code: 'invalid_input',
      details: expect.objectContaining({ sqlstate: '22023' }),
    });

    const first = dataOf<TaskWorkflow>(
      await server.request('POST', `/v2/spaces/${spaceId}/task-workflows`, {
        clientMutationId: 'w4-pg-workflow-code-first',
        typeValue: 'code',
        statuses: ['open', 'working', 'done', 'blocked'],
      }),
    );
    const replaced = dataOf<TaskWorkflow>(
      await server.request('POST', `/v2/spaces/${spaceId}/task-workflows`, {
        clientMutationId: 'w4-pg-workflow-code-replace',
        typeValue: 'code',
        statuses: [...CODE_VOCABULARY],
      }),
    );
    codeWorkflowId = replaced.id;

    expect(replaced).toEqual({
      id: first.id,
      spaceId,
      typeValue: 'code',
      statuses: [...CODE_VOCABULARY],
    });
    const rows = await server.database.query<{ id: string; statuses: string[] }>(
      `select id::text, statuses from public.task_workflows
        where space_id = $1 and type_value = 'code'`,
      [spaceId],
    );
    expect(rows).toEqual([{ id: first.id, statuses: [...CODE_VOCABULARY] }]);
  });

  it('projects the same workflows through the list operation and spaces.settings', async () => {
    const listed = dataOf<TaskWorkflow[]>(
      await server.request('GET', `/v2/spaces/${spaceId}/task-workflows`, undefined),
    );
    expect(listed).toEqual([{
      id: codeWorkflowId,
      spaceId,
      typeValue: 'code',
      statuses: [...CODE_VOCABULARY],
    }]);

    const settings = dataOf<{ taskWorkflows?: TaskWorkflow[] }>(
      await server.request('GET', `/v2/spaces/${spaceId}/settings`, undefined),
    );
    expect(settings.taskWorkflows).toEqual(listed);
  });

  it('never constrains a task with no type value or a type with no rule', async () => {
    const untyped = await createTask('untyped');
    const unruled = await createTask('unruled-design', { axes: { type: 'design' } });

    dataOf<CommandResult>(await work(untyped.id, 'cancelled', 'untyped-cancelled'));
    dataOf<CommandResult>(await work(unruled.id, 'blocked', 'unruled-blocked'));

    const rows = await server.database.query<{ id: string; work_status: string }>(
      `select entity_id::text id, work_status from public.tasks
        where entity_id = any($1::uuid[]) order by entity_id`,
      [[untyped.id, unruled.id]],
    );
    expect(new Map(rows.map((row) => [row.id, row.work_status]))).toEqual(new Map([
      [untyped.id, 'cancelled'],
      [unruled.id, 'blocked'],
    ]));
  });

  it('allows a type change onto an illegal current status, then allows a move back into the vocabulary', async () => {
    const task = await createTask('retype-off-workflow', { axes: { type: 'design' } });
    dataOf<CommandResult>(await work(task.id, 'blocked', 'retype-before'));

    const patched = dataOf<CommandResult>(await server.request('PATCH', `/v2/entities/${task.id}`, {
      clientMutationId: 'w4-pg-retype-to-code',
      expectedVersion: await versionOf(task.id),
      content: { axes: { type: 'code' } },
    }));
    expect(patched.entity).toMatchObject({
      state: { kind: 'task', workStatus: 'blocked' },
    });

    const persisted = await server.database.query<{ axes: Record<string, string>; work_status: string }>(
      `select axes, work_status from public.tasks where entity_id = $1`,
      [task.id],
    );
    expect(persisted).toEqual([{ axes: { type: 'code' }, work_status: 'blocked' }]);

    const movedIn = dataOf<CommandResult>(await work(task.id, 'working', 'retype-move-in'));
    expect(movedIn.entity).toMatchObject({
      state: { kind: 'task', workStatus: 'working' },
    });
  });

  it('refuses only a move to a forbidden status and carries the complete machine-readable DETAIL', async () => {
    const task = await createTask('forbidden-target', { axes: { type: 'code' } });
    const refused = await work(task.id, 'blocked', 'forbidden-target');

    expect(errorFacts(refused)).toEqual({
      status: 409,
      code: 'invariant_violation',
      details: {
        sqlstate: '23514',
        reason: 'workflow_forbids_status',
        typeValue: 'code',
        status: 'blocked',
        allowed: [...CODE_VOCABULARY],
      },
    });
    const rows = await server.database.query<{ work_status: string }>(
      'select work_status from public.tasks where entity_id = $1',
      [task.id],
    );
    expect(rows[0]?.work_status).toBe('open');
  });

  it('keeps the done command gate and acceptance gate independent under a workflow', async () => {
    const criterion = { id: 'w4-pg-criterion', text: 'prove both gates', done: false };
    const task = await createTask('completion-gates', {
      axes: { type: 'code' },
      acceptanceCriteria: [criterion],
    });

    const wrongDoor = await work(task.id, 'done', 'completion-wrong-door');
    expect(errorFacts(wrongDoor)).toEqual({
      status: 409,
      code: 'invariant_violation',
      details: expect.objectContaining({ sqlstate: '23514', reason: 'use_complete_command' }),
    });

    const unchecked = await server.request('POST', `/v2/entities/${task.id}/commands/complete`, {
      clientMutationId: 'w4-pg-complete-unchecked',
      expectedVersion: await versionOf(task.id),
      completerIds: [memberId],
    });
    expect(errorFacts(unchecked)).toEqual({
      status: 409,
      code: 'invariant_violation',
      details: expect.objectContaining({ sqlstate: '23514' }),
    });

    dataOf<CommandResult>(await server.request('PATCH', `/v2/entities/${task.id}`, {
      clientMutationId: 'w4-pg-check-criterion',
      expectedVersion: await versionOf(task.id),
      content: { acceptanceCriteria: [{ ...criterion, done: true }] },
    }));
    const completed = dataOf<CommandResult>(
      await server.request('POST', `/v2/entities/${task.id}/commands/complete`, {
        clientMutationId: 'w4-pg-complete-checked',
        expectedVersion: await versionOf(task.id),
        completerIds: [memberId],
      }),
    );
    expect(completed.entity).toMatchObject({
      state: { kind: 'task', workStatus: 'done' },
    });
  });

  it('scopes deletion by space, returns P0002 for a foreign id, and widens after delete', async () => {
    const testWorkflow = dataOf<TaskWorkflow>(
      await server.request('POST', `/v2/spaces/${spaceId}/task-workflows`, {
        clientMutationId: 'w4-pg-workflow-test',
        typeValue: 'test',
        statuses: [...CODE_VOCABULARY],
      }),
    );
    const task = await createTask('delete-widens', { axes: { type: 'test' } });
    expect(errorFacts(await work(task.id, 'blocked', 'delete-before'))).toMatchObject({
      status: 409,
      code: 'invariant_violation',
    });

    const neighbouring = dataOf<{ space: { id: string } }>(
      await server.request('POST', '/v2/spaces', {
        clientMutationId: 'w4-pg-neighbour-space',
        name: 'W4 migration 132 neighbouring space',
      }),
    );
    const foreignWorkflow = dataOf<TaskWorkflow>(
      await server.request('POST', `/v2/spaces/${neighbouring.space.id}/task-workflows`, {
        clientMutationId: 'w4-pg-neighbour-workflow',
        typeValue: 'code',
        statuses: [...CODE_VOCABULARY],
      }),
    );

    const foreignDelete = await server.request(
      'DELETE',
      `/v2/spaces/${spaceId}/task-workflows/${foreignWorkflow.id}`,
      { clientMutationId: 'w4-pg-delete-foreign' },
    );
    expect(errorFacts(foreignDelete)).toEqual({
      status: 404,
      code: 'not_found',
      details: expect.objectContaining({ sqlstate: 'P0002' }),
    });

    const deleted = dataOf<{ workflowId: string }>(await server.request(
      'DELETE',
      `/v2/spaces/${spaceId}/task-workflows/${testWorkflow.id}`,
      { clientMutationId: 'w4-pg-delete-own' },
    ));
    expect(deleted).toEqual({ workflowId: testWorkflow.id });

    const widened = dataOf<CommandResult>(await work(task.id, 'blocked', 'delete-after'));
    expect(widened.entity).toMatchObject({
      state: { kind: 'task', workStatus: 'blocked' },
    });
  });
});
