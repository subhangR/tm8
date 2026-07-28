/**
 * W5 DUO E — E-3: `session spawn` CANNOT EXPRESS `model`, `agentTool` OR `title`.
 *
 * ── THE CLAIM, AND THE CLI IS THE ONLY NARROW POINT ───────────────────────
 *
 * Every layer below the CLI carries these three. Verified in the tree for this
 * file rather than inherited:
 *
 *   schemas.ts:1216-1218   ExecutionSpawnInputSchema declares
 *                          `model: z.string().nullable().optional()`,
 *                          `agentTool: …`, `title: z.string().optional()`
 *   execution-handlers.ts:577-579  the handler passes all three into SpawnRequest
 *   manifest.ts:112        `request.model` is FIRST in the resolution chain,
 *                          ahead of the persona's
 *   commands/session.ts    reads NONE of the three — zero occurrences
 *
 * ⚠ THAT ORDERING MATTERS AND IS WHY THIS IS WORTH A WITNESS. This is the
 * INVERSE of the `037` inert-fix shape, where a correct repair was undone by a
 * narrow point ABOVE it. Here the whole path is built and the narrow point is
 * the outermost layer — so the capability exists end to end and no caller can
 * reach it. Found by Duo E's DEVELOPER, which checked the far end FIRST for
 * exactly that reason.
 *
 * ── ⚠ WHAT THIS FILE DELIBERATELY DOES NOT ASSERT ─────────────────────────
 *
 * IT ASSERTS ONLY THE PLAIN VALUE FORM: `--model <x>` must put `model: "<x>"`
 * on the wire.
 *
 * It does NOT pin `--model none` -> `model: null`. `manifest.ts:112` resolves
 * with `||`, so `null` and ABSENT are indistinguishable there and a `none`
 * would fall through to `member.model` rather than to any default. Pinning the
 * advertised `|none>` meaning would therefore pin a behaviour NOBODY HAS RULED
 * ON, and the `|none>` idiom is itself unsettled (three distinct spellings
 * across the package). My developer flagged this before I wrote a line of it.
 *
 * ── THE INSTRUMENT ────────────────────────────────────────────────────────
 *
 * A RECORDING ENDPOINT against the BUILT binary, because the claim is about
 * what the CLI SENDS. A real Server would answer without telling this suite
 * which keys were in the request, and the request IS the subject.
 * **THIS SUITE MAKES NO CLAIM ABOUT SERVER BEHAVIOUR.** The server-side
 * citations above are READ, not measured here.
 *
 * ── DISPOSITION (§3d), AUTHORED NOW ───────────────────────────────────────
 *
 * PRODUCTION-STATE pin, so it ships with one. Whether teaching the CLI three
 * flags the frozen contract already declares is RESTORATION or INVENTION is a
 * coordinator ruling that has NOT been given. The A20 precedent went
 * RESTORATION on a field the kernel already allowlisted; these three are NOT
 * allowlisted, so that precedent does not transfer and I am not borrowing its
 * conclusion without its premise.
 *
 *   IF RESTORATION — tests 3-5 green ON THEIR OWN when the flags are wired.
 *   Their last scheduled act; they assert the correct behaviour and were never
 *   softened. Test 6 (the silent-discard harm) must then be INVERTED BY HAND —
 *   and unlike the A20 file's disposition, WHICH I GOT WRONG, I have checked:
 *   test 6 asserts `identical === true`, i.e. it asserts THE DEFECT, because
 *   here the defect IS the indistinguishability. It is the one test in this
 *   file that does not self-invert.
 *
 *   IF INVENTION — tests 3-5's premise EXPIRES and is RECORDED AS EXPIRED,
 *   never re-pinned to pass. Test 6 becomes primary: accepted-and-silently-
 *   discarded is indefensible under either ruling.
 *
 * Tests 1-2 are controls and stay green in both worlds.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from '../../integration/harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const CLI = join(REPO_ROOT, 'packages/cli/dist/index.js');
const SPACE = '019fa297-64e3-7000-8000-000000000010';
const TEAMMATE = '019fa297-64e3-7000-8000-000000000012';
const MUT = '019fa297-64e3-7000-8000-0000000000ff';

interface Capture { body: string }

let server: Server;
let base = '';
let captures: Capture[] = [];
const measured: Record<string, unknown> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      captures.push({ body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { sessionId: TEAMMATE } }));
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
  console.log('[w5-e][spawn-unexpressible]', JSON.stringify(measured, null, 2));
});

async function drive(extra: readonly string[] = []): Promise<{ code: number; stderr: string }> {
  captures = [];
  const argv = [
    'session', 'spawn',
    '--space', SPACE,
    '--teammate', TEAMMATE,
    '--mutation-id', MUT,
    ...extra,
  ];
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

function bodyOf(): Record<string, unknown> {
  expect(captures.length, 'the recorder captured NOTHING — every negative here would be void').toBeGreaterThan(0);
  return JSON.parse(captures[0]!.body) as Record<string, unknown>;
}

// ── CONTROLS ──────────────────────────────────────────────────────────────

describe('CONTROL — the recorder is reached and the body is real', () => {
  it('a known-reachable field IS on the wire', async () => {
    const r = await drive(['--mode', 'worker']);
    measured['control.exit'] = r.code;
    if (r.code !== 0) measured['control.stderr'] = r.stderr.trim().slice(0, 300);
    expect(r.code, `spawn did not reach the wire: ${r.stderr}`).toBe(0);

    const body = bodyOf();
    measured['control.bodyKeys'] = Object.keys(body);
    measured['control.body'] = body;
    expect(body['mode']).toBe('worker');
    expect(body['teamMemberId']).toBe(TEAMMATE);
  });

  /**
   * A SECOND positive control on the SAME optional-field mechanism the three
   * flags under test would use — `--context` reaches `promptExtra`
   * (`packages/cli/src/commands/session.ts:143`). It proves the body-building
   * path for OPTIONAL spawn fields works, so a missing `model` cannot be blamed
   * on that path being broken generally. This is the difference between "these
   * three are missing" and "optional spawn fields don't work".
   *
   * ⚠ THE VALUE IS A BARE STRING, AND MY FIRST VERSION GOT THIS WRONG.
   * I passed `literal:hello` expecting the prefix to be stripped. It is not:
   * `parseSource` (`packages/cli/src/args.ts:412-419`) recognises exactly two
   * forms — `-` for stdin and `@path` for a file — and treats EVERYTHING ELSE
   * as an inline literal. So `literal:` was my own invention and the CLI was
   * correctly round-tripping it. The control failed on my expectation while the
   * mechanism it exists to prove was working the whole time.
   */
  it('another OPTIONAL spawn field reaches the wire — the mechanism is not broken', async () => {
    const r = await drive(['--context', 'hello']);
    measured['control.promptExtra.exit'] = r.code;
    const body = bodyOf();
    measured['control.promptExtra.body'] = body;
    expect(r.code, r.stderr).toBe(0);
    expect(body['promptExtra'], '--context -> promptExtra is the working comparator').toBe('hello');
  });
});

