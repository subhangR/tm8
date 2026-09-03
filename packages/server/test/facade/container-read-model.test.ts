/**
 * The container arms of the read model (TM8-CONTAINERS-DESIGN §3.7, §15).
 *
 * The assertions that matter here are the ones about what is NOT on the read.
 * `internal.command_entity` embeds `entity_content` in the command result a
 * client receives, so anything this function returns reaches the client — R5
 * keeps native runtime ids and host bind-mount paths off it. A leak there is
 * invisible in a passing test suite unless something asks the question
 * directly, which is what the first describe block does.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CONTAINER_STATUSES, EntityCapabilitiesSchema, EntityContentSchema, EntityStateSchema } from '@tm8/contract';
import { Router } from '../../src/http/router.js';
import {
  ENTITY_COLUMNS,
  ENTITY_FROM,
  contentOf,
  entityCapabilities,
  stateOf,
  titleOf,
  type AssemblyContext,
  type EntityRow,
} from '../../src/facade/entity-read.js';

/** The container arms read no actors, relations or reactions — only the row. */
const CTX = {
  actors: new Map(),
  relations: {
    children: new Map(), parents: new Map(), edges: new Map(),
    counts: new Map(), workingActors: new Map(),
  },
  viewerReactions: new Map(),
} as unknown as AssemblyContext;

const NOW = new Date('2026-09-03T00:00:00.000Z');

function containerRow(overrides: Partial<EntityRow> = {}): EntityRow {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    space_id: '00000000-0000-7000-8000-0000000000ff',
    kind: 'container',
    version: 3,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    activity_at: NOW,
    ctr_title: 'build box',
    ctr_status: 'running',
    ctr_profile: 'shell',
    ctr_provider: 'docker',
    ctr_isolation: 'gvisor',
    ctr_node_id: 'node-a',
    ctr_image: 'ghcr.io/subhangr/tm8/shell:1',
    ctr_spec: {
      profile: 'shell', cpus: 2, memMiB: 2048,
      mounts: [{ guest: '/workspace', ro: false }],
      env: { NODE_ENV: 'production' }, ports: [3000],
      network: { preset: 'balanced', allow: [] }, surfaces: {}, labels: {},
    },
    ctr_lifecycle: { ephemeral: true, ttlSeconds: 3600, graceSeconds: 600 },
    ctr_surfaces: ['terminal'],
    ctr_share_mode: 'space',
    ctr_started_at: NOW,
    ctr_expires_at: null,
    ctr_error: null,
    ctr_exposed: [{ port: 3000, url: '/v2/containers/x/ports/3000/' }],
    ctr_usage: { cpuPct: 12, memMiB: 400, diskMiB: 900 },
    ...overrides,
  } as EntityRow;
}

describe('R5 — what the read model must NEVER carry', () => {
  it('does not SELECT runtime_ref or host_spec at all', () => {
    // Asserted against the query text rather than a row, because the leak
    // would happen at the SELECT: a column that is never fetched cannot be
    // returned by accident later.
    expect(ENTITY_COLUMNS).not.toMatch(/runtime_ref/);
    expect(ENTITY_COLUMNS).not.toMatch(/host_spec/);
    expect(ENTITY_FROM).toMatch(/left join public\.containers ctr/);
  });

  it('emits no runtimeRef in content, even with a status that has one', () => {
    const content = contentOf(containerRow());
    expect(content).not.toHaveProperty('runtimeRef');
  });

  it('emits guest-only mounts', () => {
    const content = contentOf(containerRow()) as { spec: { mounts: unknown[] } };
    expect(content.spec.mounts).toEqual([{ guest: '/workspace', ro: false }]);
    expect(JSON.stringify(content)).not.toMatch(/"host"/);
  });
});

