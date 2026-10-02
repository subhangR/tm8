/**
 * The story graph's layout — pure geometry from a `StoryView`, no DOM.
 *
 * The shape is the artifact's (01a0fc3e rev 4): the story at the top with its
 * child stories beside it and its own trail further right; coordinators on
 * the left flank and dispatchers on the right, outside the fan of story-to-
 * root edges; the roots across; each root's children down its left and its
 * trail down its right. A task with a live session is ONE capsule (task +
 * session + teammate, `liveOn`), so the session and the worker fold into it.
 *
 * It holds for any page, not just the fixture: the canvas widens with the
 * root count, every column and flank is capped with a "+N more" note, and
 * every title is wrapped or truncated to the space its node owns. Nothing is
 * a figure — every number on a node comes from the server's read.
 */
import type { TeamMemberMode } from '@tm8/contract';

import {
  liveOn,
  isRecent,
  since,
  STORY_KIND,
  TEAMMATE_KIND,
  storyEdgeFamily,
  toneOf,
  VIEW_OF_KIND,
  type StoryEdgeFamily,
  type StoryGraphView,
  type StoryNode,
  type StoryPerson,
  type StorySession,
  type StoryTeammate,
  type StoryTone,
  type StoryView,
  teammatesOf,
} from '../model';

export type GraphRole = 'self' | 'child-story' | 'story-trail' | 'teammate' | 'root' | 'child' | 'trail';

export interface GraphCapsule {
  session: StorySession;
  person: StoryPerson | null;
  /** "Cedar · Forge · live · 12 min". */
  line: string;
  initials: string;
}

export interface GraphNode {
  id: string;
  kind: string;
  title: string;
  role: GraphRole;
  x: number;
  y: number;
  /** Disc radius; a capsule or teammate is a box `w`×`h` instead. */
  r: number;
  w: number;
  h: number;
  tone: StoryTone | null;
  /** A session whose runtime has ended: drawn dashed. */
  exited: boolean;
  /** Active in the last hour: drawn with a halo. */
  recent: boolean;
  rootIds: string[];
  /** The view this node belongs to; `all` = shown in every view. Null = Everything only. */
  view: StoryGraphView | null;
  /** The story and the roots: kept as context in every view. */
  spine: boolean;
  lines: string[];
  /** Small mono caption under the title: the edge that reached it, a mode, a child story's tally. */
  caption: string | null;
  capsule: GraphCapsule | null;
  /** Teammates: the avatar text and whether a session of theirs is live. */
  initials: string | null;
  live: boolean;
}

export interface GraphEdge {
  key: string;
  from: string;
  to: string;
  type: string;
  family: StoryEdgeFamily;
  cross: boolean;
  team: boolean;
  exited: boolean;
  rootIds: string[];
  d: string;
  /** Edges with no node to carry their name are labelled on the line. */
  label: { x: number; y: number; text: string; anchor: 'start' | 'middle' } | null;
}

export interface GraphNote {
  x: number;
  y: number;
  text: string;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  notes: GraphNote[];
  allRootIds: string[];
}

/* ---- geometry: the artifact's numbers ---- */
const BASE_W = 1216;
const COL = 243;
const STORY_Y = 44;
const TEAM_Y = 112;
const ROOT_Y = 210;
const ROW0 = 308;
const ROW = 70;
/** Rows per child / trail column before "+N more". */
const MAX_ROWS = 8;
const MAX_CHILD_STORIES = 3;
const FLANK_STEP = 140;

/** Which flank a teammate stands on, by tm8's own mode. Workers live inside their capsules. */
const FLANK_OF_MODE: Readonly<Record<TeamMemberMode, 'left' | 'right' | 'capsule'>> = {
  coordinator: 'left',
  'coordinated-coordinator': 'left',
  dispatcher: 'right',
  'coordinated-worker': 'capsule',
  worker: 'capsule',
};

/** Edge types drawn with their name on the line. */
const LABELLED_FAMILIES: ReadonlySet<StoryEdgeFamily> = new Set(['blocks']);

const MODE_CAPTION: Readonly<Record<TeamMemberMode, string>> = {
  coordinator: 'coordinator',
  'coordinated-coordinator': 'sub-coordinator',
  'coordinated-worker': 'worker',
  worker: 'worker',
  dispatcher: 'dispatcher',
};

