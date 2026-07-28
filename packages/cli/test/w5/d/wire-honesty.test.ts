/**
 * W5 DUO D — WHAT THE SHIPPED CLI ACTUALLY PUTS ON THE WIRE.
 *
 * ── THE INSTRUMENT, AND WHY IT IS NOT THE REAL SERVER ─────────────────────
 *
 * Every claim in this file is about WHAT THE CLI SENDS, not about what a Server
 * does with it. The correct instrument for that claim is a RECORDING ENDPOINT:
 * it captures the exact JSON body and query string the built binary emits. A
 * real Server would answer, but it would not tell this suite which keys were in
 * the request — and the request IS the subject.
 *
 * SO THIS SUITE MAKES NO CLAIM ABOUT SERVER BEHAVIOUR, and it must never be
 * quoted as real-Server evidence. The duo's real-Server evidence lives in
 * `note-merge-witness.test.ts`, which spawns the actual Server. Two different
 * questions, two different instruments, kept apart on purpose.
 *
 * The binary under test is `packages/cli/dist/index.js` — the artifact an agent
 * invokes. A measurement of source is not a measurement of the artifact.
 *
 * ── BOTH CONTROLS RUN BEFORE ANY VERDICT ─────────────────────────────────
 *
 * A recorder pointed at the wrong URL captures zero bodies, and "no fields
 * reachable" is EXACTLY what that looks like. So a known-reachable field must
 * appear (positive) and a known-unreachable one must not (negative). Without
 * both, every negative result below is void rather than merely weak.
 */
