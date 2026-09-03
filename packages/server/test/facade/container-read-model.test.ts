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
import { describe, expect, it } from 'vitest';

import { EntityContentSchema, EntityStateSchema } from '@tm8/contract';
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

  it('gates start on stopped and stop on running', () => {
    expect(caps({ ctr_status: 'stopped' }).canStart).toBe(true);
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
