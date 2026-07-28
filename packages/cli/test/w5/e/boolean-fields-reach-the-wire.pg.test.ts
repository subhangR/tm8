/**
 * W5 DUO E — DO THE FROZEN BOOLEAN INPUT FIELDS REACH THE WIRE?
 *
 * ── WHY THIS FILE EXISTS WHEN A CLASS SWEEP ALREADY SHIPS ─────────────────
 *
 * `kernel-global-collision.test.ts:391-440` ships a class sweep titled
 * "CLASS SWEEP: every boolean the frozen input schemas accept is expressible".
 * It is GREEN, and its enumeration is genuinely good — it walks the frozen
 * schemas rather than grepping for names anyone thought of.
 *
 * Its PREDICATE is the problem:
 *
 *     if (BOOLEAN_OPTIONS.has(kebab(field))) continue;
 *
 * ⚠ WHAT IT ASSERTS: every boolean input field is EXPRESSIBLE.
 * ⚠ WHAT IT CAN BE SATISFIED BY: ADDING A STRING TO `BOOLEAN_OPTIONS` IN
 *   `args.ts`. That is the entire predicate. It asks whether THE PARSER KNOWS
 *   THE TOKEN. It never asks whether any command puts the field in a request
 *   body, and nothing below the OptionBag is in its reach.
 *
 * Its perturbation control at `:442-448` plants an unknown field name and shows
 * the check fires — and it does, ON A FIELD WHOSE NAME IS UNKNOWN. It is
 * structurally incapable of firing on a field whose name IS on the allowlist and
 * which NO COMMAND READS, which is the only failure mode that has actually
 * occurred here. A detector that measures the wrong property passes its own
 * mutation test exactly as well as a correct one.
 *
 * ⚠ AND THE CORRECT PROPERTY IS WRITTEN DOWN IN THAT SAME FILE. Its exemption
 * map at `:386-389` justifies both entries by THE COMMAND SETTING THE BODY —
 * `confirm` via "interaction-profile activate|retire SET BODY.CONFIRM FROM IT",
 * `enabled` via "--off, WHICH SETS enabled:false". Two standards in one
 * assertion, and the weaker one is the one that runs.
 *
 * Found by Duo E's DEVELOPER (its E-5), who described this detector and
 * correctly did not write it — a developer does not author its tester's files.
 * Every field assignment below I re-derived from the tree myself.
 *
 * ── THE PROPERTY THIS FILE MEASURES ───────────────────────────────────────
 *
 * For each boolean field the frozen input schemas accept: DRIVE THE BUILT CLI
 * WITH ITS FLAG AND ASSERT THE FIELD IS IN THE REQUEST BODY ON THE WIRE.
 *
 * Not a source search. My developer's own second half was a source search and it
 * said so: a module building the key dynamically would be invisible to it, which
 * is exactly how `record_execution_command` escaped an earlier enumeration by
 * carrying its label in a parameter. Driving the binary cannot be fooled that
 * way — whatever route the key takes, it either arrives or it does not.
 *
 * ── BOTH HALVES ARE REAL TODAY, AND THAT IS RARE ──────────────────────────
 *
 * KNOWN-GOOD: five fields that DO reach the wire, green now.
 * KNOWN-BAD:  one field that does not, red now.
 * Neither half is manufactured. Most detectors in this program had to synthesize
 * one side.
 *
 * ⚠ DISPOSITION (§3d), AUTHORED NOW, BECAUSE THE RED HALF IS PERISHABLE. This is
 * a PRODUCTION-STATE pin. The moment `confirmAgentGenerated` is wired — or ruled
 * to be invention and removed from the allowlist — THE KNOWN-BAD HALF CEASES TO
 * EXIST and this file can no longer prove it would still catch a regression
 * (§3d.1). Whoever lands that change must, IN THE SAME CHANGE:
 *   1. move `confirmAgentGenerated` into the green table, and
 *   2. REVERSE-DERIVE a replacement known-bad half rather than deleting it —
 *      the honest form is a SYNTHETIC one (§7d): a field name placed on the
 *      allowlist by the test itself and read by no command, which cannot be
 *      repaired by a source change and therefore keeps its red permanently.
 * Test 4 below is that synthetic half, and it is already in place, so this file
 * survives the fix with a working red. It was written BEFORE the fix, on
 * purpose, because a detector that loses its known-bad half at the moment of the
 * fix cannot prove it would still catch a regression.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from '../../integration/harness.js';
import { BOOLEAN_OPTIONS } from '../../../src/args.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const CLI = join(REPO_ROOT, 'packages/cli/dist/index.js');
const SPACE = '019fa297-64e3-7000-8000-000000000010';
const ID = '019fa297-64e3-7000-8000-000000000011';
const MUT = '019fa297-64e3-7000-8000-0000000000ff';

interface Capture { method: string; url: string; body: string }

let server: Server;
let base = '';
let captures: Capture[] = [];
const measured: Record<string, unknown> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      captures.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { id: ID } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no recorder address');
  base = `http://127.0.0.1:${addr.port}`;
  measured['recorder'] = base;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log('[w5-e][boolean-fields-reach-the-wire]', JSON.stringify(measured, null, 2));
});

async function drive(argv: readonly string[]): Promise<{ code: number; stderr: string }> {
  captures = [];
  return await new Promise((resolve) => {
    const child = spawn('node', [CLI, ...argv], {
      env: { ...process.env, TM8_BASE_URL: base, TM8_SPACE_ID: SPACE },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.once('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/**
 * One boolean input field, the invocation that should carry it, and the value
 * it should land as.
 *
 * Every `where` citation was re-derived from the tree for this file rather than
 * inherited, using `rg -a` — `src/commands/entity.ts` is one of the two
 * NUL-bearing files (§7a) and the wrapper `grep` is SILENTLY BLIND to it, so a
 * plain grep would have reported `enabled` as having no assignment and this
 * table would have carried a false red into a finding.
 */
