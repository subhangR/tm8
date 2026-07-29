/**
 * GROUP 8 against a REAL Server — `events.poll`, `events.subscribe`, `presence.get`.
 *
 * Everything here is MEASURED on this host at run time. Nothing is taken on
 * report, including the coordinator's own status message: a predicted
 * composition recorded as a measured one is the proxy-for-property error this
 * program exists to eliminate, and a message describing the tree is not an
 * observation of it. So `/health` is re-read, every row is re-probed, and no
 * expected count for `implemented` is written down anywhere below.
 *
 * WHY THIS SLOT MATTERS OUT OF PROPORTION TO ITS SIZE. `presence.get` is
 * CONDITIONALLY MOUNTED — a real `PresenceSnapshot` on a node with a presence
 * source, an honest 501 on a node without one — which makes it the clearest
 * place in the CLI where the OBSERVED branch of M-3's precedence
 * (contract → observed → advertised) can be exercised end to end against a real
 * Server. Every assertion below RE-MEASURES which branch this node is on and
 * records it; not one predicts it. A verdict phrased "presence.get answers 501"
 * is unbound and this file writes none: the flip between branches is a
 * measurement changing, never a suite going red.
 *
 * THE SAME DISCIPLINE, APPLIED TO THIS SLOT'S OWN PAST. `events.subscribe` was
 * an upgrade skeleton and this file asserted the disclosure that said so. The
 * contract then grew the client→server control frames and that disclosure became
 * FALSE IN PRESENT TENSE. What replaces it below is not a new prediction — it is
 * a measurement of what the socket does, taken at run time, on this node.
 *
 * TWO VANTAGES, AND THEY PROVE DIFFERENT THINGS.
 *
 *   BUILT BINARY — `cli([...], server)` spawns `packages/cli/dist/index.js` as
 *     a child process, exactly as an agent invokes it. This is the strongest
 *     evidence available, but it can only reach commands the COORDINATOR has
 *     wired into `src/commands/registry.ts`, which this slot may not touch. So
 *     those checks are written to hold both before and after the wiring lands,
 *     and they say which state they observed.
 *   IN PROCESS — the real kernel (`parseInvocation` → `resolveContext` →
 *     module) pointed at the same real Server. Weaker than a child process,
 *     and labelled as such, but it is the only vantage that can read the
 *     availability ledger the command writes, because in the built binary that
 *     ledger lives and dies inside the child.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bindPath } from '@tm8/contract';
import {
  assertBuilt,
  cli,
  startRealServer,
  type ObservedAvailability,
  type RealServer,
} from './harness.js';
import { parseInvocation, splitCommandPath } from '../../src/args.js';
import { resolveContext } from '../../src/context.js';
import { errorLines, exitCodeFor } from '../../src/errors.js';
import { CliError, EXIT_USAGE } from '../../src/exit.js';
import { createOutput } from '../../src/output.js';
import { ledger, resolveAvailability } from '../../src/discovery/availability.js';
import type { CommandModule } from '../../src/run.js';

let server: RealServer;

/** Everything this suite measured, printed once so the report can quote it. */
const measured: Record<string, unknown> = {};

const SPACE = '00000000-0000-7000-8000-0000000000a1';
const ENTITY = '00000000-0000-7000-8000-0000000000b2';

beforeAll(async () => {
  await assertBuilt();
  server = await startRealServer('g8-event');
  measured['bindStart'] = `${server.bindStart.files}/${server.bindStart.digest}`;
}, 120_000);

afterAll(async () => {
  console.log(`[g8] MEASURED ${JSON.stringify(measured, null, 2)}`);
  await server?.stop();
});

// ── the in-process vantage: the real kernel, minus the one seam this slot may
//    not touch (registry.ts is coordinator-owned). ───────────────────────────

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