describe('the exposures aggregate stays on the RLS path', () => {
  // WHY THIS IS A TEST AND NOT A COMMENT. `container_exposures` carries
  // per-port RLS (`using internal.entity_readable(container_entity_id)`) and a
  // `share_token_hash` column. RLS only fires for the CALLER's role: a
  // SECURITY DEFINER body runs as `tm8_graph_owner` and the policy does not
  // apply, so the same aggregate moved into a definer function would return
  // exposures on containers the viewer may read but whose ports they should
  // not — and it would return rows either way, so nothing would look wrong.
  //
  // That is the #407 / mig 156-160 trap, which has already cost this repo a
  // PR. `ENTITY_FROM` is only ever interpolated into `q.query` inside
  // `db.tx(claimsFor(...))`, which does `set_config('role', …, true)` with
  // `tm8_app` as the default — so today it is correctly on the caller's role.
  //
  // These two assertions are what make that survive someone "optimising" the
  // read into a definer RPC later.
  const source = readFileSync(
    new URL('../../src/facade/entity-read.ts', import.meta.url), 'utf8',
  );

  it('selects the port and the share mode, and NEVER the token hash', () => {
    expect(source).toMatch(/container_exposures/);
    // A hash is not a secret, but it is capability-shaped and has no business
    // on a read that every list row assembles.
    expect(source).not.toMatch(/share_token_hash/);
  });

  it('lives inside ENTITY_FROM — the query that runs under the caller\'s claims', () => {
    // If the aggregate ever moves out of this template it stops being covered
    // by the claims transaction, and this fails rather than going quiet.
    const from = source.slice(
      source.indexOf('export const ENTITY_FROM'),
      source.indexOf('export interface EntityRow'),
    );
    expect(from).toMatch(/left join lateral[\s\S]*container_exposures/);
  });
});

describe('the state arm', () => {
  it('projects the hot fields and validates against the contract', () => {
    const state = stateOf(containerRow(), CTX);
    expect(state).toMatchObject({
      kind: 'container',
      status: 'running',
      profile: 'shell',
      provider: 'docker',
      isolation: 'gvisor',
      nodeId: 'node-a',
      surfaces: ['terminal'],
      ephemeral: true,
      shareMode: 'space',
    });
    expect(EntityStateSchema.safeParse(state).success).toBe(true);
  });

  it('reports an UNKNOWN status as failed, never passes it through', () => {
    // The column is CHECK-constrained, so this only fires on a node reading a
    // newer database than its build. "Something is wrong with this container"
    // is the honest answer; a value the client's exhaustive switch has no arm
    // for is not.
    const state = stateOf(containerRow({ ctr_status: 'teleporting' }), CTX) as { status: string };
    expect(state.status).toBe('failed');
  });

  it('degrades an unknown isolation class DOWNWARD, to process', () => {
    // `process` is the weakest class. Guessing upward would tell a reader
    // their container is better contained than it is.
    const state = stateOf(containerRow({ ctr_isolation: 'quantum' }), CTX) as { isolation: string };
    expect(state.isolation).toBe('process');
  });

  it('drops a surface kind the contract does not know', () => {
    const state = stateOf(containerRow({ ctr_surfaces: ['terminal', 'hologram'] }), CTX) as { surfaces: string[] };
    expect(state.surfaces).toEqual(['terminal']);
  });
});

describe('the content arm', () => {
  it('validates against the contract', () => {
    expect(EntityContentSchema.safeParse(contentOf(containerRow())).success).toBe(true);
  });

  it('marks surfaces live ONLY while the container is running', () => {
    // A recorded surface on a stopped container is a fact about its shape,
    // not about a pipe anything can attach to.
    const live = contentOf(containerRow()) as { surfaceDetail: Record<string, { live: boolean }> };
    expect(live.surfaceDetail.terminal).toEqual({ live: true });
    const stopped = contentOf(containerRow({ ctr_status: 'stopped' })) as {
      surfaceDetail: Record<string, { live: boolean }>;
    };
    expect(stopped.surfaceDetail.terminal).toEqual({ live: false });
  });

  it('omits a surface key the container does not have — surfaceDetail is PARTIAL', () => {
    const content = contentOf(containerRow()) as { surfaceDetail: Record<string, unknown> };
    expect(content.surfaceDetail).not.toHaveProperty('screen');
    expect(Object.keys(content.surfaceDetail)).toEqual(['terminal']);
  });

  it('reports usage as NULL when no heartbeat has landed, never as zeros', () => {
    // Zeros would draw an idle machine. Null is a measured absence and renders
    // nothing.
    const content = contentOf(containerRow({ ctr_usage: null })) as { usage: unknown };
    expect(content.usage).toBeNull();
  });

  it('fills a missing lifecycle with the documented defaults', () => {
    const content = contentOf(containerRow({ ctr_lifecycle: null })) as {
      lifecycle: { ephemeral: boolean; graceSeconds: number; ttlSeconds: number | null };
    };
    expect(content.lifecycle).toMatchObject({
      ephemeral: true, graceSeconds: 600, ttlSeconds: null,
    });
  });
});

