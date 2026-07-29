/**
 * W5 · DUO F · TESTER — the RED for Amendment C.
 *
 * `kind update` ADVERTISES `[--yes]` in its frozen syntax. `kind.ts` never reads
 * it, by any accessor. In this codebase `--yes` is the LOCAL destructive-
 * confirmation gate (`entity delete` REFUSES without it —
 * /Users/subhang/Desktop/Projects/tm8/packages/cli/src/commands/entity.ts:597-604),
 * and the frozen syntax places `[--yes]` immediately after `[--allow-tightening]`,
 * the flag that permits a tightening schema change on a live entity kind. So the
 * line READS AS "tightening is gated by --yes". IT IS NOT.
 *
 * Advisor 2's Amendment C ruled the direction: do NOT implement the gate (that
 * breaks every working caller of `--allow-tightening`); use `refuseUnbackedOptions`
 * with a note naming it an ADVERTISED-BUT-UNIMPLEMENTED LOCAL GATE.
 *
 * ═══ THE DISCRIMINATOR, AND IT IS AMENDMENT G'S ═══
 *
 * A real local interlock is observable WITHOUT a wire diff: without it the
 * command exits non-zero and MAKES NO REQUEST. That is the whole difference
 * between `space task-axis delete --yes` (advertised, read, acts as a gate —
 * correct) and `kind update --yes` (advertised, never read — the defect). Same
 * token, opposite verdicts, distinguishable only by driving the module.
 *
 * So this file does NOT assert on a body field. Per Amendment H the honest
 * standard for a local interlock is OBSERVABLE BEHAVIOUR DIFFERS, and the
 * observable chosen here is: DID A REQUEST HAPPEN AT ALL, and was the exit code
 * the same.
 *
 * ═══ WHAT THIS CAN BE SATISFIED BY, before what it asserts ═══
 *  - It is satisfied by `--yes` having NO EFFECT of any kind on this command.
 *    That is exactly the claim. It does NOT prove `--yes` is unread in source —
 *    it proves it is INERT in behaviour, which is the stronger and more useful
 *    statement and the one Ruling 2 asks for.
 *  - It is NOT evidence about any other command, and NOT evidence that
 *    `--allow-tightening` itself behaves correctly.
 *  - THE POSITIVE CONTROL IS SHAPE-MATCHED (§7e): it drives the SAME instrument,
 *    the same runner, the same request recorder, against a command where the
 *    gate DOES exist. A control that merely proved "the recorder records" would
 *    share no shape with the target and could not certify this absence.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { run } from '../../../src/run.js';

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

let server: Server;
let recorded: Recorded[] = [];
let previousBaseUrl: string | undefined;

/** A UUID-shaped id, so nothing is refused for a malformed argument instead. */
const ENTITY_ID = '00000000-0000-7000-8000-000000000042';
const SPACE_ID = '00000000-0000-7000-8000-000000000043';
const MUTATION_ID = '00000000-0000-7000-8000-000000000044';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      recorded.push({
        method: req.method ?? '',
        path: (req.url ?? '').split('?')[0] ?? '',
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
      });
      res.setHeader('content-type', 'application/json');
      res.writeHead(200, { 'x-tm8-request-id': 'req_w5f_yes' });
      res.end(JSON.stringify({ data: {}, requestId: 'req_w5f_yes' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  // EPHEMERAL LOOPBACK ONLY. Never 4610: a live node listens there and booting
  // or mutating against a shared database can retire another seat's session.
  previousBaseUrl = process.env['TM8_BASE_URL'];
  process.env['TM8_BASE_URL'] = `http://127.0.0.1:${port}`;
}, 30_000);

afterAll(async () => {
  if (previousBaseUrl === undefined) delete process.env['TM8_BASE_URL'];
  else process.env['TM8_BASE_URL'] = previousBaseUrl;
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
}, 30_000);

beforeEach(() => {
  recorded = [];
});

describe('W5.F CONTROL — the instrument can SEE a real --yes gate (shape-matched, §7e)', () => {
  it('`entity delete` WITHOUT --yes refuses locally and makes NO request', async () => {
    const code = await run(['entity', 'delete', ENTITY_ID]);
    // entity.ts:597-604 — "is destructive and requires --yes".
    expect(code, 'a real gate refuses non-zero').not.toBe(0);
    expect(
      recorded,
      'a real gate refuses BEFORE the wire — this is the observable that matters',
    ).toHaveLength(0);
  }, 30_000);

  it('`entity delete` WITH --yes passes the gate and DOES reach the wire', async () => {
    const code = await run(['entity', 'delete', ENTITY_ID, '--yes']);
    // The other half: without this, "no request" above would be consistent with
    // the command being broken rather than gated.
    expect(recorded.length, 'passing the gate must reach the wire').toBeGreaterThan(0);
    expect(code).toBe(0);
  }, 30_000);
});

describe('W5.F RED (Amendment C) — `kind update --yes` is advertised and INERT', () => {
  // `c:` prefix is REQUIRED — kind.ts refuses a core kind name locally, which
  // would make every assertion below pass VACUOUSLY (both invocations refused
  // identically for a reason unrelated to --yes). My first fixture used bare
  // 'task' and the ASYMMETRY test below caught it: the "identical behaviour"
  // assertion is satisfied by "both fail identically for an unrelated reason".
  // That is why a pin must assert it reached the world it means to measure.
  const base = [
    'kind', 'update', 'c:task',
    '--space', SPACE_ID,        // requireSpace(cmd.ctx) — kind.ts:126
    '--icon', 'star',           // changes.length must be > 0 — kind.ts:140-145
    '--allow-tightening',
    // PINNED so the two invocations differ ONLY in --yes. Without it
    // resolveMutationId mints a fresh uuid per run (kind.ts:128) and the bodies
    // differ for a reason that has nothing to do with the flag under test —
    // which my body assertion caught before I could mistake it for a finding.
    '--mutation-id', MUTATION_ID,
  ];

  it('DEFECT, PINNED — identical exit code and identical wire traffic with and without --yes', async () => {
    const withoutCode = await run([...base]);
    const withoutTraffic = recorded;
    recorded = [];

    const withCode = await run([...base, '--yes']);
    const withTraffic = recorded;

    // The gate does not exist: nothing about the invocation changes.
    expect(withCode, '--yes changed the exit code').toBe(withoutCode);
    expect(withTraffic.length, '--yes changed whether a request happened').toBe(
      withoutTraffic.length,
    );
    expect(withTraffic.map((r) => `${r.method} ${r.path}`)).toEqual(
      withoutTraffic.map((r) => `${r.method} ${r.path}`),
    );
    // And it never becomes a body field either — so it is inert on BOTH the
    // local axis and the wire axis, which is what "unimplemented" means here.
    expect(
      withTraffic.map((r) => JSON.stringify(r.body)),
      '--yes reached the wire; it is unread locally AND absent from the contract',
    ).toEqual(withoutTraffic.map((r) => JSON.stringify(r.body)));
  }, 30_000);

  it('THE ASYMMETRY, STATED — the same token gates one command and not this one', async () => {
    // This is the sentence Amendment C turns on, made executable. `entity
    // delete` and `kind update` advertise the same flag; only one honours it.
    recorded = [];
    const gatedRefusal = await run(['entity', 'delete', ENTITY_ID]);
    const gatedRequests = recorded.length;

    recorded = [];
    const ungatedCode = await run([...base]);
    const ungatedRequests = recorded.length;

    expect(gatedRefusal, 'entity delete refuses without --yes').not.toBe(0);
    expect(gatedRequests, 'entity delete makes no request without --yes').toBe(0);
    expect(
      ungatedRequests,
      'kind update proceeds to the wire without --yes — the flag gates nothing',
    ).toBeGreaterThan(0);
    expect(ungatedCode).toBe(0);
  }, 30_000);
});
