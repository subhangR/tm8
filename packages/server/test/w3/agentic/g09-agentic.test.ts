import { afterEach, describe, expect, it } from 'vitest';

import { observeG09DatabaseOutcome } from '../agentic-observer.js';
import { startW3PublicServer, successData } from '../public-harness.js';

type W3Harness = Awaited<ReturnType<typeof startW3PublicServer>>;
type Action = { id: string; operation: string; exposure: string };

describe('W3.G09 agentic saved-view and action discovery', () => {
  let harness: W3Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('preserves the task while saved views replay, update, delete, and action discovery remain public', async () => {
    harness = await startW3PublicServer('agentic_g09');
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const spaceResult = successData<{ space: { id: string } }>(await harness.request('POST', '/v2/spaces', {
      name: `G09 space ${suffix}`,
      clientMutationId: `g09-space-${suffix}`,
    }));
    const spaceId = spaceResult.space.id;

    const taskResult = successData<{ entity: { id: string } }>(await harness.request('POST', '/v2/entities', {
      spaceId,
      kind: 'task',
      title: `G09 task ${suffix}`,
      clientMutationId: `g09-task-${suffix}`,
    }));
    const taskId = taskResult.entity.id;
    const taskBeforeResult = successData<{ id: string; version: number }>(
      await harness.request('GET', `/v2/entities/${encodeURIComponent(taskId)}`),
    );
    const taskBefore = taskBeforeResult;

    const createMutationId = `g09-create-${suffix}`;
    const updateMutationId = `g09-update-${suffix}`;
    const deleteMutationId = `g09-delete-${suffix}`;
    const primaryInput = {
      name: `G09 primary ${suffix}`,
      shareMode: 'private',
      query: { spaceId },
      graphLayout: {},
      clientMutationId: createMutationId,
    };

    const primaryView = successData<{ id: string }>(
      await harness.request('POST', '/v2/saved-views', primaryInput),
    );
    const replayedView = successData<{ id: string }>(
      await harness.request('POST', '/v2/saved-views', primaryInput),
    );
    expect(replayedView.id).toBe(primaryView.id);

    const listedViews = successData<unknown>(
      await harness.request('GET', `/v2/spaces/${encodeURIComponent(spaceId)}/saved-views`),
    );
    expect(JSON.stringify(listedViews)).toContain(primaryView.id);

    const updatedName = `G09 primary updated ${suffix}`;
    const updatedQuery = { spaceId };
    const updatedLayout = {};
    successData<unknown>(await harness.request(
      'PATCH',
      `/v2/saved-views/${encodeURIComponent(primaryView.id)}`,
      {
        name: updatedName,
        shareMode: 'space',
        query: updatedQuery,
        graphLayout: updatedLayout,
        clientMutationId: updateMutationId,
      },
    ));

    const secondaryView = successData<{ id: string }>(await harness.request('POST', '/v2/saved-views', {
      name: `G09 delete ${suffix}`,
      shareMode: 'private',
      query: { spaceId },
      graphLayout: {},
      clientMutationId: `g09-secondary-${suffix}`,
    }));
    successData<unknown>(await harness.request(
      'DELETE',
      `/v2/saved-views/${encodeURIComponent(secondaryView.id)}`,
      { clientMutationId: deleteMutationId },
    ));

    const refused = await harness.request('POST', '/v2/saved-views', {
      name: '',
      clientMutationId: `g09-invalid-${suffix}`,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);

    const globalActions = successData<{ actions: Action[] }>(await harness.request('GET', '/v2/actions'));
    expect(globalActions.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'savedViews.create', exposure: 'public' }),
    ]));
    expect(globalActions.actions.map((action) => action.operation)).not.toEqual(
      expect.arrayContaining(['execution.prompt', 'events.subscribe', 'search.query', 'bridge.fetchBlob']),
    );

    const observed = await observeG09DatabaseOutcome(
      harness,
      taskId,
      [primaryView.id, secondaryView.id],
      [createMutationId, updateMutationId, deleteMutationId],
    );
    expect(observed.entity).toEqual({
      id: taskId,
      exists: true,
      version: taskBefore.version,
    });
    expect(observed.views).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: primaryView.id,
        exists: true,
        name: updatedName,
        shareMode: 'space',
        query: updatedQuery,
        graphLayout: updatedLayout,
      }),
      expect.objectContaining({ id: secondaryView.id, exists: false }),
    ]));
    expect(observed.mutations).toHaveLength(3);
    expect(observed.mutations).toEqual(expect.arrayContaining([
      { clientMutationId: createMutationId, operation: 'savedViews.create' },
      { clientMutationId: updateMutationId, operation: 'savedViews.update' },
      { clientMutationId: deleteMutationId, operation: 'savedViews.delete' },
    ]));
    // 120s, the same budget every other DB-backed suite in this tree uses
    // (g15-agentic:88 and :212, public-harness, the w2 pg suites). This `it`
    // calls startW3PublicServer ITSELF rather than in a beforeAll, so the test
    // timeout — not a hook timeout — has to cover creating a scratch database
    // and applying the whole migration chain before the workflow starts. On
    // vitest's 5s default that was never survivable once the chain passed ~70
    // files, and this suite died at `Test timed out in 5000ms` with nothing to
    // say which assertion was at fault.
  }, 120_000);
});