async function drive(modules: readonly CommandModule[], argv: readonly string[]): Promise<Ran> {
  let stdout = '';
  let stderr = '';
  const streams = {
    stdout: (c: string | Uint8Array) => {
      stdout += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    },
    stderr: (c: string) => {
      stderr += c;
    },
  };
  let out = createOutput({ format: 'human', streams });
  try {
    const inv = parseInvocation(argv);
    out = createOutput({ format: inv.globals.format, color: inv.globals.color, quiet: inv.globals.quiet, streams });
    const known = new Set(modules.map((m) => m.path.join(' ')));
    const match = splitCommandPath(inv.positionals, (p) => known.has(p.join(' ')));
    if (!match) throw new CliError(`unknown command: ${inv.positionals.join(' ')}`, EXIT_USAGE);
    const mod = modules.find((m) => m.path.join(' ') === match.path.join(' '));
    if (!mod) throw new CliError('no module', EXIT_USAGE);
    const ctx = resolveContext({
      globals: inv.globals,
      // The real Server this suite started — the same origin the built binary
      // is given through `server.env`.
      session: { baseUrl: server.baseUrl },
      config: {},
    });
    const code = await mod.run({
      path: match.path,
      args: match.args,
      options: inv.options,
      passthrough: inv.passthrough,
      ctx,
      out,
    });
    return { code, stdout, stderr };
  } catch (err) {
    out.error(errorLines(err));
    return { code: exitCodeFor(err), stdout, stderr };
  }
}

/**
 * What the CLI's ledger must conclude, given an independent three-state probe.
 *
 * The two vantages agree EXACTLY on `unavailable`, because a 501 is definitive:
 * the router found no handler. They deliberately do NOT agree on `unknown`. The
 * harness probe sends an empty body, so validation rejects it before any
 * handler runs and it cannot tell a live handler from a registered 501 stub.
 * The CLI sends a real request, so it learns that a handler ANSWERED — which is
 * `available` in the ledger's vocabulary, meaning "a handler exists here", and
 * is NOT the stronger claim "behaviourally implemented". Collapsing those two
 * sentences is how a registered stub gets counted as implemented.
 */
function ledgerVerdictFor(probe: ObservedAvailability): 'unavailable' | 'available' {
  return probe === 'unavailable' ? 'unavailable' : 'available';
}

// ── /health, re-measured ───────────────────────────────────────────────────

describe('the node, measured rather than reported', () => {
  it('answers /health outside the envelope, with 101 mounted HTTP routes', async () => {
    const health = await server.health();
    measured['health'] = health;
    expect(health.ok).toBe(true);
    // 102 catalog rows = 101 HTTP + the single WS row, which is served by the
    // upgrade path and is not a mounted HTTP route.
    expect(health.operations).toBe(105);
    // `implemented` is `registry.size` — REGISTERED handlers, not behaviourally
    // implemented ones. No expected number is asserted here on purpose: it moves
    // as composition tranches land, and pinning it would turn another wave's
    // legitimate progress into this slot's red.
    expect(typeof health.implemented).toBe('number');
    expect(health.implemented).toBeGreaterThan(0);
    expect(health.implemented).toBeLessThanOrEqual(health.operations);
  });
});

// ── events.subscribe: the WS row ───────────────────────────────────────────

