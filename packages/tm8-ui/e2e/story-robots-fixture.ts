/** Robot evidence fixtures: the same story graph with a chosen number of live sessions and one attention request beside a live task. No server writes. */
import { STORY_FIXTURE } from '../src/story/fixture';
import type { StorySession, StoryNode } from '../src/story/model';
import { TASK_KIND, VIEW_OF_KIND } from '../src/story/model';

/** `live` live sessions (0 keeps only the finished ones); `attention` adds a pending request on the first live session's task. */
export function robotsFixture(live: number, attention: boolean) {
  const view = structuredClone(STORY_FIXTURE);
  const finished = view.page.sessions.filter((s) => !s.live);
  const running = view.page.sessions.filter((s) => s.live);
  const tasks = view.page.nodes.filter((n) => n.kind === TASK_KIND && n.id !== view.id && n.depth >= 0);
  const extra: StorySession[] = Array.from({ length: Math.max(0, live - running.length) }, (_, i) => ({
    ...running[i % Math.max(1, running.length)]!, id: `robot-extra-${i}`, callSign: `X${i}`, title: `Extra worker ${i}`,
    taskIds: i % 3 === 2 ? [] : [tasks[(i * 2) % tasks.length]!.id],
  }));
  view.page.sessions = [...finished, ...running.slice(0, live), ...extra];
  const liveSessions = view.page.sessions.filter((s) => s.live);
  view.state.liveSessionCount = liveSessions.length;
  if (attention) {
    const target = liveSessions.map((s) => s.taskIds[0]).find((id): id is string => !!id && view.page.nodes.some((n) => n.id === id));
    const kind = Object.keys(VIEW_OF_KIND).find((k) => k !== TASK_KIND && VIEW_OF_KIND[k] === VIEW_OF_KIND[TASK_KIND])!;
    if (target) {
      const task = view.page.nodes.find((n) => n.id === target)!;
      const node: StoryNode = { id: 'robot-attention', kind, title: 'approve the plan?', status: 'pending', statusCategory: 'to_do', blocked: false, depth: task.depth + 1, rootIds: task.rootIds, activityAt: null, createdAt: task.createdAt };
      view.page.nodes.push(node);
      view.page.edges.push({ id: 'robot-attention-edge', fromId: node.id, toId: task.id, type: 'about', family: 'parent', cross: false, rootIds: task.rootIds });
      for (const r of view.page.roots) if (task.rootIds.includes(r.id)) r.trail.push({ id: node.id, kind, title: node.title, viaId: task.id, depth: node.depth, edgeType: 'about', family: 'parent', direction: 'in' });
    }
    view.state.pendingAttentionCount = Math.max(1, view.state.pendingAttentionCount);
  } else view.state.pendingAttentionCount = 0;
  Object.assign(STORY_FIXTURE, view);
  return STORY_FIXTURE;
}