export function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Up to two lines of at most `max` characters, the last ending in "…" when the title runs on. */
export function wrap(title: string, max = 14): string[] {
  const words = title.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  let used = 0;
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= max) {
      cur = next;
      used += 1;
      continue;
    }
    if (cur) lines.push(cur);
    if (lines.length === 2) break;
    cur = w;
    used += 1;
  }
  if (lines.length < 2 && cur) lines.push(cur);
  const out = lines.slice(0, 2).map((l) => trunc(l, max));
  if ((used < words.length || lines.length > 2 || out.join(' ').length < title.trim().length) && out.length) {
    const last = out[out.length - 1]!;
    if (!last.endsWith('…')) out[out.length - 1] = trunc(`${last}…`, max);
  }
  return out;
}

interface Pt {
  x: number;
  y: number;
}
type Box = Pt & { w: number; h: number };

function bez(p0: Pt, p1: Pt, p2: Pt, p3: Pt) {
  return (t: number): Pt => {
    const u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    };
  };
}

const f = (n: number): string => (Math.round(n * 10) / 10).toString();

/** The artifact's curve: straight-ish S-curves between columns, arcs for links that would cut through one. */
function curve(a: Box, b: Box, bulge: boolean, arc: number, arcUp?: boolean): { d: string; apex: Pt; at: (t: number) => Pt } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (arc) {
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const m = Math.abs(arc);
    const sgn = arcUp === undefined ? Math.sign(arc) || 1 : (dx >= 0 ? -1 : 1) * (arcUp ? 1 : -1);
    const s = { x: a.x + (dx / len) * (a.w / 2), y: a.y + (dy / len) * (a.h / 2) };
    const e = { x: b.x - (dx / len) * (b.w / 2), y: b.y - (dy / len) * (b.h / 2) };
    const c1 = { x: s.x + dx * 0.25 + nx * m * sgn, y: s.y + dy * 0.25 + ny * m * sgn };
    const c2 = { x: s.x + dx * 0.75 + nx * m * sgn, y: s.y + dy * 0.75 + ny * m * sgn };
    return {
      d: `M${f(s.x)} ${f(s.y)} C ${f(c1.x)} ${f(c1.y)}, ${f(c2.x)} ${f(c2.y)}, ${f(e.x)} ${f(e.y)}`,
      apex: { x: (s.x + e.x) / 2 + nx * m * sgn * 0.75, y: (s.y + e.y) / 2 + ny * m * sgn * 0.75 },
      at: bez(s, c1, c2, e),
    };
  }
  let p0: Pt, p1: Pt, p2: Pt, p3: Pt;
  if (Math.abs(dy) > Math.abs(dx)) {
    const sy = (Math.sign(dy) * a.h) / 2;
    const ey = (-Math.sign(dy) * b.h) / 2;
    p0 = { x: a.x, y: a.y + sy };
    p1 = { x: a.x + (bulge ? 40 : 0), y: a.y + dy * 0.5 };
    p2 = { x: b.x + (bulge ? 40 : 0), y: b.y - dy * 0.5 };
    p3 = { x: b.x, y: b.y + ey };
  } else {
    const sx = (Math.sign(dx) * a.w) / 2;
    const ex = (-Math.sign(dx) * b.w) / 2;
    p0 = { x: a.x + sx, y: a.y };
    p1 = { x: a.x + dx * 0.5, y: a.y };
    p2 = { x: b.x - dx * 0.5, y: b.y };
    p3 = { x: b.x + ex, y: b.y };
  }
  return {
    d: `M${f(p0.x)} ${f(p0.y)} C ${f(p1.x)} ${f(p1.y)}, ${f(p2.x)} ${f(p2.y)}, ${f(p3.x)} ${f(p3.y)}`,
    apex: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    at: bez(p0, p1, p2, p3),
  };
}

