import { expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/types.js';
import { DbGraphPort } from '../../src/facade/execution-handlers.js';
import { scanSpaceSkills } from '../../src/skills/service.js';
vi.mock('../../src/skills/service.js', () => ({ scanSpaceSkills: vi.fn() }));
it('finishes the scoped scan before opening the spawn context transaction', async () => {
  let finish!: () => void;
  vi.mocked(scanSpaceSkills).mockImplementationOnce(() => new Promise(resolve => {
    finish = () => resolve({ scannedAt: 'test', discovered: 0, upserted: 0, missing: 0, errors: [] });
  }));
  const db = { tx: vi.fn(async () => { throw new Error('context transaction reached'); }) } as unknown as Db;
  const port = new DbGraphPort(db);
  const claims = { identityId: 'identity' };
  const loading = port.loadSpawnContext(claims, { spaceId: 'space', projectId: 'project', teamMemberId: 'teammate' });
  expect(db.tx).not.toHaveBeenCalled();
  expect(scanSpaceSkills).toHaveBeenCalledWith(db, claims, 'space', { root: 'project' });
  finish();
  await expect(loading).rejects.toThrow('context transaction reached');
  expect(db.tx).toHaveBeenCalledOnce();
});