// ── THE ASSERTIONS ────────────────────────────────────────────────────────

const UNEXPRESSIBLE = [
  { field: 'model', flag: '--model', value: 'claude-opus-5', where: 'schemas.ts:1216 · manifest.ts:112' },
  { field: 'agentTool', flag: '--agent-tool', value: 'claude-code', where: 'schemas.ts:1217' },
  { field: 'title', flag: '--title', value: 'W5E spawn title', where: 'schemas.ts:1218' },
];

describe('E-3 — three frozen-contract fields no caller can reach', () => {
  for (const row of UNEXPRESSIBLE) {
    it(`${row.flag} <value> puts ${row.field} on the wire (${row.where})`, async () => {
      const r = await drive([row.flag, row.value]);
      const body = bodyOf();
      measured[`e3.${row.field}.exit`] = r.code;
      measured[`e3.${row.field}.bodyKeys`] = Object.keys(body);

      expect(
        body[row.field],
        `${row.flag} parsed and never reached the body: commands/session.ts reads no '${row.field}'`,
      ).toBe(row.value);
    });
  }

  /**
   * ⚠ THE HARM, AND IT IS INDEFENSIBLE UNDER EITHER RULING.
   *
   * A CLI may legitimately not implement a flag. What it may not do is ACCEPT
   * one and discard it — the caller then cannot tell a flag that did nothing
   * from a flag that did something, or from a typo. `session.ts` has no
   * unknown-option guard, so all three parse, exit 0, and change nothing.
   *
   * ⚠ THIS TEST ASSERTS THE DEFECT, NOT THE FIX, AND THAT IS DELIBERATE — it is
   * the one test here that will NOT self-invert. See the header disposition.
   * It is written this way because the indistinguishability IS the harm, and a
   * test asserting "the flags change something" would go green the day someone
   * makes the CLI merely ERROR on them, which is a different outcome.
   *
   * ⚠ WHAT IT CAN BE SATISFIED BY: `--mutation-id` is PINNED, so a generated id
   * cannot manufacture a difference. That pin exists because an unpinned one
   * produced a FALSE GREEN in this duo's A20 file — the bodies always differed
   * and the test reported the flag as effective. Do not remove it.
   */
  it('all three are accepted and silently discarded — byte-identical to omitting them', async () => {
    const without = await drive();
    const withoutBody = captures[0]?.body ?? '';

    const withAll = await drive([
      '--model', 'claude-opus-5',
      '--agent-tool', 'claude-code',
      '--title', 'W5E spawn title',
    ]);
    const withBody = captures[0]?.body ?? '';

    measured['harm.withoutBody'] = withoutBody;
    measured['harm.withBody'] = withBody;
    measured['harm.exits'] = [without.code, withAll.code];

    const identical = withoutBody === withBody && without.code === withAll.code;
    measured['harm.identical'] = identical;

    expect(
      identical,
      'if this is FALSE the flags now reach the wire — see the header disposition, this test must be inverted by hand',
    ).toBe(true);
  });
});
