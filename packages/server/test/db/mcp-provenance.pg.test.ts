/**
 * §6, THE ACCESS RULE, AS A DENY MATRIX (plan §6/D7, G3; migration 343).
 *
 * One rule, re-asked on every tools/list and tools/call: find the human behind
 * a launch, check them against the Space the call runs in and against every
 * Space the chain passed through, and withhold every connection when there is
 * no such human.
 *
 * WHAT THE AUTHORITY IS (advisor ruling B17, amending plan §6.1 to v3). The
 * authority at each hop is the SPAWNING BEARER, never `launched_by`:
 * `parentSessionId` is client-asserted for every bearer but a chat runtime, and
 * `execution_spawn` checks only that the parent is a live chat or session in the
 * same Space — so a member can spawn naming another member's chat as parent, and
 * walking that edge would hand their worker the other member's connections.
 * `packages/server/src/mcp/session-bindings.ts` carries the full reasoning.
 *
 * WHY SOME CHAINS ARE WRITTEN DIRECTLY. A multi-hop chain that CROSSES Spaces
 * cannot be produced through the live spawn path today, because an agent bearer
 * is pinned to its own Space (226/227, and Q15 — see
 * test/identity/session-space-pin.test.ts) and `execution_spawn` then refuses a
 * spawn into any other Space. §6.2 is therefore defence in depth, and the only
 * honest way to test a rule about shapes the pin currently forbids is to build
 * the shape. Those cells say so, and write the binding row as the graph owner.
 * Every cell that CAN go through `bind`/`authorize` does.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { McpSessionBindings } from '../../src/mcp/session-bindings.js';
import { hashToken } from '../../src/identity/crypto.js';

vi.setConfig({ testTimeout: 180000, hookTimeout: 300000 });

let scratch: W1ScratchDatabase;
let db: Db;
let bindings: McpSessionBindings;

const spaceA = randomUUID();
const spaceB = randomUUID();
/** identity -> { account, memberA?, memberB? } */
const people = {
  alice: { identity: `prov-alice-${randomUUID()}`, account: randomUUID(), memberA: randomUUID(), memberB: randomUUID() },
  bob:   { identity: `prov-bob-${randomUUID()}`,   account: randomUUID(), memberA: randomUUID(), memberB: null as string | null },
  carol: { identity: `prov-carol-${randomUUID()}`, account: randomUUID(), memberA: null as string | null, memberB: randomUUID() },
  /**
   * In both Spaces and owning NOTHING. A member who owns a live credential
   * cannot be removed at all ("revoke them before removing the member"), so the
   * cells that end a membership mid-session need someone whose membership can
   * actually end. They resolve the Space-SHARED connection instead.
   */
  dave:  { identity: `prov-dave-${randomUUID()}`,  account: randomUUID(), memberA: randomUUID(), memberB: randomUUID() },
};
const personaA = randomUUID();
const personaB = randomUUID();
let serverA = '';
let serverB = '';
let aliceKeyA = '';
let aliceKeyB = '';
/** Space-owned (owner null) on serverA: usable by any current member of A. */
let sharedKeyA = '';

/** A human bearer's claims: the §6 terminal root. */
const human = (who: keyof typeof people, space: string): DbClaims =>
  ({ identityId: people[who].identity, authKind: 'browser', sessionSpaceId: space });

/** A live work session plus the agent bearer minted for it, as the spawn does. */
async function session(space: string, creator: string, persona: string, who: keyof typeof people) {
  const sessionId = randomUUID();
  const authSessionId = randomUUID();
  const secret = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query("insert into public.entities(id,space_id,kind,created_by) values($1,$2,'work_session',$3)", [sessionId, space, creator]);
    await c.query("insert into public.work_sessions(entity_id,title,status,share_mode) values($1,'provenance fixture','running','space')", [sessionId]);
    await c.query(`insert into public.auth_sessions(id,account_id,kind,acting_as_team_member_id,work_session_id,token_hash,expires_at,space_id)
      values($1,$2,'agent',$3,$4,$5,now()+interval '1 hour',$6)`,
      [authSessionId, people[who].account, persona, sessionId, hashToken(secret), space]);
  });
  return {
    sessionId, authSessionId, token: `tm8s_${authSessionId}.${secret}`,
    claims: { identityId: people[who].identity, authKind: 'agent', sessionSpaceId: space, authSessionId } as DbClaims,
  };
}

/** `internal.mcp_provenance`'s own answer, through the door `bind` uses. */
const provenanceOf = (claims: DbClaims, sessionId: string, token: string,
                      source?: { sessionId: string; authSessionId: string }) =>
  db.rpc<{ reason: string; rootMemberId?: string; rootIdentityId?: string; depth?: number; via?: string }>(
    claims, 'mcp_provenance_for_bind',
    [sessionId, hashToken(token.split('.')[1]!), source?.sessionId ?? null, source?.authSessionId ?? null]);

/**
 * Write a binding row directly, for the cross-Space and depth shapes the agent
 * pin forbids through `bind`. Deliberately explicit about what it fakes: a chain
 * and a root that `bind_mcp_session` would otherwise have derived.
 */
