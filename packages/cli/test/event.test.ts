/**
 * `tm8 event list` and `tm8 event watch` — group 8's two event rows.
 *
 * PROVENANCE NOTE, AND IT IS A HONEST ONE. This file is a REWRITE, not the
 * original. The original was destroyed by this slot's own §9 causation test: it
 * moved five files into one flat scratch directory to prove it was not the
 * cause of a foreign red, and `test/event.test.ts` and
 * `test/integration/event.test.ts` share a basename, so the second overwrote
 * the first. The integration file survived and was put back; this one was
 * rebuilt from the same assertions and re-verified against the counts the
 * original produced. Nothing in `src/` was affected.
 *
 * WHY THIS FILE DRIVES THE MODULE RATHER THAN `run()`. `src/commands/registry.ts`
 * and `src/run.ts` are coordinator-owned: this slot exports a `CommandModule[]`
 * and does NOT wire it in. `drive()` below therefore reproduces `run()`'s own
 * funnel — the real `parseInvocation`, `splitCommandPath`, `resolveContext`,
 * `errorLines`, `exitCodeFor`, `createOutput` — and substitutes ONLY the
 * registry lookup, which is the exact line the coordinator will write. Nothing
 * about parsing, context, output law, or exit codes is reimplemented here,
 * because reimplementing any of it would mean this file measured itself.
 *
 * (The same twelve lines appear in `presence.test.ts`. That duplication is
 * deliberate: this slot owns exactly `commands/event.ts`, `commands/presence.ts`
 * and its own test files, so a third shared helper file would be outside its
 * assigned set.)
 *
 * THE HONESTY SURFACE THIS FILE CARRIES, and it is the whole point of the slot:
 *
 *   `events.subscribe` is the catalog's ONLY WS row. It USED to be an upgrade
 *   skeleton — a real handshake with no client→server message to send over it —
 *   and this file's central assertion was that `event watch` said so.
 *
 *   THAT SUBJECT HAS SINCE BEEN FIXED. `@tm8/contract` now defines
 *   `WorkspaceControlFrame` (subscribe/unsubscribe/presence/resume/presence.set,
 *   `.strict()`, 1..100 spaceIds) and `WorkspaceControlAck`. The shipped
 *   disclosure therefore became FALSE in present tense, which is the same class
 *   as a diagnostic that outlives its defect: a lie the CLI tells. The
 *   assertions below now measure the NEW reality and, where they still assert an
 *   absence, they carry a probe-red so "absent" is a measurement rather than a
 *   regex that never matched anything.
 *
 *   The disclosure discipline is UNCHANGED and still enforced here: no
 *   permanence claim in either direction, no roadmap promise, and no claim about
 *   THIS NODE that the CLI has not observed. Those probe-reds are kept verbatim,
 *   because the reason they existed did not change when the contract did.
 *
 *   THE ONE THING THAT BREAKS A NAIVE CLIENT, asserted rather than assumed: the
 *   socket now carries TWO server→client shapes. Anything whose `type` starts
 *   with `control.` is an ACK, not a `WorkspaceEvent`. Non-collision is proved
 *   over the variant set ENUMERATED FROM THE CONTRACT SCHEMA ITSELF, not from a
 *   hand-written list that could drift away from the thing it claims to cover.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindPath,
  MAX_CONTROL_FRAME_SPACES,
  WorkspaceControlAckSchema,
  WorkspaceControlFrameSchema,
  WorkspaceEventSchema,
} from '@tm8/contract';
import { parseInvocation, splitCommandPath } from '../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import { CliError, EXIT_USAGE } from '../src/exit.js';
import { createOutput } from '../src/output.js';
import { ledger, resolveAvailability } from '../src/discovery/availability.js';
import { commandDiscovery, discoveryFor, isCommandPath } from '../src/discovery/operations.js';
import type { CommandModule } from '../src/run.js';

/** Imported lazily so a missing module fails each TEST, not only the FILE. */
async function eventCommands(): Promise<CommandModule[]> {
  return (await import('../src/commands/event.js')).EVENT_COMMANDS;
}

// ── the stub Server ─────────────────────────────────────────────────────────

interface Seen {
  method: string;
  pathname: string;
  query: string;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { data: {}, requestId: 'req_t' } };
let scratchHome: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push({
        method: req.method ?? '',
        pathname: url.pathname,
        query: url.search,
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
      });
      res.setHeader('content-type', 'application/json');
      res.statusCode = reply.status;
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  if (scratchHome) rmSync(scratchHome, { recursive: true, force: true });
});

const SPACE = '55555555-5555-7555-8555-555555555555';
const ENTITY = '66666666-6666-7666-8666-666666666666';

beforeEach(() => {
  seen = [];
  reply = { status: 200, body: { data: { items: [], nextCursor: '0' }, requestId: 'req_t' } };
  ledger.clear();
  scratchHome ??= mkdtempSync(join(tmpdir(), 'tm8-w4-g8-home-'));
  process.env.TM8_BASE_URL = baseUrl;
  process.env.TM8_SPACE_ID = SPACE;
  process.env.XDG_CONFIG_HOME = scratchHome;
  delete process.env.TM8_CONFIG_PATH;
  delete process.env.TM8_ACTOR_ID;
});

