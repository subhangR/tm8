import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  createW1ScratchDatabase,
  migrationFiles,
  MIGRATIONS_DIR,
  REPO_ROOT,
  type W1ScratchDatabase,
} from './w1-pg.js';

const FROZEN_W2_MIGRATIONS = [
  '016_w2_identity_spaces.sql',
  '018_w2_edges_placements.sql',
  '020_w2_collections_graph_undo.sql',
  '021_w2_projects.sql',
  '022_w2_files.sql',
  '023_w2_inbox.sql',
  '024_w2_saved_views_actions.sql',
] as const;

/**
 * ⚠ POSITION-PINNED FIXTURE. Suites built on this assert CHAIN POSITION 015,
 * not present system behaviour. READ THIS BEFORE "CLEANING" ANY TEST THAT USES
 * IT: a later migration's removal never reaches these suites, so an assertion
 * about a feature the system no longer has is CORRECT here, not stale.
 * (R15 / R15b, 2026-08-07.)
 *
 * Greenness cannot classify a suite. After a removal, a green pg suite is
 * EITHER pinned below the change (leave it) OR full-chain and passing vacuously
 * (fix it) — opposite edits, and only this `.apply(...)` argument tells them
 * apart. Reference counts and grep hits are non-evidence for that question.
 *
 * THIS IS ONE OF THREE BYTE-IDENTICAL COPIES of this pin —
 * `w1-foundations.test.ts` and `w1-migration-runner.test.ts` hold the others,
 * and each is fenced separately because a cleanup lane reaches whichever file it
 * happened to open. Editing one does not warn the next reader about the rest.
 * `FROZEN_W2_MIGRATIONS` above is a second, independent pin in this same file.
 */
function w1MigrationFiles(): string[] {
  const files = migrationFiles();
  const tail = files.indexOf('015_w1_foundations.sql');
  expect(tail).toBe(14);
  return files.slice(0, tail + 1);
}

function runOfficialMigrator(database: W1ScratchDatabase): string {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, 'db', 'migrate.mjs'), 'up'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, TM8_DATABASE_URL: database.url },
  });
  expect(
    result.status,
    `official migrator failed for ${database.name}:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  ).toBe(0);
  return result.stdout ?? '';
}

async function seedW1RunnerState(database: W1ScratchDatabase): Promise<void> {
  await database.query(`
    create table public.applied_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now(),
      duration_ms integer not null default 0
    )
  `);
  const files = w1MigrationFiles();
  database.apply(files);
  for (const filename of files) {
    const checksum = createHash('sha256')
      .update(readFileSync(join(MIGRATIONS_DIR, filename)))
      .digest('hex');
    await database.query(
      `insert into public.applied_migrations(filename, checksum) values ($1, $2)`,
      [filename, checksum],
    );
  }
}

async function expectOfficialOrder(database: W1ScratchDatabase): Promise<void> {
  const files = migrationFiles();
  expect(new Set(files.map((file) => file.slice(0, 3))).size).toBe(files.length);
  expect(files).toEqual([...files].sort());
  for (const filename of FROZEN_W2_MIGRATIONS) expect(files).toContain(filename);

  const ledger = await database.query<{ filename: string }>(
    `select filename from public.applied_migrations order by filename`,
  );
  expect(ledger.map((row) => row.filename)).toEqual(files);
}

// =============================================================================
// ROLE BALANCE — a static detector for the defect that rolled back a landing.
//
// WHAT IT CATCHES. A migration that issues `set role` and never resets it leaves
// the runner's own session under that role, so db/migrate.mjs cannot write its
// post-apply row into public.applied_migrations and the WHOLE transaction rolls
// back. Migration 033 did exactly this and took a three-file batch down with it.
//
// WHY A DETECTOR AND NOT A RULE. This program has already learned this once:
// migration 015 attempted ACL cleanup while still under `set role
// tm8_graph_owner`, the mixed-owner statement failed, and 015 rolled back — same
// defect, same table, one wave earlier. A rule was left behind and the rule
// decayed. Rules decay; detectors do not.
//
// IT CANNOT BE A NAIVE GREP, FOR TWO REASONS FOUND BY BUILDING IT:
//
//   1. THE STRING "reset role" CONTAINS THE STRING "set role". Counting
//      occurrences of `set role` therefore counts every reset as a set. The regex
//      below matches `(re)?set role` as one alternation and classifies on the
//      captured prefix, so the two can never be confused.
//
//   2. BALANCE IS THE WRONG INVARIANT, AND ASSERTING IT WOULD FIRE ON A FILE THAT
//      IS ACTUALLY CORRECT. 015_w1_foundations.sql has ONE `set role` (:24) and
//      TWO `reset role` (:2188, :2211). A count-equality check calls that a
//      violation. It is not one: the sequence is set -> reset -> reset, the role
//      IS reset when the file ends, and a redundant reset is harmless. The
//      harmful condition is not "unequal counts", it is "STILL UNDER A set role
//      AT END OF FILE". That is what this models, as a state machine over the
//      statements in order. A false red on a correct file is worse than no
//      detector, because it teaches people to ignore the gate.
//
// `set local role` is deliberately NOT counted: it is transaction-scoped and
// cannot leak into the runner's later statements.
// =============================================================================

/**
 * Removes line comments, block comments, single-quoted literals and
 * dollar-quoted bodies, so only TOP-LEVEL statement text remains. Without this a
 * `set role` inside a function body or a comment would be counted as real.
 */
function stripSqlNoise(sql: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) [depth, i] = [depth + 1, i + 2];
        else if (sql.startsWith('*/', i)) [depth, i] = [depth - 1, i + 2];
        else i += 1;
      }
      continue;
    }
    if (sql[i] === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i += 1;
          break;
        } else i += 1;
      }
      out.push(' ');
      continue;
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end < 0 ? sql.length : end + tag.length;
      out.push(' ');
      continue;
    }
    out.push(sql[i]!);
    i += 1;
  }
  return out.join('');
}