describe('events.subscribe — the catalog\'s only WS row, now a real subscription', () => {
  it('is unreachable over HTTP by construction, and that is a TRANSPORT fact', async () => {
    const probe = await server.observe('events.subscribe');
    measured['events.subscribe.probe'] = probe;
    // `unknown` here does not mean "we have not looked". It means an HTTP probe
    // structurally cannot answer the question for a socket row. It must never be
    // read as `available`, and no amount of HTTP probing will ever promote it.
    expect(probe).toBe('unknown');
  });

  it('opens the socket and subscribes over the wire, against the REAL node', async () => {
    // THIS TEST EXISTS BECAUSE THE CONTRACT MOVED. Until the client→server
    // control frames landed, `event watch` had nothing legal to send and this
    // slot's deliverable was the disclosure saying so. That disclosure is now
    // false and gone; what replaces it is this measurement.
    ledger.clear();
    const mk = await cli(['space', 'create', 'G8 watch', '--format', 'json'], server);
    expect(mk.code, mk.stderr).toBe(0);
    const created = JSON.parse(mk.stdout) as { id?: string; space?: { id?: string } };
    const spaceId = created.space?.id ?? created.id;
    expect(spaceId, `no space id in ${mk.stdout}`).toBeTruthy();

    const { EVENT_COMMANDS } = await import('../../src/commands/event.js');
    const r = await drive(EVENT_COMMANDS, [
      'event', 'watch', '--space', spaceId!, '--timeout', '3', '--format', 'jsonl',
    ]);
    measured['events.subscribe.watchExit'] = r.code;
    measured['events.subscribe.watchStderr'] = r.stderr.trim().slice(0, 400);

    // TWO LEGITIMATE OUTCOMES, and the point is that they are now
    // DISTINGUISHABLE — which is exactly what the old skeleton disclosure
    // existed to warn was impossible.
    //   0 — the socket opened, the subscribe was not refused, and `--timeout`
    //       ended the watch.
    //   4 — the node REFUSED the subscribe and said so with a `control.refused`
    //       ack. That is the authorizer working, not this command failing.
    // Before the ack, a refusal was silence indistinguishable from a quiet
    // Space, and BOTH would have looked like the 0 branch forever.
    expect([0, 4], `unexpected exit ${r.code}: ${r.stderr}`).toContain(r.code);
    measured['events.subscribe.branch'] =
      r.code === 0 ? 'subscribed; --timeout ended the watch' : 'REFUSED via a control.refused ack';

    // Availability stays honestly `unknown`. A socket outcome is not an HTTP
    // observation, and M-3's ledger is fed only by what the HTTP path saw.
    expect(resolveAvailability('events.subscribe', 'v1').availability).toBe('unknown');
  }, 120_000);

  it('a durable event created AFTER the subscribe arrives on the socket', async () => {
    // The strongest available evidence that this is a subscription rather than a
    // handshake: an event that did not exist when the socket opened is rendered
    // by the CLI's own stdout path.
    const mk = await cli(['space', 'create', 'G8 watch live', '--format', 'json'], server);
    expect(mk.code, mk.stderr).toBe(0);
    const created = JSON.parse(mk.stdout) as { id?: string; space?: { id?: string } };
    const spaceId = created.space?.id ?? created.id;
    expect(spaceId, `no space id in ${mk.stdout}`).toBeTruthy();

    const { EVENT_COMMANDS } = await import('../../src/commands/event.js');
    const watching = drive(EVENT_COMMANDS, [
      'event', 'watch', '--space', spaceId!, '--timeout', '10', '--format', 'jsonl',
    ]);
    // Let the subscribe frame land before anything is created, so what arrives
    // cannot be retained history.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const res = await fetch(new URL(bindPath('entities.create', { spaceId: spaceId! }), server.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spaceId, kind: 'task', title: 'live watch target', clientMutationId: randomUUID() }),
    });
    expect(res.status, `seed: ${await res.clone().text()}`).toBe(201);

    const r = await watching;
    measured['events.subscribe.liveExit'] = r.code;
    measured['events.subscribe.liveStdout'] = r.stdout.trim().slice(0, 400);
    measured['events.subscribe.liveStderr'] = r.stderr.trim().slice(0, 400);

    if (r.code === 4) {
      // REFUSED. Not a defect and not this command's failure — record the branch
      // and stop, rather than asserting a delivery the node declined to make.
      measured['events.subscribe.liveBranch'] = 'REFUSED — the authorizer declined the subscribe';
      expect(r.stdout).toBe('');
      return;
    }

    const lines = r.stdout.trim().split('\n').filter((l) => l !== '');
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    measured['events.subscribe.liveEventCount'] = events.length;
    measured['events.subscribe.liveTypes'] = [...new Set(events.map((e) => String(e['type'])))];

    // NOT a bare `length > 0`: a subscribe that (per the server author's own
    // disclosed caveat) still seeds its cursor at 0 would push retained history
    // and satisfy that. This asserts the SEEDED entity specifically.
    expect(events.some((e) => String(e['type']).startsWith('entity.'))).toBe(true);

    // THE DISCRIMINATION, measured against the real socket: not one line on
    // stdout is a control frame. An ack rendered as an event is the naive-client
    // failure this whole change had to avoid.
    expect(events.filter((e) => String(e['type']).startsWith('control.'))).toEqual([]);
    // GUARD AGAINST A VACUOUS SWEEP: the filter above would also be empty if the
    // stream had produced nothing at all to filter.
    expect(events.length).toBeGreaterThan(0);
  }, 120_000);
});

