/** Synthetic examples only; no private workspace snapshot data. */
import type { MapEntity, MapInput, MapScope } from './types';
export const FIXTURE_SCOPE: MapScope = { kind: 'story', id: 'demo-story' };
const entity = (id: string, kind: string, title: string, extra: Partial<MapEntity> = {}): MapEntity => ({ id, kind, title, status: 'open', progress: null, createdAt: '2026-01-01T00:00:00Z', storyIds: [FIXTURE_SCOPE.id], ...extra });
export function smallFixture(): MapInput {
  return { scope: FIXTURE_SCOPE, entities: [
    entity('task-foundation', 'task', 'Build the harbour', { status: 'working', progress: 0.42, pointsEstimate: 8, mailbox: { count: 3 }, pendingAttention: 1 }),
    entity('task-plans', 'task', 'Draw the harbour plans', { parentId: 'task-foundation', progress: 0.18, pointsEstimate: 3 }),
    entity('task-review', 'task', 'Review the gate', { status: 'in_review', progress: 0.86 }),
    entity('task-blocked', 'task', 'Bridge needs timber', { status: 'blocked', progress: 0.34 }),
    entity('task-done', 'task', 'Town square', { status: 'done', progress: 0.61, subtreeWeight: 8 }),
    entity('task-open-child', 'task', 'Finish the square gardens', { parentId: 'task-done', progress: 0.12 }),
    entity('task-cancelled', 'task', 'Old watchtower', { status: 'cancelled', progress: 0.3 }),
    entity('session-builder', 'work_session', 'Cedar · builder', { status: 'running', processState: 'running', live: true }),
    entity('session-child', 'work_session', 'Cedar · helper', { parentId: 'session-builder', status: 'idle', processState: 'idle', live: true }),
    entity('session-ended', 'work_session', 'Survey expedition', { status: 'failed', endedKind: 'failed', live: false }),
    entity('session-done', 'work_session', 'Completed survey', { status: 'completed', endedKind: 'completed', live: false }),
    entity('staff-cedar', 'team_member', 'Cedar'), entity('skill-carpentry', 'skill', 'Carpentry'),
    entity('doc-plans', 'doc', 'Harbour plans'), entity('doc-detail', 'doc', 'Gate joinery', { parentId: 'doc-plans' }),
    entity('artifact-square', 'artifact', 'Town square preview'), entity('drawing-gate', 'drawing', 'Gate elevation'), entity('file-survey', 'file', 'Survey measurements'),
    entity('project-harbour', 'project', 'Harbour project'), entity('pr-gate', 'pull_request', 'Build the gate'), entity('commit-gate', 'commit', 'Gate foundation'), entity('worktree-gate', 'worktree', 'Gate worktree'),
    entity('child-story', 'story', 'The mountain trail', { parentId: FIXTURE_SCOPE.id }),
  ], edges: [
    { id: 'claim-builder', type: 'working_on', fromId: 'session-builder', toId: 'task-foundation', status: 'working' },
    { id: 'claim-plans', type: 'working_on', fromId: 'session-builder', toId: 'task-plans', status: 'working' },
    { id: 'claim-helper', type: 'working_on', fromId: 'session-child', toId: 'task-foundation', status: 'waiting' },
    { id: 'claim-ended', type: 'working_on', fromId: 'session-ended', toId: 'task-blocked' },
    { id: 'claim-historical', type: 'working_on', fromId: 'session-builder', toId: 'task-review', endedAt: '2026-01-02T00:00:00Z' },
    { id: 'dependency-gate', type: 'depends_on', fromId: 'task-foundation', toId: 'task-blocked' },
    { id: 'produced-square', type: 'produces', fromId: 'task-done', toId: 'artifact-square' },
  ] };
}
export function nestedFixture(): MapInput {
  let data = smallFixture();
  for (let depth = 1; depth <= 5; depth++) {
    data = { ...data, entities: [...data.entities, entity(`nested-${depth}`, 'task', `Nested workshop · level ${depth}`, { parentId: depth === 1 ? 'task-foundation' : `nested-${depth - 1}`, status: ['open', 'working', 'blocked', 'in_review'][depth % 4], progress: depth / 7 })] };
  }
  return data;
}
export function denseFixture(count = 1000): MapInput {
  const statuses = ['open', 'working', 'in_review', 'blocked'];
  return { scope: FIXTURE_SCOPE, entities: Array.from({ length: count }, (_, i) => entity(`dense-${String(i).padStart(4, '0')}`, 'task', `Workshop ${i + 1}`, {
    parentId: i % 10 === 0 ? null : `dense-${String(i - i % 10).padStart(4, '0')}`,
    status: statuses[i % 4], progress: (i % 101) / 100, pointsEstimate: 1 + i % 5,
  })), edges: [] };
}
export function pathologicalFixture(): MapInput {
  return { scope: FIXTURE_SCOPE, entities: [
    ...smallFixture().entities,
    entity('orphan', 'task', 'Missing parent', { parentId: 'absent-parent' }),
    entity('cycle-a', 'task', 'Cycle A', { parentId: 'cycle-b' }), entity('cycle-b', 'task', 'Cycle B', { parentId: 'cycle-a' }),
    entity('self-parent', 'task', 'Self parent', { parentId: 'self-parent' }),
    entity('long-title', 'task', 'A very long workshop title — '.repeat(30)),
  ], edges: smallFixture().edges };
}
export const MAP_FIXTURES = {
  empty: (): MapInput => ({ scope: FIXTURE_SCOPE, entities: [], edges: [] }),
  small: smallFixture, nested: nestedFixture, dense: () => denseFixture(1000), pathological: pathologicalFixture,
};
