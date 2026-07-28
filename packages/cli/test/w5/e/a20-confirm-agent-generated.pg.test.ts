/**
 * W5 DUO E — DOES `--confirm-agent-generated` REACH THE WIRE ON A20?
 *
 * ── THE QUESTION, AND WHY THE OBVIOUS TEST ALREADY PASSES ─────────────────
 *
 * Duo E's packet records `confirmAgentGenerated` as "unexpressible on A20".
 * That word is doing too much work, and the tree already contains a green test
 * that appears to refute it:
 *
 *     kernel-global-collision.test.ts:127
 *     describe('--confirm-agent-generated is expressible')
 *
 * That test PASSES, and it is not a bad test — it even ships a probe-red
 * control for the swallowing failure it guards against. But it measures
 * `BOOLEAN_OPTIONS.has(...)` and `parsed.options.bool(...)`, which is the
 * OPTION BAG, and it stops there. "Expressible" in its title means "the parser
 * accepts it and does not swallow the next token". An agent reads "expressible"
 * as "I can use this to affect the operation".
 *
 * ⚠ THAT GAP IS THE PROGRAM'S DOMINANT FAILURE CLASS LIVING IN A TEST TITLE: a
 * sound measurement described in language wider than the measurement. IMPLIES
 * IS NOT STATES. This file measures the half that title does not: whether the
 * flag survives past the parser and into the REQUEST BODY.
 *
 * Credited: found by Duo E's DEVELOPER, who went looking precisely because the
 * green looked wider than its assertion. I re-derived every citation below from
 * the tree rather than inheriting them.
 *
 * ── THE INSTRUMENT IS A RECORDER, AND THAT IS DELIBERATE ──────────────────
 *
 * The claim is about WHAT THE CLI SENDS. A real Server would answer, but it
 * would not tell this suite which keys were in the request — and the request IS
 * the subject. So this drives the BUILT BINARY at a recording endpoint and
 * reads the captured body.
 *
 * THIS SUITE THEREFORE MAKES NO CLAIM ABOUT SERVER BEHAVIOUR and must never be
 * quoted as real-Server evidence. The SQL half is cited, not measured here:
 * `027:1208,1225-1227` raises "Agent-generated Space default requires explicit
 * human confirmation" when provenance is present and the flag is false, and
 * `entity-kinds-profiles.ts:326` passes `input.confirmAgentGenerated ?? false`.
 * Those are READ, and this file does not verify them.
 *
 * ── ⚠ DISPOSITION, AUTHORED BEFORE THE RULING AND NOW RESOLVED BY IT (§3d) ─
 *
 * This is a PRODUCTION-STATE pin, so it ships with its disposition.
 *
 * This file was authored while the ruling was OPEN, carrying branches for both
 * outcomes — because a pin whose disposition waits for a decision has no
 * disposition. THE RULING HAS SINCE BEEN GIVEN: **RESTORATION** (W5 Advisor 2,
 * sess_1785158309998_pjkmb6piy). Its mechanism, recorded so this does not become
 * an unsourced assertion: the frozen contract input on A20 carries the field
 * (`schemas.ts:1525`); `args.ts:56` already ships the flag spelling under a
 * comment naming this very command; and `teammate.ts:42-46`'s recorded reason
 * rests on an EXPIRED PREMISE — recorded as expired, not obeyed.
 *
 * ⚠ DISCHARGED. The fix landed at `teammate.ts:168` and this file was re-run as
 * its own gate. WHAT ACTUALLY HAPPENED, against what this header predicted:
 *
 *   Test 3 went green ON ITS OWN, exactly as authored. Its last scheduled act.
 *
 *   Test 5 ALSO went green on its own — AND THIS HEADER WAS WRONG ABOUT IT.
 *   It said "test 5 MUST BE INVERTED BY HAND ... it is the one manual step."
 *   THERE WAS NO MANUAL STEP. Test 5 asserts `identical === false`, i.e. that
 *   the flag DOES change something — the CORRECT behaviour — so it inverted
 *   itself like every other unsoftened witness here. I mis-described my own
 *   assertion when authoring the disposition, and a disposition that invents a
 *   manual step is not harmless: it invites the next reader to "finish" a
 *   transition that is already complete, editing a passing test to match a
 *   description of it. Recorded rather than quietly corrected.
 *
 *   Test 4 (the `--yes` leak guard) and tests 1-2 (controls) stayed green
 *   throughout and are this file's durable regression value.
 *
 * GATE EVIDENCE, from the measured block rather than the summary line, because
 * a green whose assertions did not execute is byte-identical in a count:
 *   withFlag.body   carries `confirmAgentGenerated: true`
 *   control.body    (same invocation, `--yes` present, flag ABSENT) does NOT —
 *                   three keys against four, so the field arrives BECAUSE OF
 *                   the flag and not because it is always sent
 *   discard.identical  FALSE, with `--mutation-id` pinned so the only remaining
 *                   variable between the two bodies is the flag itself
 *
 * THE SUPERSEDED BRANCH, kept because a deleted alternative teaches nobody: had
 * the ruling been INVENTION, test 3's premise would have EXPIRED and it would
 * have been RECORDED AS EXPIRED, never re-pinned to pass, with test 5 becoming
 * the primary finding — "accepted and silently discarded" being indefensible
 * under either ruling.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from '../../integration/harness.js';

/**
 * ⚠ BOTH TIMEOUTS. See the sibling suite's note — they are two independent
 * settings and a `beforeAll` argument covers neither. Mutation-tested there:
 * `hookTimeout:1` yields a file-level abort with ZERO test names, `testTimeout:1`
 * yields six named failures.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const CLI = join(REPO_ROOT, 'packages/cli/dist/index.js');
const SPACE = '019fa297-64e3-7000-8000-000000000010';
const PROFILE = '019fa297-64e3-7000-8000-000000000011';

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
      // A shape the CLI will accept as success, so the command runs to
      // completion and this suite measures the REQUEST rather than the CLI's
      // error handling.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { spaceId: SPACE, profileId: PROFILE } }));
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
  console.log('[w5-e][a20-confirm-agent-generated]', JSON.stringify(measured, null, 2));
});

/** Drive the BUILT binary — the artifact an agent invokes, not the source. */
async function drive(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  captures = [];
  return await new Promise((resolve) => {
    const child = spawn('node', [CLI, ...argv], {
      // TM8_BASE_URL set EXPLICITLY: a recorder that is never reached captures
      // zero bodies, and "the field is not on the wire" is EXACTLY what that
      // looks like. The controls below exist because of this.
      env: { ...process.env, TM8_BASE_URL: base, TM8_SPACE_ID: SPACE },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * A20's minimum viable invocation, per `operations.ts:1151`'s own syntax line.
 *
 * ⚠ `--mutation-id` IS PINNED, AND THAT PIN IS LOAD-BEARING — IT CAUGHT A FALSE
 * GREEN IN THIS FILE.
 *
 * `resolveMutationId` mints a fresh UUID when the flag is absent, so two
 * invocations that are IDENTICAL IN EVERY WAY THAT MATTERS still produce
 * different bytes. The first version of the discard test below compared raw
 * bodies without this pin and PASSED — reporting that the flag "changed
 * something observable" when the only thing that changed was a generated id the
 * flag has nothing to do with.
 *
 * That is a detector satisfied by the wrong thing, and it is worse than a false
 * red: a false red gets investigated, while a false green is indistinguishable
 * from a working check and would have shipped as evidence that the CLI behaves
 * honestly here. Pinning the id removes the only other moving part, so a
 * difference can come from nothing but the flag.
 */
const MUTATION_ID = '019fa297-64e3-7000-8000-0000000000ff';

function a20(extra: readonly string[] = []): string[] {
  return [
    'space', 'interaction-profile', 'set-default', PROFILE,
    '--space', SPACE,
    '--expect-settings-revision', '3',
    '--mutation-id', MUTATION_ID,
    '--yes',
    ...extra,
  ];
}

function bodyOf(): Record<string, unknown> {
  expect(captures.length, 'the recorder captured NOTHING — every negative below would be void').toBeGreaterThan(0);
  return JSON.parse(captures[0]!.body) as Record<string, unknown>;
}

// ── CONTROLS: without both, every negative in this file is void ────────────

describe('CONTROL — the recorder is reached and the body is real', () => {
  /**
   * POSITIVE. A field that is KNOWN to reach the body must appear. Without
   * this, "confirmAgentGenerated is absent" is equally well explained by a
   * recorder pointed at the wrong place, a command that exited before sending,
   * or a body this suite never parsed.
   */
  it('a known-reachable field IS on the wire', async () => {
    const r = await drive(a20());
    measured['control.exit'] = r.code;
    measured['control.stderr'] = r.stderr.trim().slice(0, 300);
    expect(r.code, `A20 did not reach the wire: ${r.stderr}`).toBe(0);

    const body = bodyOf();
    measured['control.bodyKeys'] = Object.keys(body);
    measured['control.body'] = body;
    // `requireGuard(cmd, 'expect-settings-revision')` at teammate.ts:90-98.
    expect(body['expectedSettingsRevision']).toBe(3);
    expect(body['profileId']).toBe(PROFILE);
  });

  /**
   * NEGATIVE. A field that is NOT part of this DTO must not appear, so the
   * assertions below are known to be capable of returning "absent" rather than
   * matching anything the recorder happens to hold.
   */
  it('a field that belongs to no A20 input is NOT on the wire', async () => {
    await drive(a20());
    const body = bodyOf();
    expect(body['expectedVersion']).toBeUndefined();
    expect(body['thisKeyDoesNotExist']).toBeUndefined();
  });
});

// ── THE ASSERTION ─────────────────────────────────────────────────────────

describe('A20 — --confirm-agent-generated past the parser', () => {
  /**
   * ⚠ THE ASSERTION THIS FILE EXISTS FOR, and it asserts the CORRECT behaviour.
   *
   * The whole path exists except the last hop:
   *   DOSSIER:383                  requires confirmAgentGenerated=true when
   *                                generator provenance is present
   *   schemas.ts:1525              confirmAgentGenerated: z.literal(true).optional()
   *                                on SetSpaceProfileDefaultInput
   *   args.ts:56                   'confirm-agent-generated' IS on the kernel's
   *                                boolean allowlist — verified in this tree
   *   027:1208,1225-1227           the SQL raises without it
   *   teammate.ts:127-151          spaceSetDefault NEVER READS IT     <- DIES HERE
   *
   * MECHANISM, not symptom, exactly as the developer asked: this asserts the
   * BODY ON THE WIRE. A symptom-only test ("the command fails") would go green
   * the day someone teaches the CLI to swallow the SQL error, which would be a
   * regression wearing a fix's clothes.
   */
  it('puts confirmAgentGenerated: true in the request body', async () => {
    const r = await drive(a20(['--confirm-agent-generated']));
    measured['withFlag.exit'] = r.code;
    const body = bodyOf();
    measured['withFlag.bodyKeys'] = Object.keys(body);
    measured['withFlag.body'] = body;

    expect(
      body['confirmAgentGenerated'],
      'the flag parsed cleanly and never reached the body: teammate.ts:127-151 does not read it',
    ).toBe(true);
  });

  /**
   * ⚠ THE GUARD ON THE TEST ABOVE — WITHOUT THIS, MY OWN WITNESS IS SATISFIABLE
   * BY THE FIX THAT MUST NOT BE MADE.
   *
   * Raised by Duo E's DEVELOPER while I was writing this file. The tempting
   * one-line "fix" for the red above is to map the EXISTING `--yes` onto
   * `confirmAgentGenerated`, since A20 already requires `--yes`. That would send
   * `confirmAgentGenerated: true` for EVERY caller and silently auto-confirm
   * agent provenance for all of them — DELETING the guard while looking exactly
   * like wiring it up. `--yes` is the 7.5 destructive-action confirmation and it
   * answers a different question.
   *
   * The test above would go GREEN on that change. So it is not sufficient on its
   * own, and this is the assertion that makes it sufficient: with `--yes` present
   * and `--confirm-agent-generated` ABSENT, the field must NOT be on the wire.
   *
   * Same shape as §3g's `018:33` one-word diff: the most reviewable available
   * diff is the one that destroys the protection.
   */
  it('does NOT ride on --yes: the field is absent when only --yes is passed', async () => {
    await drive(a20());
    const body = bodyOf();
    expect(
      body['confirmAgentGenerated'],
      '--yes is leaking into confirmAgentGenerated, which auto-confirms agent provenance for every caller',
    ).toBeUndefined();
  });

  /**
   * ⚠ THE HALF THAT IS INDEFENSIBLE UNDER EITHER RULING, and therefore the more
   * durable finding.
   *
   * A CLI may legitimately not implement a flag. What it may not do is ACCEPT
   * one and discard it, because the caller then cannot tell a flag that did
   * nothing from a flag that did something. There is no unknown-option guard on
   * this module (Duo D's D-2 set), so `--confirm-agent-generated` parses, exits
   * 0, and changes nothing.
   *
   * This test asserts the CORRECT behaviour: the flag must make a difference
   * somewhere observable — either in the body, or in a refusal that names it.
   *
   * ⚠ WHAT THIS CHECK CAN BE SATISFIED BY: any observable difference at all,
   * including a refusal. It deliberately does NOT require the flag to work — it
   * requires the CLI to stop pretending. That is why it survives both rulings.
   *
   * ⚠ AND IT WAS SATISFIED BY THE WRONG THING ONCE ALREADY. See `MUTATION_ID`:
   * without that pin this test passed on a generated-uuid difference. The
   * control that catches it is `withoutBody === withBody` being compared on
   * bodies whose ONLY remaining variable is the flag under test.
   */
  it('is not accepted-and-silently-discarded: the flag changes SOMETHING observable', async () => {
    const without = await drive(a20());
    const withoutBody = captures[0]?.body ?? '';
    const withoutExit = without.code;
    const withoutErr = without.stderr.trim();

    const withFlag = await drive(a20(['--confirm-agent-generated']));
    const withBody = captures[0]?.body ?? '';

    measured['discard.withoutBody'] = withoutBody;
    measured['discard.withBody'] = withBody;
    measured['discard.exits'] = [withoutExit, withFlag.code];

    const identical =
      withoutBody === withBody &&
      withoutExit === withFlag.code &&
      withoutErr === withFlag.stderr.trim();
    measured['discard.identical'] = identical;

    expect(
      identical,
      'passing --confirm-agent-generated produced a BYTE-IDENTICAL request, exit code and stderr: ' +
        'the caller cannot distinguish this flag from a typo',
    ).toBe(false);
  });
});
