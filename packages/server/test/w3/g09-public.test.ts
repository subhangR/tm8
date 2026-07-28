import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  errorCode,
  startW3PublicServer,
  successData,
  type W3PublicServer,
} from './public-harness.js';

describe.sequential('W3.G09 saved views and actions through the production Server', () => {
  let harness: W3PublicServer;
  let spaceId = '';
  let taskId = '';
  let taskVersion = 0;
  let privateViewId = '';
  let sharedViewId = '';

  beforeAll(async () => {
    harness = await startW3PublicServer('g09');
    const space = successData<{ space: { id: string } }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-g09-space',
        name: 'W3 G09 public gate',
      }),
    );
    spaceId = space.space.id;
    const task = successData<{ entity: { id: string; version: number } }>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: 'w3-g09-task',
        spaceId,
        kind: 'task',
        title: 'Saved view target',
        content: { priority: 'high' },
      }),
    );
    taskId = task.entity.id;
    taskVersion = task.entity.version;
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  it('creates private and Space-shared views and replays one mutation without duplication', async () => {
    const query = { spaceId, kinds: ['task'], sort: 'activityAt_desc', limit: 20 };
    const created = successData<{
      id: string;
      spaceId: string;
      name: string;
      shareMode: string;
      query: Record<string, unknown>;
    }>(await harness.request('POST', '/v2/saved-views', {
      clientMutationId: 'w3-g09-private-create',
      name: 'My active tasks',
      shareMode: 'private',
      query,
    }));
    privateViewId = created.id;
    expect(created).toMatchObject({ spaceId, name: 'My active tasks', shareMode: 'private', query });

    const replay = successData<typeof created>(await harness.request('POST', '/v2/saved-views', {
      clientMutationId: 'w3-g09-private-create',
      name: 'ignored replay',
      shareMode: 'space',
      query,
    }));
    expect(replay).toEqual(created);

    const shared = successData<typeof created>(await harness.request('POST', '/v2/saved-views', {
      clientMutationId: 'w3-g09-shared-create',
      name: 'Team graph',
      shareMode: 'space',
      query: { spaceId, kinds: ['task'], layout: 'graph' },
      graphLayout: { [taskId]: { x: 12, y: 34 } },
    }));
    sharedViewId = shared.id;
    expect(shared).toMatchObject({ spaceId, name: 'Team graph', shareMode: 'space' });

    const rows = await harness.rows<{ views: number; ledger_rows: number }>(
      `select
         (select count(*)::integer from public.saved_views where space_id = $1) views,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id in ('w3-g09-private-create', 'w3-g09-shared-create')) ledger_rows`,
      [spaceId],
    );
    expect(rows[0]).toEqual({ views: 2, ledger_rows: 2 });
  });

  it('lists, updates, and deletes authorized views without mutating selected entities', async () => {
    const listed = successData<Array<{ id: string; shareMode: string }>>(
      await harness.request('GET', `/v2/spaces/${spaceId}/saved-views`),
    );
    expect(listed.map((view) => view.id)).toEqual(expect.arrayContaining([privateViewId, sharedViewId]));

    const updated = successData<{ id: string; name: string; shareMode: string }>(
      await harness.request('PATCH', `/v2/saved-views/${privateViewId}`, {
        clientMutationId: 'w3-g09-private-update',
        name: 'My focused tasks',
        shareMode: 'private',
        query: { spaceId, kinds: ['task'], filters: { workStatus: ['open'] } },
      }),
    );
    expect(updated).toMatchObject({ id: privateViewId, name: 'My focused tasks', shareMode: 'private' });

    const deleted = successData<{ viewId?: string; id?: string }>(
      await harness.request('DELETE', `/v2/saved-views/${sharedViewId}`, {
        clientMutationId: 'w3-g09-shared-delete',
      }),
    );
    expect(deleted.viewId ?? deleted.id).toBe(sharedViewId);

    const rows = await harness.rows<{
      private_name: string;
      shared_count: number;
      task_version: number;
      ledger_rows: number;
    }>(
      `select
         (select name from public.saved_views where id = $1) private_name,
         (select count(*)::integer from public.saved_views where id = $2) shared_count,
         (select version from public.entities where id = $3) task_version,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id in ('w3-g09-private-update', 'w3-g09-shared-delete')) ledger_rows`,
      [privateViewId, sharedViewId, taskId],
    );
    expect(rows[0]).toEqual({
      private_name: 'My focused tasks',
      shared_count: 0,
      task_version: taskVersion,
      ledger_rows: 2,
    });
  });

  it('discovers only live registered and target-applicable actions', async () => {
    const global = successData<{
      actorId: string;
      capabilityEpoch: string;
      actions: Array<{ operation: string; helpRef: string; exposure: string }>;
    }>(await harness.request('GET', '/v2/actions'));
    expect(global.capabilityEpoch).toMatch(/^cap:/);
    expect(global.actions.length).toBeGreaterThan(0);

    const contextual = successData<{
      targetEntityId: string;
      targetVersion: number;
      capabilityEpoch: string;
      actions: Array<{
        operation: string;
        targetEntityId?: string;
        targetVersion?: number;
        helpRef: string;
        exposure: string;
      }>;
    }>(await harness.request('GET', `/v2/actions?contextEntityId=${taskId}`));
    expect(contextual).toMatchObject({ targetEntityId: taskId, targetVersion: taskVersion });
    expect(contextual.capabilityEpoch).toMatch(/^cap:/);

    const operations = contextual.actions.map((action) => action.operation);
    expect(operations).toContain('entities.get');
    expect(operations).not.toEqual(expect.arrayContaining([
      'execution.prompt',
      'events.subscribe',
      'search.query',
      'bridge.fetchBlob',
    ]));
    for (const action of contextual.actions) {
      expect(action.helpRef).toBe(`tm8://help/operation/${action.operation}`);
      expect(action.exposure).not.toBe('reserved');
      expect(action.targetEntityId).toBe(taskId);
      expect(action.targetVersion).toBe(taskVersion);
    }
  });

  it('rejects strict unknown saved-view input without a row or ledger effect', async () => {
    const response = await harness.request('POST', '/v2/saved-views', {
      clientMutationId: 'w3-g09-invalid',
      name: 'Invalid',
      shareMode: 'private',
      query: { spaceId },
      unknownField: true,
    });
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe('invalid_input');

    const rows = await harness.rows<{ views: number; ledger_rows: number }>(
      `select
         (select count(*)::integer from public.saved_views where space_id = $1 and name = 'Invalid') views,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id = 'w3-g09-invalid') ledger_rows`,
      [spaceId],
    );
    expect(rows[0]).toEqual({ views: 0, ledger_rows: 0 });
  });
});
