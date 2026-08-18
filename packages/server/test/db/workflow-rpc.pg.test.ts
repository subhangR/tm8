/**
 * 148's ADMIN DOORS, through the real HTTP boundary.
 *
 * `workflows.pg.test.ts` proves the SCHEMA — it writes the tables directly,
 * because a trigger has to hold for a writer that bypassed the catalog. This
 * file proves the opposite half: that the catalog operations exist, mount,
 * authorize, and mean what the contract says. Nothing here writes a table.
 *
 * The two suites overlap on purpose in exactly one place — exactly-one-initial —
 * because it is enforced TWICE, once in the RPC (a clear 22023 the admin can
 * act on) and once as a deferred constraint trigger (the backstop that catches
 * a writer who never called the RPC). A test that only covered one would leave
 * the other free to be deleted as redundant.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { migrationFiles } from './w1-pg.js';
import { startSurfaceServer, type SurfaceResponse, type SurfaceServer } from '../w5/surface/harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const FULL_MIGRATION_CHAIN = migrationFiles();

interface WorkflowState {
  id: string;
  workflowId: string;
  name: string;
  category: string;
  position: number;
  isInitial: boolean;
  isDefault: boolean;
}

interface WorkflowTransition {
  id: string;
  workflowId: string;
  fromStateId: string | null;
  toStateId: string;
  conditions: Record<string, unknown>;
}

interface Workflow {
  id: string;
  spaceId: string | null;
  name: string;
  kind: string | null;
  states: WorkflowState[];
  transitions: WorkflowTransition[];
}

function dataOf<T>(response: SurfaceResponse): T {
  const envelope = response.json as { data?: T; error?: unknown } | undefined;
  if (response.status < 200 || response.status >= 300 || envelope?.data === undefined) {
    throw new Error(`expected success, received ${response.status}: ${JSON.stringify(response.json)}`);
  }
  return envelope.data;
}

const EPIC_STATES = [
  { name: 'Draft', category: 'to_do', isInitial: true },
  { name: 'Committed', category: 'in_progress' },
  { name: 'In Review', category: 'in_progress' },
  { name: 'Shipped', category: 'done' },
  { name: 'Dropped', category: 'cancelled' },
];

describe.sequential('148 — the workflow admin doors', () => {
  let server: SurfaceServer;
  let spaceId = '';
  let counter = 0;

  const upsert = async (body: Record<string, unknown>): Promise<SurfaceResponse> => {
    counter += 1;
    return server.request('POST', `/v2/spaces/${spaceId}/workflows`, {
      clientMutationId: `wf-rpc-${counter}`,
      ...body,
    });
  };

  beforeAll(async () => {
    server = await startSurfaceServer('w148_workflow_rpc');
    expect(server.appliedMigrations).toEqual(FULL_MIGRATION_CHAIN);
    expect(server.appliedMigrations).toContain('149_workflows.sql');

    const created = dataOf<{ space: { id: string } }>(
      await server.request('POST', '/v2/spaces', {
        clientMutationId: 'wf-rpc-space',
        name: '148 workflow doors',
      }),
    );
    spaceId = created.space.id;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  }, 180_000);

  it('lists the built-in default for a space that has authored nothing', async () => {
    const workflows = dataOf<Workflow[]>(
      await server.request('GET', `/v2/spaces/${spaceId}/workflows`, undefined),
    );
    // A brand-new space owns no workflows, and the answer is NOT an empty list:
    // the built-in default is the workflow every kind falls back to, so omitting
    // it would answer a question nobody asked ("which have you overridden?").
    expect(workflows).toHaveLength(1);
    expect(workflows[0]!.spaceId).toBeNull();
    expect(workflows[0]!.kind).toBeNull();
    expect(workflows[0]!.states.map((s) => [s.name, s.category])).toEqual([
      ['To Do', 'to_do'],
      ['In Progress', 'in_progress'],
      ['Done', 'done'],
      ['Cancelled', 'cancelled'],
    ]);
    expect(workflows[0]!.transitions).toEqual([]);
  });

  it('creates a whole workflow in ONE call, states and all', async () => {
    const workflow = dataOf<Workflow>(
      await upsert({ name: 'Epic flow', kind: 'c:epic', states: EPIC_STATES }),
    );
    expect(workflow.spaceId).toBe(spaceId);
    expect(workflow.name).toBe('Epic flow');
    expect(workflow.states.map((s) => s.name)).toEqual([
      'Draft', 'Committed', 'In Review', 'Shipped', 'Dropped',
    ]);
    // Position defaults to ARRAY ORDER — the caller ordered them deliberately,
    // and position is what decides a category's default state.
    expect(workflow.states.map((s) => s.position)).toEqual([1, 2, 3, 4, 5]);
    expect(workflow.states.filter((s) => s.isInitial).map((s) => s.name)).toEqual(['Draft']);
    // Zero transitions is the NORMAL case and the whole design: this workflow
    // is fully usable, by the ruled category defaults, with no rows at all.
    expect(workflow.transitions).toEqual([]);
  });

  it('refuses a workflow with no initial state — with a reason, not a bare sqlstate', async () => {
    const response = await upsert({
      name: 'Headless',
      kind: 'c:headless',
      states: [{ name: 'Only', category: 'to_do' }],
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.errorDetails ?? response.json))
      .toContain('workflow_initial_state_required');
  });

  it('refuses TWO initial states', async () => {
    const response = await upsert({
      name: 'Two starts',
      kind: 'c:two',
      states: [
        { name: 'A', category: 'to_do', isInitial: true },
        { name: 'B', category: 'to_do', isInitial: true },
      ],
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a fifth category at the EDGE, before it reaches the database', async () => {
    const response = await upsert({
      name: 'Fifth',
      kind: 'c:fifth',
      states: [{ name: 'Triaging', category: 'triaging', isInitial: true }],
    });
    // The closed four are closed in the zod schema AND in the table's CHECK.
    // This asserts the edge refuses, which is what keeps an invalid category
    // from ever being a database round trip.
    expect(response.status).toBe(400);
  });

  it('is an UPSERT on (space, kind, name) — a second call replaces the states', async () => {
    const updated = dataOf<Workflow>(
      await upsert({
        name: 'Epic flow',
        kind: 'c:epic',
        states: [
          { name: 'Draft', category: 'to_do', isInitial: true },
          { name: 'Committed', category: 'in_progress' },
          { name: 'Shipped', category: 'done' },
        ],
      }),
    );
    // 'In Review' and 'Dropped' were left out of the document, so they are
    // gone — whole-document semantics, not a patch.
    expect(updated.states.map((s) => s.name)).toEqual(['Draft', 'Committed', 'Shipped']);
    const listed = dataOf<Workflow[]>(await server.request('GET', `/v2/spaces/${spaceId}/workflows`, undefined));
    expect(listed.filter((w) => w.name === 'Epic flow')).toHaveLength(1);
  });

  it('stores transitions addressed by state NAME', async () => {
    const workflow = dataOf<Workflow>(
      await upsert({
        name: 'Override flow',
        kind: 'c:override',
        states: [
          { name: 'Backlog', category: 'to_do', isInitial: true },
          { name: 'Building', category: 'in_progress' },
          { name: 'Blocked', category: 'in_progress' },
          { name: 'Shipped', category: 'done' },
        ],
        transitions: [
          { from: 'Building', to: 'Blocked' },
          { to: 'Shipped' },
        ],
      }),
    );
    const byTarget = new Map(workflow.states.map((s) => [s.id, s.name]));
    const rendered = workflow.transitions.map((t) => [
      t.fromStateId === null ? 'ANY' : byTarget.get(t.fromStateId),
      byTarget.get(t.toStateId),
    ]);
    expect(rendered).toEqual(expect.arrayContaining([['Building', 'Blocked'], ['ANY', 'Shipped']]));
    // An absent `from` and an explicit null must be the SAME thing, and this is
    // where that gets proved rather than assumed.
    expect(workflow.transitions.filter((t) => t.fromStateId === null)).toHaveLength(1);
  });

  it('refuses a transition naming a state the workflow does not have', async () => {
    const response = await upsert({
      name: 'Bad target',
      kind: 'c:badtarget',
      states: [{ name: 'Start', category: 'to_do', isInitial: true }],
      transitions: [{ to: 'Nonexistent' }],
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.errorDetails ?? response.json)).toContain('unknown_state');
  });

  it('deletes a workflow the space owns', async () => {
    const workflow = dataOf<Workflow>(
      await upsert({
        name: 'Disposable',
        kind: 'c:disposable',
        states: [{ name: 'Start', category: 'to_do', isInitial: true }],
      }),
    );
    const response = await server.request('DELETE', `/v2/spaces/${spaceId}/workflows/${workflow.id}`, {
      clientMutationId: 'wf-rpc-delete',
    });
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    const listed = dataOf<Workflow[]>(await server.request('GET', `/v2/spaces/${spaceId}/workflows`, undefined));
    expect(listed.map((w) => w.name)).not.toContain('Disposable');
  });

  it('refuses to delete the BUILT-IN default — it belongs to no space', async () => {
    const listed = dataOf<Workflow[]>(await server.request('GET', `/v2/spaces/${spaceId}/workflows`, undefined));
    const builtin = listed.find((w) => w.spaceId === null)!;
    const response = await server.request('DELETE', `/v2/spaces/${spaceId}/workflows/${builtin.id}`, {
      clientMutationId: 'wf-rpc-delete-builtin',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    // Still there.
    const after = dataOf<Workflow[]>(await server.request('GET', `/v2/spaces/${spaceId}/workflows`, undefined));
    expect(after.filter((w) => w.spaceId === null)).toHaveLength(1);
  });

  it('leaves 132`s enforcement trigger alone — only the structural constraint went, in 151', async () => {
    const rows = await server.database.query<{ n: string }>(
      `select count(*) n from pg_trigger
        where tgname = 'tasks_validate_workflow' and not tgisinternal`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
    // 149 (this phase) did not touch it; 151 dropped it, on schedule, once the
    // doors resolved categories and the completion gate moved onto the
    // transition. `task_workflows` itself survives until phase 6.
    const constraint = await server.database.query<{ n: string }>(
      `select count(*) n from pg_constraint where conname = 'task_workflows_structural_statuses'`,
    );
    expect(Number(constraint[0]!.n)).toBe(0);
  });

  it('revokes the definer functions from PUBLIC — the thing 138 exists to have fixed', async () => {
    // A `security definer` function is EXECUTE-able by PUBLIC by default, so
    // granting it to tm8_app is not what restricts it; revoking it from PUBLIC
    // is. 132 shipped without the revoke and needed a whole migration (138) to
    // add it. This asserts 148 did not repeat that.
    const rows = await server.database.query<{ proname: string; acl: string | null }>(
      `select proname, proacl::text acl from pg_proc
        where proname in ('upsert_workflow', 'delete_workflow') order by proname`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.acl, `${row.proname} must have an explicit ACL`).not.toBeNull();
      // A PUBLIC grant appears as a leading `=X/` with no grantee before the `=`.
      expect(row.acl!.includes('{=X/') || row.acl!.includes(',=X/')).toBe(false);
      expect(row.acl!).toContain('tm8_app=X/');
    }
  });
});