afterEach(() => {
  delete process.env.TM8_SPACE_ID;
  delete process.env.TM8_BASE_URL;
});

// ── the driver: `run()`'s funnel with only the registry substituted ─────────

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

async function drive(argv: readonly string[]): Promise<Ran> {
  const modules = await eventCommands();
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
    out = createOutput({
      format: inv.globals.format,
      color: inv.globals.color,
      quiet: inv.globals.quiet,
      streams,
    });
    const known = new Set(modules.map((m) => m.path.join(' ')));
    const match = splitCommandPath(inv.positionals, (p) => known.has(p.join(' ')));
    if (!match) throw new CliError(`unknown command: ${inv.positionals.join(' ')}`, EXIT_USAGE);
    const mod = modules.find((m) => m.path.join(' ') === match.path.join(' '));
    if (!mod) throw new CliError('no module', EXIT_USAGE);
    const ctx = resolveContext({
      globals: inv.globals,
      session: sessionContextFromEnv(),
      config: loadLocalConfig(),
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

/** A `not_implemented` envelope in the Server's own words. */
function honest501(operation: string): { status: number; body: unknown } {
  return {
    status: 501,
    body: {
      error: {
        code: 'not_implemented',
        message: `operation ${operation} is not implemented on this node`,
        requestId: 'r501',
        retryable: false,
      },
    },
  };
}

// ── the module agrees with its own projection ──────────────────────────────

describe('the module is the projection, not a second answer', () => {
  it('registers exactly the two command paths the projection names', async () => {
    const modules = await eventCommands();
    expect(modules.map((m) => m.path.join(' ')).sort()).toEqual(['event list', 'event watch']);
    // Guard against a vacuous sweep: an empty module array would satisfy the
    // `for` below and prove nothing.
    expect(modules.length).toBe(2);
    for (const m of modules) expect(isCommandPath(m.path)).toBe(true);
  });

  it('binds the operations the projection binds', () => {
    expect(discoveryFor('events.poll').command).toEqual(['event', 'list']);
    expect(discoveryFor('events.subscribe').command).toEqual(['event', 'watch']);
    expect(commandDiscovery(['event', 'list'])?.operations).toEqual(['events.poll']);
    expect(commandDiscovery(['event', 'watch'])?.operations).toEqual(['events.subscribe']);
  });

  /*
   * A DIVERGENCE TRIPWIRE STOOD HERE. IT FIRED, AND IT WAS RETIRED.
   *
   * When the control protocol landed, `event watch` began genuinely subscribing
   * while `src/discovery/operations.ts` still described `events.subscribe` as
   * "an upgrade SKELETON … do not depend on it for durable ordering yet" — so
   * `tm8 help event watch` told operators "skeleton" about a command that
   * subscribes. That file is frozen and another group's, so this slot reported
   * the conflict and pinned it as a test asserting BOTH sides as they then
   * stood: green while the divergence existed, RED the moment it was closed.
   *
   * The projection has since been corrected and the test went red exactly as
   * designed, so it has been DELETED rather than chased green — which is the
   * instruction it carried in its own comment. It is retired, not suppressed.
   *
   * NOTHING REPLACES IT, AND THAT IS DELIBERATE. The obvious move is an inverse
   * assertion — "the notes no longer say skeleton", or "the notes now mention
   * the control protocol". Both would be the SAME MISTAKE pointed the other
   * way: a test matching PROSE, which is precisely what rotted here. Prose
   * asserting a current state of the world has nothing that goes red when the
   * world moves, and pinning its wording only converts that into a suite that
   * goes red when an owner legitimately rewords their own file.
   *
   * What this describe block asserts instead is the STRUCTURAL agreement, which
   * cannot rot that way: the command paths the projection names (above), the
   * operations it binds (above), and `sideEffect: 'none'` — checked where it
   * actually constrains behaviour, in "NEVER writes presence: `event watch` is
   * side:none in its own projection". Those are facts with a mechanism behind
   * them, not sentences.
   */
});

// ── events.poll → `tm8 event list` ─────────────────────────────────────────

describe('tm8 event list — events.poll (composed, NOT independently gated)', () => {
  it('GETs exactly the path bindPath produces — no hand-written URL', async () => {
    const r = await drive(['event', 'list']);
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.pathname).toBe(bindPath('events.poll', { spaceId: SPACE }));
  });

  it('carries --after and --limit as QUERY params (the row takes no request body)', async () => {
    // `events.poll` is `input: none` in the projection. That means NO REQUEST
    // PAYLOAD — it does not mean "no flags": a GET read carries its dimensions
    // as query params, which never meet a body schema. So this is agreement
    // with the projection, not a conflict with it.
    await drive(['event', 'list', '--after', '42', '--limit', '10']);
    const q = new URLSearchParams(seen[0]?.query ?? '');
    expect(q.get('since')).toBe('42');
    expect(q.get('limit')).toBe('10');
    expect(seen[0]?.body).toBeUndefined();
  });

  it('sends no query at all when neither dimension is given', async () => {
    await drive(['event', 'list']);
    expect(seen[0]?.query).toBe('');
  });

  it('rejects a negative --after locally, without touching the network', async () => {
    const r = await drive(['event', 'list', '--after', '-1']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(seen).toHaveLength(0);
    expect(r.stderr).toMatch(/--after/);
  });

  it('rejects a non-integer --limit locally', async () => {
    const r = await drive(['event', 'list', '--limit', 'lots']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(seen).toHaveLength(0);
  });

  it('refuses --cursor, naming the seq cursor this feed actually uses', async () => {
    // `events.poll`'s cursor IS the per-space seq (AM-2 §3), not an opaque
    // keyset cursor. A caller carrying the `--cursor` habit from every other
    // list command would otherwise be silently ignored and conclude they were
    // caught up — the precise data-loss-wearing-a-green-badge failure.
    const r = await drive(['event', 'list', '--cursor', 'opaque']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(seen).toHaveLength(0);
    expect(r.stderr).toMatch(/--after/);
  });

  it('is a read: --mutation-id is refused', async () => {
    const r = await drive(['event', 'list', '--mutation-id', 'x']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(seen).toHaveLength(0);
    expect(r.stderr).toMatch(/mutation/i);
  });

  it('needs a Space, and says which four steps could have supplied one', async () => {
    delete process.env.TM8_SPACE_ID;
    const r = await drive(['event', 'list']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.stderr).toMatch(/--space/);
    expect(seen).toHaveLength(0);
  });

  it('--format json emits the contract page DTO verbatim', async () => {
    reply = {
      status: 200,
      body: {
        data: {
          items: [
            { spaceId: SPACE, seq: 7, occurredAt: '2026-01-01T00:00:00Z', schemaVersion: 1,
              type: 'entity.upsert', entity: { id: ENTITY, title: 'T' } },
          ],
          nextCursor: '7',
        },
        requestId: 'r',
      },
    };
    const r = await drive(['event', 'list', '--format', 'json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      items: [
        { spaceId: SPACE, seq: 7, occurredAt: '2026-01-01T00:00:00Z', schemaVersion: 1,
          type: 'entity.upsert', entity: { id: ENTITY, title: 'T' } },
      ],
      nextCursor: '7',
    });
  });

  it('human renders the SAME DTO and never drops the cursor a follow-up needs', async () => {
    reply = {
      status: 200,
      body: {
        data: {
          items: [
            { spaceId: SPACE, seq: 7, occurredAt: '2026-01-01T00:00:00Z', schemaVersion: 1,
              type: 'entity.upsert', entity: { id: ENTITY, title: 'T' }, clientMutationId: 'cmid-1' },
          ],
          nextCursor: '7',
        },
        requestId: 'r',
      },
    };
    const r = await drive(['event', 'list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('7');
    expect(r.stdout).toContain('entity.upsert');
    // The subject id and the follow-up cursor are both ids a next command needs.
    expect(r.stdout).toContain(ENTITY);
    expect(r.stdout).toMatch(/--after 7/);
    expect(r.stdout).toContain('cmid-1');
  });

  it('an empty page still renders its cursor, so a caller cannot lose its place', async () => {
    reply = { status: 200, body: { data: { items: [], nextCursor: '31' }, requestId: 'r' } };
    const r = await drive(['event', 'list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/--after 31/);
  });

  // ── the cursor class: assert the MECHANISM, not the symptom ──────────────

  it('passes a seq beyond 2^53 through VERBATIM in both directions', async () => {
    // `workspace_events.seq` is `bigint` (db/migrations/003_read_model.sql:297)
    // and node-pg hands a bigint back as a STRING. Any `Number()` on that path
    // is exact only below 2^53-1; above it the value rounds to NEAREST, which
    // can round UP — and a cursor rounded UP makes `seq > cursor` SKIP rows
    // silently, with no duplicate and no loop, so a "terminates and does not
    // overlap" assertion passes while events are being dropped.
    //
    // This asserts the mechanism at the point of truncation: the CLI must never
    // parse a seq into a JS number, outbound or inbound. It is a string it
    // received and a string it forwards. 9007199254740993 is 2^53+1, which is
    // NOT representable as a double — `Number()` on it yields ...992.
    const BEYOND_2_53 = '9007199254740993';
    expect(String(Number(BEYOND_2_53))).not.toBe(BEYOND_2_53); // the trap is real

    reply = { status: 200, body: { data: { items: [], nextCursor: BEYOND_2_53 }, requestId: 'r' } };
    const r = await drive(['event', 'list', '--after', BEYOND_2_53]);

    // outbound: the query param the Server receives
    expect(new URLSearchParams(seen[0]?.query ?? '').get('since')).toBe(BEYOND_2_53);
    // inbound: the cursor the caller is told to reuse
    expect(r.stdout).toContain(BEYOND_2_53);
  });

  it('a refusal puts NOTHING on stdout and everything on stderr', async () => {
    reply = {
      status: 403,
      body: { error: { code: 'forbidden', message: 'nope', requestId: 'r1', retryable: false } },
    };
    const r = await drive(['event', 'list']);
    expect(r.code).toBe(4);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/forbidden/);
  });
});

// ── availability: an honest 501 is a signal, never a defect ────────────────

describe('per-operation availability (M-3) is derived, never assumed', () => {
  it('defaults to unknown before anything has been observed', () => {
    expect(resolveAvailability('events.poll', 'v1')).toEqual({
      availability: 'unknown',
      availabilityReason: null,
      availabilitySource: 'none',
    });
  });

  it('an honest 501 is exit 8, rendered verbatim, and teaches the ledger', async () => {
    reply = honest501('events.poll');
    const r = await drive(['event', 'list']);
    expect(r.code).toBe(8);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('operation events.poll is not implemented on this node');
    expect(resolveAvailability('events.poll', 'v1')).toEqual({
      availability: 'unavailable',
      availabilityReason: 'not_implemented_on_node',
      availabilitySource: 'observed',
    });
  });

  it('a working row is recorded available, so the ledger is not write-only', async () => {
    // The positive control for the probe above: an assertion that can only ever
    // report `unavailable` proves nothing about what it measured.
    const r = await drive(['event', 'list']);
    expect(r.code).toBe(0);
    expect(resolveAvailability('events.poll', 'v1').availability).toBe('available');
  });
});

// ── the seam is BOUND: the control protocol exists and this file proves it ──

/**
 * The `type` discriminant of EVERY `WorkspaceEvent` variant, read off
 * `WorkspaceEventSchema` itself.
 *
 * DERIVED, NOT HAND-LISTED, and that is the whole point. A hand-written list is
 * a second source of truth: it would keep passing while the contract grew a
 * variant it had never heard of, and the assertion it feeds ("no event type
 * collides with `control.`") would silently stop covering the new one. Reading
 * the union means a variant cannot be added without this sweep seeing it.
 */
function contractEventTypes(): string[] {
  let schema: unknown = WorkspaceEventSchema;
  // `WorkspaceEventSchema` is wrapped in `z.lazy` for the recursive payloads.
  for (let hop = 0; hop < 8; hop++) {
    const def = (schema as { _def?: { typeName?: string; getter?: () => unknown } })._def;
    if (def?.typeName !== 'ZodLazy' || def.getter === undefined) break;
    schema = def.getter();
  }
  const def = (schema as { _def: { typeName: string; options?: unknown[] } })._def;
  if (def.typeName !== 'ZodUnion' || !Array.isArray(def.options)) {
    throw new Error(`WorkspaceEventSchema is not a union but a ${def.typeName}`);
  }
  const types: string[] = [];
  for (const option of def.options) {
    const shape = (option as { shape: Record<string, unknown> }).shape;
    const discriminant = (shape['type'] as { _def: { typeName: string; value?: string; values?: string[] } })._def;
    if (discriminant.typeName === 'ZodLiteral' && typeof discriminant.value === 'string') {
      types.push(discriminant.value);
    } else if (discriminant.typeName === 'ZodEnum' && Array.isArray(discriminant.values)) {
      types.push(...discriminant.values);
    } else {
      throw new Error(`unreadable discriminant ${discriminant.typeName}`);
    }
  }
  return types;
}

/**
 * A FULLY schema-valid `WorkspaceEvent` — it really does parse under
 * `WorkspaceEventSchema`, which is what makes it usable as the positive control
 * in the mutual-exclusivity assertions below. `typing.changed` is chosen only
 * because it is the union's smallest payload.
 */
const SCHEMA_VALID_EVENT = {
  spaceId: SPACE,
  seq: 9,
  occurredAt: '2026-01-01T00:00:00.000Z',
  schemaVersion: 1,
  type: 'typing.changed',
  anchorId: ENTITY,
  typingActorIds: [],
} as const;

/**
 * An event as it plausibly arrives on the wire, DELIBERATELY not a complete
 * `EntitySummary`.
 *
 * This is not laziness in a fixture — it is the assertion. The client renders
 * server output FAITHFULLY and must not gate rendering on schema validation: a
 * node that adds or omits a payload field must not be able to make the CLI go
 * silent, because a stream that drops what it cannot parse is a stream that
 * hides exactly the drift a gate needs to see. So the loop tests below feed
 * partial payloads on purpose and require them to be rendered anyway.
 */
const WIRE_EVENT = {
  spaceId: SPACE,
  seq: 9,
  occurredAt: '2026-01-01T00:00:00.000Z',
  schemaVersion: 1,
  type: 'entity.upsert',
  entity: { id: ENTITY, title: 'T' },
} as const;

/** A schema-valid `WorkspaceControlAck`. */
const REAL_ACK = { type: 'control.refused', frame: 'subscribe', spaceId: SPACE, reason: 'forbidden' } as const;

describe('the control protocol LANDED — the shipped disclosure had to change', () => {
  it('the contract really does define client→server control frames now', () => {
    // The premise of every assertion below. If this ever fails, the rest of this
    // describe block is measuring a contract that is not there, and the OLD
    // disclosure would have been right after all.
    expect(WorkspaceControlFrameSchema.safeParse({ type: 'subscribe', spaceIds: [SPACE] }).success).toBe(true);
    expect(WorkspaceControlAckSchema.safeParse(REAL_ACK).success).toBe(true);
  });

  it('`event watch` no longer says the contract has no client→server message', async () => {
    const r = await drive(['event', 'watch', '--space', SPACE, '--timeout', '0']);
    // The EXACT shipped clause that became false, plus the looser class around
    // it. PROBE-RED: the matcher is shown to fire on the text that was shipped,
    // so its absence below is a fact about the command and not a dead regex.
    const wasShipped =
      'defines the server→client WorkspaceEvent and no client→server control message, so this';
    const falseNow = /no client→server control message|is a WebSocket upgrade SKELETON/;
    expect(wasShipped).toMatch(falseNow);
    expect(r.stderr).not.toMatch(falseNow);
    expect(r.stdout).not.toMatch(falseNow);
  });

  it('the seam resolves: wsControlProtocol() is no longer null', async () => {
    const { wsControlProtocol } = await import('../src/commands/event.js');
    expect(wsControlProtocol()).not.toBeNull();
  });
});

describe('the frames `event watch` sends are the CONTRACT frames, validated', () => {
  async function framesFor(argv: readonly string[]): Promise<unknown[]> {
    const { wsControlProtocol, watchRequestFrom } = await import('../src/commands/event.js');
    const protocol = wsControlProtocol();
    if (protocol === null) throw new Error('the seam did not resolve');
    const inv = parseInvocation(argv);
    const match = splitCommandPath(inv.positionals, (p) => p.join(' ') === 'event watch');
    if (!match) throw new Error('argv did not resolve to `event watch`');
    const ctx = resolveContext({
      globals: inv.globals,
      session: sessionContextFromEnv(),
      config: loadLocalConfig(),
    });
    return protocol.frames(watchRequestFrom({ options: inv.options, ctx }));
  }

  it('every frame it would send is legal under the contract schema', async () => {
    const frames = await framesFor(['event', 'watch', '--space', SPACE, '--after', '12', '--presence']);
    // GUARD AGAINST A VACUOUS SWEEP: zero frames would satisfy the `for` below
    // and prove nothing whatsoever.
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      const parsed = WorkspaceControlFrameSchema.safeParse(frame);
      expect(parsed.success, `illegal frame ${JSON.stringify(frame)}`).toBe(true);
    }
  });

  it('a bare watch subscribes, naming the Space — membership, nothing else', async () => {
    const frames = await framesFor(['event', 'watch', '--space', SPACE]);
    expect(frames).toEqual([{ type: 'subscribe', spaceIds: [SPACE] }]);
  });

  it('subscribe carries NO cursor: subscribe is membership, resume is replay', async () => {
    // The contract prose is explicit that merging them would make every
    // re-subscribe implicitly re-replay. So `--after` must produce a SECOND
    // frame, never a `since` smuggled onto the first.
    const frames = (await framesFor(['event', 'watch', '--space', SPACE, '--after', '12'])) as Array<
      Record<string, unknown>
    >;
    const subscribe = frames.find((f) => f['type'] === 'subscribe');
    expect(subscribe).toEqual({ type: 'subscribe', spaceIds: [SPACE] });
    expect(subscribe).not.toHaveProperty('since');
    expect(frames).toContainEqual({ type: 'resume', spaceId: SPACE, since: 12 });
    // ORDER matters: membership before replay, or the replay has no fan-out to
    // arrive on.
    expect(frames.findIndex((f) => f['type'] === 'subscribe'))
      .toBeLessThan(frames.findIndex((f) => f['type'] === 'resume'));
  });

  it('sends no resume frame when no --after was given', async () => {
    const frames = (await framesFor(['event', 'watch', '--space', SPACE])) as Array<Record<string, unknown>>;
    expect(frames.some((f) => f['type'] === 'resume')).toBe(false);
    // POSITIVE CONTROL: the same predicate DOES find one when --after is passed,
    // so `false` above is a measurement and not a broken predicate.
    const withAfter = (await framesFor(['event', 'watch', '--space', SPACE, '--after', '1'])) as Array<
      Record<string, unknown>
    >;
    expect(withAfter.some((f) => f['type'] === 'resume')).toBe(true);
  });

  it('--presence toggles the channel, and its absence sends no presence frame', async () => {
    const on = (await framesFor(['event', 'watch', '--space', SPACE, '--presence'])) as Array<
      Record<string, unknown>
    >;
    expect(on).toContainEqual({ type: 'presence', on: true });
    const off = (await framesFor(['event', 'watch', '--space', SPACE])) as Array<Record<string, unknown>>;
    expect(off.some((f) => f['type'] === 'presence')).toBe(false);
  });

  it('NEVER writes presence: `event watch` is side:none in its own projection', async () => {
    // `presence.set` is a contract frame, but it is a WRITE, and the projection
    // this command must agree with declares `events.subscribe` to have no side
    // effect. A read command that announced presence would contradict its own
    // published contract, so this slot binds the frame nowhere.
    const frames = (await framesFor([
      'event', 'watch', '--space', SPACE, '--presence', '--entity', ENTITY,
    ])) as Array<Record<string, unknown>>;
    expect(frames.some((f) => f['type'] === 'presence.set')).toBe(false);
    expect(discoveryFor('events.subscribe').sideEffect).toBe('none');
  });

  it('--type and --entity NEVER reach the wire — the frame schema is strict', async () => {
    // This is the strictness trap: `WorkspaceControlFrameSchema` is `.strict()`,
    // so a filter field smuggled onto a subscribe frame is a REJECTED frame, not
    // a tolerated one. The contract has no filter field at all, so filtering is
    // local by construction.
    const frames = await framesFor([
      'event', 'watch', '--space', SPACE,
      '--type', 'entity.upsert', '--entity', ENTITY,
    ]);
    const wire = JSON.stringify(frames);
    expect(wire).not.toContain('entity.upsert');
    expect(wire).not.toContain(ENTITY);

    // PROBE-RED for the strictness claim itself: prove the schema really does
    // reject an extra key, or "we did not send one" would be a claim about a
    // rule that was never enforced.
    expect(
      WorkspaceControlFrameSchema.safeParse({
        type: 'subscribe', spaceIds: [SPACE], eventTypes: ['entity.upsert'],
      }).success,
    ).toBe(false);
  });

  it('stays inside the contract bound of 100 Spaces per frame', async () => {
    const frames = (await framesFor(['event', 'watch', '--space', SPACE])) as Array<
      { type: string; spaceIds?: string[] }
    >;
    const subscribe = frames.find((f) => f.type === 'subscribe');
    expect(subscribe?.spaceIds?.length).toBeGreaterThanOrEqual(1);
    expect(subscribe?.spaceIds?.length).toBeLessThanOrEqual(MAX_CONTROL_FRAME_SPACES);
  });

  it('encode() refuses a frame the contract would reject, rather than sending it', async () => {
    const { wsControlProtocol } = await import('../src/commands/event.js');
    const protocol = wsControlProtocol();
    expect(protocol).not.toBeNull();
    // MUTATION-STYLE probe on the encoder: hand it an illegal frame and show it
    // refuses. An encoder that serialised anything handed to it would make the
    // schema validation above decorative.
    expect(() => protocol!.encode({ type: 'subscribe', spaceIds: [] } as never)).toThrow();
    // POSITIVE CONTROL: the same encoder accepts the legal frame.
    expect(protocol!.encode({ type: 'subscribe', spaceIds: [SPACE] })).toContain('subscribe');
  });

  it('refuses an --after beyond 2^53 rather than rounding it onto the wire', async () => {
    // `resume.since` is a NUMBER in the contract, but `workspace_events.seq` is a
    // bigint the CLI otherwise carries as a STRING precisely so it is never
    // rounded. `Number('9007199254740993')` is ...992 — and a cursor rounded UP
    // SKIPS rows silently. Refusing is the only safe direction: zod's `.safe()`
    // would happily accept the already-rounded value, so the guard cannot live
    // in the schema.
    const BEYOND_2_53 = '9007199254740993';
    expect(String(Number(BEYOND_2_53))).not.toBe(BEYOND_2_53); // the trap is real
    const r = await drive(['event', 'watch', '--space', SPACE, '--after', BEYOND_2_53]);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/--after/);
  });
});

// ── THE discrimination: `control.` is an ACK, never a WorkspaceEvent ────────

describe('a `control.` frame is an ACK and can never be mistaken for an event', () => {
  it('no WorkspaceEvent variant in the CONTRACT begins with `control.`', () => {
    const types = contractEventTypes();
    // GUARD AGAINST A VACUOUS SWEEP: an introspection that silently yielded zero
    // variants would pass the assertion below while covering nothing. The
    // contract carries dozens; anything near zero means the reader broke.
    expect(types.length).toBeGreaterThan(20);
    expect(types).toContain('entity.upsert');
    expect(types).toContain('typing.changed');
    expect(types.filter((t) => t.startsWith('control.'))).toEqual([]);

    // PROBE-RED: inject the ack's own type into the SAME predicate and show it
    // fires. Otherwise "nothing starts with control." is indistinguishable from
    // a filter that can never match.
    expect([...types, 'control.refused'].filter((t) => t.startsWith('control.'))).toEqual([
      'control.refused',
    ]);
  });

  it('the two shapes are mutually exclusive under the contract schemas themselves', () => {
    // Not merely "our classifier tells them apart" — the CONTRACT does, which is
    // what makes discriminating on the prefix safe rather than a convention.
    expect(WorkspaceEventSchema.safeParse(REAL_ACK).success).toBe(false);
    expect(WorkspaceControlAckSchema.safeParse(SCHEMA_VALID_EVENT).success).toBe(false);
    // POSITIVE CONTROLS: each schema does accept its own shape, so the two
    // failures above are discrimination and not two broken schemas.
    expect(WorkspaceEventSchema.safeParse(SCHEMA_VALID_EVENT).success).toBe(true);
    expect(WorkspaceControlAckSchema.safeParse(REAL_ACK).success).toBe(true);
  });

  it('classify() calls a control frame an ack and an event an event', async () => {
    const { wsControlProtocol } = await import('../src/commands/event.js');
    const protocol = wsControlProtocol()!;
    expect(protocol.classify(JSON.stringify(REAL_ACK)).kind).toBe('ack');
    // POSITIVE CONTROL: 'ack' is not the only answer this function can give.
    expect(protocol.classify(JSON.stringify(SCHEMA_VALID_EVENT)).kind).toBe('event');
  });

  it('classifies by the `control.` PREFIX, not by an equality on one literal', async () => {
    // `control.refused` is the only ack today. A client that matched that exact
    // string would render a future `control.*` message as if it were an event —
    // the precise failure the namespacing exists to prevent.
    const { wsControlProtocol } = await import('../src/commands/event.js');
    const protocol = wsControlProtocol()!;
    const future = protocol.classify(JSON.stringify({ type: 'control.something_else', frame: 'subscribe' }));
    expect(future.kind).toBe('ack');
  });

  it('an unintelligible frame is neither, and is never rendered as data', async () => {
    const { wsControlProtocol } = await import('../src/commands/event.js');
    const protocol = wsControlProtocol()!;
    expect(protocol.classify('this is not json').kind).toBe('unintelligible');
    expect(protocol.classify('null').kind).toBe('unintelligible');
  });
});

// ── the watch loop, driven over an injected socket ─────────────────────────

/**
 * A fake `WatchSocket`.
 *
 * The transport is injected for the same reason the FROZEN kernel injects
 * `fetchImpl` into `Tm8Client` — this is that established pattern, not a new
 * seam invented for testability. Socket BEHAVIOUR against a real server is
 * proved in `test/integration/event.test.ts`; what is proved here is the
 * protocol logic above the socket, which a real server cannot be made to
 * exercise deterministically.
 */
class FakeSocket {
  readonly sent: string[] = [];
  closedByClient = false;
  private onMsg: (text: string) => void = () => {};
  private onEnd: (code: number, reason: string) => void = () => {};

  async open(): Promise<void> {
    return Promise.resolve();
  }
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    this.closedByClient = true;
    this.onEnd(1000, 'closed by client');
  }
  onMessage(fn: (text: string) => void): void {
    this.onMsg = fn;
  }
  onClose(fn: (code: number, reason: string) => void): void {
    this.onEnd = fn;
  }

  // ── test drivers ──
  deliver(payload: unknown): void {
    this.onMsg(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }
  serverClose(code: number, reason = ''): void {
    this.onEnd(code, reason);
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

async function watchOver(
  socket: FakeSocket,
  argv: readonly string[],
  drivePlan: (s: FakeSocket) => void,
): Promise<Ran> {
  const { runWatch, watchRequestFrom } = await import('../src/commands/event.js');
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
  const inv = parseInvocation(argv);
  const out = createOutput({ format: inv.globals.format, quiet: inv.globals.quiet, streams });
  const ctx = resolveContext({
    globals: inv.globals,
    session: sessionContextFromEnv(),
    config: loadLocalConfig(),
  });
  try {
    const running = runWatch({
      request: watchRequestFrom({ options: inv.options, ctx }),
      socket,
      out,
      timeoutMs: undefined,
    });
    // Let `open()` settle and the opening frames flush before the plan runs.
    await new Promise((resolve) => setImmediate(resolve));
    drivePlan(socket);
    return { code: await running, stdout, stderr };
  } catch (err) {
    out.error(errorLines(err));
    return { code: exitCodeFor(err), stdout, stderr };
  }
}

describe('tm8 event watch — the loop, over an injected socket', () => {
  it('subscribes on open, then renders events to STDOUT one per line', async () => {
    const socket = new FakeSocket();
    const r = await watchOver(socket, ['event', 'watch', '--space', SPACE, '--format', 'jsonl'], (s) => {
      s.deliver(WIRE_EVENT);
      s.deliver({ ...WIRE_EVENT, seq: 10, type: 'entity.deleted' });
      s.serverClose(1000, 'bye');
    });
    expect(r.code).toBe(0);
    expect(socket.frames()).toContainEqual({ type: 'subscribe', spaceIds: [SPACE] });
    const lines = r.stdout.trim().split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(WIRE_EVENT);
    expect((JSON.parse(lines[1]!) as { seq: number }).seq).toBe(10);
  });

  it('a REFUSED subscribe is reported, not silence — exit 4 on `forbidden`', async () => {
    // The whole reason the ack exists. Before it, an unauthorized subscribe was
    // indistinguishable from a Space that was simply quiet, and a caller waited
    // forever on events it would never be sent.
    const socket = new FakeSocket();
    const r = await watchOver(socket, ['event', 'watch', '--space', SPACE], (s) => {
      s.deliver(REAL_ACK);
    });
    expect(r.code).toBe(4);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/refus/i);
    expect(r.stderr).toContain(SPACE);
  });

  it('a `malformed` refusal is OUR defect, and exits 10 rather than blaming the caller', async () => {
    const socket = new FakeSocket();
    const r = await watchOver(socket, ['event', 'watch', '--space', SPACE], (s) => {
      s.deliver({ type: 'control.refused', frame: 'subscribe', reason: 'malformed' });
    });
    // Not 2: the caller's invocation was fine. The CLI encoded something the
    // node rejected, which is a protocol failure on this side.
    expect(r.code).toBe(10);
    expect(r.stdout).toBe('');
  });

  it('an ack NEVER reaches stdout — it is a diagnostic, not data', async () => {
    const socket = new FakeSocket();
    const r = await watchOver(socket, ['event', 'watch', '--space', SPACE, '--format', 'jsonl'], (s) => {
      s.deliver(REAL_ACK);
    });
    expect(r.stdout).not.toContain('control.refused');
    // POSITIVE CONTROL: this same stdout DOES carry a real event, so "absent"
    // above is discrimination and not a stream that never writes anything.
    const ok = new FakeSocket();
    const r2 = await watchOver(ok, ['event', 'watch', '--space', SPACE, '--format', 'jsonl'], (s) => {
      s.deliver(WIRE_EVENT);
      s.serverClose(1000);
    });
    expect(r2.stdout).toContain('entity.upsert');
  });

  it('filters --type and --entity LOCALLY, and says that it is doing so', async () => {
    const socket = new FakeSocket();
    const r = await watchOver(
      socket,
      ['event', 'watch', '--space', SPACE, '--type', 'entity.upsert', '--format', 'jsonl'],
      (s) => {
        s.deliver(WIRE_EVENT);
        s.deliver({ ...WIRE_EVENT, seq: 11, type: 'entity.deleted' });
        s.serverClose(1000);
      },
    );
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as { type: string }).type).toBe('entity.upsert');
    // DISCLOSED: a caller must not believe the node is filtering for them. The
    // contract's frames carry no filter field, so this happens after delivery.
    expect(r.stderr).toMatch(/local/i);
  });

  it('an unintelligible frame is disclosed on stderr and never printed as data', async () => {
    const socket = new FakeSocket();
    const r = await watchOver(socket, ['event', 'watch', '--space', SPACE, '--format', 'jsonl'], (s) => {
      s.deliver('}{ not json');
      s.serverClose(1000);
    });
    expect(r.stdout).toBe('');
    expect(r.stderr).not.toBe('');
  });

  it('an unclean server close is retryable (7), a clean one is success (0)', async () => {
    const dirty = new FakeSocket();
    const bad = await watchOver(dirty, ['event', 'watch', '--space', SPACE], (s) => {
      s.serverClose(1006, 'abnormal');
    });
    expect(bad.code).toBe(7);
    const clean = new FakeSocket();
    const good = await watchOver(clean, ['event', 'watch', '--space', SPACE], (s) => {
      s.serverClose(1000, 'bye');
    });
    expect(good.code).toBe(0);
  });
});

// ── what did NOT change: the disclosure discipline still binds ─────────────

describe('tm8 event watch — local validation and the disclosure discipline', () => {
  it('a stream is not a mutation: --mutation-id is refused', async () => {
    const r = await drive(['event', 'watch', '--mutation-id', 'x']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.stderr).toMatch(/mutation/i);
  });

  it('validates the invocation FIRST — a malformed --after is a usage error', async () => {
    const r = await drive(['event', 'watch', '--space', SPACE, '--after', 'abc']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.stderr).toMatch(/--after/);
    expect(seen).toHaveLength(0);
  });

  it('requires a Space, because a `subscribe` frame NAMES the Spaces it wants', async () => {
    // There is no all-Spaces subscribe in the contract: `spaceIds` is 1..100.
    // So "watch everything" is inexpressible, and saying so is better than
    // silently watching one Space the caller did not choose.
    delete process.env.TM8_SPACE_ID;
    const r = await drive(['event', 'watch']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.stderr).toMatch(/--space/);
  });

  it('refuses --format json up front: a stream is jsonl or human (§7.2)', async () => {
    const r = await drive(['event', 'watch', '--space', SPACE, '--format', 'json']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/jsonl/);
  });

  it('makes NO unobserved claim about this node', async () => {
    reply = honest501('events.poll');
    const control = await drive(['event', 'list']);
    // POSITIVE CONTROL: the same stderr funnel demonstrably carries this literal
    // when a node really does refuse, so its absence below is a fact about
    // `event watch` rather than about the assertion.
    expect(control.stderr).toContain('is not implemented on this node');

    const r = await drive(['event', 'watch', '--space', SPACE, '--after', 'abc']);
    expect(r.stderr).not.toContain('is not implemented on this node');
  });

  it('never claims the current shape is PERMANENT', async () => {
    const r = await drive(['event', 'watch', '--space', SPACE, '--after', 'abc']);
    const forever = /\b(permanent(ly)?|forever|never will|always be|by design and will not)\b/i;
    // PROBE-RED: the matcher fires on text that does make the permanence claim.
    expect('the WS row is permanently a skeleton and never will be more').toMatch(forever);
    expect(r.stderr).not.toMatch(forever);
  });

  it('equally never promises what is coming — a diagnostic is not a roadmap', async () => {
    // This slot has now watched its own shipped text become false once. The
    // lesson is not "predict better", it is "claim only what the build that
    // printed the line can be checked against".
    const r = await drive(['event', 'watch', '--space', SPACE, '--after', 'abc']);
    const roadmap = /\b(coming soon|will be added|planned|in a future release|once .* lands)\b/i;
    // PROBE-RED: the matcher fires on text that does make the promise.
    expect('a control protocol will be added in a future release').toMatch(roadmap);
    expect(r.stderr).not.toMatch(roadmap);
  });
});