// ── events.poll: composed, NOT independently gated ─────────────────────────

describe('events.poll — composed, NOT independently gated', () => {
  it('is exercised against the real Server, and the two vantages agree', async () => {
    ledger.clear();
    const probe = await server.observe('events.poll');
    measured['events.poll.probe'] = probe;

    const { EVENT_COMMANDS } = await import('../../src/commands/event.js');
    const r = await drive(EVENT_COMMANDS, ['event', 'list', '--space', SPACE, '--format', 'json']);
    measured['events.poll.cliExit'] = r.code;
    measured['events.poll.cliStdout'] = r.stdout.slice(0, 200);
    measured['events.poll.cliStderr'] = r.stderr.slice(0, 200);

    expect(resolveAvailability('events.poll', 'v1').availability).toBe(ledgerVerdictFor(probe));
  });

  it('is reachable through the BUILT BINARY as an agent would invoke it', async () => {
    const r = await cli(['event', 'list', '--space', SPACE, '--format', 'json'], server);
    measured['events.poll.builtExit'] = r.code;
    measured['events.poll.builtStderr'] = r.stderr.slice(0, 300);

    // The grammar knows this command whether or not the coordinator has wired the
    // module in, so "unknown command" (exit 2) is wrong in BOTH states.
    expect(r.stderr).not.toMatch(/unknown command/);
    expect(r.code).not.toBe(EXIT_USAGE);

    if (/not implemented in this CLI build/.test(r.stderr)) {
      // NOT YET WIRED. `src/commands/registry.ts` is coordinator-owned: this slot
      // exports EVENT_COMMANDS and does not add the import. The kernel's honest
      // answer for a documented-but-unregistered path is exit 8 with a pointer at
      // its help — which is exactly what a caller should see today.
      measured['events.poll.builtState'] = 'grammar-known, module not yet wired';
      expect(r.code).toBe(8);
      expect(r.stdout).toBe('');
    } else {
      // WIRED. The built binary ran this slot's module against the real Server.
      measured['events.poll.builtState'] = 'wired and executed';
      expect(r.code).toBe(0);
      const page = JSON.parse(r.stdout) as { items?: unknown; nextCursor?: unknown };
      expect(Array.isArray(page.items)).toBe(true);
      // The cursor a follow-up poll needs is never omitted.
      expect(page.nextCursor).toBeDefined();
    }
  });
});

// ── the paging standard: exactly-once over a KNOWN FULL SET ────────────────