describe('the capabilities the server computes SURVIVE the contract schema', () => {
  // THE ROUND TRIP, and it is the whole point: server output -> strict schema.
  //
  // `EntityCapabilitiesSchema` is `.strict()`, so a member the server emits and
  // the schema omits is `unrecognized_keys` — and every container detail then
  // fails `EntityDetailSchema`. That is exactly what happened: the six verbs
  // were added to the `EntityCapabilities` INTERFACE and not to the schema.
  //
  // `tsc` cannot see it. `z.ZodType<T>` only requires the schema to PRODUCE a
  // valid `T`, and a schema missing an OPTIONAL member still does — so the
  // annotation type-checks while the runtime schema is incomplete. Asserting
  // the shapes match is not enough; the emitted object has to be parsed.
  it('parses a container capability object through the strict schema', () => {
    const emitted = entityCapabilities(containerRow());
    const parsed = EntityCapabilitiesSchema.safeParse(emitted);
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues),
    ).toBe(true);
  });

  it('parses across every status, so no arm emits a member the schema refuses', () => {
    for (const status of CONTAINER_STATUSES) {
      const emitted = entityCapabilities(containerRow({ ctr_status: status }));
      const parsed = EntityCapabilitiesSchema.safeParse(emitted);
      expect(parsed.success, `${status}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`)
        .toBe(true);
    }
  });

  it('POSITIVE CONTROL — the strict schema DOES reject an unknown capability', () => {
    // Without this, the two assertions above would pass just as happily against
    // a non-strict schema, and would prove nothing about the defect they guard.
    const bogus = { ...entityCapabilities(containerRow()), canTeleport: true };
    expect(EntityCapabilitiesSchema.safeParse(bogus).success).toBe(false);
  });
});

describe('the derived expose URL actually routes', () => {
  // THE TWO HALVES ARE ONE CHANGE, and this is the assertion that says so.
  //
  // `containers.expose` returns a URL, the CLI PRINTS IT TO A USER
  // (`port 8080 -> <url>`), and the panel puts it in the ports section. The
  // read model DERIVES that URL from (containerId, port) rather than storing
  // it — right, because a stored URL would keep asserting a path after
  // `containers.proxy`'s binding moved.
  //
  // But deriving it makes the derivation's target load-bearing, and that
  // target could not be routed at all until `compileRoute` learned a trailing
  // `*`: the asterisk was escaped into a literal, so the route matched a path
  // containing `*` and nothing a browser sends. Without this test the two
  // fixes are separately green and jointly broken — a working verb handing
  // out a link that 404s, which the user would reasonably blame on `expose`.
  const router = new Router();

  const derivedUrls = () => {
    const content = contentOf(containerRow({
      ctr_exposed: [{ port: 8080, share: 'none' }, { port: 3000, share: 'space' }],
    })) as { exposed: Array<{ port: number; url: string }> };
    return content.exposed;
  };

  it('derives one URL per exposed port, from the id and the port', () => {
    expect(derivedUrls()).toEqual([
      { port: 8080, url: '/v2/containers/00000000-0000-7000-8000-000000000001/ports/8080/' },
      { port: 3000, url: '/v2/containers/00000000-0000-7000-8000-000000000001/ports/3000/' },
    ]);
  });

  it('every derived URL RESOLVES through the real router to containers.proxy', () => {
    for (const { port, url } of derivedUrls()) {
      const match = router.match('GET', url);
      expect(match, `derived URL does not route: ${url}`).toBeDefined();
      expect(match!.opName).toBe('containers.proxy');
      expect(match!.params.port).toBe(String(port));
      // The INDEX request — a bare trailing slash with an empty remainder.
      // This is the case lane C's probe showed the old pattern failing, and
      // the reason the wildcard compiles to `(.*)` and not `(.+)`.
      expect(match!.params.rest).toBe('');
    }
  });

  it('routes a real asset path below the derived URL, slashes included', () => {
    const { url } = derivedUrls()[0]!;
    const match = router.match('GET', `${url}assets/app.js`);
    expect(match?.opName).toBe('containers.proxy');
    // `([^/]+)` could never carry this, which is why the grammar needed a
    // wildcard rather than another `:param`.
    expect(match?.params.rest).toBe('assets/app.js');
  });
});

describe('titleOf', () => {
  it('uses the container\'s own title', () => {
    expect(titleOf(containerRow())).toBe('build box');
  });

  it('falls back rather than rendering an id (L3)', () => {
    expect(titleOf(containerRow({ ctr_title: null }))).toBe('Container');
  });
});

