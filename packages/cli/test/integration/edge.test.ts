/**
 * GROUP 4 AGAINST A REAL SERVER — `edge`, `edge type`, `entity connections`,
 * and `placement apply` on an isolated, freshly migrated scratch database.
 *
 * WHAT THIS SUITE CAN AND CANNOT CLAIM, stated up front because the difference
 * is the whole value of the run:
 *
 *  - G03 (`edges.*`, `edgeTypes.list`, `placements.apply`) is composed AND
 *    independently W3-passed. Evidence here is REAL local-Server evidence.
 *  - `entities.connections` belongs to G02, which is composed but carries ZERO
 *    W3 verdict and a known live defect elsewhere in that group. Everything it
 *    proves is labelled "composed, NOT independently gated" and is never
 *    counted as verified coverage.
 *  - Registry wiring is coordinator-owned. These paths are now wired, so the
 *    last describe drives the BUILT BINARY as a child process — the way an
 *    agent actually invokes it — end to end against the real Server. The
 *    earlier describes drive this module's production code in-process against
 *    the same Server (same `Tm8Client`, same `bindPath`, same envelope
 *    handling); that layer is kept because it can assert exit codes and stream
 *    separation without paying process spawn per case.
 *
 * Setup rows (Space, entities) are created by RAW FETCH, deliberately. They
 * belong to other groups; routing them through a CLI command this slot does not
 * own would quietly claim coverage of it.
 *
 * `server.observe()` is THREE-STATE and is never collapsed: `'unknown'` means
 * "registered, but the handler never ran", which is exactly what an empty-body
 * probe can conclude and no more.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeCursor } from '@tm8/contract';
import { assertBuilt, cli, startRealServer, type RealServer } from './harness.js';
import { parseInvocation, splitCommandPath } from '../../src/args.js';
import { resolveContext } from '../../src/context.js';
import { errorLines, exitCodeFor } from '../../src/errors.js';
import { CliError, EXIT_USAGE, type ExitCode } from '../../src/exit.js';
import { createOutput, type OutputStreams } from '../../src/output.js';
import type { CommandModule } from '../../src/run.js';
import { EDGE_COMMANDS } from '../../src/commands/edge.js';
import { PLACEMENT_COMMANDS } from '../../src/commands/placement.js';

let server: RealServer;

beforeAll(async () => {
  await assertBuilt();
  server = await startRealServer('edge');
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

/**
 * Each of these spawns several `node` child processes. Five seconds is fine
 * for this file alone and is NOT fine when the whole suite runs: eight
 * integration files each start a real Server on a loaded host, and the
 * default timeout then fails a test that is working correctly. A timeout
 * tuned to the file in isolation is a test that lies under load.
 */
const BINARY_TIMEOUT_MS = 60_000;

const MODULES: readonly CommandModule[] = [...EDGE_COMMANDS, ...PLACEMENT_COMMANDS];

interface Ran {
  code: ExitCode;
  stdout: string;
  stderr: string;
}

/**
 * Drive this module's production code against the real Server, capturing
 * streams instead of writing to the process. This mirrors `run()`'s funnel;
 * only the command lookup differs, because the registry is coordinator-owned.
 */
