// The story page (migration 283, contract `StoryPage`), assembled on a DETAIL
// read. The trail itself — roots, depth, the edge each row was reached by —
// comes from `internal.story_trail`, the same function `internal.story_summary`
// (the twins' `state`) reads, so the page and the summary cannot disagree on
// what is in the story. Everything here is computed at read time and bounded:
// the trail by 500 rows, activity and messages by 50, child stories by 50.
//
// Queries run SEQUENTIALLY: a `Querier` wraps one pooled client.
import {
  STORY_FOLLOWED_EDGE_TYPES,
  STORY_FOLLOW_DEPTH,
  STORY_FOLLOW_LIMIT,
  storyCallSign,
  storyEdgeFamily,
  type ActorSummary,
  type StatusCategory,
  type StoryActivityItem,
  type StoryChild,
  type StoryFeedMessage,
  type StoryGraphEdge,
  type StoryNode,
  type StoryPage,
  type StoryProgress,
  type StoryRoot,
  type StorySession,
  type StoryState,
  type StoryTeammate,
  type StoryTrailItem,
  type TeamMemberMode,
} from '@tm8/contract';
import type { Querier } from '../db/types.js';
import { ENTITY_COLUMNS, ENTITY_FROM, iso, isoOrNull, loadActors, titleOf as rowTitleOf, type EntityRow } from './entity-read.js';

const ACTIVITY_LIMIT = 50;
const MESSAGE_LIMIT = 50;
const CHILD_STORY_LIMIT = 50;
const LIVE_SESSION_STATUSES = new Set(['spawning', 'running', 'idle']);
const TEAM_MODES = new Set<TeamMemberMode>(['worker', 'coordinator', 'coordinated-worker', 'coordinated-coordinator', 'dispatcher']);
/** Edge types drawn between nodes: the followed set plus membership and blocking. */
const DRAWN_EDGE_TYPES = [...STORY_FOLLOWED_EDGE_TYPES.filter((t) => t !== 'parent'), 'contains', 'depends_on'];

interface TrailRow {
  entity_id: string;
  root_id: string;
  depth: number;
  via_id: string;
  edge_type: string;
  edge_id: string | null;
  direction: 'out' | 'in';
  root_position: number | null;
}

interface FactRow {
  id: string;
  kind: string;
  parent_id: string | null;
  status_category: string | null;
  status_name: string | null;
  activity_at: Date | string | null;
  created_at: Date | string;
  ws_status: string | null;
  ws_mode: string | null;
  tm_mode: string | null;
  blocked: boolean;
}

function category(raw: string | null): StatusCategory | null {
  return raw === 'to_do' || raw === 'in_progress' || raw === 'done' || raw === 'cancelled' ? raw : null;
}

function teamMode(raw: string | null): TeamMemberMode | null {
  return raw !== null && TEAM_MODES.has(raw as TeamMemberMode) ? (raw as TeamMemberMode) : null;
}

/** MIRRORS `internal.story_tally` (283): disjoint bands, done + inProgress + toDo + blocked = work. */
export function tallyStory(facts: readonly Pick<FactRow, 'status_category' | 'blocked'>[]): StoryProgress {
  const t: StoryProgress = { work: 0, done: 0, inProgress: 0, toDo: 0, blocked: 0, cancelled: 0 };
  for (const f of facts) {
    switch (f.status_category) {
      case 'cancelled': t.cancelled++; break;
      case 'done': t.work++; t.done++; break;
      case 'in_progress': t.work++; if (f.blocked) t.blocked++; else t.inProgress++; break;
      case 'to_do': t.work++; if (f.blocked) t.blocked++; else t.toDo++; break;
      default: break;
    }
  }
  return t;
}

function storyStateOf(raw: unknown): StoryState | null {
  return raw && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'story' ? (raw as StoryState) : null;
}

/**
 * The status KEY every context ref carries — MIRRORS `statusOf` in
 * services/w2/feed-context-v2.ts, so a root's `status` on the page and the
 * same row's `status` in `tm8 entity context` are one string.
 */
const STATUS_KEY_SQL = `case e.kind
    when 'task' then coalesce(t.work_status, 'open')
    when 'work_session' then coalesce(ws.status, 'spawning')
    when 'pull_request' then coalesce(pr.state, 'unknown')
    when 'chat' then coalesce(cht.runtime_state, 'cold')
    else coalesce(e.status_category, 'none') end`;
