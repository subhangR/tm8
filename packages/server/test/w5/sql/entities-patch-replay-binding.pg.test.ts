/**
 * W5 Duo A — `038`'s eleven `entities.patch` doors keep their replay binding.
 *
 * ## Why this file is written the awkward way
 *
 * The obvious guard — *"does the body mention `ledger_replay`?"* — is **VACUOUS
 * ON THESE ELEVEN FUNCTIONS**, and would be vacuous in the reassuring direction.
 *
 * Every one of the eleven carries an in-body comment:
 *
 * ```
 * -- Security boundary: runs with ledger_replay's advisory lock HELD.
 * ```
 *
 * `pg_get_functiondef` and `prosrc` **return comments**. So a substring guard
 * keyed on the identifier `ledger_replay` is satisfied by the PROSE, and would
 * keep reporting a door as bound after a future migration removed the CALL. **It
 * would report a hole as CLOSED — and nothing would ever contradict it.**
 *
 * (The sibling instance in `039` ran the other way: a comment made a check report
 * a *fixed* defect as *broken*. That is alarming and self-correcting. This one is
 * reassuring, and every misattribution in this program has run in that direction.)
 *
 * ## What this guard does instead
 *
 * 1. **Strips `--` comments before matching.** Non-negotiable.
 * 2. **Matches the CALL WITH ITS ARGUMENTS** —
 *    `internal.ledger_replay(p_client_mutation_id, 'entities.patch')` — not the
 *    bare identifier. A comment can plausibly contain the identifier; it does not
 *    plausibly contain the full parenthesised call with its exact arguments.
 * 3. **Reads the CATALOG, never a migration file.** `038`'s definitions are
 *    uppercase (generated from `pg_get_functiondef`) while 31 of 33
 *    function-defining migrations are lowercase, so a case-sensitive sweep of
 *    `db/migrations/*.sql` in the chain's own dominant convention misses exactly
 *    these eleven. `prosrc` is regenerated verbatim and carries no such hazard.
 *    Every match here is case-insensitive and whitespace-tolerant regardless.
 *
 * ## The known-bad is SYNTHETIC, and therefore permanent
 *
 * Per the disposition rule: a pin against synthetic known-bad input **cannot be
 * repaired by a source change and needs no disposition.** The claim under test is
 * *"a guard keyed on the identifier cannot distinguish code from prose"* — a
 * property of the DETECTION METHOD, not of the shipped SQL. No migration can
 * expire it. This file therefore keeps its red half forever, which is exactly
 * what the `039` pin could not do and had to be rebuilt to survive.
 *
 * ⚠ **AND THE MUTATION TARGETS THE CALL, NEVER THE COMMENT.** A guard
 * "mutation-tested" by deleting the comment goes red and looks correct — while
 * measuring the thing it actually keys on. Deleting the CALL and LEAVING THE
 * COMMENT STANDING is the only mutation that separates a guard checking the code
 * from a guard checking the prose.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from '../../db/w1-pg.js';

// vitest ships two independent defaults — testTimeout 5s (a NAMED failure) and
// hookTimeout 10s (an UNNAMED file-level abort) — and a generous `beforeAll`
// argument covers neither. One scratch-database `destroy()` costs ~5.0s at load
// 20 on this machine.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

/**
 * FROZEN EXACT LITERALS. Eleven names, hand-listed ON PURPOSE.
 *
 * They are NOT derived from "functions that call ledger_replay with
 * 'entities.patch'", because that is the property under test — deriving the
 * population from the predicate makes a door that LOSES the call silently drop
 * out of the population and the guard pass vacuously. That is the same shape as
 * enumerating by the thing you are about to assert.
 *
 * A twelfth door, or a rename, makes this list stale — and a stale exact-literal
 * assertion is a DETECTOR WORKING. Update it to new exact literals with
 * before-and-after recorded; never to a pattern, never to a live-computed set.
 */
const PATCH_DOORS = [
  // Before 2026-07-31 this was eleven doors. Migrations 056 (entity_memory)
  // and 057 (worktrees) added `update_memory` and `update_worktree`, both
  // carrying 038's replay binding from birth — the detector fired, and the
  // list moved to the new exact literals (never to a pattern).
  'update_channel',
  'update_collection',
  'update_commit_entity',
  'update_custom_entity',
  'update_document',
  'update_file_entity',
  // 2026-08-09: migration 090 (loops) added `update_loop`, which carries 038's
  // replay binding from birth. Thirteen doors -> fourteen; the detector fired
  // and the list moved to the new exact literals, never to a pattern.
  'update_loop',
  'update_memory',
  'update_pull_request_entity',
  'update_skill_entity',
  'update_spell_entity',
  'update_task_content',
  'update_team_member',
  'update_worktree',
] as const;

/** Remove `--` line comments. The whole point of the file. */
function stripSqlComments(body: string): string {
  return body.replace(/--[^\n]*/g, '');
}

/** The CALL, with its arguments. Whitespace-tolerant, case-insensitive. */
const LEDGER_REPLAY_CALL =
  /internal\.ledger_replay\(\s*p_client_mutation_id\s*,\s*'entities\.patch'\s*\)/i;