async function forgeBinding(input: {
  sessionId: string; authSessionId: string; space: string; runtime: keyof typeof people;
  root: keyof typeof people; rootMember: string; chain: string[]; chainSpaces: string[];
  selections: unknown;
  /** Defaults to the root, as a bearer chain always has them equal. */
  launcher?: keyof typeof people;
}) {
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into internal.mcp_session_bindings
      (session_id,space_id,auth_session_id,runtime_identity_id,launcher_identity_id,launcher_auth_kind,
       selections,root_member_id,root_identity_id,chain,chain_space_ids)
      values($1,$2,$3,$4,$5,'browser',$6,$7,$8,$9,$10)
      on conflict (session_id) do update set chain=excluded.chain, chain_space_ids=excluded.chain_space_ids,
        root_member_id=excluded.root_member_id, root_identity_id=excluded.root_identity_id,
        selections=excluded.selections`,
      [input.sessionId, input.space, input.authSessionId, people[input.runtime].identity,
       people[input.launcher ?? input.root].identity, JSON.stringify(input.selections), input.rootMember,
       people[input.root].identity, input.chain, input.chainSpaces]);
  });
}

const outcome = async (run: () => Promise<unknown>): Promise<string> => {
  try { await run(); return 'ok'; } catch (error) { return String((error as Error).message); }
};

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('mcp_provenance');
  scratch.apply(migrationFiles());
  db = createDb(scratch.url, { max: 4 });
  bindings = new McpSessionBindings(db);
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    for (const [name, p] of Object.entries(people)) {
      await c.query('insert into public.accounts(id,identity_id,username) values($1,$2,$3)', [p.account, p.identity, `prov-${name}-${p.account.slice(0, 8)}`]);
      await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$2)', [p.identity, name]);
    }
    await c.query('insert into public.spaces(id,name,created_by_identity) values($1,$2,$3),($4,$5,$3)',
      [spaceA, 'Space A', people.alice.identity, spaceB, 'Space B']);
    for (const [space, key] of [[spaceA, 'memberA'], [spaceB, 'memberB']] as const) {
      for (const [name, p] of Object.entries(people)) {
        const id = p[key];
        if (!id) continue;
        await c.query("insert into public.entities(id,space_id,kind,created_by) values($1,$2,'member',$1)", [id, space]);
        await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,$4,$5)",
          [id, space, p.identity, name === 'alice' ? 'owner' : 'member', name]);
      }
    }
    for (const [persona, space, owner] of [[personaA, spaceA, people.alice.memberA], [personaB, spaceB, people.alice.memberB]] as const) {
      await c.query("insert into public.entities(id,space_id,kind,created_by) values($1,$2,'team_member',$3)", [persona, space, owner]);
      await c.query("insert into public.team_members(entity_id,owner_member_id,name,role,model,agent_tool) values($1,$2,'Prov worker','helper','claude-sonnet-4-5','claude-code')", [persona, owner]);
    }
  });
  const definition = (name: string) => JSON.stringify({
    name, transport: 'http', url: 'https://example.test/mcp', envKeys: [], headerKeys: ['Authorization'],
    auth: { type: 'api_key', headerName: 'Authorization' }, approved: true,
  });
  serverA = (await db.rpc<{ entity: { id: string } }>(human('alice', spaceA), 'create_mcp_server_entity', [spaceA, definition('provspacea'), null, randomUUID()])).entity.id;
  serverB = (await db.rpc<{ entity: { id: string } }>(human('alice', spaceB), 'create_mcp_server_entity', [spaceB, definition('provspaceb'), null, randomUUID()])).entity.id;
  aliceKeyA = randomUUID();
  aliceKeyB = randomUUID();
  await db.rpc(human('alice', spaceA), 'create_mcp_credential', [aliceKeyA, spaceA, serverA, 'Alice in A', Buffer.alloc(32, 7), Buffer.alloc(12, 3), 'api_key', null, false, 1]);
  await db.rpc(human('alice', spaceB), 'create_mcp_credential', [aliceKeyB, spaceB, serverB, 'Alice in B', Buffer.alloc(32, 7), Buffer.alloc(12, 3), 'api_key', null, false, 1]);
  // §5.2: scope 'space' is a Space-owned row (owner null) and needs an admin;
  // Alice is A's owner. Nobody owns it, so its users stay removable.
  sharedKeyA = randomUUID();
  await db.rpc(human('alice', spaceA), 'create_mcp_credential',
    [sharedKeyA, spaceA, serverA, 'Shared in A', Buffer.alloc(32, 9), Buffer.alloc(12, 4), 'api_key', null, false, 1, 'space']);
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); });

/* ===========================================================================
 * THE MATRIX. One row per §6 cell, each naming the claim shape it arrives on,
 * the reason `internal.mcp_provenance` must answer, and who the root must be.
 * Driven through `mcp_provenance_for_bind`, the door `bind` reads, so every row
 * exercises the real authentication (the freshly minted agent token) and not a
 * helper.
 * =========================================================================== */
describe('§6 deny matrix — the provenance rule, cell by cell', () => {
  type Cell = {
    name: string;
    /** Build the session under test and the claims `bind` would arrive on. */
    arrange(): Promise<{ claims: DbClaims; sessionId: string; token: string;
                         source?: { sessionId: string; authSessionId: string } }>;
    reason: string;
    /** Which person must come out as the root, when the cell is `ready`. */
    root?: keyof typeof people;
    rootSpace?: 'A' | 'B';
  };

  const cells: Cell[] = [
    {
      // SAME SPACE, the ordinary case: a human bearer is a terminal root.
      name: 'same-space human bearer is its own root',
      reason: 'ready', root: 'alice', rootSpace: 'A',
      async arrange() {
        const s = await session(spaceA, people.alice.memberA, personaA, 'alice');
        return { claims: human('alice', spaceA), sessionId: s.sessionId, token: s.token };
      },
    },
    {
      // CROSS-SPACE MEMBER: Alice is in both, and the launch is in B. She gets
      // B's connections — never A's, which is what the Space-scoped resolution
      // below asserts end to end.
      name: 'cross-space member: a human bearer in the other Space is admitted there',
      reason: 'ready', root: 'alice', rootSpace: 'B',
      async arrange() {
        const s = await session(spaceB, people.alice.memberB, personaB, 'alice');
        return { claims: human('alice', spaceB), sessionId: s.sessionId, token: s.token };
      },
    },
    {
      // CROSS-SPACE NON-MEMBER: Bob is in A only. A launch of his in B has no
      // root there at all, so nothing can be lent to it.
      name: 'cross-space non-member: a human bearer outside the Space has no root',
      reason: 'root_not_in_space',
      async arrange() {
        const s = await session(spaceB, people.alice.memberB, personaB, 'bob');
        return { claims: human('bob', spaceB), sessionId: s.sessionId, token: s.token };
      },
    },
    {
      // LINK SESSION (§6.5): no connectors, ever, and the rule is stated in the
      // walk itself so no caller has to remember it.
      name: 'link session: refused by the walk, not only by bind',
      reason: 'link_session',
      async arrange() {
        const s = await session(spaceA, people.alice.memberA, personaA, 'alice');
        return {
          claims: { ...human('alice', spaceA), authKind: 'link', viaLinkId: randomUUID() },
          sessionId: s.sessionId, token: s.token,
        };
      },
    },
    {
      // AN AGENT BEARER THAT NAMES NO SOURCE has nothing to hop to. 298's
      // behaviour, now a named reason instead of a caught exception.
      name: 'agent bearer with no verified source: no hop, no root',
      reason: 'source_unavailable',
      async arrange() {
        const s = await session(spaceA, people.alice.memberA, personaA, 'alice');
        return { claims: s.claims, sessionId: s.sessionId, token: s.token };
      },
    },
    {
      // THE IN-PROCESS SHAPE with no schedule behind it: the loop-executor
      // claims (#1316) and anything like them.
      name: 'no bearer and no schedule: no root',
      reason: 'no_human_provenance',
      async arrange() {
        // There is no persona-owner fallback (B21), even though this session
        // acts as a persona Alice owns and Alice is the caller: a no-bearer
        // session whose only facts are about a persona gets no root.
        const s = await session(spaceA, people.alice.memberA, personaA, 'alice');
        return {
          claims: { identityId: people.alice.identity, requestId: 'loop-executor' },
          sessionId: s.sessionId, token: s.token,
        };
      },
    },
  ];

  for (const cell of cells) {
    it(cell.name, async () => {
      const a = await cell.arrange();
      const got = await provenanceOf(a.claims, a.sessionId, a.token, a.source);
      expect(got.reason).toBe(cell.reason);
      if (cell.reason === 'ready') {
        const want = cell.rootSpace === 'B' ? people[cell.root!].memberB : people[cell.root!].memberA;
        expect(got.rootMemberId).toBe(want);
        expect(got.rootIdentityId).toBe(people[cell.root!].identity);
        expect(got.depth).toBe(1);
      } else {
        expect(got.rootMemberId).toBeUndefined();
      }
    });
  }
});

describe('§6 deny matrix — the schedule root (G3)', () => {
  /**
   * A loop is the one launcher with no bearer behind its firings, so the human
   * has to be recorded when they arm it. `entities.created_by` is NOT that fact
   * — it names an actor, which is a team_member whenever an agent created the
   * loop — so 343 adds `loops.armed_by_member_id`, stamped by a trigger that
   * fires only for a human bearer.
   */
  const armLoop = async (claims: DbClaims, title: string) =>
    (await db.rpc<{ entity: { id: string } }>(claims, 'create_loop',
      [spaceA, title, null, 'every 1h', personaA, null, 'fire', '{}', true, null, null, null, randomUUID()])).entity.id;
  const editPrompt = async (claims: DbClaims, loopId: string, prompt: string) => {
    const [{ version }] = await scratch.query<{ version: number }>('select version from public.entities where id=$1', [loopId]);
    return db.rpc(claims, 'update_loop',
      [loopId, version, null, null, null, null, false, null, false, prompt, null, null, null, false, null, null, false, randomUUID()]);
  };
  const stampOf = async (loopId: string) => (await scratch.query<{
    armed_by_member_id: string | null; armed_by_identity_id: string | null;
  }>('select armed_by_member_id, armed_by_identity_id from public.loops where entity_id=$1', [loopId]))[0];
  /** The in-process scheduler's shape: an identity, no bearer kind at all. */
  const executor: DbClaims = { identityId: people.alice.identity, requestId: 'loop-executor' };

  it('a human bearer arming a loop is stamped; the in-process executor is not', async () => {
    const armed = await armLoop(human('alice', spaceA), 'Armed by Alice');
    const [row] = await scratch.query<{ armed_by_member_id: string | null; armed_by_identity_id: string | null }>(
      'select armed_by_member_id, armed_by_identity_id from public.loops where entity_id=$1', [armed]);
    expect(row?.armed_by_member_id).toBe(people.alice.memberA);
    expect(row?.armed_by_identity_id).toBe(people.alice.identity);
    // The executor advances `next_run_at` through the same door on every tick.
    // It is not a human bearer, so it must neither stamp nor CLEAR the fact.
    const [{ version }] = await scratch.query<{ version: number }>('select version from public.entities where id=$1', [armed]);
    await db.rpc(executor, 'update_loop',
      [armed, version, null, null, null, null, false, null, false, null, null, null,
       new Date(Date.now() + 3_600_000).toISOString(), false, new Date().toISOString(), null, true, randomUUID()]);
    const [after] = await scratch.query<{ armed_by_member_id: string | null }>(
      'select armed_by_member_id from public.loops where entity_id=$1', [armed]);
    expect(after?.armed_by_member_id).toBe(people.alice.memberA);
  });

  it('a firing of an ARMED loop has the arming human as its root; an UNARMED one has none', async () => {
    const armed = await armLoop(human('alice', spaceA), 'Armed firing');
    // An UNARMED loop, produced the way one really occurs: created by a caller
    // that is not a human bearer, so the trigger never stamps it. The column is
    // never written directly — the trigger owns it, and a direct write is
    // restored, which is itself asserted in the B26 block below.
    const unarmed = await armLoop({ identityId: people.alice.identity, authKind: 'agent' }, 'Unarmed firing');
    expect(await stampOf(unarmed)).toMatchObject({ armed_by_member_id: null });

    for (const [loopId, reason] of [[armed, 'ready'], [unarmed, 'no_human_provenance']] as const) {
      const s = await session(spaceA, people.alice.memberA, personaA, 'alice');
      // The firing's own `triggered_by` edge. NOTE the ordering caveat reported
      // to the lead: `createLoopExecutorPort.fire` writes this edge AFTER
      // `spawnService.spawn` returns, and `bind` runs inside that spawn, so a
      // FIRST firing does not yet carry it. The rule below is correct and live
      // for every path where the edge exists; making a first firing reach it is
      // an ordering fix in the executor, not in this rule.
      await db.rpc(human('alice', spaceA), 'write_edge', [s.sessionId, loopId, 'triggered_by', '{}', null, randomUUID()]);
      const got = await provenanceOf(executor, s.sessionId, s.token);
      expect(got.reason).toBe(reason);
      if (reason === 'ready') {
        expect(got.rootMemberId).toBe(people.alice.memberA);
        expect(got.via).toBe('schedule_armed_by');
      }
    }
  });

  it('B26 — armed_by follows the CONTENT: who may change it, and who loses it', async () => {
    /*
     * The lead's F2: `update_loop` requires only membership (091), so Bob — or
     * Bob's agent — could rewrite the prompt, persona or subject of a loop ALICE
     * armed, and the firing would run Bob's instructions on Alice's
     * connections. Preserving the stamp across any write is therefore wrong;
     * what matters is whether the CONTENT moved (B26).
     */
    // 1. An AGENT bearer changing the prompt NULLs the stamp: the next firing
    //    then has no human provenance and is lent nothing, until a human
    //    re-arms. Fails closed rather than keeping Alice's name on Bob's words.
    const byAgent = await armLoop(human('alice', spaceA), 'B26 agent edit');
    expect(await stampOf(byAgent)).toMatchObject({ armed_by_member_id: people.alice.memberA });
    await editPrompt({ identityId: people.bob.identity, authKind: 'agent' }, byAgent, 'rewritten by an agent');
    expect(await stampOf(byAgent)).toMatchObject({ armed_by_member_id: null, armed_by_identity_id: null });

    // 2. A DIFFERENT HUMAN changing the prompt re-stamps to THEM, so the firing
    //    runs on the connections of whoever actually wrote the instructions.
    const byHuman = await armLoop(human('alice', spaceA), 'B26 human edit');
    await editPrompt(human('bob', spaceA), byHuman, 'rewritten by Bob himself');
    expect(await stampOf(byHuman)).toMatchObject({
      armed_by_member_id: people.bob.memberA, armed_by_identity_id: people.bob.identity,
    });

    // 3. The EXECUTOR's tick preserves it. This is the firing path itself: it
    //    advances next_run_at and records the outcome through the same door
    //    every minute, and must not disarm the loop it just fired.
    const ticked = await armLoop(human('alice', spaceA), 'B26 executor tick');
    const [{ version }] = await scratch.query<{ version: number }>('select version from public.entities where id=$1', [ticked]);
    await db.rpc(executor, 'update_loop',
      [ticked, version, null, null, null, null, false, null, false, null, null, null,
       new Date(Date.now() + 3_600_000).toISOString(), false, new Date().toISOString(), null, true, randomUUID()]);
    expect(await stampOf(ticked)).toMatchObject({ armed_by_member_id: people.alice.memberA });

    // 4. An AGENT RE-ENABLING a paused loop NULLs it: resuming is authorising
    //    the content again. Pausing (true -> false) only narrows, so it keeps.
    const resumed = await armLoop(human('alice', spaceA), 'B26 resume');
    const setEnabled = async (claims: DbClaims, enabled: boolean) => {
      const [{ version: v }] = await scratch.query<{ version: number }>('select version from public.entities where id=$1', [resumed]);
      await db.rpc(claims, 'update_loop',
        [resumed, v, null, null, null, null, false, null, false, null, null, enabled, null, false, null, null, false, randomUUID()]);
    };
    await setEnabled({ identityId: people.bob.identity, authKind: 'agent' }, false);
    expect(await stampOf(resumed)).toMatchObject({ armed_by_member_id: people.alice.memberA });
    await setEnabled({ identityId: people.bob.identity, authKind: 'agent' }, true);
    expect(await stampOf(resumed)).toMatchObject({ armed_by_member_id: null });

    // 5. A column in NEITHER list counts as CONTENT (B28). The trigger diffs
    //    `to_jsonb(new/old)` minus the bookkeeping columns rather than
    //    enumerating content, so a field nobody thought about — here `config`,
    //    which carries the model, agent tool and access mode a firing launches
    //    with — cannot be quietly treated as harmless. An agent changing it
    //    NULLs the stamp.
    const byConfig = await armLoop(human('alice', spaceA), 'B26 config is content');
    const [{ version: cv }] = await scratch.query<{ version: number }>('select version from public.entities where id=$1', [byConfig]);
    await db.rpc({ identityId: people.bob.identity, authKind: 'agent' }, 'update_loop',
      [byConfig, cv, null, null, null, null, false, null, false, null,
       JSON.stringify({ accessMode: 'fullAccess' }), null, null, false, null, null, false, randomUUID()]);
    expect(await stampOf(byConfig)).toMatchObject({ armed_by_member_id: null });

    // 5b. THE PROPERTY THE INVERSION ACTUALLY BUYS (B28), which cell 5 cannot
    //     show on its own: `config` is a column that exists today, so a trigger
    //     enumerating content would have listed it and that cell would pass
    //     either way. What the inversion protects is a column nobody has written
    //     yet. So add one, change it as an agent, and require the stamp to be
    //     NULLED — i.e. an UNLISTED column reads as content, not as bookkeeping.
    //     Dropped again straight after, so no sibling test sees it.
    const byFuture = await armLoop(human('alice', spaceA), 'B28 a future column is content');
    await scratch.query('alter table public.loops add column if not exists zz_future_field text');
    try {
      await scratch.transaction(async c => {
        await c.query('set local role tm8_graph_owner');
        await c.query("select set_config('tm8.identity_id', $1, true), set_config('tm8.auth_kind', 'agent', true)", [people.bob.identity]);
        await c.query('update public.loops set zz_future_field = $2 where entity_id = $1', [byFuture, 'moved']);
      });
      expect(await stampOf(byFuture)).toMatchObject({ armed_by_member_id: null });
    } finally {
      await scratch.query('alter table public.loops drop column if exists zz_future_field');
    }

    // 6. The stamp is the TRIGGER's to write. A direct UPDATE of the column —
    //    the shape a future writer might reach for — is restored, so the fact
    //    cannot be forged onto a member who authorised nothing.
    const owned = await armLoop(human('alice', spaceA), 'B26 trigger owns it');
    await scratch.query('update public.loops set armed_by_member_id=$2, armed_by_identity_id=$3 where entity_id=$1',
      [owned, people.bob.memberA, people.bob.identity]);
    expect(await stampOf(owned)).toMatchObject({
      armed_by_member_id: people.alice.memberA, armed_by_identity_id: people.alice.identity,
    });
  });

  it('an armed loop whose arming member has left the Space lends nothing', async () => {
    // Armed by BOB, as himself — not by rewriting the stamp.
    const armed = await armLoop(human('bob', spaceA), 'Armed then left');
    expect(await stampOf(armed)).toMatchObject({ armed_by_member_id: people.bob.memberA });
    const s = await session(spaceA, people.alice.memberA, personaA, 'alice');
    await db.rpc(human('alice', spaceA), 'write_edge', [s.sessionId, armed, 'triggered_by', '{}', null, randomUUID()]);
    expect((await provenanceOf(executor, s.sessionId, s.token)).reason).toBe('ready');
    await scratch.query("update public.members set status='removed', left_at=now() where entity_id=$1", [people.bob.memberA]);
    try {
      expect((await provenanceOf(executor, s.sessionId, s.token)).reason).toBe('no_human_provenance');
    } finally {
      await scratch.query("update public.members set status='active', left_at=null where entity_id=$1", [people.bob.memberA]);
    }
  });
});

describe('§6 deny matrix — re-checked on every call, not only at bind', () => {
  it('member removed mid-session: a bound, authorized session loses access on the next call', async () => {
    // Dave is the root and owns nothing, so his membership can actually end;
    // he carries the launch on A's SPACE-shared connection (§6's shared row).
    const s = await session(spaceA, people.dave.memberA, personaA, 'dave');
    const picks = await bindings.bind(human('dave', spaceA), {
      sessionId: s.sessionId, spaceId: spaceA, teamMemberId: personaA, agentToken: s.token,
      mcpSelections: [{ serverId: serverA }],
    });
    // `serverKey` is the §4.2 tool prefix bind answers with, derived from the
    // connector's name ('provspacea'); it is returned, never stored.
    expect(picks).toEqual([{ serverId: serverA, credentialId: sharedKeyA, serverKey: 'provspacea' }]);
    // The chain and root really were recorded, which is what the re-check reads.
    const grant = await bindings.authorize(s.claims, s.sessionId, serverA);
    expect(grant).toMatchObject({ rootMemberId: people.dave.memberA, rootIdentityId: people.dave.identity });
    expect(grant.chain).toEqual([s.sessionId]);
    expect(grant.chainSpaceIds).toEqual([spaceA]);

    await scratch.query("update public.members set status='removed', left_at=now() where entity_id=$1", [people.dave.memberA]);
    try {
      // §6's last line: "If someone is removed from a Space, their running
      // workers there lose access on the next call." Here the removed human is
      // also the session's own runtime identity, so 298's caller membership
      // check is what answers first.
      expect(await outcome(() => bindings.authorize(s.claims, s.sessionId, serverA))).toMatch(/not a member of this space/);
    } finally {
      await scratch.query("update public.members set status='active', left_at=null where entity_id=$1", [people.dave.memberA]);
    }
    // Restored, and access comes back: the refusal was the membership, not a
    // one-way latch on the binding.
    expect(await outcome(() => bindings.authorize(s.claims, s.sessionId, serverA))).toBe('ok');
  });

  it('ROOT removed while BOTH the caller and the launcher stay members: only the root check refuses', async () => {
    /*
     * The cell above is answered by checks that predate 343 — the caller's own
     * membership, and 332's `launcher_identity_id` membership — because for a
     * BEARER chain the launcher and the root are the same human. So on its own
     * it would pass even if 343's root check did nothing.
     *
     * Here they differ, which is the shape a SCHEDULE root has: the launcher is
     * whoever the binding transaction ran as, and the root is the human who
     * armed the loop. The binding is written directly to get that shape without
     * the loop-executor ordering caveat in the way. Removing only the ROOT
     * leaves every pre-343 check satisfied, so nothing but the recorded root can
     * refuse — which is the whole reason it is recorded.
     */
    const s = await session(spaceA, people.alice.memberA, personaA, 'alice');
    await forgeBinding({
      sessionId: s.sessionId, authSessionId: s.authSessionId, space: spaceA,
      runtime: 'alice', launcher: 'alice', root: 'dave', rootMember: people.dave.memberA,
      chain: [s.sessionId], chainSpaces: [spaceA],
      selections: [{ serverId: serverA, credentialId: sharedKeyA }],
    });
    expect(await bindings.authorize(s.claims, s.sessionId, serverA))
      .toMatchObject({ launcherIdentityId: people.alice.identity, rootIdentityId: people.dave.identity });
    await scratch.query("update public.members set status='removed', left_at=now() where entity_id=$1", [people.dave.memberA]);
    try {
      // The SPECIFIC refusal, not an alternation: §6.2 is what answers, because
      // chain[1] is this session and so this Space is already in the array.
      // `read_mcp_session_binding`'s own "root is no longer a member of this
      // space" branch is redundant by construction — disabling it leaves every
      // cell green — and the migration says so at that line rather than
      // pretending a cell defends it.
      expect(await outcome(() => bindings.authorize(s.claims, s.sessionId, serverA)))
        .toMatch(/no longer a member of every space in the chain/);
      // Controls: both of the pre-343 principals are untouched, so neither of
      // their checks is what refused.
      for (const member of [people.alice.memberA, people.dave.memberB]) {
        const [row] = await scratch.query<{ status: string }>('select status from public.members where entity_id=$1', [member]);
        expect(row?.status).toBe('active');
      }
    } finally {
      await scratch.query("update public.members set status='active', left_at=null where entity_id=$1", [people.dave.memberA]);
    }
    expect(await outcome(() => bindings.authorize(s.claims, s.sessionId, serverA))).toBe('ok');
  });

  it('authorize opens the account as the RECORDED ROOT, not as the launcher', async () => {
    /*
     * The invariant the backend advisor flagged as most at risk of a merge that
     * compiles but drops it — and it had NO cell watching it. Reverting
     * `authorize` to the launcher identity left all 39 cells green, because for
     * a bearer chain the launcher and the root are the same human, and the one
     * cell with launcher <> root pins a SPACE-SHARED connection, which either
     * identity can open.
     *
     * So this cell makes the distinction matter: the pinned connection is
     * ALICE's own PRIVATE row, the recorded root is Alice, and the launcher is
     * DAVE — an active member of the Space who has no claim on that row at all.
     * Opening it as the launcher is refused by `read_mcp_credential`; opening it
     * as the root succeeds. Nothing else in the binding differs.
     *
     * It matters beyond defending a line: a schedule firing roots at the human
     * who armed the loop while the binding transaction ran as someone else, so
     * "resolve as the launcher" would hand that firing the WRONG person's
     * connections — or none, failing a launch that should work.
     */
    const s = await session(spaceA, people.dave.memberA, personaA, 'dave');
    await forgeBinding({
      sessionId: s.sessionId, authSessionId: s.authSessionId, space: spaceA,
      runtime: 'dave', launcher: 'dave', root: 'alice', rootMember: people.alice.memberA,
      chain: [s.sessionId], chainSpaces: [spaceA],
      selections: [{ serverId: serverA, credentialId: aliceKeyA }],
    });
    // Alice's row is PRIVATE: she owns it, it is not public, and it is shared
    // with nobody — so only resolution under her own identity can open it.
    const [row] = await scratch.query<{ visibility: string; owner: string | null }>(
      'select visibility, owner_account_id::text owner from public.space_credentials where id=$1', [aliceKeyA]);
    expect(row).toMatchObject({ visibility: 'private', owner: people.alice.account });
    const grant = await bindings.authorize(s.claims, s.sessionId, serverA);
    expect(grant).toMatchObject({
      launcherIdentityId: people.dave.identity,
      rootIdentityId: people.alice.identity,
      credentialId: aliceKeyA,
    });
    // Control: the launcher really is live and admitted, so the success above is
    // the ROOT opening the row and not the launcher happening to be allowed.
    expect(await outcome(() => db.rpc(
      { identityId: people.dave.identity, authKind: 'browser', sessionSpaceId: spaceA },
      'read_mcp_credential', [spaceA, serverA, aliceKeyA])))
      .toMatch(/MCP credential unavailable/);
  });

  it('§6.2 A -> B -> A: losing the MIDDLE Space withdraws access in the outer one', async () => {
    /*
     * The shape the plan's "a chain like A -> B -> A can't launder access"
     * names. It is written directly: an agent bearer is pinned to its own Space
     * (Q15), so `execution_spawn` refuses a cross-Space agent spawn and this
     * chain cannot be produced live. The RULE still has to hold, because the pin
     * is a second mechanism and not this one.
     */
    const hop = await session(spaceA, people.dave.memberA, personaA, 'dave');
    await forgeBinding({
      sessionId: hop.sessionId, authSessionId: hop.authSessionId, space: spaceA,
      runtime: 'dave', root: 'dave', rootMember: people.dave.memberA,
      chain: [hop.sessionId, randomUUID(), randomUUID()],
      chainSpaces: [spaceA, spaceB, spaceA],
      selections: [{ serverId: serverA, credentialId: sharedKeyA }],
    });
    expect(await outcome(() => bindings.authorize(hop.claims, hop.sessionId, serverA))).toBe('ok');
    // Alice keeps her membership of A, and loses only B — the Space the chain
    // merely passed THROUGH. Checking the target Space alone would miss this.
    await scratch.query("update public.members set status='left', left_at=now() where entity_id=$1", [people.dave.memberB]);
    try {
      expect(await outcome(() => bindings.authorize(hop.claims, hop.sessionId, serverA)))
        .toMatch(/no longer a member of every space in the chain/);
      // Control: she IS still a member of A, so the target-Space check alone
      // would have admitted this call. That is what makes §6.2 load-bearing.
      const [row] = await scratch.query<{ status: string }>('select status from public.members where entity_id=$1', [people.dave.memberA]);
      expect(row?.status).toBe('active');
    } finally {
      await scratch.query("update public.members set status='active', left_at=null where entity_id=$1", [people.dave.memberB]);
    }
    expect(await outcome(() => bindings.authorize(hop.claims, hop.sessionId, serverA))).toBe('ok');
  });

  it('the chain depth cap is 8, and a ninth hop is refused rather than truncated', async () => {
    const source = await session(spaceA, people.alice.memberA, personaA, 'alice');
    const child = await session(spaceA, people.alice.memberA, personaA, 'alice');
    const eight = [source.sessionId, ...Array.from({ length: 7 }, () => randomUUID())];
    await forgeBinding({
      sessionId: source.sessionId, authSessionId: source.authSessionId, space: spaceA,
      runtime: 'alice', root: 'alice', rootMember: people.alice.memberA,
      chain: eight, chainSpaces: eight.map(() => spaceA), selections: [],
    });
    // The source itself is at the cap, so the child would be the ninth hop.
    const got = await provenanceOf(
      { ...source.claims }, child.sessionId, child.token,
      { sessionId: source.sessionId, authSessionId: source.authSessionId });
    expect(got.reason).toBe('depth_exceeded');
    expect(got.depth).toBe(9);
    // And a chain one shorter is admitted, so the cap is a boundary and not a
    // blanket refusal of delegated launches.
    const seven = eight.slice(0, 7);
    await forgeBinding({
      sessionId: source.sessionId, authSessionId: source.authSessionId, space: spaceA,
      runtime: 'alice', root: 'alice', rootMember: people.alice.memberA,
      chain: seven, chainSpaces: seven.map(() => spaceA), selections: [],
    });
    const ok = await provenanceOf(
      { ...source.claims }, child.sessionId, child.token,
      { sessionId: source.sessionId, authSessionId: source.authSessionId });
    expect(ok.reason).toBe('ready');
    expect(ok.depth).toBe(8);
    expect(ok.rootMemberId).toBe(people.alice.memberA);
  });
});

describe('§6 — a forged root is refused (B28)', () => {
  it('p_root_member naming another member, where the in-SQL walk is NOT ready, raises and binds nothing', async () => {
    /*
     * `p_root_member` is a CALLER argument. The ready-path equality check
     * (`p_root_member <> v_root`) only fires when the in-SQL walk succeeds — so
     * the hole is a walk that returns a NON-ready reason, where the chain branch
     * would otherwise adopt whatever root the caller named. That root is stored,
     * and `authorize` resolves under it from then on.
     *
     * This is that shape: the loop-executor claims (an identity, no bearer kind)
     * make the walk answer `no_human_provenance`, and the call names DAVE as the
     * root with a perfectly shaped one-hop chain in a Space Dave really is a
     * member of — so neither the chain checks nor §6.2 object.
     *
     * The anchor that refuses it is B3's rule moved into SQL: `bind` always
     * resolves accounts under the ROOT's own claims, so the root's identity must
     * be the identity this transaction is running as. Verified non-vacuous by
     * removing that one branch, which makes this cell fail.
     */
    const s = await session(spaceA, people.alice.memberA, personaA, 'alice');
    const rootless: DbClaims = { identityId: people.alice.identity, requestId: 'loop-executor' };
    const secret = s.token.split('.')[1]!;
    const forge = (rootMember: string) => db.tx(rootless, q => q.rpc('bind_mcp_session', [
      s.sessionId, hashToken(secret), JSON.stringify([{ serverId: serverA, credentialId: aliceKeyA }]),
      null, null, rootMember, [s.sessionId], [spaceA],
    ]));
    expect(await outcome(() => forge(people.dave.memberA)))
      .toMatch(/root must be the identity this launch resolves as/);
    // NOTHING was bound: no row at all, so no later call can resolve under it.
    const [row] = await scratch.query<{ n: string }>(
      'select count(*)::text n from internal.mcp_session_bindings where session_id=$1', [s.sessionId]);
    expect(row?.n).toBe('0');
    expect(await outcome(() => bindings.authorize(s.claims, s.sessionId, serverA)))
      .toMatch(/MCP session unavailable/);
    // CONTROL: naming ALICE — the identity this transaction runs as — is
    // accepted, so what the refusal rejects is the forged member and not the
    // shape of the call or the rootless claims.
    expect(await outcome(() => forge(people.alice.memberA))).toBe('ok');
    expect(await bindings.authorize(s.claims, s.sessionId, serverA))
      .toMatchObject({ rootMemberId: people.alice.memberA, rootIdentityId: people.alice.identity });
  });

  it('and the ready-path check still catches a forged root under a human bearer', async () => {
    // The other half, which was already there: when the walk DOES succeed, the
    // derived root and the named one must agree.
    const s = await session(spaceA, people.alice.memberA, personaA, 'alice');
    expect(await outcome(() => db.tx(human('alice', spaceA), q => q.rpc('bind_mcp_session', [
      s.sessionId, hashToken(s.token.split('.')[1]!), '[]',
      null, null, people.dave.memberA, [s.sessionId], [spaceA],
    ])))).toMatch(/root changed during launch/);
  });

  it('a chain that UNDERSTATES a hop\'s Space is refused — §6.2 cannot be dodged', async () => {
    /*
     * The check this cell defends is the one the identity-id allow-list verdict
     * for `bind_mcp_session` claims: "a caller cannot understate a hop's space
     * to dodge §6.2's membership check on it". Nothing was watching it — all the
     * other cells pass with the read-back disabled — so the verdict asserted a
     * property no test defended. Found by disabling each new guard in turn and
     * looking for a cell that fails.
     *
     * THE ATTACK: Bob is a member of A only. He launches in A with a chain whose
     * second hop is a session that really lives in B, but declares that hop's
     * Space as A. §6.2 then checks him against [A, A] — where he IS a member —
     * instead of the true [A, B], where he is not. Every other check is
     * satisfied: the head is his session, the tail matches the source binding's
     * stored chain, and the root identity is his own.
     *
     * The refusal comes from reading each hop's Space back off its own entity
     * row rather than believing the array.
     */
    const child = await session(spaceA, people.bob.memberA, personaA, 'bob');
    const sourceInB = await session(spaceB, people.alice.memberB, personaB, 'alice');
    // A pre-343-shaped source binding (no recorded root), so the source-root
    // anchor cannot be what refuses, leaving the read-back isolated.
    await scratch.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`insert into internal.mcp_session_bindings
        (session_id,space_id,auth_session_id,runtime_identity_id,launcher_identity_id,launcher_auth_kind,
         selections,chain,chain_space_ids)
        values($1,$2,$3,$4,$4,'browser','[]',$5,$6)
        on conflict (session_id) do update set chain=excluded.chain, chain_space_ids=excluded.chain_space_ids`,
        [sourceInB.sessionId, spaceB, sourceInB.authSessionId, people.alice.identity,
         [sourceInB.sessionId], [spaceB]]);
    });
    const bob: DbClaims = { identityId: people.bob.identity, authKind: 'browser', sessionSpaceId: spaceA };
    const bind = (spaces: string[]) => db.tx(bob, q => q.rpc('bind_mcp_session', [
      child.sessionId, hashToken(child.token.split('.')[1]!), '[]',
      sourceInB.sessionId, sourceInB.authSessionId, people.bob.memberA,
      [child.sessionId, sourceInB.sessionId], spaces,
    ]));
    // Understated: the second hop is really in B, declared as A.
    expect(await outcome(() => bind([spaceA, spaceA])))
      .toMatch(/names a space the hop does not belong to/);
    // And told the TRUTH, §6.2 refuses it on the merits — Bob is not in B. Two
    // different refusals, so neither can stand in for the other.
    expect(await outcome(() => bind([spaceA, spaceB])))
      .toMatch(/not a member of every space in the chain/);
    const [row] = await scratch.query<{ n: string }>(
      'select count(*)::text n from internal.mcp_session_bindings where session_id=$1', [child.sessionId]);
    expect(row?.n).toBe('0');
  });

  it('a delegated launch cannot re-root away from its source binding', async () => {
    // The chain is inherited, and so is the ROOT: a child that names a root its
    // source did not record is refused even when the chain shape checks out.
    const parent = await session(spaceA, people.alice.memberA, personaA, 'alice');
    const child = await session(spaceA, people.alice.memberA, personaA, 'alice');
    const common = { spaceId: spaceA, teamMemberId: personaA };
    await bindings.bind(human('alice', spaceA), { ...common, sessionId: parent.sessionId, agentToken: parent.token, mcpSelections: [] });
    expect(await outcome(() => db.tx(
      { identityId: people.dave.identity, authKind: 'browser', sessionSpaceId: spaceA },
      q => q.rpc('bind_mcp_session', [
        child.sessionId, hashToken(child.token.split('.')[1]!), '[]',
        parent.sessionId, parent.authSessionId, people.dave.memberA,
        [child.sessionId, parent.sessionId], [spaceA, spaceA],
      ]))))
      .toMatch(/root does not match its source binding/);
  });

  it('a chain naming a source that was never bound is refused (B35/B36, 350)', async () => {
    /*
     * The tail check and the root anchor BOTH fall open when the named source
     * has no binding row, and they fall open together:
     * `coalesce(v_source_chain, array[p_source_session])` invents the very tail
     * it is meant to verify, so a two-hop chain matches; and `v_source_root` is
     * null, so `if v_source_root is not null and ...` skips the root anchor.
     *
     * The call below is shaped so NOTHING ELSE can refuse it, which is what
     * makes it a test of this guard and not of its neighbours: the walk is
     * ready (Alice is a human bearer), the named root is the one the walk
     * derived, the head is the child's own session, both hops really are in A,
     * and the transaction runs as Alice — so the B28 identity anchor is
     * satisfied too. The only untrue thing about it is that Alice's "source"
     * was never bound.
     *
     * Severity is defence in depth, not a live exploit (B36): the TypeScript
     * derivation calls `read_mcp_session_binding` under the source's own bearer
     * first and answers `source_unavailable`, so no API path arrives here with
     * a bindingless source. This cell goes at the SQL door, which is specified
     * to stand on facts it reads itself.
     */
    const child = await session(spaceA, people.alice.memberA, personaA, 'alice');
    const unbound = await session(spaceA, people.alice.memberA, personaA, 'alice');
    const bindChild = () => db.tx(human('alice', spaceA), q => q.rpc('bind_mcp_session', [
      child.sessionId, hashToken(child.token.split('.')[1]!), '[]',
      unbound.sessionId, unbound.authSessionId, people.alice.memberA,
      [child.sessionId, unbound.sessionId], [spaceA, spaceA],
    ]));
    expect(await outcome(bindChild)).toMatch(/names a source with no binding/);
    // Nothing was recorded, so no later call can resolve under the invented chain.
    const [row] = await scratch.query<{ n: string }>(
      'select count(*)::text n from internal.mcp_session_bindings where session_id=$1', [child.sessionId]);
    expect(row?.n).toBe('0');

    // CONTROL: bind the source for real and the IDENTICAL call is accepted. So
    // what the refusal rejects is the missing row, not the shape of the call —
    // and the inherited chain is recorded as the two hops it really has.
    await bindings.bind(human('alice', spaceA),
      { spaceId: spaceA, teamMemberId: personaA, sessionId: unbound.sessionId, agentToken: unbound.token, mcpSelections: [] });
    expect(await outcome(bindChild)).toBe('ok');
    const [bound] = await scratch.query<{ chain: string[]; root_member_id: string }>(
      'select chain, root_member_id from internal.mcp_session_bindings where session_id=$1', [child.sessionId]);
    expect(bound?.chain).toEqual([child.sessionId, unbound.sessionId]);
    expect(bound?.root_member_id).toBe(people.alice.memberA);
  });
});

describe('§6 — the recorded chain is what audit reads', () => {
  it('mcp_session_provenance returns what bind recorded, and refuses a link caller', async () => {
    const s = await session(spaceA, people.alice.memberA, personaA, 'alice');
    await bindings.bind(human('alice', spaceA), {
      sessionId: s.sessionId, spaceId: spaceA, teamMemberId: personaA, agentToken: s.token,
      mcpSelections: [{ serverId: serverA, credentialId: aliceKeyA }],
    });
    const recorded = await db.rpc<{ recorded: boolean; rootMemberId: string; chain: string[]; depth: number; rootStillAdmitted: boolean }>(
      human('alice', spaceA), 'mcp_session_provenance', [s.sessionId]);
    expect(recorded).toMatchObject({
      recorded: true, rootMemberId: people.alice.memberA, depth: 1, rootStillAdmitted: true,
    });
    expect(recorded.chain).toEqual([s.sessionId]);
    // Off the human gate, so it refuses a link caller itself — otherwise a link
    // session could enumerate which members are behind a Space's agents.
    expect(await outcome(() => db.rpc({ ...human('alice', spaceA), authKind: 'link' }, 'mcp_session_provenance', [s.sessionId])))
      .toMatch(/linked MCP provenance is unavailable/);
    // A session nobody bound reads as not recorded rather than raising.
    const bare = await session(spaceA, people.alice.memberA, personaA, 'alice');
    expect(await db.rpc<{ recorded: boolean }>(human('alice', spaceA), 'mcp_session_provenance', [bare.sessionId]))
      .toMatchObject({ recorded: false });
  });

  it('a launch in B never reaches A\'s connections, pinned or defaulted', async () => {
    const s = await session(spaceB, people.alice.memberB, personaB, 'alice');
    const input = { sessionId: s.sessionId, spaceId: spaceB, teamMemberId: personaB, agentToken: s.token };
    // Her own B connection resolves with no pin at all (§3 tier 1 under the root).
    expect(await bindings.bind(human('alice', spaceB), { ...input, mcpSelections: [{ serverId: serverB }] }))
      .toEqual([{ serverId: serverB, credentialId: aliceKeyB, serverKey: 'provspaceb' }]);
    // A's connector is not even VISIBLE to a launch in B: `loadMcpServer` reads
    // through RLS under the root's pinned claims, so it is not_found rather
    // than "belongs to another space". The stricter of the two answers.
    expect(await outcome(() => bindings.bind(human('alice', spaceB), { ...input, mcpSelections: [{ serverId: serverA }] })))
      .toMatch(/MCP connector is unavailable/);
    expect(await outcome(() => bindings.bind(human('alice', spaceB), { ...input, mcpSelections: [{ serverId: serverB, credentialId: aliceKeyA }] })))
      .toMatch(/MCP launch unavailable|MCP credential unavailable/);
  });
});

describe('§6 — the delegated hop, including bindings written before 343', () => {
  it('a delegated launch records [child, parent] and keeps the parent chain root', async () => {
    const parent = await session(spaceA, people.alice.memberA, personaA, 'alice');
    const child = await session(spaceA, people.alice.memberA, personaA, 'alice');
    // Alice launches the parent as a human bearer; the parent then launches the
    // child on its OWN agent bearer, which is the only source §6 admits.
    await bindings.bind(human('alice', spaceA), {
      sessionId: parent.sessionId, spaceId: spaceA, teamMemberId: personaA, agentToken: parent.token, mcpSelections: [],
    });
    await bindings.bind({ ...parent.claims, mcpSource: { sessionId: parent.sessionId, authSessionId: parent.authSessionId } }, {
      sessionId: child.sessionId, spaceId: spaceA, teamMemberId: personaA, agentToken: child.token,
      mcpSelections: [{ serverId: serverA, credentialId: aliceKeyA }],
    });
    const grant = await bindings.authorize(child.claims, child.sessionId, serverA);
    // The whole ancestry, nearest hop first, read in ONE hop because the
    // parent's binding already held its own chain.
    expect(grant.chain).toEqual([child.sessionId, parent.sessionId]);
    expect(grant.chainSpaceIds).toEqual([spaceA, spaceA]);
    expect(grant).toMatchObject({ rootIdentityId: people.alice.identity, rootMemberId: people.alice.memberA });
  });

  it('an END-TO-END chain of 3 real binds records 3 hops, and §6.2 spans all of them', async () => {
    /*
     * F1/B27, through real `bind` only — no forged rows. The earlier depth and
     * A->B->A cells write their bindings by hand, so they could not catch the
     * collapse the lead found: `bind_mcp_session` re-derived the chain under the
     * ROOT's claims, where the hop branch is not taken, and stored `[self]`.
     * This is the cell that fails on that bug.
     */
    const a = await session(spaceA, people.alice.memberA, personaA, 'alice');
    const b = await session(spaceA, people.alice.memberA, personaA, 'alice');
    const c = await session(spaceA, people.alice.memberA, personaA, 'alice');
    const common = { spaceId: spaceA, teamMemberId: personaA };
    await bindings.bind(human('alice', spaceA), { ...common, sessionId: a.sessionId, agentToken: a.token, mcpSelections: [] });
    const hopFrom = (parent: { sessionId: string; authSessionId: string; claims: DbClaims }) =>
      ({ ...parent.claims, mcpSource: { sessionId: parent.sessionId, authSessionId: parent.authSessionId } });
    await bindings.bind(hopFrom(a), { ...common, sessionId: b.sessionId, agentToken: b.token, mcpSelections: [] });
    await bindings.bind(hopFrom(b), { ...common, sessionId: c.sessionId, agentToken: c.token,
      mcpSelections: [{ serverId: serverA, credentialId: aliceKeyA }] });
    const grant = await bindings.authorize(c.claims, c.sessionId, serverA);
    expect(grant.chain).toEqual([c.sessionId, b.sessionId, a.sessionId]);
    expect(grant.chainSpaceIds).toEqual([spaceA, spaceA, spaceA]);
    expect(grant).toMatchObject({ rootIdentityId: people.alice.identity, rootMemberId: people.alice.memberA });
    // And the launch record carries the same depth, which is what audit reads.
    expect(await db.rpc<{ depth: number }>(human('alice', spaceA), 'mcp_session_provenance', [c.sessionId]))
      .toMatchObject({ depth: 3 });
  });

  it('the depth cap refuses the NINTH real bind, and the eighth is admitted', async () => {
    // Through real binds, so the cap is reachable rather than only asserted on
    // a hand-written row: eight hops bind, the ninth is refused.
    const chain: Array<{ sessionId: string; authSessionId: string; claims: DbClaims; token: string }> = [];
    let claims: DbClaims = human('alice', spaceA);
    for (let hop = 1; hop <= 9; hop += 1) {
      const next = await session(spaceA, people.alice.memberA, personaA, 'alice');
      const input = { spaceId: spaceA, teamMemberId: personaA, sessionId: next.sessionId,
        agentToken: next.token, mcpSelections: [] as never[] };
      if (hop === 9) {
        // A rootless launch asking for NOTHING must still not refuse the spawn,
        // so the ninth hop binds `[]` — and gets no root, which is the refusal.
        await bindings.bind(claims, input);
        const provenance = await provenanceOf(claims, next.sessionId, next.token,
          { sessionId: chain.at(-1)!.sessionId, authSessionId: chain.at(-1)!.authSessionId });
        expect(provenance).toMatchObject({ reason: 'depth_exceeded', depth: 9 });
        // And naming a connector by name at that depth refuses out loud.
        await expect(bindings.bind(claims, { ...input, mcpSelections: [{ serverId: serverA, credentialId: aliceKeyA }] }))
          .rejects.toThrow(/requires a human root \(depth_exceeded\)/);
        break;
      }
      await bindings.bind(claims, input);
      chain.push(next);
      claims = { ...next.claims, mcpSource: { sessionId: next.sessionId, authSessionId: next.authSessionId } };
    }
    // The eighth is at the cap and still fully rooted.
    const eighth = chain.at(-1)!;
    const atCap = await db.rpc<{ depth: number; rootMemberId: string }>(
      human('alice', spaceA), 'mcp_session_provenance', [eighth.sessionId]);
    expect(atCap).toMatchObject({ depth: 8, rootMemberId: people.alice.memberA });
  });

  it('a PRE-343 parent binding still yields a one-hop root, and only for a human kind', async () => {
    /*
     * Rows written before this migration have null chain columns, and they will
     * exist in every database that upgrades. Their launcher identity WAS checked
     * against the human auth kinds when they were written and that kind is
     * stored, so they are still a sound one-hop root — but a stored kind that is
     * NOT human is exactly a binding written with no root, and it must not
     * become one now.
     */
    const parent = await session(spaceA, people.alice.memberA, personaA, 'alice');
    const child = await session(spaceA, people.alice.memberA, personaA, 'alice');
    await bindings.bind(human('alice', spaceA), {
      sessionId: parent.sessionId, spaceId: spaceA, teamMemberId: personaA, agentToken: parent.token, mcpSelections: [],
    });
    await scratch.query(`update internal.mcp_session_bindings
      set chain=null, chain_space_ids=null, root_member_id=null, root_identity_id=null
      where session_id=$1`, [parent.sessionId]);
    const source = { sessionId: parent.sessionId, authSessionId: parent.authSessionId };
    const got = await provenanceOf(parent.claims, child.sessionId, child.token, source);
    expect(got).toMatchObject({ reason: 'ready', via: 'bearer_source_legacy', depth: 2, rootMemberId: people.alice.memberA });

    await scratch.query("update internal.mcp_session_bindings set launcher_auth_kind='' where session_id=$1", [parent.sessionId]);
    expect((await provenanceOf(parent.claims, child.sessionId, child.token, source)).reason).toBe('no_human_provenance');
  });
});
