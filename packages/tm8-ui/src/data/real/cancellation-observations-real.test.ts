import { describe, expect, it } from 'vitest';
import { createRealSeam } from './seam-real';
import { fakeFetch, fakeSocketPool } from './test-support';

const SPACE = '00000000-0000-7000-8000-000000000001';
const TASK = '00000000-0000-7000-8000-000000000002';

describe('real Seam task cancellation observation read', () => {
  it('uses the POST read catalog binding on demand with only bounded task IDs', async () => {
    const payload = { schemaVersion: 'tm8.task-cancellation-observations.v1', spaceId: SPACE, complete: true,
      facts: [{ taskId: TASK, statusChangedNotAfter: '2026-10-08T12:00:00.000Z' }] };
    const transport = fakeFetch(() => ({ data: payload }));
    const seam = createRealSeam({ baseUrl: '', wsUrl: 'ws://fake.invalid/v2/ws', fetch: transport.fetch,
      webSocketFactory: fakeSocketPool().factory });
    expect(transport.calls).toEqual([]);
    expect(await seam.taskCancellationObservations!(SPACE, [TASK])).toEqual(payload);
    expect(transport.last()).toMatchObject({
      url: `/v2/spaces/${SPACE}/tasks/cancellation-observations`, method: 'POST', body: { taskIds: [TASK] },
    });
    seam.dispose();
  });
});