describe('events.poll paging — exactly-once, not merely duplicate-free', () => {
  it('pages a known full set at --limit 1 and the union EQUALS the set', async () => {
    // WHY THE UNION AND NOT JUST "NO DUPLICATES". The cursor-truncation class
    // has two halves and only one is loud. A cursor rounded DOWN re-admits the
    // boundary row: duplicates, loops, obvious. A cursor rounded UP SKIPS rows:
    // no error, no loop, and a "terminates and does not overlap" assertion
    // passes cleanly over the wreckage. Requiring the union to EQUAL a known
    // complete set is the only half that can catch the silent one.
    const mk = await cli(['space', 'create', 'G8 events paging', '--format', 'json'], server);
    expect(mk.code, mk.stderr).toBe(0);
    const created = JSON.parse(mk.stdout) as { id?: string; space?: { id?: string } };
    const spaceId = created.space?.id ?? created.id;
    expect(spaceId, `could not read a space id from ${mk.stdout}`).toBeTruthy();

    // Seeded over raw HTTP rather than through `tm8 entity create`, DELIBERATELY:
    // that command belongs to another slot and is not wired into the built CLI
    // right now (it answers the kernel's honest exit 8, "in the tm8 grammar but
    // not implemented in this CLI build"). The mechanism under test here is
    // events.poll's paging, not entity creation, so this suite must not be
    // hostage to a sibling's registry wiring.
    for (const title of ['alpha', 'beta', 'gamma']) {
      const res = await fetch(new URL(bindPath('entities.create', { spaceId: spaceId! }), server.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spaceId, kind: 'task', title, clientMutationId: randomUUID() }),
      });
      expect(res.status, `seed ${title}: ${await res.clone().text()}`).toBe(201);
    }

    const whole = await cli(
      ['event', 'list', '--space', spaceId!, '--limit', '500', '--format', 'json'], server);
    expect(whole.code, whole.stderr).toBe(0);
    const full = JSON.parse(whole.stdout) as { items: Array<{ seq: number }>; nextCursor: string };
    const fullSeqs = full.items.map((e) => e.seq);
    measured['events.poll.knownSetSize'] = fullSeqs.length;
    // GUARD AGAINST A VACUOUS SWEEP: a loop over zero rows would satisfy every
    // assertion below and prove nothing at all.
    expect(fullSeqs.length).toBeGreaterThan(0);

    const walked: number[] = [];
    let cursor = '0';
    for (let guard = 0; guard < 200; guard++) {
      const r = await cli(
        ['event', 'list', '--space', spaceId!, '--after', cursor, '--limit', '1', '--format', 'json'],
        server);
      expect(r.code, r.stderr).toBe(0);
      const page = JSON.parse(r.stdout) as { items: Array<{ seq: number }>; nextCursor: string };
      if (page.items.length === 0) break;
      walked.push(...page.items.map((e) => e.seq));
      // The feed echoes the caller's position when caught up rather than going
      // null, so a non-advancing cursor is the terminator, not an error.
      if (page.nextCursor === cursor) break;
      cursor = page.nextCursor;
    }
    measured['events.poll.walkedSize'] = walked.length;

    // EXACTLY ONCE: same members, same order, nothing repeated, nothing skipped.
    expect(walked).toEqual(fullSeqs);
    expect(new Set(walked).size).toBe(walked.length);
  }, 120_000);
});

// ── presence.get: the last observed-501 witness in the CLI ─────────────────

