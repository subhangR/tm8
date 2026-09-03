/**
 * `internal.entity_content` resolves EVERY core kind — the guard against the
 * silent-drop failure shape.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT ABOUT CONTAINERS.
 *
 * `internal.entity_content` is a SHARED BODY. Eleven migrations have re-created
 * it (001 → 005 → 011 → 015 → 017 → 053 → 055 → 056 → 057 → 091 → 135), each
 * copying the last and adding one `when '<kind>' then` arm. Two branches that
 * both re-create it do not conflict in git, neither errors, and NEITHER REDS A
 * TEST: whichever migration lands second wins wholesale, and the arm the other
 * one added is simply gone. Content for that kind resolves to `{}`::jsonb
 * forever, everywhere, with no error and no signal — until somebody notices a
 * panel is empty in production.
 *
 * That is not hypothetical. `177_container_kind.sql` (this program) and
 * `176_chat_entity.sql` (the chat lane) were written at the same time and both
 * re-create this function. The two lanes agreed the rule — whichever merges
 * second re-copies the body from `origin/main` at merge time and adds its arm on
 * top — and this suite is what makes a broken promise LOUD instead of silent.
 * It reds for whichever side gets it wrong.
 *
 * So: this file is deliberately NOT scoped to `container`. It defends a class of
 * bug, not one instance, and it is the guard for the chat arm as much as for the
 * container one. Do not "simplify" it down to the kind whose migration shipped
 * it — that would restore exactly the blind spot it exists to remove.
 *
 * FULL-CHAIN, not position-pinned. An all-kinds assertion is chain-wide by
 * construction, which is why it cannot live in `containers.pg.test.ts` (that
 * suite slices the chain) for the same reason a migration's VERIFY block may not
 * assert chain-wide: a sliced chain legitimately has fewer arms.
 *
 * Entities are created through each kind's OWN door wherever one exists, because
 * a raw insert would not prove the door and the arm agree about the table.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

let database: W1ScratchDatabase;

interface Seed {
  identityId: string;
  spaceId: string;
  memberId: string;
}

let seed: Seed;

/**
 * Kinds whose content arm is not expected to resolve to a non-empty object, with
 * the reason. An entry here is a DECISION, not a way to quiet a failure: if a
 * kind lands in this list because its arm went missing, the list is the bug.
 */
const NO_CONTENT_ARM: Record<string, string> = {
  // A space-scoped custom kind is `c:%`-prefixed and handled by the
  // `custom_entities` branch above the case statement, never by an arm.
};

beforeAll(async () => {
  database = await createW1ScratchDatabase('entcontent');
  database.apply(migrationFiles());
  seed = await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const s = (await client.query<Seed>(
      `select 'entity-content-owner'::text "identityId",
              internal.new_id()::text "spaceId",
              internal.new_id()::text "memberId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Content owner')`,
      [s.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Content',$2)`,
      [s.spaceId, s.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1)`,
      [s.memberId, s.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Content owner')`,
      [s.memberId, s.spaceId, s.identityId],
    );
    return s;
  });
});

afterAll(async () => {
  await database?.destroy();
});

describe('internal.entity_content resolves every core kind', () => {
  it('has an arm for every kind registered with core origin', async () => {
    const kinds = await database.query<{ kind: string }>(
      `select kind from public.entity_kinds where origin = 'core' and space_id is null order by kind`,
    );
    expect(kinds.length).toBeGreaterThan(15);

    const source = (await database.query<{ prosrc: string }>(
      `select p.prosrc from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'internal' and p.proname = 'entity_content'`,
    ))[0]!.prosrc;

    const missing = kinds
      .map((row) => row.kind)
      .filter((kind) => !(kind in NO_CONTENT_ARM))
      .filter((kind) => !source.includes(`when '${kind}' then`));

    // The message is the point: it names the kind whose arm a shared-body
    // re-creation dropped, which is the one fact the failure otherwise hides.
    expect(missing, `entity_content has no arm for: ${missing.join(', ')}`).toEqual([]);
  });

  it('resolves every arm to a table and column that actually exist', async () => {
    // The SECOND half of the failure shape. A source grep proves an arm is
    // PRESENT; it does not prove the arm works. plpgsql resolves table and
    // column names lazily, when a branch executes, so an arm naming a table
    // that was renamed — or a `to_jsonb(x) - 'entity_id'` on a detail table
    // whose key column is not `entity_id` — parses fine, creates fine, and
    // fails only for the one kind nobody happened to open.
    //
    // Running each arm's own SELECT with an id that matches nothing resolves
    // every name in it without needing to satisfy that table's CHECK
    // constraints, so this covers ALL arms rather than only the two whose
    // columns happen to be defaultable.
    const arms = await database.query<{ kind: string; alias: string; table_name: string }>(
      `with src as (
         select p.prosrc from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'internal' and p.proname = 'entity_content')
       select m[1] kind, m[2] alias, m[3] table_name
         from src, regexp_matches(
           src.prosrc,
           'when ''([a-z_]+)'' then select to_jsonb\\(([a-z]+)\\)[^\\n]*?from public\\.([a-z_]+)',
           'g') m`,
    );
    // If the regex stops matching the arm style, this suite would silently
    // check nothing. Pin the count so a rewrite of that function has to come
    // back here deliberately.
    expect(arms.length).toBeGreaterThanOrEqual(21);

    const broken: string[] = [];
    for (const arm of arms) {
      try {
        await database.query(
          `select to_jsonb(${arm.alias}) - 'entity_id' from public.${arm.table_name} ${arm.alias}
            where ${arm.alias}.entity_id = '00000000-0000-0000-0000-000000000000'::uuid`,
        );
      } catch {
        broken.push(`${arm.kind} -> public.${arm.table_name}`);
      }
    }
    expect(broken, `entity_content arms name a table or column that does not resolve: ${broken.join(', ')}`)
      .toEqual([]);
  });

  // A THIRD test was written here and REMOVED rather than shipped: "create one
  // row of every kind whose detail table is fully defaultable, and assert its
  // content is non-empty". Only two of the twenty-one arms have a defaultable
  // detail table at all, and both of those inserts are refused by envelope
  // validation, so the loop constructed NOTHING and the test passed by skipping
  // every case — the failure mode it was meant to detect. It is recorded here
  // because it looks like an obvious addition and the next person will think of
  // it too: end-to-end content for one kind belongs in that kind's own suite,
  // with that kind's own fixture. `containers.pg.test.ts` does exactly that for
  // `container`, with real spec and mount data.
});