export function layoutStoryGraph(view: StoryView, now: number = Date.now()): GraphLayout {
  const page = view.page;
  const byId = new Map(page.nodes.map((n) => [n.id, n]));
  const live = liveOn(view);
  const roots = [...page.roots].sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
  const allRootIds = roots.map((r) => r.id);
  const n = roots.length;
  const width = Math.max(BASE_W, n * COL);
  const cx = width / 2;

  const nodes = new Map<string, GraphNode>();
  /** A folded id (a session inside a capsule, a session of a flank teammate) → the node drawn for it. */
  const alias = new Map<string, string>();
  const notes: GraphNote[] = [];
  const at = (id: string): string => alias.get(id) ?? id;

  const personName = (id: string | null | undefined, fallback: string): string =>
    (id ? view.people[id]?.name : undefined) ?? fallback;

  const capsuleOf = (taskId: string): GraphCapsule | null => {
    const s = live.get(taskId);
    if (!s) return null;
    const person = s.teamMemberId ? view.people[s.teamMemberId] ?? null : null;
    const who = personName(s.teamMemberId, page.team.find((t) => t.id === s.teamMemberId)?.name ?? 'someone');
    return {
      session: s,
      person,
      line: `${s.callSign} · ${who} · live · ${since(s.createdAt, now)}`,
      initials: person?.initials ?? who.slice(0, 1),
    };
  };

  const add = (
    row: Pick<GraphNode, 'id' | 'kind' | 'title' | 'role' | 'x' | 'y'> & Partial<GraphNode>,
    src?: StoryNode | null,
  ): GraphNode => {
    const r = row.r ?? 13;
    const node: GraphNode = {
      r,
      w: r * 2,
      h: r * 2,
      tone: src ? toneOf(src) : null,
      exited: src?.live === false,
      recent: isRecent(src?.activityAt, now),
      rootIds: src?.rootIds ?? [],
      view: VIEW_OF_KIND[row.kind] ?? null,
      spine: false,
      lines: [],
      caption: null,
      capsule: null,
      initials: null,
      live: false,
      ...row,
    };
    nodes.set(node.id, node);
    return node;
  };

  /* ---- the story and its child stories ---- */
  const storyNode = byId.get(view.id);
  add(
    {
      id: view.id, kind: STORY_KIND, title: view.title, role: 'self', x: cx, y: STORY_Y, r: 20,
      rootIds: allRootIds, view: 'all', spine: true, lines: [trunc(view.title, 30)], tone: null,
    },
    storyNode,
  );
  const kids = page.childStories;
  kids.slice(0, MAX_CHILD_STORIES).forEach((c, i) => {
    add({
      id: c.id, kind: STORY_KIND, title: c.title, role: 'child-story', x: cx + 140 + i * 130, y: STORY_Y - 4, r: 14,
      rootIds: allRootIds, view: 'all', lines: wrap(c.title, 16),
      caption: `child story · ${c.taskProgress.done} of ${c.taskProgress.work}`,
      recent: isRecent(c.lastActivityAt, now),
    });
  });
  if (kids.length > MAX_CHILD_STORIES) {
    notes.push({ x: cx + 140 + MAX_CHILD_STORIES * 130 - 40, y: STORY_Y + 4, text: `+${kids.length - MAX_CHILD_STORIES} child stories` });
  }

  /* ---- the team layer: flanks; workers fold into their capsules ---- */
  const capsuleTasks = new Set<string>();
  for (const r of roots) {
    if (live.has(r.id)) capsuleTasks.add(r.id);
    for (const c of r.childIds) if (live.has(c)) capsuleTasks.add(c);
  }
  const capsuleOfMember = (memberId: string): string | null => {
    let fallback: string | null = null;
    for (const t of capsuleTasks) {
      if (live.get(t)?.teamMemberId !== memberId) continue;
      if (allRootIds.includes(t)) return t;
      fallback ??= t;
    }
    return fallback;
  };
  const left: StoryTeammate[] = [];
  const right: StoryTeammate[] = [];
  for (const t of teammatesOf(page)) {
    const flank = t.mode ? FLANK_OF_MODE[t.mode] : 'left';
    if (flank === 'right') right.push(t);
    else if (flank === 'left' || !capsuleOfMember(t.id)) left.push(t);
  }
  const placeFlank = (list: StoryTeammate[], xAt: (i: number) => number, fits: (x: number) => boolean, noteX: (i: number) => number) => {
    let i = 0;
    for (; i < list.length; i += 1) {
      const x = xAt(i);
      if (!fits(x)) break;
      const t = list[i]!;
      add({
        id: t.id, kind: TEAMMATE_KIND, title: t.name, role: 'teammate', x, y: TEAM_Y, r: 13,
        rootIds: allRootIds, view: VIEW_OF_KIND[TEAMMATE_KIND] ?? 'team', lines: [trunc(t.name, 16)],
        caption: t.mode ? MODE_CAPTION[t.mode] : null, live: t.live,
        initials: view.people[t.id]?.initials ?? t.name.slice(0, 1),
      }, byId.get(t.id));
      for (const s of t.sessionIds) if (!live.has(s)) alias.set(s, t.id);
    }
    if (i < list.length) notes.push({ x: noteX(i), y: TEAM_Y + 4, text: `+${list.length - i} teammates` });
  };
  placeFlank(left, (i) => 178 + i * FLANK_STEP, (x) => x <= cx - 150, (i) => 178 + i * FLANK_STEP - 40);
  placeFlank(right, (i) => width - 228 - i * FLANK_STEP, (x) => x >= cx + 150, (i) => width - 228 - i * FLANK_STEP + 40);

  /* Sessions folded into capsules. */
  for (const t of capsuleTasks) {
    const s = live.get(t)!;
    if (!alias.has(s.id)) alias.set(s.id, t);
  }

  /* ---- roots, children down the left, trails down the right ---- */
  let maxRows = 0;
  roots.forEach((root, i) => {
    const rx = cx + (i - (n - 1) / 2) * COL;
    const src = byId.get(root.id);
    const cap = capsuleOf(root.id);
    add(
      {
        id: root.id, kind: root.kind, title: root.title, role: 'root', x: rx, y: ROOT_Y, r: 17,
        rootIds: [root.id], spine: true, capsule: cap, lines: [trunc(root.title, 28)],
        tone: toneOf(root),
        ...(cap ? { w: 198, h: 36 } : {}),
      },
      src,
    );
    let rows: number;
    const kidIds = root.childIds.filter((id) => byId.has(id) && !nodes.has(id));
    kidIds.slice(0, MAX_ROWS).forEach((id, j) => {
      const c = byId.get(id)!;
      const ccap = capsuleOf(id);
      add(
        {
          id, kind: c.kind, title: c.title, role: 'child', x: rx - 60, y: ROW0 + ROW * j, capsule: ccap,
          lines: wrap(c.title, 14), ...(ccap ? { w: 150, h: 30 } : {}),
        },
        c,
      );
    });
    if (kidIds.length > MAX_ROWS) notes.push({ x: rx - 60, y: ROW0 + ROW * MAX_ROWS - 8, text: `+${kidIds.length - MAX_ROWS} more` });
    rows = Math.max(0, Math.min(kidIds.length, MAX_ROWS) + (kidIds.length > MAX_ROWS ? 1 : 0));
    const trail = root.trail.filter((t) => byId.has(t.id) && !nodes.has(t.id) && !alias.has(t.id));
    trail.slice(0, MAX_ROWS).forEach((t, k) => {
      const src = byId.get(t.id)!;
      const sign = src.callSign ? `${src.callSign} · ` : '';
      add(
        {
          id: t.id, kind: t.kind, title: t.title, role: 'trail', x: rx + 60, y: ROW0 + ROW * k,
          lines: wrap(`${sign}${t.title}`, 14), caption: t.edgeType,
        },
        src,
      );
    });
    if (trail.length > MAX_ROWS) notes.push({ x: rx + 60, y: ROW0 + ROW * MAX_ROWS - 8, text: `+${trail.length - MAX_ROWS} more` });
    rows = Math.max(rows, Math.min(trail.length, MAX_ROWS) + (trail.length > MAX_ROWS ? 1 : 0));
    maxRows = Math.max(maxRows, rows);
  });

  /* ---- the story's own trail: followed rows reached from no root ---- */
  const storyTrail = page.nodes.filter((x) => x.depth >= 0 && x.rootIds.length === 0 && !nodes.has(x.id) && !alias.has(x.id));
  const slots: number[] = [];
  const firstRight = Math.max(cx + 520, cx + 140 + Math.min(kids.length, MAX_CHILD_STORIES) * 130);
  for (let x = firstRight; x <= width - 50; x += 120) slots.push(x);
  for (let x = cx - 150; x >= 50; x -= 120) slots.push(x);
  storyTrail.slice(0, slots.length).forEach((x, i) => {
    const edge = page.edges.find((e) => (e.fromId === x.id && e.toId === view.id) || (e.toId === x.id && e.fromId === view.id));
    add(
      {
        id: x.id, kind: x.kind, title: x.title, role: 'story-trail', x: slots[i]!, y: STORY_Y,
        rootIds: allRootIds, view: VIEW_OF_KIND[x.kind] ?? 'all', lines: wrap(x.title, 14), caption: edge?.type ?? null,
      },
      x,
    );
  });
  if (storyTrail.length > slots.length) notes.push({ x: width - 60, y: STORY_Y + 30, text: `+${storyTrail.length - slots.length} more` });

  /* ---- edges ---- */
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const push = (e: { from: string; to: string; type: string; family?: StoryEdgeFamily; cross?: boolean; team?: boolean; bulge?: boolean; rootIds?: string[] }) => {
    const from = at(e.from);
    const to = at(e.to);
    const a = nodes.get(from);
    const b = nodes.get(to);
    if (!a || !b || from === to) return;
    const key = `${from}|${to}|${e.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    const family = e.family ?? storyEdgeFamily(e.type);
    const cross = !!e.cross;
    const team = !!e.team;
    const bothRoots = allRootIds.includes(from) && allRootIds.includes(to);
    const teamArc = team ? (e.type === DISPATCHED ? (Math.abs(b.x - a.x) > 300 ? 120 : 60) : 44) : 0;
    const c = team ? curve(a, b, false, teamArc, true) : curve(a, b, !!e.bulge, cross ? (bothRoots ? -70 : 80) : 0);
    const labelled = cross || team || LABELLED_FAMILIES.has(family);
    /* A straight-down blocks line is labelled beside itself, clear of the node title it runs past. */
    const vertical = !team && !cross && Math.abs(b.y - a.y) > Math.abs(b.x - a.x);
    const lp = team ? c.at(e.type === COORDINATES ? 0.6 : 0.32) : vertical ? { x: c.apex.x + 38, y: c.apex.y } : c.apex;
    edges.push({
      key, from, to, type: e.type, family, cross, team,
      exited: a.exited || b.exited,
      rootIds: [...new Set(e.rootIds?.length ? e.rootIds : [...a.rootIds, ...b.rootIds])],
      d: c.d,
      label: labelled ? { x: lp.x, y: lp.y + 3, text: e.type, anchor: vertical ? 'start' : 'middle' } : null,
    });
  };

  /* Story → child stories (the contract carries no edge row for them). */
  for (const c of kids) push({ from: view.id, to: c.id, type: CONTAINS, rootIds: allRootIds });
  /* Every stored edge, folded onto what is drawn. Cross-root links swing as arcs. */
  for (const e of page.edges) {
    /* "A depends on B" draws as B blocks A: the arrow points at the work that waits. */
    const flip = e.type === DEPENDS_ON;
    push({ from: flip ? e.toId : e.fromId, to: flip ? e.fromId : e.toId, type: flip ? BLOCKS : e.type, family: e.family, cross: e.cross, rootIds: e.rootIds });
  }
  /* A live child capsule also hangs off its root on a green "runs" line. */
  for (const node of nodes.values()) {
    if (node.role !== 'child' || !node.capsule) continue;
    const parent = page.edges.find((e) => e.toId === node.id && e.family === 'parent');
    if (parent) push({ from: parent.fromId, to: node.id, type: WORKING_ON, family: 'runs', bulge: true, rootIds: node.rootIds });
  }
  /* The team layer: top teammates hang off the story; coordinators coordinate; dispatchers hand out. */
  for (const t of teammatesOf(page)) {
    if (!nodes.has(t.id)) continue;
    if (!t.parentId || !nodes.has(t.parentId)) push({ from: view.id, to: t.id, type: CONTAINS, rootIds: allRootIds });
    for (const c of teammatesOf(page)) {
      if (c.parentId !== t.id) continue;
      const target = nodes.has(c.id) ? c.id : capsuleOfMember(c.id);
      if (target) push({ from: t.id, to: target, type: COORDINATES, family: 'team', team: true, rootIds: nodes.get(target)!.rootIds });
    }
    for (const d of t.dispatched) {
      const target = nodes.get(at(d.taskId));
      if (target) push({ from: t.id, to: target.id, type: DISPATCHED, family: 'team', team: true, rootIds: target.rootIds });
    }
  }

  const height = n === 0 ? 150 : ROW0 + ROW * Math.max(maxRows, 1) + 24;
  return { width, height, nodes: [...nodes.values()], edges, notes, allRootIds };
}

/* Edge words the layout synthesises (they are edge types, not kinds). */
const CONTAINS = 'contains';
const COORDINATES = 'coordinates';
const DISPATCHED = 'dispatched';
const WORKING_ON = 'working_on';
const DEPENDS_ON = 'depends_on';
const BLOCKS = 'blocks';

/** Spec for one graph view: what is in view, what stays as context. */
export interface ViewMask {
  inView: Set<string>;
  context: Set<string>;
}

/** The artifact's filtered trees: one view at a time over the same graph; the spine always stays, dimmed when it is only context. */
export function maskFor(layout: GraphLayout, view: StoryGraphView): ViewMask {
  const inView = new Set<string>();
  const context = new Set<string>();
  for (const n of layout.nodes) {
    const match =
      view === 'all' ||
      n.view === view ||
      n.view === 'all' ||
      (!!n.capsule && (view === 'sessions' || view === 'team'));
    if (match) inView.add(n.id);
    else if (n.spine) context.add(n.id);
  }
  if (view !== 'all') {
    /* A node in view keeps the thing it hangs off, so a doc still shows which task it is attached to. */
    for (const e of layout.edges) {
      if (inView.has(e.from) && !inView.has(e.to)) context.add(e.to);
      if (inView.has(e.to) && !inView.has(e.from)) context.add(e.from);
    }
  }
  return { inView, context };
}
