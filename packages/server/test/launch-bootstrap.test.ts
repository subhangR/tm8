import { describe, expect, it } from 'vitest';
import { HOUSE_TEAMMATE_NAMES } from '@tm8/contract';
import { ensureLaunchResources } from '../src/bootstrap/launch-resources.js';
import type { Db, DbClaims, Querier } from '../src/db/types.js';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const SMOKE_ID = '33333333-3333-4333-8333-333333333333';
const HOUSE_COUNT = Object.keys(HOUSE_TEAMMATE_NAMES).length;

interface FakeTeammate {
  id: string;
  version: number;
  name: string;
  role: string;
  identity: string | null;
  model: string | null;
  agent_tool: string | null;
  deleted: boolean;
}

class SeedDb implements Db {
  project: { id: string; trust: 'trusted' | 'untrusted' } | null = null;
  teammates: FakeTeammate[] = [{
    id: SMOKE_ID, version: 1, name: 'Smoke Agent', role: '', identity: null,
    model: null, agent_tool: null, deleted: false,
  }];
  /** Teammate ids with a spawning/running/idle session. */
  live = new Set<string>();
  calls: Array<{ fn: string; args: readonly unknown[] }> = [];

  async query<R>(_claims: DbClaims, sql: string, params: readonly unknown[] = []): Promise<R[]> {
    if (sql.includes('from public.spaces')) return [{ id: SPACE_ID }] as R[];
    if (sql.includes('from public.projects')) return (this.project ? [this.project] : []) as R[];
    // The retire sweep, answered from the fake's own state and the query's own
    // params, so a wrong role or name list reds here rather than passing.
    if (sql.includes('public.work_sessions')) {
      const [, role, names] = params as [string, string, string[]];
      return this.teammates
        .filter((row) => !row.deleted && row.role === role && names.includes(row.name) && !this.live.has(row.id))
        .map((row) => ({ id: row.id })) as R[];
    }
    // The Dreamer's loop lookup (D8). Empty = "not seeded yet", so the seeder
    // proceeds; the create call is what these tests count.
    if (sql.includes('join public.loops')) return [] as R[];
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
        role: String(args[3]),
        identity: String(args[4]),
        model: String(args[5]),
        agent_tool: String(args[6]),
        deleted: false,
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
    if (fn === 'public.delete_entity') {
      const row = this.teammates.find((candidate) => candidate.id === args[0]);
      if (row) row.deleted = true;
    }
    return {} as T;
  }

  // Routed to the same fakes, not stubbed empty: the teammate roster is seeded
  // inside a transaction, and a tx that answered nothing would report a full
  // roster on every pass and hide the idempotence this test exists to prove.
  async tx<T>(claims: DbClaims, run: (q: Querier) => Promise<T>): Promise<T> {
    return run({
      query: <R>(sql: string, params?: readonly unknown[]) => this.query<R>(claims, sql, params),
      rpc: <T2>(fn: string, args?: readonly unknown[]) => this.rpc<T2>(claims, fn, args),
    });
  }

  async end(): Promise<void> {}

