/**
 * G6 W1-client — the real seam reaches the W1-server operations.
 *
 * `spaces.members.remove` and `spaces.leave` are POST commands whose subject
 * rides the PATH (catalog rows, migration 232) and whose body is the mutation
 * id alone. Pinned here through `createRealSeam`, so a rename on either side
 * fails with the URL that moved.
 */
import { describe, expect, it } from 'vitest';
import { bindPath } from '@tm8/contract';
import { createRealSeam } from './seam-real';
import { FakeClock, fakeFetch, fakeSocketPool } from './test-support';

function mk(reply: unknown) {
  const clock = new FakeClock();
  const f = fakeFetch(() => ({ data: reply }));
  const seam = createRealSeam({
    baseUrl: '',
    wsUrl: 'ws://fake.invalid/v2/ws',
    fetch: f.fetch,
    webSocketFactory: fakeSocketPool().factory,
    timers: clock.timers,
    now: clock.now,
    random: clock.random,
  });
  return { seam, f };
}

const RESULT = {
  spaceId: 'sp-1',
  memberId: 'm-2',
  status: 'removed',
  leftAt: '2026-09-26T00:00:00.000Z',
  stoppedSessionIds: [],
  deactivatedPersonaIds: [],
  unassignedEntityIds: [],
  revokedTokenCount: 1,
  activity: 'act-1',
};

describe('seam-real: membership endings (G6)', () => {
  it('removeMember POSTs spaces.members.remove with a mutation id and returns the server answer', async () => {
    const { seam, f } = mk(RESULT);
    const result = await seam.commands.removeMember('sp-1', 'm-2');
    const call = f.last();
    expect(call.method).toBe('POST');
    expect(call.url).toBe(bindPath('spaces.members.remove', { spaceId: 'sp-1', memberId: 'm-2' }));
    expect(call.url).toBe('/v2/spaces/sp-1/members/m-2/remove');
    expect(Object.keys(call.body as object)).toEqual(['clientMutationId']);
    expect((call.body as { clientMutationId: string }).clientMutationId).toMatch(/^memremove/);
    expect(result).toEqual(RESULT);
  });

  it('leaveSpace POSTs spaces.leave for the space in the path', async () => {
    const { seam, f } = mk({ ...RESULT, status: 'left' });
    const result = await seam.commands.leaveSpace('sp-1');
    const call = f.last();
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/v2/spaces/sp-1/leave');
    expect(Object.keys(call.body as object)).toEqual(['clientMutationId']);
    expect(result.status).toBe('left');
  });
});
