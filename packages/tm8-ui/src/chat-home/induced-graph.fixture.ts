/**
 * P0 — THE MEASUREMENT, AS A FIXTURE.
 *
 * Encodes the live-node measurement of 2026-08-16 (design doc §4,
 * docs/features/tm8-chat/CHAT-ENTITY-GRAPH-DESIGN.md): ten seeds in the
 * screenshot's mix — 4 work_session, 2 team_member, 1 channel, 3 task — read
 * with one `entities.connections` call each, yielding:
 *
 *   · 14 induced relations across 4 types
 *     (assigned_to, participates_in, relates_to, working_on);
 *   · 3 hub seeds at degree 60, page-capped (both teammates and one session);
 *   · ordinary tasks at degree 6–11;
 *   · one channel at degree 16 contributing ZERO induced edges (isolated);
 *   · one seed whose read failed — but which still appears in an induced
 *     edge through a PEER's read, so "unread" and "unlinked" stay distinct.
 *
 * This fixture is the acceptance instrument for the model (P1) and the read
 * (P2). If the model disagrees with these numbers, the model is wrong.
 */
import type { EdgeView, EntitySummary } from '@tm8/contract';
import type { GraphSeed, SeedConnections } from './induced-graph';

const pad = (n: number): string => String(n).padStart(12, '0');
/** Valid UUIDv7 shape — the extraction path (R2) only admits these. */
const seedId = (n: number): string => `01900000-00aa-7000-8000-${pad(n)}`;
const externalId = (n: number): string => `01900000-00ee-7000-8000-${pad(n)}`;

export const S1 = seedId(1); // work_session "Fix THis"
export const S2 = seedId(2); // work_session "Task Types run"
export const S3 = seedId(3); // work_session "Board run"
export const S4 = seedId(4); // work_session — its connections read FAILED
export const M1 = seedId(5); // team_member "GPT 5.6 Teammate" (hub)
export const M2 = seedId(6); // team_member "Opus 5 Teammate" (hub)
export const C1 = seedId(7); // channel "deployment" (isolated)
export const T1 = seedId(8); // task "Fix THis"
export const T2 = seedId(9); // task "All CHAT UI Modes"
export const T3 = seedId(10); // task "Task Types"

const TITLES: Readonly<Record<string, { kind: string; title: string }>> = {
  [S1]: { kind: 'work_session', title: 'Fix THis' },
  [S2]: { kind: 'work_session', title: 'Task Types run' },
  [S3]: { kind: 'work_session', title: 'Board run' },
  [S4]: { kind: 'work_session', title: 'Stalled run' },
  [M1]: { kind: 'team_member', title: 'GPT 5.6 Teammate' },
  [M2]: { kind: 'team_member', title: 'Opus 5 Teammate' },
  [C1]: { kind: 'channel', title: 'deployment' },
  [T1]: { kind: 'task', title: 'Fix THis' },
  [T2]: { kind: 'task', title: 'All CHAT UI Modes' },
  [T3]: { kind: 'task', title: 'Task Types' },
};

export function summaryOf(id: string): EntitySummary {
  const known = TITLES[id] ?? { kind: 'doc', title: `External ${id.slice(-4)}` };
  return {
    id,
    kind: known.kind,
    title: known.title,
    activityAt: '2026-08-16T00:00:00.000Z',
  } as unknown as EntitySummary;
}

export function edgeOf(fromId: string, type: string, toId: string): EdgeView {
  return {
    id: `edge:${type}:${fromId}:${toId}`,
    type,
    source: summaryOf(fromId),
    target: summaryOf(toId),
    props: {},
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  } as unknown as EdgeView;
}

/**
 * THE 14 INDUCED RELATIONS (both endpoints in the seed set), verbatim from
 * the measurement's shape: task↔teammate↔session triangles over four types.
 */
const INDUCED: readonly [string, string, string][] = [
  [T1, 'assigned_to', M1],
  [T2, 'assigned_to', M2],
  [T3, 'assigned_to', M2],
  [M1, 'participates_in', T1],
  [M2, 'participates_in', T2],
  [M2, 'participates_in', T3],
  [T2, 'relates_to', M2], // parallel with assigned_to/participates_in — R4
  [S1, 'working_on', T1], // session and task share a title — Q4
  [S2, 'working_on', T2],
  [S3, 'working_on', T3],
  [M1, 'participates_in', S1],
  [M2, 'participates_in', S2],
  [M2, 'participates_in', S3],
  [S4, 'relates_to', T1], // S4's own read failed; this arrives via T1's read
];

/** Every induced relation touching `id` — an edge appears in BOTH endpoints'
 *  connections pages, which is exactly how the live read behaves and what
 *  forces the model to dedupe. */
function inducedTouching(id: string): EdgeView[] {
  return INDUCED.filter(([from, , to]) => from === id || to === id).map(([from, type, to]) =>
    edgeOf(from, type, to),
  );
}

/** Pad a seed's page with external (non-induced) edges up to `degree`. */
let externalSeq = 0;
function padded(id: string, degree: number): EdgeView[] {
  const edges = inducedTouching(id);
  while (edges.length < degree) {
    edges.push(edgeOf(id, 'messaged', externalId((externalSeq += 1))));
  }
  return edges;
}

/** The screenshot's mix, in first-reference order, bare-id (no extraction
 *  titles) so resolution must come from the edge payload (F2 → R7a). */
export function measuredSeeds(): GraphSeed[] {
  return [S1, S2, S3, S4, M1, M2, C1, T1, T2, T3].map((id) => ({
    id,
    mutated: id === T1, // the conversation edited one task; read the rest
  }));
}

export function measuredConnections(): Map<string, SeedConnections> {
  externalSeq = 0;
  const loaded = (edges: EdgeView[], pageCapped = false): SeedConnections => ({
    state: 'loaded',
    edges,
    pageCapped,
  });
  return new Map<string, SeedConnections>([
    // Hubs: degree 60, page-capped — both teammates and one session (F3).
    [S1, loaded(padded(S1, 60), true)],
    [M1, loaded(padded(M1, 60), true)],
    [M2, loaded(padded(M2, 60), true)],
    // Ordinary seeds: degree 6–11 (F3).
    [S2, loaded(padded(S2, 6))],
    [S3, loaded(padded(S3, 7))],
    [T1, loaded(padded(T1, 8))],
    [T2, loaded(padded(T2, 7))],
    [T3, loaded(padded(T3, 8))],
    // The channel: degree 16, zero induced edges (F4 — isolated is real).
    [C1, loaded(padded(C1, 16))],
    // One read failed (R11) — distinct from isolated.
    [S4, { state: 'failed' }],
  ]);
}

/** The measured answers P1 must reproduce. */
export const MEASURED = {
  seedCount: 10,
  inducedRelations: 14,
  mergedLines: 10,
  relationTypes: ['assigned_to', 'participates_in', 'relates_to', 'working_on'],
  hubIds: [S1, M1, M2],
  isolatedIds: [C1],
  unreadIds: [S4],
} as const;