/** The resource binding `038` added, likewise matched as a call. */
const REPLAY_SUBJECT_CALL = /internal\.require_replay_subject\(/i;
/** The naive guard this file exists to discredit. */
const NAIVE_IDENTIFIER = /ledger_replay/i;

describe.sequential('W5 Duo A — 038: the eleven entities.patch doors keep their replay binding', () => {
  let database: W1ScratchDatabase;
  let bodies: Map<string, string>;

  const readBodies = async (): Promise<Map<string, string>> => {
    const rows = await database.query<{ proname: string; prosrc: string }>(
      `select p.proname, p.prosrc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1::text[])`,
      [[...PATCH_DOORS]],
    );
    return new Map(rows.map((r) => [r.proname, r.prosrc]));
  };

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w5a_patch_binding');
    // Chain DERIVED from migrationFiles(), never a hand-listed slice.
    database.apply(migrationFiles());
    bodies = await readBodies();
  }, 240_000);

  afterAll(async () => {
    await database?.destroy();
  }, 120_000);

  it('the frozen list is exactly fourteen and every one exists in the catalog', () => {
    expect(PATCH_DOORS).toHaveLength(14);
    expect(new Set(PATCH_DOORS).size).toBe(14);
    for (const door of PATCH_DOORS) {
      expect(bodies.get(door), `${door} is missing from the catalog`).toBeTypeOf('string');
    }
  });

  it('an INDEPENDENT catalog enumeration agrees — so a twelfth door would be noticed', async () => {
    // Derived by a DIFFERENT property than the one under test: functions that
    // carry 038's resource binding at all. If a twelfth door is bound later, or
    // one of these is renamed, this disagrees with the frozen list and fails.
    const derived = (await database.query<{ proname: string }>(
      `select p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'require_replay_subject'
          and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '''entities\\.patch'''
        order by 1`,
    )).map((r) => r.proname);
    expect(derived).toEqual([...PATCH_DOORS].sort());
  });

  it('every door CALLS ledger_replay with its arguments, in comment-stripped text', () => {
    const missing = PATCH_DOORS.filter(
      (door) => !LEDGER_REPLAY_CALL.test(stripSqlComments(bodies.get(door)!)),
    );
    expect(missing, 'doors whose ledger_replay CALL is absent once comments are removed').toEqual([]);
  });

  it('every door CALLS require_replay_subject — 038s binding itself', () => {
    const missing = PATCH_DOORS.filter(
      (door) => !REPLAY_SUBJECT_CALL.test(stripSqlComments(bodies.get(door)!)),
    );
    expect(missing).toEqual([]);
  });

  // -- the anti-vacuity control, and it is the reason the file exists ---------

  it('SYNTHETIC KNOWN-BAD: with the CALL deleted and the COMMENT left standing, the naive guard still passes and this one does not', () => {
    const original = bodies.get('update_channel')!;
    // Confirm the bait is really there before relying on the demonstration.
    expect(original).toMatch(/--[^\n]*ledger_replay/i);

    // Delete the CALL. Leave every comment untouched — that is the whole point.
    const callGone = original.replace(LEDGER_REPLAY_CALL, 'null');
    expect(callGone, 'the mutation did not apply — this control would be vacuous')
      .not.toBe(original);
    // The comment survived the mutation, so the two guards are being compared on
    // the same body and differ only in what they key on.
    expect(callGone).toMatch(/--[^\n]*ledger_replay/i);

    // The naive guard: satisfied by the prose. This is the defect.
    expect(NAIVE_IDENTIFIER.test(callGone)).toBe(true);
    // This guard: comment-stripped, full call. Correctly refuses.
    expect(LEDGER_REPLAY_CALL.test(stripSqlComments(callGone))).toBe(false);
    // And it still passes on the unmutated body, so it is not refusing everything.
    expect(LEDGER_REPLAY_CALL.test(stripSqlComments(original))).toBe(true);
  });

  it('SYNTHETIC KNOWN-BAD, driven through the CATALOG: an unbound door is detected end to end', async () => {
    // The string comparison above proves the PREDICATE discriminates. This proves
    // the GUARD does — the same check, over a real `create or replace`, against
    // pg_catalog rather than against a variable.
    const original = bodies.get('update_channel')!;
    const definition = (await database.query<{ def: string }>(
      `select pg_get_functiondef(p.oid) def from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'update_channel'`,
    ))[0]!.def;

    const unbound = definition.replace(LEDGER_REPLAY_CALL, 'null');
    expect(unbound, 'mutation did not apply to the definition').not.toBe(definition);
    await database.query(unbound);
    try {
      const after = (await readBodies()).get('update_channel')!;
      // The comment is still in the catalog...
      expect(after).toMatch(/--[^\n]*ledger_replay/i);
      // ...so the naive guard reports this unbound door as BOUND.
      expect(NAIVE_IDENTIFIER.test(after)).toBe(true);
      // This guard catches it.
      expect(LEDGER_REPLAY_CALL.test(stripSqlComments(after))).toBe(false);
    } finally {
      // Restore, and VERIFY the restore: a repair left in place would make every
      // later assertion run against a database nobody shipped.
      await database.query(definition);
      const restored = (await readBodies()).get('update_channel')!;
      expect(restored).toBe(original);
    }
  });
});