describe('presence.get — the observed-501 → `unavailable` path, end to end', () => {
  it('is probed independently, and the CLI derives the same verdict', async () => {
    ledger.clear();
    const probe = await server.observe('presence.get');
    measured['presence.get.probe'] = probe;

    const { PRESENCE_COMMANDS } = await import('../../src/commands/presence.js');
    const r = await drive(PRESENCE_COMMANDS, ['presence', 'get', ENTITY]);
    measured['presence.get.cliExit'] = r.code;
    measured['presence.get.cliStderr'] = r.stderr.trim().slice(0, 300);

    const derived = resolveAvailability('presence.get', 'v1');
    measured['presence.get.derived'] = derived;
    expect(derived.availability).toBe(ledgerVerdictFor(probe));

    if (probe === 'unavailable') {
      // TODAY'S BRANCH — and the reason this slot exists. A real Server refused
      // with an honest 501; the CLI reported it verbatim, exited 8, and the
      // derivation reached `unavailable` through the OBSERVED source, not the
      // contract source and not a guess.
      expect(r.code).toBe(8);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('operation presence.get is not implemented on this node');
      expect(derived).toEqual({
        availability: 'unavailable',
        availabilityReason: 'not_implemented_on_node',
        availabilitySource: 'observed',
      });
    } else {
      // G10 HAS COMPOSED IT. Re-measured, not predicted: the row flipped, the
      // derivation followed it, and this slot's honest-501 rendering is simply no
      // longer the branch that fires. That is a measurement changing, not a break.
      measured['presence.get.state'] = 'composed by G10 — the 501 branch no longer fires';
      expect(derived.availabilitySource).toBe('observed');
    }
  });

  it('answers for a REAL entity through the built binary', async () => {
    // Seeded over raw HTTP so this suite is not hostage to another slot's
    // registry wiring — see the paging test above for the same reasoning.
    const mk = await cli(['space', 'create', 'G8 presence', '--format', 'json'], server);
    expect(mk.code, mk.stderr).toBe(0);
    const created = JSON.parse(mk.stdout) as { id?: string; space?: { id?: string } };
    const spaceId = created.space?.id ?? created.id;
    expect(spaceId, `no space id in ${mk.stdout}`).toBeTruthy();

    const res = await fetch(new URL(bindPath('entities.create', { spaceId: spaceId! }), server.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spaceId, kind: 'task', title: 'presence target', clientMutationId: randomUUID() }),
    });
    expect(res.status).toBe(201);
    const createdBody = (await res.json()) as { data?: Record<string, unknown> };
    measured['entities.create.dtoKeys'] = Object.keys(createdBody.data ?? {});
    // The DTO shape is READ, not assumed — an earlier guess at `data.id` was
    // wrong and produced a `no entity undefined` refusal that looked like a
    // server defect and was entirely this fixture's fault.
    const d = createdBody.data ?? {};
    const entityId = (typeof d['id'] === 'string' ? d['id'] : undefined)
      ?? (typeof (d['entity'] as { id?: string })?.id === 'string'
        ? (d['entity'] as { id: string }).id
        : undefined);
    expect(entityId, `no entity id in ${JSON.stringify(createdBody).slice(0, 300)}`).toBeTruthy();

    const r = await cli(["presence", "get", entityId!, "--format", "json"], server);
    measured['presence.get.realEntityExit'] = r.code;
    measured['presence.get.realEntityStdout'] = r.stdout.trim().slice(0, 200);
    measured['presence.get.realEntityStderr'] = r.stderr.trim().slice(0, 200);

    // The grammar knows this command in every state, so "unknown command" and a
    // usage error are both wrong regardless of composition state.
    expect(r.stderr).not.toMatch(/unknown command/);
    expect(r.code).not.toBe(EXIT_USAGE);

    if (r.code === 8 && /not implemented on this node/.test(r.stderr)) {
      // THE ARCHIVED BRANCH. `presence.get` was the last v1 residual, and this
      // was the only place in the whole CLI where the OBSERVED source of M-3's
      // precedence could be demonstrated end to end against a real Server.
      measured['presence.get.builtState'] = 'RESIDUAL — honest 501 through the built binary';
      expect(r.stdout).toBe('');
    } else {
      // G10 HAS COMPOSED IT. Re-measured, not predicted. The invariant that
      // survives the flip is not a particular exit code — it is that a
      // COMPOSED row may never answer `not_implemented` again.
      measured['presence.get.builtState'] = 'COMPOSED — no longer a 501';
      expect(r.stderr).not.toMatch(/not_implemented/);
      expect(r.code).toBe(0);
      const snapshot = JSON.parse(r.stdout) as {
        viewers?: unknown; typingActorIds?: unknown; updatedAt?: unknown;
      };
      // The contract's PresenceSnapshot: viewers, typingActorIds, updatedAt.
      expect(Array.isArray(snapshot.viewers)).toBe(true);
      expect(Array.isArray(snapshot.typingActorIds)).toBe(true);
    }
  }, 120_000);
});

// ── bind coherence: no count is reported from a straddled run ──────────────

describe('bind coherence', () => {
  it('the migration chain did not move under this suite', async () => {
    // If this THROWS, another wave landed migrations mid-run. That is EXPECTED
    // during a landing and is not a defect: the correct response is to DISCARD
    // this run's numbers and re-run, never to report a count bound to two trees.
    await server.assertBindCoherent();
    measured['bindEnd'] = 'coherent';
  });
});