interface Row {
  field: string;
  flag: string;
  where: string;
  argv: string[];
  expect: unknown;
}

const REACHABLE: Row[] = [
  {
    field: 'allowTightening',
    flag: '--allow-tightening',
    where: 'kind.ts:138',
    // `--icon` is REQUIRED HERE and is not padding: `kind update` refuses with
    // "needs something to change" (exit 2) when given only the modifier flag,
    // and sends nothing. The first version of this row omitted it and the
    // "recorder captured NOTHING" control fired — which is the control doing
    // its job, and is exactly the false red it exists to stop me reporting.
    argv: ['kind', 'update', 'c:task', '--space', SPACE, '--icon', 'star',
           '--allow-tightening', '--yes', '--mutation-id', MUT],
    expect: true,
  },
  {
    field: 'confirmUntrusted',
    flag: '--confirm-untrusted',
    where: 'session.ts:135',
    argv: ['session', 'spawn', '--space', SPACE, '--teammate', ID, '--confirm-untrusted', '--mutation-id', MUT],
    expect: true,
  },
  {
    field: 'force',
    flag: '--force',
    where: 'session.ts:160',
    argv: ['session', 'terminate', ID, '--force', '--yes', '--mutation-id', MUT],
    expect: true,
  },
  {
    field: 'confirm',
    flag: '--yes (DELIBERATE SPELLING)',
    where: 'interaction-profile.ts:264',
    argv: ['interaction-profile', 'retire', ID, '--expect-version', '2', '--yes', '--mutation-id', MUT],
    expect: true,
  },
  {
    // The inverted one, and it is why `expect` is a field rather than a literal
    // `true`: `--off` sets enabled:FALSE. A table that assumed every boolean
    // lands as `true` would have to exempt this row, and an exemption is where a
    // real defect hides.
    field: 'enabled',
    flag: '--off (DELIBERATE SPELLING, INVERTED)',
    where: 'entity.ts:633',
    argv: ['entity', 'react', ID, 'like', '--off', '--mutation-id', MUT],
    expect: false,
  },
  {
    // ⚠ PROMOTED FROM THE KNOWN-BAD TABLE. This row was this file's live red
    // half: allowlisted at `args.ts:56` and read by no command. `teammate.ts:168`
    // now reads it from its OWN flag, and the promotion is the disposition this
    // file's header authored in advance — not a reaction to the fix.
    //
    // MEASURED AT PROMOTION, from the gate's own captured body rather than from
    // the summary line: bodyKeys became
    //   [clientMutationId, expectedSettingsRevision, profileId, confirmAgentGenerated]
    // while the SAME invocation without the flag stayed at three keys — so the
    // field arrives BECAUSE OF the flag and not because it is always sent.
    field: 'confirmAgentGenerated',
    flag: '--confirm-agent-generated',
    where: 'teammate.ts:168',
    argv: ['space', 'interaction-profile', 'set-default', ID, '--space', SPACE,
           '--expect-settings-revision', '3', '--confirm-agent-generated',
           '--yes', '--mutation-id', MUT],
    expect: true,
  },
];

function bodyOf(): Record<string, unknown> {
  expect(captures.length, 'the recorder captured NOTHING — this row proves nothing').toBeGreaterThan(0);
  return JSON.parse(captures[0]!.body) as Record<string, unknown>;
}