describe('capabilities (§15)', () => {
  const caps = (over: Partial<EntityRow> = {}) => entityCapabilities(containerRow(over));

  it('gates start on stopped OR PAUSED, and stop on running or paused', () => {
    expect(caps({ ctr_status: 'stopped' }).canStart).toBe(true);
    // 177's transition table admits BOTH `stopped -> running` and
    // `paused -> running`. With `canStart <=> stopped` alone a paused container
    // had `canStop` true and nothing to bring it back — a UI dead end for a
    // legal transition. One boolean gates both doors; the UI labels by status.
    expect(caps({ ctr_status: 'paused' }).canStart).toBe(true);
    expect(caps({ ctr_status: 'running' }).canStart).toBe(false);
    expect(caps({ ctr_status: 'running' }).canStop).toBe(true);
    expect(caps({ ctr_status: 'paused' }).canStop).toBe(true);
    expect(caps({ ctr_status: 'stopped' }).canStop).toBe(false);
  });

  it('refuses destroy once destroying or destroyed', () => {
    expect(caps({ ctr_status: 'running' }).canDestroy).toBe(true);
    expect(caps({ ctr_status: 'destroying' }).canDestroy).toBe(false);
    expect(caps({ ctr_status: 'destroyed' }).canDestroy).toBe(false);
  });

  it('does NOT make a terminal-only container attachable', () => {
    // `terminal` is reached through `containers.terminal.start`, which mints a
    // real work_session — it is not a surface grant, so it must not light up
    // an Attach control that would mint a grant nothing can serve.
    expect(caps({ ctr_surfaces: ['terminal'] }).canAttach).toBe(false);
    expect(caps({ ctr_surfaces: ['terminal', 'screen'] }).canAttach).toBe(true);
  });

  it('gates exec on running, and attach on running too', () => {
    expect(caps({ ctr_status: 'running' }).canExec).toBe(true);
    expect(caps({ ctr_status: 'stopped' }).canExec).toBe(false);
    expect(caps({ ctr_status: 'stopped', ctr_surfaces: ['screen'] }).canAttach).toBe(false);
  });

  it('grants canControl ONLY when the row alone settles it', () => {
    // `capabilitiesOf` receives an EntityRow and no viewer, so no capability
    // here can be actor-dependent. `share_mode = 'space'` is the one value the
    // ROW can settle: every reader may drive, and RLS has already established
    // this viewer is a reader.
    const attachable: Partial<EntityRow> = { ctr_surfaces: ['terminal', 'screen'] };
    expect(caps({ ...attachable, ctr_share_mode: 'space' }).canControl).toBe(true);
    // A deliberate FALSE NEGATIVE: the row cannot tell whether THIS viewer is
    // the creator or on the explicit list, so it refuses rather than hand a
    // view-only viewer a control that `grant_surface_attach` answers with
    // `42501 attach refused`.
    expect(caps({ ...attachable, ctr_share_mode: 'none' }).canControl).toBe(false);
    expect(caps({ ...attachable, ctr_share_mode: 'explicit' }).canControl).toBe(false);
  });

  it('keeps canAttach permissive where canControl is not — view is not drive', () => {
    // The pair is the point: VIEW is justified by a live surface, DRIVE is an
    // authorization the row cannot answer. If these two ever collapse into one
    // value, the drive/view split that `grant_surface_attach`'s `p_mode`
    // decides has been thrown away here instead.
    const row: Partial<EntityRow> = {
      ctr_surfaces: ['terminal', 'screen'], ctr_share_mode: 'none',
    };
    expect(caps(row).canAttach).toBe(true);
    expect(caps(row).canControl).toBe(false);
  });

  it('keeps canDelete FALSE — a container is destroyed, not deleted', () => {
    // `entities.delete` refuses the kind, so offering the control would be a
    // lie whose only outcome is a 403.
    expect(caps().canDelete).toBe(false);
  });

  it('leaves the six ABSENT on every other kind', () => {
    // Absence means "this kind has no such verb", and a consumer renders no
    // control rather than a disabled one.
    const task = entityCapabilities({
      ...containerRow(), kind: 'task', work_status: 'open',
    } as EntityRow);
    expect(task.canStart).toBeUndefined();
    expect(task.canAttach).toBeUndefined();
    expect(task.canExec).toBeUndefined();
  });
});