const STATUS_KEY_FROM = `
       left join public.tasks t on t.entity_id = e.id
       left join public.work_sessions ws on ws.entity_id = e.id
       left join public.pull_requests pr on pr.entity_id = e.id
       left join public.chats cht on cht.entity_id = e.id`;

const EMPTY_PROGRESS: StoryProgress = { work: 0, done: 0, inProgress: 0, toDo: 0, blocked: 0, cancelled: 0 };

export async function loadStoryPage(q: Querier, storyId: string): Promise<StoryPage> {
  const trail = await q.query<TrailRow>(
    `select entity_id, root_id, depth, via_id, edge_type, edge_id, direction, root_position
       from internal.story_trail($1)`,
    [storyId],
  );
  const itemIds = [...new Set(trail.map((r) => r.entity_id))];
  const allIds = [storyId, ...itemIds];

  const facts = await q.query<FactRow>(
    `select e.id, e.kind, e.parent_id, e.status_category, ${STATUS_KEY_SQL} as status_name,
            e.activity_at, e.created_at, ws.status as ws_status, ws.mode as ws_mode, tm.mode as tm_mode,
            exists (
              select 1 from public.edges dep
               where dep.src_id = e.id and dep.type = 'depends_on'
                 and coalesce((dep.props ->> 'hard')::boolean, true)
                 and not internal.is_resolved(dep.dst_id)
            ) as blocked
       from public.entities e${STATUS_KEY_FROM}
       left join public.team_members tm on tm.entity_id = e.id
      where e.id = any($1::uuid[]) and e.deleted_at is null`,
    [allIds],
  );
  const factOf = new Map(facts.map((f) => [f.id, f]));

  // Session -> persona (`participates_in`, team_member -> session), dispatch
  // provenance (`dispatched_by`, session -> dispatcher session) and what each
  // session is `working_on`. Read for every session in the trail even when the
  // edge itself was not walked: the team layer is about the sessions.
  const sessionIds = facts.filter((f) => f.kind === 'work_session').map((f) => f.id);
  const sessionEdges = sessionIds.length === 0 ? [] : await q.query<{ src_id: string; dst_id: string; type: string }>(
    `select g.src_id, g.dst_id, g.type
       from public.edges g
      where (g.type = 'participates_in' and g.dst_id = any($1::uuid[]))
         or (g.type in ('dispatched_by', 'working_on') and g.src_id = any($1::uuid[]))`,
    [sessionIds],
  );
  const personaOf = new Map<string, string>();
  const dispatchedByOf = new Map<string, string>();
  const workingOn = new Map<string, string[]>();
  for (const g of sessionEdges) {
    if (g.type === 'participates_in') personaOf.set(g.dst_id, g.src_id);
    else if (g.type === 'dispatched_by') dispatchedByOf.set(g.src_id, g.dst_id);
    else if (factOf.has(g.dst_id)) workingOn.set(g.src_id, [...(workingOn.get(g.src_id) ?? []), g.dst_id]);
  }

  // Teammates: personas of the sessions, plus team_member rows in the trail.
  const personaIds = [...new Set(personaOf.values())].filter((id) => !factOf.has(id));
  const personaFacts = personaIds.length === 0 ? [] : await q.query<{ id: string; parent_id: string | null; mode: string | null }>(
    `select e.id, e.parent_id, tm.mode
       from public.entities e join public.team_members tm on tm.entity_id = e.id
      where e.id = any($1::uuid[]) and e.deleted_at is null`,
    [personaIds],
  );

  // Edges between nodes, as stored. Hierarchy links come from parent_id below.
  const edgeRows = await q.query<{ id: string; src_id: string; dst_id: string; type: string }>(
    `select g.id, g.src_id, g.dst_id, g.type
       from public.edges g
      where g.src_id = any($1::uuid[]) and g.dst_id = any($1::uuid[]) and g.type = any($2::text[])
      order by g.created_at, g.id
      limit 2000`,
    [allIds, DRAWN_EDGE_TYPES],
  );

  const children = await q.query<{ id: string; title: string; summary: unknown; status_category: string | null; status_name: string | null }>(
    `select c.id, st.title, internal.story_summary(c.id) as summary, c.status_category,
            coalesce(c.status_category, 'none') as status_name
       from public.entities c join public.stories st on st.entity_id = c.id
      where c.parent_id = $1 and c.kind = 'story' and c.deleted_at is null
      order by c.position, c.created_at, c.id
      limit ${CHILD_STORY_LIMIT}`,
    [storyId],
  );

  const activityRows = await q.query<{ id: string; created_at: Date | string; entity_id: string; verb: string; actor_id: string | null }>(
    `select a.id, a.created_at, a.entity_id, a.verb, a.actor_id
       from public.activity a
      where a.entity_id = any($1::uuid[])
      order by a.created_at desc, a.id desc
      limit ${ACTIVITY_LIMIT}`,
    [allIds],
  );

  const feedAnchorIds = allIds.filter((id) => factOf.get(id)?.kind !== 'message' && factOf.has(id));
  const messageRows = feedAnchorIds.length === 0 ? [] : await q.query<{ id: string; created_at: Date | string; anchor_id: string; author_id: string | null; body: string }>(
    `select m.entity_id as id, m.created_at, m.anchor_id, m.author_id, left(m.body, 280) as body
       from public.messages m
       join public.entities me on me.id = m.entity_id and me.deleted_at is null
      where m.anchor_id = any($1::uuid[]) and m.redacted_at is null
      order by m.created_at desc, m.entity_id desc
      limit ${MESSAGE_LIMIT}`,
    [feedAnchorIds],
  );

  const parentRows = await q.query<{ id: string; title: string }>(
    `select p.id, st.title
       from public.entities s
       join public.entities p on p.id = s.parent_id and p.kind = 'story' and p.deleted_at is null
       join public.stories st on st.entity_id = p.id
      where s.id = $1`,
    [storyId],
  );

  // Titles through the one title rule every surface uses (`titleOf`, kind-
  // correct, RLS-filtered), for the nodes and the personas behind the
  // sessions. Viewer-free, so `entities.context` can render the page too.
  const titleRows = await q.query<EntityRow>(
    `select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = any($1::uuid[])`,
    [[...allIds, ...personaIds]],
  );
  const titleOf = new Map(titleRows.map((r) => [r.id, rowTitleOf(r)]));
  const title = (id: string) => titleOf.get(id) ?? 'Untitled';

  const actorIds = [
    ...activityRows.map((a) => a.actor_id),
    ...messageRows.map((m) => m.author_id),
  ].filter((id): id is string => id !== null);
  const actors = await loadActors(q, actorIds);
  const actor = (id: string | null): ActorSummary | null => (id ? actors.get(id) ?? null : null);

  // ---- assemble -----------------------------------------------------------
  const visibleTrail = trail.filter((r) => factOf.has(r.entity_id));
  const roots = visibleTrail.filter((r) => r.depth === 0);
  const rootIdsOf = new Map<string, string[]>();
  const depthOf = new Map<string, number>();
  for (const r of visibleTrail) {
    rootIdsOf.set(r.entity_id, [...new Set([...(rootIdsOf.get(r.entity_id) ?? []), r.root_id])]);
    depthOf.set(r.entity_id, Math.min(depthOf.get(r.entity_id) ?? r.depth, r.depth));
  }
  const allRootIds = roots.map((r) => r.entity_id);

  // Call signs: every session in the story, by (created_at, id).
  const orderedSessions = facts
    .filter((f) => f.kind === 'work_session' && f.id !== storyId)
    .sort((a, b) => (iso(a.created_at) < iso(b.created_at) ? -1 : iso(a.created_at) > iso(b.created_at) ? 1 : a.id < b.id ? -1 : 1));
  const signOf = new Map(orderedSessions.map((f, i) => [f.id, storyCallSign(i)]));
  const isLive = (f: FactRow | undefined) => f?.kind === 'work_session' && LIVE_SESSION_STATUSES.has(f.ws_status ?? '');

  const nodeOf = (f: FactRow, depth: number, rootIds: string[]): StoryNode => ({
    id: f.id,
    kind: f.kind,
    title: title(f.id),
    status: f.status_name,
    statusCategory: category(f.status_category),
    blocked: f.blocked,
    depth,
    rootIds,
    activityAt: isoOrNull(f.activity_at),
    createdAt: iso(f.created_at),
    ...(f.kind === 'work_session' ? { live: isLive(f), callSign: signOf.get(f.id) ?? storyCallSign(0) } : {}),
  });

  const nodes: StoryNode[] = [];
  const storyFact = factOf.get(storyId);
  if (storyFact) nodes.push(nodeOf(storyFact, -1, allRootIds));
  for (const id of itemIds) {
    const f = factOf.get(id);
    if (f) nodes.push(nodeOf(f, depthOf.get(id) ?? 0, rootIdsOf.get(id) ?? []));
  }

  const rootsOut: StoryRoot[] = roots.map((r) => {
    const f = factOf.get(r.entity_id)!;
    const mine = visibleTrail.filter((t) => t.root_id === r.entity_id);
    const mineFacts = [...new Set(mine.map((t) => t.entity_id))].map((id) => factOf.get(id)!).filter(Boolean);
    const hierarchy = new Set<string>([r.entity_id]);
    const childIds: string[] = [];
    const trailItems: StoryTrailItem[] = [];
    for (const t of mine.filter((x) => x.depth > 0).sort((a, b) => a.depth - b.depth)) {
      if (t.edge_type === 'parent' && hierarchy.has(t.via_id)) {
        hierarchy.add(t.entity_id);
        childIds.push(t.entity_id);
      } else {
        trailItems.push({
          id: t.entity_id,
          kind: factOf.get(t.entity_id)!.kind,
          title: title(t.entity_id),
          edgeType: t.edge_type,
          family: storyEdgeFamily(t.edge_type),
          viaId: t.via_id,
          direction: t.direction,
          depth: t.depth,
        });
      }
    }
    return {
      id: r.entity_id,
      kind: f.kind,
      title: title(r.entity_id),
      status: f.status_name,
      statusCategory: category(f.status_category),
      blocked: f.blocked,
      position: r.root_position,
      progress: tallyStory(mineFacts),
      taskProgress: tallyStory(mineFacts.filter((x) => x.kind === 'task')),
      childIds,
      trail: trailItems,
    };
  });

  const rootsOfEdge = (a: string, b: string) => {
    const ra = a === storyId ? [] : rootIdsOf.get(a) ?? [];
    const rb = b === storyId ? [] : rootIdsOf.get(b) ?? [];
    const cross = ra.length > 0 && rb.length > 0 && !ra.some((x) => rb.includes(x));
    return { rootIds: [...new Set([...ra, ...rb])], cross };
  };
  const edges: StoryGraphEdge[] = edgeRows
    .filter((g) => factOf.has(g.src_id) && factOf.has(g.dst_id))
    .map((g) => ({ id: g.id, fromId: g.src_id, toId: g.dst_id, type: g.type, family: storyEdgeFamily(g.type), ...rootsOfEdge(g.src_id, g.dst_id) }));
  for (const f of facts) {
    if (f.parent_id && f.parent_id !== storyId && factOf.has(f.parent_id) && f.id !== storyId) {
      edges.push({ id: null, fromId: f.parent_id, toId: f.id, type: 'parent', family: 'parent', ...rootsOfEdge(f.parent_id, f.id) });
    }
  }
  for (const c of children) {
    edges.push({ id: null, fromId: storyId, toId: c.id, type: 'parent', family: 'parent', rootIds: [], cross: false });
  }

  const sessions: StorySession[] = orderedSessions.map((f) => {
    const persona = personaOf.get(f.id) ?? null;
    // The session's OWN mode (work_sessions.mode, set at spawn); the persona's
    // default only when the session row carries none.
    const personaMode = teamMode(f.ws_mode)
      ?? (persona ? teamMode(factOf.get(persona)?.tm_mode ?? personaFacts.find((p) => p.id === persona)?.mode ?? null) : null);
    const taskIds = workingOn.get(f.id) ?? [];
    return {
      id: f.id,
      title: title(f.id),
      callSign: signOf.get(f.id)!,
      createdAt: iso(f.created_at),
      live: isLive(f),
      runtimeStatus: f.ws_status,
      teamMemberId: persona,
      mode: personaMode,
      taskIds,
      rootIds: rootIdsOf.get(f.id) ?? [],
      dispatchedById: dispatchedByOf.get(f.id) ?? null,
    };
  });

  const teamIds = [...new Set([
    ...facts.filter((f) => f.kind === 'team_member').map((f) => f.id),
    ...personaOf.values(),
  ])];
  const teamFacts = new Map<string, { parent_id: string | null; mode: string | null }>([
    ...personaFacts.map((p) => [p.id, { parent_id: p.parent_id, mode: p.mode }] as const),
    ...facts.filter((f) => f.kind === 'team_member').map((f) => [f.id, { parent_id: f.parent_id, mode: f.tm_mode }] as const),
  ]);
  const assignedTo = edgeRows.filter((g) => g.type === 'assigned_to');
  const team: StoryTeammate[] = teamIds.filter((id) => teamFacts.has(id)).map((id) => {
    const tf = teamFacts.get(id)!;
    const mine = sessions.filter((s) => s.teamMemberId === id);
    const mySessionIds = new Set(mine.map((s) => s.id));
    return {
      id,
      kind: 'team_member' as const,
      name: title(id),
      mode: teamMode(tf.mode),
      parentId: tf.parent_id,
      live: mine.some((s) => s.live),
      sessionIds: mine.map((s) => s.id),
      runs: [...new Set(mine.flatMap((s) => s.taskIds))],
      assigned: assignedTo.filter((g) => g.dst_id === id).map((g) => g.src_id),
      dispatched: sessions
        .filter((s) => s.dispatchedById !== null && mySessionIds.has(s.dispatchedById))
        .flatMap((s) => (s.taskIds.length > 0 ? s.taskIds : [null]).map((taskId) => ({ taskId, sessionId: s.id })))
        .filter((d): d is { taskId: string; sessionId: string } => d.taskId !== null),
    };
  });

  // The humans in the trail (a member reached by working_on / assigned_to):
  // on the team with no mode, no hierarchy and no sessions of their own.
  for (const f of facts.filter((x) => x.kind === 'member')) {
    team.push({
      id: f.id,
      kind: 'member',
      name: title(f.id),
      mode: null,
      parentId: null,
      live: false,
      sessionIds: [],
      runs: edgeRows.filter((g) => g.type === 'working_on' && g.src_id === f.id).map((g) => g.dst_id),
      assigned: assignedTo.filter((g) => g.dst_id === f.id).map((g) => g.src_id),
      dispatched: [],
    });
  }

  const childStories: StoryChild[] = children.map((c) => {
    const s = storyStateOf(c.summary);
    return {
      id: c.id,
      title: c.title,
      status: c.status_name,
      statusCategory: category(c.status_category),
      itemCount: s?.itemCount ?? 0,
      taskProgress: s?.taskProgress ?? EMPTY_PROGRESS,
      rollup: s?.rollup ?? EMPTY_PROGRESS,
      liveSessionCount: s?.liveSessionCount ?? 0,
      lastActivityAt: s?.lastActivityAt ?? null,
    };
  });

  const activity: StoryActivityItem[] = activityRows.map((a) => ({
    id: a.id,
    at: iso(a.created_at),
    entityId: a.entity_id,
    entityKind: factOf.get(a.entity_id)?.kind ?? 'unknown',
    entityTitle: title(a.entity_id),
    verb: a.verb,
    actorId: a.actor_id,
    actor: actor(a.actor_id),
  }));

  const recentMessages: StoryFeedMessage[] = messageRows.map((m) => ({
    id: m.id,
    at: iso(m.created_at),
    anchorId: m.anchor_id,
    anchorKind: factOf.get(m.anchor_id)?.kind ?? 'unknown',
    anchorTitle: title(m.anchor_id),
    authorId: m.author_id,
    author: actor(m.author_id),
    excerpt: m.body.replace(/\s+/g, ' ').trim(),
  }));

  return {
    asOf: new Date().toISOString(),
    follow: {
      depth: STORY_FOLLOW_DEPTH,
      limit: STORY_FOLLOW_LIMIT,
      truncated: trail.length >= STORY_FOLLOW_LIMIT,
      edgeTypes: STORY_FOLLOWED_EDGE_TYPES,
    },
    parent: parentRows[0] ? { id: parentRows[0].id, title: parentRows[0].title } : null,
    roots: rootsOut,
    nodes,
    edges,
    sessions,
    team,
    childStories,
    activity,
    feedAnchorIds,
    recentMessages,
  };
}
