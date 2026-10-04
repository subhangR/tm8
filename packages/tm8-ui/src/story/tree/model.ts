import { getKind } from '../../domain/registry';
import { STORY_KIND, type StoryNode, type StoryView } from '../model';

export const PAGE_SIZE = 25;
export const ALL_KINDS = '*';
const KIND_ORDER = ['task', 'work_session', 'doc', 'drawing', 'story'];

export function kindLabel(kind: string, plural = false): string {
  const labels: Record<string, [string, string]> = { doc: ['Document', 'Documents'], work_session: ['Session', 'Sessions'] };
  if (labels[kind]) return labels[kind][plural ? 1 : 0];
  const registered = getKind(kind);
  return registered.kind === kind
    ? plural ? registered.labelPlural : registered.label
    : kind.replace(/_/g, ' ');
}

export interface Relation {
  peer: StoryNode;
  type: string;
  direction: 'out' | 'in';
  key: string;
}

/** A hierarchy is made only from parent links. Connections never masquerade as children. */
export function storyTree(view: StoryView) {
  const nodes = new Map(view.page.nodes.map(n => [n.id, n]));
  const add = (n: Pick<StoryNode, 'id' | 'kind' | 'title' | 'status' | 'statusCategory'> & Partial<StoryNode>) => {
    if (!nodes.has(n.id)) nodes.set(n.id, {
      blocked: false, depth: 0, rootIds: [], activityAt: null, createdAt: '', ...n,
    });
  };
  add({ id: view.id, kind: STORY_KIND, title: view.title, status: view.status, statusCategory: view.statusCategory });
  for (const r of view.page.roots) add(r);
  for (const c of view.page.childStories) add({ ...c, kind: STORY_KIND, activityAt: c.lastActivityAt });
  for (const t of view.page.team) add({ id: t.id, kind: t.kind, title: t.name, status: null, statusCategory: null });
  for (const s of view.page.sessions) add({ ...s, kind: 'work_session', status: s.runtimeStatus, statusCategory: null });

  const parents = new Map<string, string>();
  const parent = (child: string, owner: string) => {
    if (child === view.id || child === owner || !nodes.has(child) || !nodes.has(owner) || parents.has(child)) return;
    // Malformed or cyclic input still renders every entity exactly once.
    let p: string | undefined = owner;
    while (p) {
      if (p === child) return;
      p = parents.get(p);
    }
    parents.set(child, owner);
  };
  for (const edge of view.page.edges) if (edge.type === 'parent') parent(edge.toId, edge.fromId);
  for (const c of view.page.childStories) parent(c.id, view.id);
  for (const t of view.page.team) if (t.parentId) parent(t.id, t.parentId);

  const children = new Map<string, StoryNode[]>();
  const ranks = new Map(view.page.roots.map((r, i) => [r.id, i]));
  for (const n of nodes.values()) {
    if (n.id === view.id) continue;
    const owner = parents.get(n.id) ?? view.id;
    parents.set(n.id, owner);
    const list = children.get(owner) ?? [];
    list.push(n);
    children.set(owner, list);
  }
  for (const list of children.values()) list.sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));

  const relations = new Map<string, Map<string, Relation[]>>();
  const seen = new Set<string>();
  for (const e of view.page.edges) {
    const key = e.id ?? `${e.fromId}:${e.type}:${e.toId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const [id, peerId, direction] of [[e.fromId, e.toId, 'out'], [e.toId, e.fromId, 'in']] as const) {
      // An endpoint outside the bounded page is still a navigable connection.
      const peer = nodes.get(peerId) ?? { id: peerId, kind: 'entity', title: peerId, status: null,
        statusCategory: null, blocked: false, depth: 0, rootIds: [], activityAt: null, createdAt: '' };
      const groups = relations.get(id) ?? new Map<string, Relation[]>();
      const group = groups.get(peer.kind) ?? [];
      group.push({ peer, type: e.type, direction, key: `${key}:${direction}` });
      groups.set(peer.kind, group);
      relations.set(id, groups);
    }
  }
  const counts = new Map<string, number>();
  for (const n of nodes.values()) if (n.id !== view.id) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
  const kinds = [...counts].sort(([a], [b]) => {
    const rank = (k: string) => KIND_ORDER.includes(k) ? KIND_ORDER.indexOf(k) : KIND_ORDER.length;
    return rank(a) - rank(b) || kindLabel(a).localeCompare(kindLabel(b));
  });
  return { nodes, parents, children, relations, kinds };
}

export type StoryTree = ReturnType<typeof storyTree>;
export interface TreeFilter { kind: string; query: string; status: string; scope: string; kinds?: ReadonlySet<string> | null; hops?: number }

export function filterTree(tree: StoryTree, storyId: string, filter: TreeFilter, pinned?: string) {
  const matches = new Set<string>();
  const withinScope = (n: StoryNode) => {
    if (!filter.scope || n.rootIds.includes(filter.scope)) return true;
    let id: string | undefined = n.id;
    while (id && id !== storyId) {
      if (id === filter.scope) return true;
      id = tree.parents.get(id);
    }
    return false;
  };
  const words = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const n of tree.nodes.values()) {
    if (n.id === storyId || !withinScope(n)) continue;
    if (filter.kind !== ALL_KINDS && n.kind !== filter.kind) continue;
    if (filter.kind === ALL_KINDS && filter.kinds && !filter.kinds.has(n.kind)) continue;
    if (filter.hops !== undefined && n.depth > filter.hops) continue;
    if (filter.status && (filter.status === 'blocked' ? !n.blocked : n.statusCategory !== filter.status)) continue;
    if (words.some(w => !`${n.title} ${n.callSign ?? ''} ${kindLabel(n.kind)}`.toLowerCase().includes(w))) continue;
    matches.add(n.id);
  }
  const visible = new Set(matches);
  const ancestors = new Set<string>();
  if (pinned && pinned !== storyId && tree.nodes.has(pinned)) visible.add(pinned);
  for (const id of [...visible]) {
    let p = tree.parents.get(id);
    while (p && p !== storyId) {
      visible.add(p);
      ancestors.add(p);
      p = tree.parents.get(p);
    }
  }
  return { matches, visible, ancestors };
}