import { vi, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from '../../integration/harness.js';
import { DISCOVERY } from '../../../src/discovery/operations.js';

/**
 * ⚠ EXPLICIT TIMEOUTS FOR BOTH KINDS OF HOOK AND FOR EVERY TEST.
 *
 * vitest ships TWO independent defaults and this suite exceeded BOTH under load:
 *   testTimeout 5s   -> "Test timed out in 5000ms", a NAMED test failure
 *   hookTimeout 10s  -> "Hook timed out in 10000ms", an UNNAMED file-level abort
 * A generous `beforeAll` argument covers NEITHER; they are separate settings.
 *
 * THE FAILURE MODE IS LOAD-SENSITIVE, WHICH IS WHAT MAKES IT DANGEROUS. These
 * tests ran in 1195ms / 1102ms / 507ms at load 13.7 and BLEW A 5s CEILING at
 * load 30.0 — same tree, same binary, same assertions. So it is invisible on an
 * idle machine and fires exactly inside a busy migration gate, where it is
 * attributed to whatever landed rather than to the clock.
 *
 * Each `it` spawns SEVERAL built-CLI child processes against a real Server;
 * `node` start-up alone is most of a second per invocation on a loaded host.
 * Matching the in-tree precedent at `test/integration/inbox.test.ts:39`.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });


const CLI = join(REPO_ROOT, 'packages/cli/dist/index.js');
const ID = '019fa297-64e3-7000-8000-000000000001';

interface Capture { method: string; url: string; body: string }
let server: Server;
let base = '';
let captured: Capture[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      captured.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { id: ID, entity: { id: ID }, items: [], version: 1 }, requestId: 'req_w5d' }));
    });
  });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('recorder did not bind');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => { server.close(() => r()); });
  // ⚠ EXPLICIT, even though this teardown drops no database and kills no child.
  //
  // vitest's hook timeout is 10s by default and `afterAll` is configured
  // INDEPENDENTLY of `beforeAll` — a generous `beforeAll` does not cover it.
  // The two DB-backed suites in this directory hit that and produced a
  // FILE-LEVEL failure carrying NO test name, with every test passing.
  //
  // This file's risk is LOWER but not zero, and the reason is worth stating
  // rather than waving at: `http.Server.close()` stops accepting new
  // connections and then WAITS FOR EXISTING ONES TO END. It does not hang here
  // because every request comes from a CLI child process that exits, closing
  // its socket — but that is a property of the callers, not of `close()`, and
  // it is exactly the kind of premise that holds until it does not.
  //
  // The failure mode being guarded is unnamed, file-level, and LOAD-SENSITIVE,
  // so it is invisible on an idle machine and appears under a busy gate — where
  // it is attributed to whatever else is happening. An explicit timeout costs
  // nothing and removes that from the table.
}, 120_000);

interface Ran { code: number; stderr: string; sent: Capture[] }

/**
 * `TM8_BASE_URL` is set EXPLICITLY, never left to the default.
 * `env.ts` defaults to `http://127.0.0.1:4610`, and a node is frequently
 * listening there on a shared database — a probe that relies on the default
 * sends real traffic at another seat's Server.
 */
async function cli(argv: readonly string[]): Promise<Ran> {
  captured = [];
  return await new Promise((resolve) => {
    const child = spawn('node', [CLI, ...argv], {
      env: { ...process.env, TM8_BASE_URL: base, TM8_SPACE_ID: ID, TM8_ACTOR_ID: ID },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.once('close', (code) => resolve({ code: code ?? -1, stderr, sent: [...captured] }));
  });
}

const bodyKeys = (r: Ran): string[] =>
  [...new Set(r.sent.flatMap((c) => {
    try { return Object.keys(JSON.parse(c.body || '{}') as Record<string, unknown>); } catch { return []; }
  }))].sort();

const bodyValue = (r: Ran, key: string): unknown => {
  for (const c of r.sent) {
    try {
      const parsed = JSON.parse(c.body || '{}') as Record<string, unknown>;
      if (key in parsed) return parsed[key];
    } catch { /* non-JSON body */ }
  }
  return undefined;
};

describe('INSTRUMENT CONTROLS — these run first, and every result below depends on them', () => {
  it('POSITIVE: a field carried by a DIFFERENTLY-SPELLED flag reaches the wire', async () => {
    // `--by` carries `completerIds`. If this fails the recorder is not
    // recording, and every "field absent" assertion in this file is void
    // rather than informative.
    const r = await cli(['task', 'complete', ID, '--expect-version', '1', '--by', ID]);
    expect(bodyKeys(r)).toContain('completerIds');
    expect(bodyValue(r, 'completerIds')).toEqual([ID]);
  });

  it('NEGATIVE: a field measured unreachable does NOT appear (the recorder invents nothing)', async () => {
    const r = await cli(['task', 'transition', ID, 'working']);
    expect(bodyKeys(r)).toContain('status');
    expect(bodyKeys(r)).not.toContain('note');
  });
});

/**
 * ⚠ FINDING D-2 — 65 of 99 commands SILENTLY DISCARD AN UNKNOWN FLAG.
 *
 * `entity.ts`'s own module header names this hazard by example and explains
 * why it is the one an agent cannot survive:
 *
 *   "a command that simply ignores what it does not recognize turns
 *    `--assigne <id>` into an unfiltered query and `--sort position` into a
 *    silently unsorted page. Both LOOK like success. Refusing is the only
 *    outcome an agent can act on."
 *
 * The guard exists, is correct, and is EXPORTED as `assertKnownOptions`.
 * Sixteen of twenty-one modules never call it. THE COMMENT PREVENTS THE BUG IN
 * THE FILE IT IS WRITTEN IN AND NOWHERE ELSE.
 *
 * ── WHY AN EXACT SET AND NOT A COUNT ─────────────────────────────────────
 *
 * A count cannot detect a pairing error, because a transposition is
 * count-preserving. An EXACT SET goes red in BOTH directions: a NEW command
 * that starts ignoring flags fails, AND fixing one without delisting it here
 * also fails. The second half is the one that matters — it is what stops this
 * assertion from silently ceasing to test anything as the defect is repaired.
 */
describe('FINDING D-2 — which commands refuse an unknown flag, as an EXACT SET', () => {
  /**
   * The commands that DO guard, measured. Every one belongs to a module that
   * calls `assertKnownOptions`: entity.ts, task.ts, graph.ts, tracking.ts,
   * undo.ts — five of twenty-one.
   *
   * ⚠ IF YOU ARE HERE BECAUSE THIS WENT RED: do not "update the list" reflexively.
   *   A command ADDED here = a module gained the guard. Good — delete it from the
   *   defect's tally and record the before/after.
   *   A command REMOVED here = a guard was LOST. That is a regression and the
   *   red is the point.
   */
  const GUARDED = [
    'entity activity', 'entity children', 'entity delete', 'entity feed', 'entity get',
    'entity move', 'entity point grant', 'entity pull', 'entity query', 'entity react',
    'entity restore', 'entity update', 'entity versions', 'graph query',
    'task complete', 'task link-commit', 'task link-pr', 'task transition',
    'tracking refresh', 'undo apply',
  ] as const;

  it('the guarded set is EXACTLY these commands — red if one is gained OR lost', async () => {
    // Only commands whose clean invocation reaches the wire can be classified;
    // one that fails for its own reasons would otherwise be scored as guarded.
    const measured: string[] = [];
    for (const path of GUARDED) {
      const r = await cli([...path.split(' '), '--w5d-not-a-real-flag', 'x']);
      if (r.code === 2 && r.stderr.includes('w5d-not-a-real-flag')) measured.push(path);
    }
    expect(measured.sort()).toEqual([...GUARDED].sort());
  }, 120_000);

  /**
   * The other half of the detector, and the half that carries the finding: a
   * representative unguarded command must still be UNGUARDED. When someone
   * fixes D-2, THIS goes red and points them at the exact-set list above.
   *
   * `edge list` is chosen deliberately over a write command: its silent ignore
   * produces a WRONG ANSWER rather than a lost field.
   */
  it('UNGUARDED WITNESS — `edge list` drops an unknown flag and still answers (red when D-2 is fixed)', async () => {
    const good = await cli(['edge', 'list', ID, '--direction', 'outgoing']);
    expect(good.sent[0]?.url, 'positive control: the real flag must reach the query string')
      .toContain('direction=outgoing');

    const typo = await cli(['edge', 'list', ID, '--directon', 'outgoing']);
    expect(typo.code, 'exit 0 — the typo did not stop the command').toBe(0);
    expect(typo.sent.length, 'the request was still sent').toBe(1);
    expect(
      typo.sent[0]?.url,
      'THE FINDING: a typo of --direction yields an UNFILTERED query at exit 0. ' +
        'The agent asked for outgoing edges and received all of them, reported as success.',
    ).not.toContain('direction');
  });
});

/**
 * ⚠ FINDING D-3 — `project update --repo-url` WORKS AND IS NOT ADVERTISED.
 *
 * Three surfaces disagree about one flag:
 *   the frozen syntax in `discovery/operations.ts`  — does NOT name it
 *   `project.ts:248`'s own error hint               — DOES name it
 *   `project.ts:237`'s implementation               — ACCEPTS it
 *
 * A capability that exists, works, handles the `|none>` idiom correctly, and is
 * discoverable ONLY BY MAKING A MISTAKE. This is the `note` defect pointing the
 * other way: `note` is declared and unreachable; `repoUrl` is reachable and
 * undeclared.
 */
describe('FINDING D-3 — a working flag the frozen syntax does not advertise', () => {
  it('the frozen syntax for `project update` does NOT name --repo-url (red when the projection is corrected)', () => {
    const row = DISCOVERY.find((d) => d.operation === 'projects.update');
    expect(row?.syntax, 'sanity: the row must exist before its absence means anything').toBeTypeOf('string');
    expect(
      row?.syntax,
      'When --repo-url is added to the advertised syntax this goes RED — which is correct, and is ' +
        'the signal to retire this finding rather than to loosen the assertion.',
    ).not.toContain('--repo-url');
  });

  it('but the shipped binary ACCEPTS it and puts repoUrl on the wire', async () => {
    const r = await cli(['project', 'update', ID, '--repo-url', 'https://example.invalid/r']);
    expect(r.code).toBe(0);
    expect(bodyValue(r, 'repoUrl')).toBe('https://example.invalid/r');
  });

  it('and it honours the `<value|none>` idiom — `none` becomes JSON null, not the string', async () => {
    const r = await cli(['project', 'update', ID, '--repo-url', 'none']);
    expect(r.code).toBe(0);
    expect(bodyValue(r, 'repoUrl')).toBeNull();
  });
});

/**
 * The `<value|none>` idiom, verified ON THE WIRE across this duo's modules.
 *
 * This is the measured DISPROOF of the coordinator's §7 lead, which suspected —
 * from a name grep that was silently blind to `entity.ts` — that the literal
 * string `"none"` might be sent as an entity id. It is not, anywhere.
 *
 * BOTH HALVES: `none` must become null AND a real value must survive unchanged.
 * A helper that returned null for everything would pass the first half alone.
 */
describe('the `<value|none>` idiom reaches the wire as JSON null — never the string "none"', () => {
  const CASES: ReadonlyArray<{ label: string; argv: string[]; field: string }> = [
    { label: 'entity create --parent none', field: 'parentId',
      argv: ['entity', 'create', 'task', 'w5d', '--parent', 'none'] },
    { label: 'entity move --parent none', field: 'parentId',
      argv: ['entity', 'move', ID, '--parent', 'none', '--position', '1', '--expect-version', '1'] },
    { label: 'space update --github-repo none', field: 'githubRepo',
      argv: ['space', 'update', ID, '--github-repo', 'none'] },
    { label: 'space invite create --expires-at none', field: 'expiresAt',
      argv: ['space', 'invite', 'create', '--expires-at', 'none'] },
  ];

  for (const c of CASES) {
    it(`${c.label} -> ${c.field}: null`, async () => {
      const r = await cli(c.argv);
      expect(r.code, r.stderr).toBe(0);
      expect(bodyValue(r, c.field)).toBeNull();
    });
  }

  it('POSITIVE HALF — a real value survives unchanged (a helper nulling everything would pass above)', async () => {
    const r = await cli(['entity', 'create', 'task', 'w5d', '--parent', ID]);
    expect(bodyValue(r, 'parentId')).toBe(ID);
  });

  /**
   * One advertised `|none>` that the command REFUSES — and the refusal is
   * correct, so the SYNTAX LINE is the defect rather than the behaviour.
   * `CorrectProjectAssociationInput` requires a `projectId`; the repair is
   * scoped to one association rather than a generic edge delete.
   */
  it('`project association correct --project none` is REFUSED — so the advertised |none> is wrong, not the code', async () => {
    const r = await cli(['project', 'association', 'correct', ID, '--project', 'none', '--expect-version', '1']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('has no binding');
    expect(r.sent.length, 'nothing may reach the wire on a local refusal').toBe(0);
  });
});
