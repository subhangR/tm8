import { describe, expect, it } from 'vitest';
import { LAUNCH_MODEL_CATALOG } from '@tm8/contract';
import { ensureLaunchResources } from '../src/bootstrap/launch-resources.js';
import type { Db, DbClaims, Querier } from '../src/db/types.js';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const SMOKE_ID = '33333333-3333-4333-8333-333333333333';

class SeedDb implements Db {
  project: { id: string; trust: 'trusted' | 'untrusted' } | null = null;
  teammates = [{ id: SMOKE_ID, version: 1, name: 'Smoke Agent', model: null, agent_tool: null }];
  calls: Array<{ fn: string; args: readonly unknown[] }> = [];

  async query<R>(_claims: DbClaims, sql: string): Promise<R[]> {
    if (sql.includes('from public.spaces')) return [{ id: SPACE_ID }] as R[];
    if (sql.includes('from public.projects')) return (this.project ? [this.project] : []) as R[];
    if (sql.includes('join public.team_members')) return this.teammates as R[];
    throw new Error(`unexpected query: ${sql}`);
  }

  async rpc<T>(_claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    this.calls.push({ fn, args });
    if (fn === 'public.create_project') {
      this.project = { id: PROJECT_ID, trust: 'trusted' };
      return { project: { id: PROJECT_ID } } as T;
    }
    if (fn === 'public.create_team_member') {
      this.teammates.push({
        id: `seed-${String(this.teammates.length)}`,
        version: 1,
        name: String(args[1]),
        model: String(args[5]),
        agent_tool: String(args[6]),
      });
    }
    if (fn === 'public.update_team_member') {
      const row = this.teammates.find((candidate) => candidate.id === args[0]);
      if (row) {
        row.version += 1;
        row.model = String(args[6]);
        row.agent_tool = String(args[7]);
      }
    }
    return {} as T;
  }

  // Routed to the same fakes, not stubbed empty: the teammate roster is seeded
  // inside a transaction now, and a tx that answers nothing would report seven
  // creations on every pass and hide the idempotence this test exists to prove.
  async tx<T>(claims: DbClaims, run: (q: Querier) => Promise<T>): Promise<T> {
    return run({
      query: <R>(sql: string) => this.query<R>(claims, sql),
      rpc: <T2>(fn: string, args?: readonly unknown[]) => this.rpc<T2>(claims, fn, args),
    });
  }

  async end(): Promise<void> {}
}

describe('launch resource bootstrap', () => {
  it('repairs Smoke Agent, seeds truthful model/tool personas, links the current project, and is idempotent', async () => {
    const db = new SeedDb();
    const args = {
      db,
      owner: {
        identityId: 'identity-1', accountId: 'account-1', username: 'owner',
        isNodeAdmin: true, isOwner: true,
      },
      projectDir: process.cwd(),
    };

    const first = await ensureLaunchResources(args);
    const second = await ensureLaunchResources(args);

    expect(first).toEqual({
      spaces: 1,
      projectId: PROJECT_ID,
      teammatesCreated: LAUNCH_MODEL_CATALOG.length,
      teammatesUpdated: 1,
    });
    expect(second).toEqual({
      spaces: 1,
      projectId: PROJECT_ID,
      teammatesCreated: 0,
      teammatesUpdated: 0,
    });
    expect(db.teammates.find((row) => row.name === 'Smoke Agent')).toMatchObject({
      model: 'claude-sonnet-5',
      agent_tool: 'claude-code',
    });
    for (const entry of LAUNCH_MODEL_CATALOG) {
      expect(db.teammates).toContainEqual(expect.objectContaining({
        name: entry.seedName,
        model: entry.model,
        agent_tool: entry.agentTool,
      }));
    }
    expect(db.calls.filter(({ fn }) => fn === 'public.create_team_member'))
      .toHaveLength(LAUNCH_MODEL_CATALOG.length);
    expect(db.calls.some(({ fn, args: callArgs }) =>
      fn === 'public.link_project_w2' && callArgs[0] === SPACE_ID && callArgs[1] === PROJECT_ID,
    )).toBe(true);
  });

  it('does not silently grant trust to an existing untrusted project', async () => {
    const db = new SeedDb();
    db.project = { id: PROJECT_ID, trust: 'untrusted' };

    await expect(ensureLaunchResources({
      db,
      owner: {
        identityId: 'identity-1', accountId: 'account-1', username: 'owner',
        isNodeAdmin: true, isOwner: true,
      },
      projectDir: process.cwd(),
    })).rejects.toThrow('will not override untrusted project');

    expect(db.calls).toEqual([]);
  });
});
