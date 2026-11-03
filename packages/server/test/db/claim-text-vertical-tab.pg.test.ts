/**
 * 387 — E'\v' is not a PostgreSQL escape, so three trims stripped the letter v.
 *
 * 037's internal.claim_text, 085's rename_work_session and 223's
 * internal.header_text trimmed with E' \t\n\r\f\v'. PostgreSQL has no \v
 * escape (E'\v' = 'v'), so btrim took a leading or trailing 'v' off every
 * claim, renamed title and header field, and never a real vertical tab.
 *
 * Every assertion here failed before 387, through the doors callers use:
 *   · claim_text hands back 'vikram', 'olev', 'vv-x-vv' verbatim;
 *   · an identity that starts and ends with 'v' is a member of its own space
 *     and NOT of the space its v-trimmed twin owns (before 387 it read as the
 *     twin: is_space_member compares members.identity_id with the claim);
 *   · a session title and every header field keep their edge v's, and a
 *     vertical tab is trimmed like the rest of the whitespace set;
 *   · no function in the live catalog carries such a literal any more.
 * migration-string-escapes.test.ts guards the migration files themselves.
 */
import { type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

/** Starts and ends with 'v'. */
const V_IDENTITY = 'vikram-claim-387-olev';
/** What 037's trim turned V_IDENTITY into: a separate account here. */
const TWIN_IDENTITY = 'ikram-claim-387-ole';
const VT = '\u000b';

/** An E'' literal in a function body that uses \v (the 037/085/223 mistake). */
const V_ESCAPE_RE = String.raw`(^|[^A-Za-z0-9_])[Ee]'([^'\\]|\\.|'')*\\v`;

describe.sequential('387 — the whitespace trims keep the letter v and drop a vertical tab', () => {
  let database: W1ScratchDatabase;
  let vSpace: string;
  let twinSpace: string;
  let personaId: string;

  async function asApp<T>(identity: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(
        `select set_config('tm8.identity_id', $1, true),
                set_config('tm8.actor_id', '', true),
                set_config('tm8.node_admin', 'false', true),
                set_config('tm8.request_id', 'claim-387', true)`,
        [identity],
      );
      return fn(client);
    });
  }

  async function appValue<T>(identity: string, sql: string, params: readonly unknown[] = []): Promise<T> {
    return asApp(identity, async (client) => (await client.query<{ value: T }>(sql, [...params])).rows[0]!.value);
  }

  async function refusal(identity: string, sql: string, params: readonly unknown[] = []): Promise<string | null> {
    try {
      await appValue(identity, sql, params);
      return null;
    } catch (error) {
      return (error as { message?: string }).message ?? String(error);
    }
  }

  async function ownerRows<R extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query<R>(sql, [...params])).rows;
    });
  }

  const titleOf = async (sessionId: string): Promise<string> =>
    (await ownerRows<{ title: string }>(`select title from public.work_sessions where entity_id = $1`, [sessionId]))[0]!.title;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('claim_text_387');
    database.apply(migrationFiles());

    for (const identity of [V_IDENTITY, TWIN_IDENTITY]) {
      await ownerRows(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      await ownerRows(
        `insert into public.accounts(identity_id, username, display_name, is_owner, is_node_admin)
         values ($1, $1, $1, false, true)`,
        [identity],
      );
    }
    vSpace = (await appValue<{ space: { id: string } }>(V_IDENTITY,
      `select public.create_space($1, '', 'private', null, $2) value`, ['387 v space', 'claim-387-v'])).space.id;
    twinSpace = (await appValue<{ space: { id: string } }>(TWIN_IDENTITY,
      `select public.create_space($1, '', 'private', null, $2) value`, ['387 twin space', 'claim-387-twin'])).space.id;
    personaId = (await appValue<{ entity: { id: string } }>(V_IDENTITY,
      `select public.create_team_member(p_space_id => $1, p_name => $2, p_client_mutation_id => 'claim-387-persona') value`,
      [vSpace, '387 persona'])).entity.id;
  }, 300_000);

  afterAll(async () => {
    await database?.destroy();
  }, 120_000);

  it('CONTROL: explicit octal encodes a vertical tab portably', async () => {
    const [row] = await ownerRows<{ same: boolean }>(String.raw`select E'\013' = chr(11) as same`);
    expect(row!.same).toBe(true);
  });

  it('internal.claim_text returns a claim verbatim apart from whitespace, a vertical tab included', async () => {
    const cases: Array<[string, string | null]> = [
      ['vikram', 'vikram'],
      ['olev', 'olev'],
      [' vv-x-vv ', 'vv-x-vv'],
      ['v', 'v'],
      [`${VT}vikram${VT}`, 'vikram'],
      [`\t${VT} \n`, null],
    ];
    for (const [claim, expected] of cases) {
      const got = await database.transaction(async (client) => {
        await client.query('set local role tm8_app');
        await client.query(`select set_config('tm8.identity_id', $1, true)`, [claim]);
        return (await client.query<{ value: string | null }>(`select internal.claim_text('tm8.identity_id') value`)).rows[0]!.value;
      });
      expect(got, `claim ${JSON.stringify(claim)}`).toBe(expected);
    }
  });

  it("an identity that starts and ends with v is its own space's member, and not its trimmed twin", async () => {
    expect(await appValue<string>(V_IDENTITY, `select internal.identity_id() value`)).toBe(V_IDENTITY);
    const [member] = await ownerRows<{ identity_id: string }>(
      `select identity_id from public.members where space_id = $1`, [vSpace]);
    expect(member!.identity_id, 'create_space stored the trimmed identity').toBe(V_IDENTITY);

    expect(await appValue<boolean>(V_IDENTITY, `select internal.is_space_member($1) value`, [vSpace])).toBe(true);
    expect(
      await appValue<boolean>(V_IDENTITY, `select internal.is_space_member($1) value`, [twinSpace]),
      `${V_IDENTITY} read as ${TWIN_IDENTITY}`,
    ).toBe(false);
  });

  it('rename_work_session keeps edge v\'s, trims a vertical tab, and refuses a title of one', async () => {
    const sessionId = (await appValue<{ entity: { id: string } }>(V_IDENTITY,
      `select public.execution_spawn(p_space_id => $1, p_team_member_id => $2, p_title => 'spawned',
              p_node_id => 'claim-387-node', p_model => 'claim-387-model', p_session_cap => 64,
              p_client_mutation_id => 'claim-387-spawn') value`,
      [vSpace, personaId])).entity.id;

    const rename = (version: number, title: string, cmid: string) =>
      appValue(V_IDENTITY,
        `select public.rename_work_session(p_entity_id => $1, p_expected_version => $2,
                p_title => $3, p_client_mutation_id => $4) value`,
        [sessionId, version, title, cmid]);

    await rename(1, 'v2 deploy rev', 'claim-387-rename-1');
    expect(await titleOf(sessionId)).toBe('v2 deploy rev');
    await rename(2, `${VT} v-title-v ${VT}`, 'claim-387-rename-2');
    expect(await titleOf(sessionId)).toBe('v-title-v');

    const raised = await refusal(V_IDENTITY,
      `select public.rename_work_session(p_entity_id => $1, p_expected_version => 3,
              p_title => $2, p_client_mutation_id => 'claim-387-rename-3') value`,
      [sessionId, VT]);
    expect(raised ?? `NOT REFUSED, title is now ${JSON.stringify(await titleOf(sessionId))}`).toMatch(/must not be empty/i);
    expect(await titleOf(sessionId)).toBe('v-title-v');
  });

  it("set_entity_header keeps edge v's in every field and trims a vertical tab", async () => {
    const taskId = (await appValue<{ entity: { id: string } }>(V_IDENTITY,
      `select public.create_task($1, 'claim 387 task') value`, [vSpace])).entity.id;
    await appValue(V_IDENTITY,
      `select public.set_entity_header(p_entity_id => $1, p_when_to_use => $2, p_summary => $3,
              p_keywords => $4::text[], p_client_mutation_id => 'claim-387-header') value`,
      [taskId, 'verify the nav', `${VT}v2 summary rev${VT}`, ['csv', 'env', 'kv', `${VT}dev`]]);

    const [header] = await ownerRows<{ when_to_use: string; summary: string; keywords: string[] }>(
      `select when_to_use, summary, keywords from public.entity_headers where entity_id = $1`, [taskId]);
    expect(header).toEqual({ when_to_use: 'verify the nav', summary: 'v2 summary rev', keywords: ['csv', 'env', 'kv', 'dev'] });
  });

  it("no function in the live catalog trims with E'...\\v'", async () => {
    const [control] = await ownerRows<{ old: boolean; fixed: boolean; doubled: boolean }>(
      `select $1 ~ $4 as old, $2 ~ $4 as fixed, $3 ~ $4 as doubled`,
      [String.raw`btrim(x, E' \t\n\r\f\v')`, String.raw`btrim(x, E' \t\n\r\f\x0B')`, String.raw`select E'\\v'`, V_ESCAPE_RE]);
    expect(control).toEqual({ old: true, fixed: false, doubled: false });

    const offenders = await ownerRows<{ fn: string }>(
      `select p.oid::regprocedure::text as fn
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in ('pg_catalog', 'information_schema') and p.prosrc ~ $1
        order by 1`,
      [V_ESCAPE_RE]);
    expect(offenders.map((row) => row.fn)).toEqual([]);
  });
});