const ROLE_STATEMENT = /\b(re)?set\s+(local\s+)?role\b/gi;

/** True when the file ends while still under a `set role`. */
function endsUnderSetRole(sql: string): boolean {
  const text = stripSqlNoise(sql);
  let under = false;
  for (const match of text.matchAll(ROLE_STATEMENT)) {
    if (match[2]) continue; // SET LOCAL ROLE — transaction-scoped, cannot leak.
    under = match[1] === undefined;
  }
  return under;
}

describe('migration role balance (static, no database)', () => {
  it('no migration ends while still under a set role', () => {
    const offenders = migrationFiles().filter((file) =>
      endsUnderSetRole(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')),
    );
    expect(
      offenders,
      'a migration ends under `set role`; db/migrate.mjs cannot then record into ' +
        'public.applied_migrations and the whole chain rolls back',
    ).toEqual([]);
  });

  // NON-VACUITY, AND THE FIXTURE IS INLINE ON PURPOSE.
  //
  // The assertion above is green on a healthy tree, so on its own it proves
  // nothing about its own ability to fail. What follows is the proof that it can.
  //
  // ⚠ THESE FIXTURES ARE BUILT IN THIS FILE AND READ NOTHING FROM DISK. That is a
  // requirement, not a convenience. The obvious alternative — point the red
  // validation at the real 033-as-it-was on disk — would make this detector's
  // ability to fail depend on a path outside the repository, and a path is not an
  // artifact. That exact dependency has already bitten this program twice: a suite
  // whose candidate lived in a dead session's scratchpad, and a file that was
  // rewritten in place at 11:39 while a test still pointed at it, byte-identical
  // when the pointer was set and different an hour later. Both degrade to an ERROR
  // or a false green rather than a red, which is the worst direction. So the red
  // lives here, in the repository, where nothing external can rewrite it.
  //
  // HISTORICAL NOTE, deliberately a comment and NOT a runtime dependency: this
  // check was validated once against the genuine defective artifact,
  // 033_w2_sec1b_ledger_replay_principal_pin.sql at sha256
  // 42ae16a8f14027d9f9edcb80645f6af5f341fd56fece221f1c9c838c0ccebed9, which had
  // `set role tm8_graph_owner;` at :282 and no `reset role` anywhere. The check
  // reported it RED, and reported the fixed revision (sha256 3ee5e036…6996aba5,
  // which adds `reset role;` at :355) green. That was a real production red, not a
  // mutation and not a probe. The reconstruction below is the same shape.
  const THIRTY_THREE_AS_IT_WAS = [
    'set role tm8_graph_owner;',
    '',
    'create or replace function internal.ledger_replay(p_cmid text) returns jsonb',
    'language plpgsql as $$ begin return null; end $$;',
    '',
    '-- no reset role, which is the whole defect',
  ].join('\n');

  it('goes RED on the 033 shape, and does NOT fire on the shapes that are fine', () => {
    // THE RED.
    expect(
      endsUnderSetRole(THIRTY_THREE_AS_IT_WAS),
      'the detector no longer catches the defect it was built for',
    ).toBe(true);
    expect(endsUnderSetRole('set role tm8_graph_owner;\ncreate table t(a int);\n')).toBe(true);

    // THE GREENS IT MUST KEEP.
    expect(endsUnderSetRole('set role tm8_graph_owner;\nreset role;\n')).toBe(false);
    // 015's real shape: one set, two resets. Correct, and a count-equality check
    // would false-red on it. See the header for why that would be worse than none.
    expect(endsUnderSetRole('set role x;\nreset role;\nreset role;\n')).toBe(false);
    // "reset role" CONTAINS "set role" — a naive count sees every reset as a set,
    // and fails in the REASSURING direction. This is the assertion that pins it.
    expect(endsUnderSetRole('reset role;\n')).toBe(false);
    // Transaction-scoped, cannot leak into the runner's later statements.
    expect(endsUnderSetRole('set local role tm8_app;\n')).toBe(false);
    // A `set role` that only APPEARS — in a body, a comment, or a literal — is not
    // a statement. Without stripping, each of these is a false red on a good file.
    expect(
      endsUnderSetRole('create function f() returns void as $$ begin set role x; end $$;\n'),
    ).toBe(false);
    expect(endsUnderSetRole('-- set role tm8_graph_owner;\n')).toBe(false);
    expect(endsUnderSetRole('/* set role tm8_graph_owner; */\n')).toBe(false);
    expect(endsUnderSetRole("select 'set role tm8_graph_owner;';\n")).toBe(false);
  });
});

describe.sequential('W2 official migration order', () => {
  it('applies every repository migration in lexical order from empty and is idempotent', async () => {
    const database = await createW1ScratchDatabase('w2_order_empty');
    try {
      expect(runOfficialMigrator(database)).toContain('migrations applied');
      await expectOfficialOrder(database);
      expect(runOfficialMigrator(database)).toContain('nothing to do');
    } finally {
      await database.destroy();
    }
  }, 120_000);

  it('upgrades the supported 001-015 runner state through every later repository migration', async () => {
    const database = await createW1ScratchDatabase('w2_order_current');
    try {
      await seedW1RunnerState(database);
      const output = runOfficialMigrator(database);
      expect(output).toContain('016_w2_identity_spaces.sql');
      expect(output).toContain('024_w2_saved_views_actions.sql');
      await expectOfficialOrder(database);
    } finally {
      await database.destroy();
    }
  }, 120_000);
});