async function tm8(argv: readonly string[]): Promise<Ran> {
  let stdout = '';
  let stderr = '';
  const streams: OutputStreams = {
    stdout: (c) => { stdout += typeof c === 'string' ? c : Buffer.from(c).toString('utf8'); },
    stderr: (c) => { stderr += c; },
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
    const known = (p: readonly string[]): boolean =>
      MODULES.some((m) => m.path.join(' ') === p.join(' '));
    const match = splitCommandPath(inv.positionals, known);
    if (!match) throw new CliError(`unknown command: ${inv.positionals.join(' ')}`, EXIT_USAGE);
    const mod = MODULES.find((m) => m.path.join(' ') === match.path.join(' '))!;
    const ctx = resolveContext({
      globals: inv.globals,
      // The real Server, and nothing from the developer's own environment.
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

const json = <T>(r: Ran): T => JSON.parse(r.stdout) as T;

let mutationSeq = 0;
const cmid = (): string => `w4-g4-${process.pid}-${++mutationSeq}`;

/** A fresh task for the built-binary cases, so they never inherit earlier state. */
async function binTask(title: string): Promise<string> {
  const r = await post<{ entity: { id: string } }>('/v2/entities', {
    clientMutationId: cmid(),
    spaceId: ids.spaceId,
    kind: 'task',
    title,
  });
  return r.entity.id;
}

/** SETUP ONLY — other groups' operations, called raw so no coverage is implied. */
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(new URL(path, server.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json()) as { data?: T; error?: { code: string; message: string } };
  if (!res.ok) {
    throw new Error(`setup ${path} answered ${res.status}: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.data as T;
}

interface Ids { spaceId: string; memberId: string; a: string; b: string; c: string }
let ids: Ids;

beforeAll(async () => {
  const created = await post<{ space: { id: string }; memberId: string }>('/v2/spaces', {
    name: `w4 group4 ${process.pid}`,
    clientMutationId: cmid(),
  });
  const task = async (title: string): Promise<string> => {
    const r = await post<{ entity: { id: string } }>('/v2/entities', {
      clientMutationId: cmid(),
      spaceId: created.space.id,
      kind: 'task',
      title,
    });
    return r.entity.id;
  };
  ids = {
    spaceId: created.space.id,
    // `entities.create` refuses kind `member`, so the owner member the Space
    // creation itself produced is the only real assignee available here.
    memberId: created.memberId,
    a: await task('alpha'),
    b: await task('beta'),
    c: await task('gamma'),
  };
}, 120_000);

interface EdgeView {
  id: string;
  type: string;
  source: { id: string };
  target: { id: string };
  props: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  hard?: boolean;
  resolved?: boolean;
}
interface Page { items: EdgeView[]; nextCursor: string | null }
interface CommandResult {
  edge?: EdgeView;
  entity?: { id: string };
  patches: unknown[];
  undo?: { token: string; label: string };
}

describe('per-operation availability, observed three-state and never collapsed', () => {
  it('reports each of this slot rows as the node actually answers it', async () => {
    const rows = [
      'edges.list', 'edges.create', 'edges.patch', 'edges.delete',
      'edgeTypes.list', 'placements.apply', 'entities.connections',
    ] as const;
    const observed: Record<string, string> = {};
    for (const row of rows) observed[row] = await server.observe(row);
    console.log(`[g4] observed availability ${JSON.stringify(observed)}`);
    for (const row of rows) {
      // The point of the three-state API: 'unknown' is a real answer and must
      // not be read as available. What is asserted is that NONE of this slot's
      // rows is definitively unavailable — every one is composed on this node.
      expect(observed[row], row).not.toBe('unavailable');
      expect(['available', 'unknown']).toContain(observed[row]);
    }
    // The GET rows carry no body, so their handler genuinely ran.
    expect(observed['edges.list']).toBe('available');
    expect(observed['edgeTypes.list']).toBe('available');
  });

  it('a permanently reserved row is still definitively unavailable — the probe discriminates', async () => {
    // Without this, "nothing came back 'unavailable'" would be consistent with
    // a probe that cannot detect unavailability at all.
    expect(await server.observe('search.query')).toBe('unavailable');
  });
});

describe('edge type list — edgeTypes.list, G03: composed and W3-passed', () => {
  it('returns the real registered edge types with their endpoint rules', async () => {
    const r = await tm8(['edge', 'type', 'list', '--format', 'json']);
    expect(r.code).toBe(0);
    const types = json<{ type: string; sourceKinds: string[]; destinationKinds: string[] }[]>(r);
    expect(types.length).toBeGreaterThan(10);
    const dependsOn = types.find((t) => t.type === 'depends_on');
    expect(dependsOn?.sourceKinds).toEqual(['*']);
    const assignedTo = types.find((t) => t.type === 'assigned_to');
    expect(assignedTo?.destinationKinds).toEqual(expect.arrayContaining(['member']));
  });

  it('human output names the type and its rule, and writes nothing to stderr', async () => {
    const r = await tm8(['edge', 'type', 'list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('depends_on');
    expect(r.stderr).toBe('');
  });
});

describe('edge create / list / update / delete — G03, real rows in a real database', () => {
  let created: string;

  it('creates a real edge and returns the CommandResult the contract promises', async () => {
    const r = await tm8(['edge', 'create', ids.a, 'relates_to', ids.b, '--format', 'json']);
    expect(r.code).toBe(0);
    const result = json<CommandResult>(r);
    expect(result.edge?.type).toBe('relates_to');
    expect(result.edge?.source.id).toBe(ids.a);
    expect(result.edge?.target.id).toBe(ids.b);
    created = result.edge!.id;
  });

  it('lists it back through the catalog-bound filters, including --target -> destination', async () => {
    const bySource = json<Page>(await tm8(['edge', 'list', '--source', ids.a, '--format', 'json']));
    expect(bySource.items.map((e) => e.id)).toContain(created);

    // The mapping that would silently return EVERY edge if it drifted.
    const byTarget = json<Page>(await tm8([
      'edge', 'list', '--source', ids.a, '--target', ids.b, '--format', 'json',
    ]));
    expect(byTarget.items.map((e) => e.id)).toContain(created);

    const wrongTarget = json<Page>(await tm8([
      'edge', 'list', '--source', ids.a, '--target', ids.c, '--format', 'json',
    ]));
    expect(wrongTarget.items.map((e) => e.id)).not.toContain(created);
  });

  it('honours --direction incoming, which is the reverse of the same edge', async () => {
    const incoming = json<Page>(await tm8([
      'edge', 'list', '--source', ids.b, '--direction', 'incoming', '--format', 'json',
    ]));
    expect(incoming.items.map((e) => e.id)).toContain(created);
  });

  it('human output carries the edge id a follow-up `edge update` needs', async () => {
    const r = await tm8(['edge', 'list', '--source', ids.a]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(created);
  });

  it('updates props under the real Server', async () => {
    const r = await tm8(['edge', 'update', created, '--props', '{"note":"w4"}', '--format', 'json']);
    expect(r.code).toBe(0);
    expect(json<CommandResult>(r).edge?.props).toMatchObject({ note: 'w4' });
  });

  it('props.origin is Server-owned: the CLI sends it and the Server answers FORBIDDEN (exit 4)', async () => {
    // Asserted against the real node rather than pre-empted locally. A local
    // exit 2 would have reported a different code than the node returns.
    const r = await tm8(['edge', 'create', ids.a, 'relates_to', ids.c, '--props', '{"origin":"client"}']);
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/forbidden/);
    expect(r.stderr).toMatch(/origin/);
    expect(r.stdout).toBe('');
  });

  it('an unregistered edge type is refused by the real registry, not by a guess here', async () => {
    const r = await tm8(['edge', 'create', ids.a, 'not_a_real_edge_type', ids.b]);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe('');
  });

  it('deletes it with --yes, and it stops appearing in the list', async () => {
    const r = await tm8(['edge', 'delete', created, '--yes', '--format', 'json']);
    expect(r.code).toBe(0);
    const after = json<Page>(await tm8(['edge', 'list', '--source', ids.a, '--format', 'json']));
    expect(after.items.map((e) => e.id)).not.toContain(created);
  });

  it('deleting an edge that is gone is a real not-found (exit 5), not a silent success', async () => {
    const r = await tm8(['edge', 'delete', created, '--yes']);
    expect(r.code).toBe(5);
  });

  it('a mutation id replayed against the real ledger does not create a second edge', async () => {
    const id = cmid();
    const first = json<CommandResult>(await tm8([
      'edge', 'create', ids.b, 'relates_to', ids.c, '--mutation-id', id, '--format', 'json',
    ]));
    const second = json<CommandResult>(await tm8([
      'edge', 'create', ids.b, 'relates_to', ids.c, '--mutation-id', id, '--format', 'json',
    ]));
    expect(second.edge?.id).toBe(first.edge?.id);
  });
});

describe('entity connections — G02: composed, NOT independently gated', () => {
  let connection: string;

  beforeAll(async () => {
    const r = json<CommandResult>(await tm8([
      'edge', 'create', ids.a, 'depends_on', ids.c, '--format', 'json',
    ]));
    connection = r.edge!.id;
    // A SECOND connection on the same anchor, so `--limit 1` genuinely has a
    // next page. Without it the paging assertions below would sit behind a
    // null cursor and pass without ever exercising a cursor — the vacuous
    // pass this suite exists to avoid.
    await tm8(['edge', 'create', ids.a, 'relates_to', ids.b, '--format', 'json']);
  });

  it('answers a FLAT Page<EdgeView>, which the frozen projection note does not describe', async () => {
    const r = await tm8(['entity', 'connections', ids.a, '--format', 'json']);
    expect(r.code).toBe(0);
    const page = json<Page>(r);
    // The projection's note still says the frozen row "returns grouped
    // connections". On this tree it does not — see the report; this suite
    // records the observation and changes no frozen file.
    expect(Array.isArray(page.items)).toBe(true);
    expect(page).toHaveProperty('nextCursor');
    expect(page.items.map((e) => e.id)).toContain(connection);
  });

  it('filters by repeated --type and --peer, and both actually narrow the result', async () => {
    const byType = json<Page>(await tm8([
      'entity', 'connections', ids.a, '--type', 'depends_on', '--format', 'json',
    ]));
    expect(byType.items.map((e) => e.id)).toContain(connection);

    const otherType = json<Page>(await tm8([
      'entity', 'connections', ids.a, '--type', 'completed_by', '--format', 'json',
    ]));
    expect(otherType.items.map((e) => e.id)).not.toContain(connection);

    const byPeer = json<Page>(await tm8([
      'entity', 'connections', ids.a, '--peer', ids.c, '--format', 'json',
    ]));
    expect(byPeer.items.map((e) => e.id)).toContain(connection);

    const otherPeer = json<Page>(await tm8([
      'entity', 'connections', ids.a, '--peer', ids.b, '--format', 'json',
    ]));
    expect(otherPeer.items.map((e) => e.id)).not.toContain(connection);
  });

  it('--direction both is accepted here and outgoing/incoming disagree, as they must', async () => {
    const both = json<Page>(await tm8([
      'entity', 'connections', ids.c, '--direction', 'both', '--format', 'json',
    ]));
    expect(both.items.map((e) => e.id)).toContain(connection);

    const outgoing = json<Page>(await tm8([
      'entity', 'connections', ids.c, '--direction', 'outgoing', '--format', 'json',
    ]));
    expect(outgoing.items.map((e) => e.id)).not.toContain(connection);
  });

  it('pages with a real opaque cursor bound to this query fingerprint', async () => {
    const first = json<Page>(await tm8([
      'entity', 'connections', ids.a, '--limit', '1', '--format', 'json',
    ]));
    expect(first.items).toHaveLength(1);
    // Asserted, not guarded: the anchor has two connections, so a truncated
    // page MUST hand back a cursor.
    expect(first.nextCursor).toBeTruthy();

    const second = await tm8([
      'entity', 'connections', ids.a, '--limit', '1', '--cursor', first.nextCursor!, '--format', 'json',
    ]);
    expect(second.code).toBe(0);
    expect(json<Page>(second).items).toHaveLength(1);
    expect(json<Page>(second).items[0]?.id).not.toBe(first.items[0]?.id);

    // The cursor is bound to the filter fingerprint: reusing it under a
    // DIFFERENT filter is refused rather than silently resumed somewhere else.
    const crossed = await tm8([
      'entity', 'connections', ids.a, '--type', 'depends_on', '--limit', '1',
      '--cursor', first.nextCursor!,
    ]);
    expect(crossed.code).toBe(2);
    expect(crossed.stderr).toMatch(/cursor/i);
  });

  it('an unknown entity is a real not-found from the node', async () => {
    const r = await tm8(['entity', 'connections', '00000000-0000-7000-8000-000000000000']);
    expect(r.code).toBe(5);
  });
});

describe('placement apply — G03, including the newly repaired embed variant', () => {
  it('attach creates the real attached_to edge the Server chose', async () => {
    const r = await tm8(['placement', 'apply', ids.a, 'attach', ids.b, '--format', 'json']);
    expect(r.code).toBe(0);
    expect(json<CommandResult>(r).edge?.type).toBe('attached_to');
  });

  it('depend creates depends_on in the Server own orientation, not one this CLI guessed', async () => {
    const r = await tm8(['placement', 'apply', ids.a, 'depend', ids.b, '--format', 'json']);
    expect(r.code).toBe(0);
    const edge = json<CommandResult>(r).edge!;
    expect(edge.type).toBe('depends_on');
    // The RPC writes target -> source. The CLI models none of this.
    expect(edge.source.id).toBe(ids.b);
    expect(edge.target.id).toBe(ids.a);
  });

  it('reparent moves the hierarchy rather than writing an edge', async () => {
    const r = await tm8(['placement', 'apply', ids.c, 'reparent', ids.b, '--format', 'json']);
    expect(r.code).toBe(0);
    expect(json<CommandResult>(r).entity?.id).toBe(ids.c);
  });

  it('EMBED — the repaired path: the message is posted AND the undo token survives', async () => {
    // The confirmed defect was an undo token rejected at INSERT, which rolled
    // back the message the placement had just posted. Both halves are asserted
    // here: the message exists, and a redeemable token came back with it.
    const r = await tm8(['placement', 'apply', ids.a, 'embed', ids.b, '--format', 'json']);
    expect(r.code).toBe(0);
    const result = json<CommandResult>(r);
    expect(result.entity?.id).toBeTruthy();
    expect(result.undo?.token).toBeTruthy();
    expect(typeof result.undo?.label).toBe('string');
    console.log(`[g4] embed undo label from the Server: ${JSON.stringify(result.undo?.label)}`);
  });

  it('LAW O5 — the embed undo renders as a token, never as a delete', async () => {
    // The Server binds this token to `messages.delete`, whose undo is a
    // REDACTION: the body becomes [redacted] and thread history SURVIVES.
    const r = await tm8(['placement', 'apply', ids.a, 'embed', ids.c]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('undo token:');
    expect(r.stdout.toLowerCase()).not.toMatch(/delet|resurrect|history is gone/);
  });

  it('assign writes the real assigned_to edge when the endpoints satisfy the registry', async () => {
    const r = await tm8(['placement', 'apply', ids.a, 'assign', ids.memberId, '--format', 'json']);
    expect(r.code).toBe(0);
    expect(json<CommandResult>(r).edge?.type).toBe('assigned_to');
  });

  it('an intent the Server cannot satisfy is refused by the Server, with stdout untouched', async () => {
    // `assign` needs a member/team_member endpoint; two tasks cannot satisfy it.
    const r = await tm8(['placement', 'apply', ids.a, 'assign', ids.b]);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe('');
  });

  it('a typo intent never reaches the network at all', async () => {
    const r = await tm8(['placement', 'apply', ids.a, 'depends', ids.b]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('depend');
  });
});

describe('the BUILT binary against this same Server', () => {
  it('renders the frozen syntax for every one of this slot rows from the projection', async () => {
    for (const [path, needle] of [
      [['edge', 'list'], '--direction incoming|outgoing'],
      [['edge', 'create'], '<source-entity-id> <edge-type> <target-entity-id>'],
      [['edge', 'update'], '--props <json-source>'],
      [['edge', 'delete'], '--yes'],
      [['edge', 'type', 'list'], 'tm8 edge type list'],
      [['placement', 'apply'], 'attach|assign|depend|subtask|embed|reparent'],
      [['entity', 'connections'], '--peer <entity-id>'],
    ] as const) {
      const r = await cli(['help', ...path, '--format', 'json'], server);
      expect(r.code, path.join(' ')).toBe(0);
      expect(JSON.parse(r.stdout).syntax as string, path.join(' ')).toContain(needle);
    }
  }, BINARY_TIMEOUT_MS);

  it('names --limit <count> and --timeout <seconds>, never a bare <n>', async () => {
    const r = await cli(['help', 'edge', 'list', '--format', 'json'], server);
    expect(JSON.parse(r.stdout).syntax as string).toContain('--limit <count>');
    const root = await cli(['help'], server);
    expect(root.stdout).toContain('--timeout <seconds>');
  }, BINARY_TIMEOUT_MS);

  it('DISPATCHES these paths now that the registry is wired — never exit 8, never "unknown command"', async () => {
    const r = await cli(['edge', 'type', 'list', '--format', 'json'], server);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/unknown command|not implemented in this CLI build/);
    expect((JSON.parse(r.stdout) as { type: string }[]).map((t) => t.type)).toContain('depends_on');
  }, BINARY_TIMEOUT_MS);

  it('creates, lists, connects and deletes a real edge, entirely through the binary', async () => {
    const x = await binTask('binary alpha');
    const y = await binTask('binary beta');

    const created = await cli(['edge', 'create', x, 'relates_to', y, '--format', 'json'], server);
    expect(created.code, created.stderr).toBe(0);
    const edgeId = (JSON.parse(created.stdout) as CommandResult).edge!.id;

    const listed = await cli(
      ['edge', 'list', '--source', x, '--target', y, '--format', 'json'], server);
    expect(listed.code).toBe(0);
    expect((JSON.parse(listed.stdout) as Page).items.map((e) => e.id)).toContain(edgeId);

    // Human mode through the binary still carries the id a follow-up needs,
    // and every diagnostic stays off stdout.
    const human = await cli(['edge', 'list', '--source', x], server);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(edgeId);

    const connections = await cli(['entity', 'connections', x, '--format', 'json'], server);
    expect(connections.code).toBe(0);
    expect((JSON.parse(connections.stdout) as Page).items.map((e) => e.id)).toContain(edgeId);

    // §7.5 through the real binary: destructive without --yes is a local refusal.
    const unconfirmed = await cli(['edge', 'delete', edgeId], server);
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.stdout).toBe('');

    const deleted = await cli(['edge', 'delete', edgeId, '--yes', '--format', 'json'], server);
    expect(deleted.code).toBe(0);
  }, BINARY_TIMEOUT_MS);

  it('carries the frozen exit table out of the real process, not just out of run()', async () => {
    const x = await binTask('binary gamma');
    const y = await binTask('binary delta');

    // Server-owned props.origin -> forbidden -> exit 4.
    const forbidden = await cli(
      ['edge', 'create', x, 'relates_to', y, '--props', '{"origin":"client"}'], server);
    expect(forbidden.code).toBe(4);
    expect(forbidden.stdout).toBe('');

    // A local enum refusal never reaches the network -> exit 2.
    const usage = await cli(['placement', 'apply', x, 'depends', y], server);
    expect(usage.code).toBe(2);

    // An entity that does not exist -> exit 5.
    const missing = await cli(
      ['entity', 'connections', '00000000-0000-7000-8000-000000000000'], server);
    expect(missing.code).toBe(5);
  }, BINARY_TIMEOUT_MS);

  it('LAW O5 through the binary: the embed placement prints a token, never a delete', async () => {
    const x = await binTask('binary embed source');
    const y = await binTask('binary embed anchor');
    const r = await cli(['placement', 'apply', x, 'embed', y], server);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('undo token:');
    expect(r.stdout.toLowerCase()).not.toMatch(/delet|resurrect|history is gone/);
  }, BINARY_TIMEOUT_MS);
});

describe('bind coherence — asserted LAST, before any number is reported', () => {
  it('the migration chain did not move under this suite', async () => {
    console.log(`[g4] bind-start ${server.bindStart.files}/${server.bindStart.digest}`);
    // A throw here is EXPECTED during a landing and means the run must be
    // DISCARDED and re-run, not that anything is broken.
    await server.assertBindCoherent();
  });
});

/**
 * CURSOR TRUNCATION SWEEP — the mechanism, not only the symptom.
 *
 * The class: a `timestamptz` holds MICROSECONDS; a JS `Date` holds only
 * milliseconds, so a cursor that round-trips through one is emitted TRUNCATED.
 * Rounded DOWN the keyset re-admits its own boundary row — duplicates, loops,
 * loud. Rounded UP it SKIPS rows — silent data loss, no error, and a
 * "terminates without duplicates" assertion passes cleanly straight through it.
 *
 * So both halves are asserted, and the second is the one that matters:
 *
 *  1. MECHANISM — the cursor is read back OFF THE WIRE, decoded, and required
 *     to carry SIX fractional digits. That fails at the point of truncation the
 *     moment a `Date` round-trip is reintroduced, instead of waiting for a
 *     paging symptom to appear downstream.
 *  2. EXACTLY-ONCE over a KNOWN FULL SET — the union of every page must EQUAL
 *     the complete set. Duplicate-free is not enough: it is blind to skipping.
 *
 * Both of this slot's paging rows format their cursor timestamp in SQL with
 * `to_char(… .US …)` rather than through a `Date`, so the prediction is that
 * both are immune. That is a DISPROOF to be demonstrated, not assumed — a
 * prediction of immunity is exactly the comfortable result that earns more
 * scrutiny, not less.
 */
describe('cursor fidelity and exactly-once paging — this slot two paging rows', () => {
  const MICROSECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
  let anchor: string;
  let everyEdgeId: string[];

  beforeAll(async () => {
    anchor = await binTask('paging anchor');
    everyEdgeId = [];
    for (let i = 0; i < 5; i++) {
      const peer = await binTask(`paging peer ${i}`);
      const r = json<CommandResult>(await tm8([
        'edge', 'create', anchor, 'relates_to', peer, '--format', 'json',
      ]));
      everyEdgeId.push(r.edge!.id);
    }
  }, 120_000);

  it('PROBE: the microsecond matcher REJECTS a millisecond timestamp', () => {
    // Without this the regex could be wrong in the permissive direction and
    // every fidelity assertion below would pass vacuously.
    expect('2026-07-27T06:34:13.421911Z').toMatch(MICROSECONDS);
    expect('2026-07-27T06:34:13.421Z').not.toMatch(MICROSECONDS);
    expect(new Date('2026-07-27T06:34:13.421911Z').toISOString()).not.toMatch(MICROSECONDS);
  });

  it('edges.list emits a cursor with FULL microsecond fidelity, read off the wire', async () => {
    const page = json<Page>(await tm8([
      'edge', 'list', '--source', anchor, '--limit', '2', '--format', 'json',
    ]));
    expect(page.nextCursor).toBeTruthy();
    const decoded = decodeCursor(page.nextCursor!);
    // k = [fingerprint, timestamp, id]
    expect(String(decoded.k[1])).toMatch(MICROSECONDS);
  }, BINARY_TIMEOUT_MS);

  it('entities.connections emits a cursor with FULL microsecond fidelity', async () => {
    const page = json<Page>(await tm8([
      'entity', 'connections', anchor, '--limit', '2', '--format', 'json',
    ]));
    expect(page.nextCursor).toBeTruthy();
    expect(String(decodeCursor(page.nextCursor!).k[1])).toMatch(MICROSECONDS);
  }, BINARY_TIMEOUT_MS);

  it('edges.list pages EXACTLY ONCE over the complete set — no duplicates AND no skips', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 25; guard++) {
      const argv = ['edge', 'list', '--source', anchor, '--limit', '1', '--format', 'json'];
      if (cursor) argv.push('--cursor', cursor);
      const page: Page = json<Page>(await tm8(argv));
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();                                   // terminates
    expect(new Set(seen).size).toBe(seen.length);                // no duplicates
    expect([...seen].sort()).toEqual([...everyEdgeId].sort());   // and NO SKIPS
  }, BINARY_TIMEOUT_MS);

  it('entities.connections pages EXACTLY ONCE over the complete set', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 25; guard++) {
      const argv = ['entity', 'connections', anchor, '--limit', '1', '--format', 'json'];
      if (cursor) argv.push('--cursor', cursor);
      const page: Page = json<Page>(await tm8(argv));
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...everyEdgeId].sort());
  }, BINARY_TIMEOUT_MS);
});