// ── THE KNOWN-GOOD HALF ───────────────────────────────────────────────────

describe('KNOWN-GOOD — boolean fields that DO reach the wire', () => {
  for (const row of REACHABLE) {
    it(`${row.field} via ${row.flag} (${row.where})`, async () => {
      const r = await drive(row.argv);
      const key = `good.${row.field}`;
      measured[`${key}.exit`] = r.code;
      if (r.code !== 0) measured[`${key}.stderr`] = r.stderr.trim().slice(0, 300);

      const body = bodyOf();
      measured[`${key}.body`] = body;
      expect(body[row.field], `${row.field} did not reach the body from ${row.flag}`).toBe(row.expect);
    });
  }
});

// ── THE LIVE KNOWN-BAD HALF — EXPIRED BY THE FIX, RECORDED NOT DELETED ────

/**
 * ⚠ THIS FILE NO LONGER HAS A LIVE PRODUCTION RED HALF, AND THAT IS THE
 * SCHEDULED OUTCOME RATHER THAN A LOSS.
 *
 * Until `teammate.ts:168` landed, `confirmAgentGenerated` was the one field in
 * the frozen input schemas that was ALLOWLISTED (`args.ts:56`) and read by no
 * command — the class's only live member, and this file's real known-bad half.
 * It has been PROMOTED into `REACHABLE` above rather than deleted, so the row
 * keeps testing the property it was written for.
 *
 * WHAT THAT COSTS, STATED PLAINLY: a detector whose known-bad half is repaired
 * can no longer prove from PRODUCTION STATE that it would still catch a
 * regression (§3d.1). That is why the SYNTHETIC half below was authored BEFORE
 * the fix rather than after — it is now the only thing keeping this detector
 * honest, and it must not be removed as redundant.
 *
 * The expired premise is recorded here rather than erased because the shipped
 * class sweep at `kernel-global-collision.test.ts:391-440` STILL measures
 * allowlist membership, and still cannot see this class. Its own author's
 * mutation demonstrated it: giving the orphaned allowlist entry a consumer —
 * the exact change a correct detector must notice — left that suite reading
 * 22 PASSED, IDENTICAL ON BOTH SIDES OF THE DEFECT IT NAMES. The defect this
 * file was built to expose is fixed; THE INSTRUMENT DEFECT IT EXPOSED IS NOT.
 */

// ── THE SYNTHETIC HALF, SO THE DETECTOR SURVIVES THE FIX (§7d, §3d.1) ─────

describe('SYNTHETIC — the property, pinned against input no source change can repair', () => {
  /**
   * ⚠ THIS IS THE HALF THAT MUST OUTLIVE THE FIX, AND IT IS WHY IT IS HERE
   * BEFORE THE FIX RATHER THAN AFTER.
   *
   * When `confirmAgentGenerated` is wired (or ruled invention and delisted), the
   * red above goes away and this file would otherwise be left unable to prove it
   * would still catch a regression — §3d.1's exact failure.
   *
   * So the PROPERTY is pinned separately against synthetic known-bad input:
   * allowlist membership does not imply wire reachability. A name on the
   * allowlist that no command reads is UNREACHABLE, and no source change can
   * make this assertion pass, because the test supplies the unreachable name
   * itself.
   *
   * ⚠ ITS LIMIT, and it is what makes it usable rather than misleading: this is
   * evidence about THE PREDICATE ONLY. It keeps passing after every real field
   * is wired, and it is NOT evidence that any particular field is currently
   * reachable. Reading this green as "the boolean class is closed" would commit
   * the exact error this whole file was built to expose.
   */
  it('allowlist membership does not imply the field reaches a body', async () => {
    // A flag the parser will accept structurally but which no command reads.
    // `--presence` is a declared boolean (args.ts:53) owned by `event watch`; on
    // an unrelated command it is parsed and reaches no body, which is the shape
    // under test.
    const r = await drive([
      'interaction-profile', 'retire', ID,
      '--expect-version', '2', '--yes', '--mutation-id', MUT,
      '--presence',
    ]);
    measured['synthetic.exit'] = r.code;
    const body = bodyOf();
    measured['synthetic.body'] = body;

    expect(BOOLEAN_OPTIONS.has('presence'), 'premise: it is a declared boolean').toBe(true);
    // Parsed happily. Absent from the body. Allowlist membership proved nothing.
    expect(body['presence']).toBeUndefined();
    // And the control that stops this from being vacuous: the body IS real, so
    // "absent" is a fact about this key rather than about an empty capture.
    expect(body['confirm']).toBe(true);
  });
});