  row(name: string): FakeTeammate {
    const found = this.teammates.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no teammate ${name}`);
    return found;
  }

  legacy(id: string, name: string, role = 'Launch persona'): void {
    this.teammates.push({
      id, version: 1, name, role, identity: 'x via claude-code',
      model: 'claude-opus-5', agent_tool: 'claude-code', deleted: false,
    });
  }
}

const bootArgs = (db: SeedDb) => ({
  db,
  owner: {
    identityId: 'identity-1', accountId: 'account-1', username: 'owner',
    isNodeAdmin: true, isOwner: true,
  },
  projectDir: process.cwd(),
});

const createdNames = (db: SeedDb): string[] =>
  db.calls.filter(({ fn }) => fn === 'public.create_team_member').map(({ args }) => String(args[1]));

describe('launch resource bootstrap', () => {
  it('repairs Smoke Agent, seeds the role roster, links the current project, and is idempotent', async () => {
    const db = new SeedDb();

    const first = await ensureLaunchResources(bootArgs(db));
    const second = await ensureLaunchResources(bootArgs(db));

    expect(first).toEqual({
      spaces: 1,
      projectId: PROJECT_ID,
      teammatesCreated: HOUSE_COUNT,
      teammatesUpdated: 1,
      teammatesRetired: 0,
    });
    expect(second).toEqual({
      spaces: 1,
      projectId: PROJECT_ID,
      teammatesCreated: 0,
      teammatesUpdated: 0,
      teammatesRetired: 0,
    });
    expect(db.row('Smoke Agent')).toMatchObject({ model: 'claude-sonnet-5', agent_tool: 'claude-code' });
    expect(createdNames(db)).toEqual(Object.values(HOUSE_TEAMMATE_NAMES));
    expect(db.row('Worker')).toMatchObject({ model: 'claude-opus-5-5[1m]', agent_tool: 'claude-code' });
    expect(db.calls.some(({ fn, args: callArgs }) =>
      fn === 'public.link_project_w2' && callArgs[0] === SPACE_ID && callArgs[1] === PROJECT_ID,
    )).toBe(true);
  });

  it('seeds once: a deleted default stays deleted and a renamed one is not minted again', async () => {
    const db = new SeedDb();
    await ensureLaunchResources(bootArgs(db));
    db.row('Worker').deleted = true;
    db.row('Reviewer').name = 'Code Reviewer';

    const again = await ensureLaunchResources(bootArgs(db));

    expect(again.teammatesCreated).toBe(0);
    expect(createdNames(db).filter((name) => name === 'Worker' || name === 'Reviewer')).toHaveLength(2);
  });

  it('never rewrites a model the owner chose on a seeded teammate', async () => {
    const db = new SeedDb();
    await ensureLaunchResources(bootArgs(db));
    Object.assign(db.row('Coordinator'), { model: 'gpt-6-astra', agent_tool: 'codex' });

    const again = await ensureLaunchResources(bootArgs(db));

    expect(again.teammatesUpdated).toBe(0);
    expect(db.row('Coordinator')).toMatchObject({ model: 'gpt-6-astra', agent_tool: 'codex' });
    expect(db.calls.filter(({ fn }) => fn === 'public.update_team_member')).toHaveLength(1); // Smoke Agent only
  });

  it('retires the per-model teammates, deferring any with a live session', async () => {
    const db = new SeedDb();
    db.legacy('opus', 'Opus 5 Teammate');
    db.legacy('kimi', 'Kimi K2 Turbo Teammate');
    db.legacy('busy', 'Sonnet 5 Teammate');
    db.legacy('owned', 'Haiku 4.5 Teammate', 'My haiku persona'); // owner changed its role
    db.legacy('mine', 'PR Reviewer', 'Launch persona'); // not a seeded name
    db.live.add('busy');

    const first = await ensureLaunchResources(bootArgs(db));

    expect(first.teammatesRetired).toBe(2);
    const deleted = () => db.calls.filter(({ fn }) => fn === 'public.delete_entity').map(({ args }) => args[0]);
    expect(deleted()).toEqual(['opus', 'kimi']);
    expect(db.row('Sonnet 5 Teammate').deleted).toBe(false);
    expect(db.row('Haiku 4.5 Teammate').deleted).toBe(false);
    expect(db.row('PR Reviewer').deleted).toBe(false);

    // The busy one goes on the first boot after its session ends.
    db.live.delete('busy');
    const later = await ensureLaunchResources(bootArgs(db));
    expect(later.teammatesRetired).toBe(1);
    expect(deleted()).toEqual(['opus', 'kimi', 'busy']);
  });

  it('does not silently grant trust to an existing untrusted project', async () => {
    const db = new SeedDb();
    db.project = { id: PROJECT_ID, trust: 'untrusted' };

    await expect(ensureLaunchResources(bootArgs(db))).rejects.toThrow('will not override untrusted project');

    expect(db.calls).toEqual([]);
  });
});
