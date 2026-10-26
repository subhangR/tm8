/**
 * Function EXECUTE grants — what PUBLIC may call (360).
 *
 * `revoke all on all functions in schema internal from public` (001-008) only
 * reached the functions that existed when it ran; every later `create function`
 * gets Postgres's default EXECUTE to PUBLIC unless its migration revokes it.
 * tm8_app holds USAGE on `internal`, so a SECURITY DEFINER helper that missed
 * its revoke is callable by the app role as the function owner, past whatever
 * check its public wrapper makes. Nineteen had slipped through before 360,
 * including `internal.stop_work_session_core`, which stopped any session in any
 * space with no claims bound.
 *
 * This suite is the catalog-wide guard: a new definer function that forgets its
 * `revoke all ... from public` fails here, by name.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { denied, OWNER_URL, rows } from './helpers.mjs';

test('no SECURITY DEFINER function in internal is executable by PUBLIC', () => {
  const leaked = rows(
    `select p.oid::regprocedure::text as fn
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'internal'
        and p.prosecdef
        and has_function_privilege('public', p.oid, 'execute')
      order by 1`,
    { url: OWNER_URL },
  ).map((row) => row.fn);
  assert.deepEqual(leaked, [], `add "revoke all on function <fn> from public" for: ${leaked.join(', ')}`);
});

test('no function in public is executable by PUBLIC (tm8_app is granted each RPC by name)', () => {
  const leaked = rows(
    `select p.oid::regprocedure::text as fn
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and has_function_privilege('public', p.oid, 'execute')
      order by 1`,
    { url: OWNER_URL },
  ).map((row) => row.fn);
  assert.deepEqual(leaked, [], `add "revoke all on function <fn> from public" for: ${leaked.join(', ')}`);
});

test('tm8_app cannot reach a *_core session helper past its public wrapper', () => {
  denied(
    'internal.stop_work_session_core: tm8_app with no claims',
    `select internal.stop_work_session_core(gen_random_uuid(), gen_random_uuid(), 'x')`,
    { expect: '42501' },
  );
});
