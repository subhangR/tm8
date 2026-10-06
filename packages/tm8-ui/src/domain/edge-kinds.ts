/**
 * EDGE ENDPOINT KINDS — which kinds may stand at each end of every registered
 * edge type, as registry DATA.
 *
 * WHERE IT COMES FROM. The edge-type registry is the Server's `edge_types`
 * table (`tm8 edge type list`, operation `edgeTypes.list`); the migrations are
 * its only writer. `EDGE_VERBS` beside this file already vendors the HUMAN
 * label of every type and holds itself to the migration set by test; this file
 * vendors the other half of the same rows — the `src_kinds` / `dst_kinds`
 * columns — so a surface can answer 'what does a task connect TO, and through
 * which verb?' with no round-trip. Entity Help's Constellation tab is the
 * first reader.
 *
 * WHY VENDORED AND NOT FETCHED. Help ships with the application (the same
 * ruling that vendored the field-guide plates, 2026-08-20): a fresh node, an
 * offline node and a test all get the same graph on first paint. The set is
 * pinned two ways — `edge-kinds.test.ts` holds these keys to `EDGE_VERBS`
 * (and so to the migrations), and this header records the snapshot.
 *
 * Snapshot: `tm8 edge type list --format json`, 2026-09-28, 46 types; plus
 * 283 (2026-10-02), which appends `story` to `contains` and `attached_to` sources,
 * and 304 (2026-10-06), which appends `design` to `contains` sources.
 * Migration 296 adds catalog MCP servers as equips destinations.
 * Migration 303 (canonical edges) rewrites every description to one plain
 * meaning, registers `follows_up`, and adds file and drawing to `produces`.
 * A `*` endpoint admits any kind.
 *
 * Kind literals are legal here: `src/domain/` is one of the two directories
 * §15.2 permits them in.
 */

export interface EdgeKinds {
  /** Kinds allowed as the edge's SOURCE; `*` = any. */
  readonly src: readonly string[];
  /** Kinds allowed as the edge's TARGET; `*` = any. */
  readonly dst: readonly string[];
  /** The registry's own one-line description of the relation. */
  readonly description: string;
  /** True when the registry forbids cycles through this type. */
  readonly acyclic: boolean;
}

export const EDGE_KINDS: Readonly<Record<string, EdgeKinds>> = {
  about: {
    src: ['memory', 'chat'],
    dst: ['*'],
    description: 'Subject: this chat or memory is about that entity.',
    acyclic: false,
  },
  anchored_to: {
    src: ['message'],
    dst: ['*'],
    description: 'System: this message hangs on that entity (projection of the message\'s anchor).',
    acyclic: false,
  },
  approval_requested_from: {
    src: ['task'],
    dst: ['member', 'team_member'],
    description: 'Approval of this task is requested from that member or teammate (inert in v1).',
    acyclic: false,
  },
  approved_by: {
    src: ['task'],
    dst: ['member', 'team_member'],
    description: 'That member or teammate gave a verdict on this task (inert in v1).',
    acyclic: false,
  },
  assigned_to: {
    src: ['task'],
    dst: ['member', 'team_member'],
    description: 'Responsible for: that member or teammate is responsible for this task.',
    acyclic: false,
  },
  attached_to: {
    src: ['task', 'member', 'team_member', 'doc', 'file', 'spell', 'skill', 'pull_request', 'commit', 'work_session', 'collection', 'memory', 'artifact', 'drawing', 'form', 'story'],
    dst: ['*'],
    description: 'Context or input: this entity gives context to that one (a reference, an input, a message attachment). Not a task\'s output: use produces.',
    acyclic: false,
  },
  authored_from: {
    src: ['*'],
    dst: ['work_session', 'chat'],
    description: 'Made during: this entity was recorded by the server as made in that work session or chat.',
    acyclic: false,
  },
  based_on: {
    src: ['memory'],
    dst: ['*'],
    description: 'This memory depends on that entity at a pinned version.',
    acyclic: false,
  },
  completed_by: {
    src: ['task'],
    dst: ['member', 'team_member'],
    description: 'Completed by: that member or teammate completed this task.',
    acyclic: false,
  },
  consumes: {
    src: ['task'],
    dst: ['doc', 'artifact', 'memory'],
    description: 'Input (Craft): this task reads that doc, artifact or memory.',
    acyclic: false,
  },
  contains: {
    // 283 appends `story`: a story's roots are its `contains` targets.
    // 304 appends `design`: a design's pages are its `contains` targets.
    src: ['collection', 'story', 'design'],
    dst: ['*'],
    description: 'Story root or collection item: this story, collection or design holds that entity directly. props.position orders it.',
    acyclic: false,
  },
  controls: {
    src: ['team_member', 'member'],
    dst: ['container'],
    description: 'This person may drive that container\'s input (takeover or exec grant).',
    acyclic: false,
  },
  copy_of: {
    src: ['*'],
    dst: ['*'],
    description: 'This entity is a copy of that one.',
    acyclic: false,
  },
  created_in: {
    src: ['*'],
    dst: ['work_session'],
    description: 'Deprecated (unverified, legacy): replaced by authored_from, which the server records.',
    acyclic: false,
  },
  defaults_to_profile: {
    src: ['team_member'],
    dst: ['interaction_profile'],
    description: 'This teammate\'s future sessions default to that interaction profile.',
    acyclic: false,
  },
  depends_on: {
    src: ['*'],
    dst: ['*'],
    description: 'Prerequisite: this task cannot be finished before that one.',
    acyclic: true,
  },
  derived_from: {
    src: ['task'],
    dst: ['*'],
    description: 'Launch task: the system created this task to launch or continue that entity (a story or session).',
    acyclic: false,
  },
  dislikes: {
    src: ['member'],
    dst: ['*'],
    description: 'Reaction: this member dislikes that entity.',
    acyclic: false,
  },
  dispatched_by: {
    src: ['work_session'],
    dst: ['work_session'],
    description: 'Deprecated: a spawned session\'s parentId names the session that spawned it.',
    acyclic: false,
  },
  disputes: {
    src: ['message', 'memory'],
    dst: ['*'],
    description: 'This message or memory disputes that entity, with evidence.',
    acyclic: false,
  },
  drives: {
    src: ['work_session'],
    dst: ['container'],
    description: 'This work session uses that container through tools.',
    acyclic: false,
  },
  equips: {
    src: ['task', 'team_member', 'work_session'],
    dst: ['spell', 'skill', 'mcp_server'],
    description: 'This task, teammate or session is equipped with that skill, spell or MCP server.',
    acyclic: false,
  },
  follows_up: {
    src: ['task', 'work_session'],
    dst: ['task', 'work_session'],
    description: 'Follow-up: this task (or session) continues the work of that earlier task (or session).',
    acyclic: true,
  },
  has_member: {
    src: ['channel'],
    dst: ['member', 'team_member'],
    description: 'Channel membership: this channel has that member or teammate.',
    acyclic: false,
  },
  in_project: {
    src: ['task', 'work_session', 'pull_request', 'commit', 'artifact'],
    dst: ['project'],
    description: 'This entity belongs to that project.',
    acyclic: false,
  },
  in_worktree: {
    src: ['task', 'work_session', 'pull_request', 'commit'],
    dst: ['worktree'],
    description: 'This entity is associated with that worktree.',
    acyclic: false,
  },
  likes: {
    src: ['member'],
    dst: ['*'],
    description: 'Reaction: this member likes that entity.',
    acyclic: false,
  },
  member_of: {
    src: ['team_member'],
    dst: ['team_member'],
    description: 'This teammate is also affiliated with that team.',
    acyclic: false,
  },
  messaged: {
    src: ['work_session'],
    dst: ['work_session'],
    description: 'System: this work session sent a message to that work session.',
    acyclic: false,
  },
  mounts: {
    src: ['container'],
    dst: ['project'],
    description: 'This container mounts that project\'s working directory.',
    acyclic: false,
  },
  participates_in: {
    src: ['team_member'],
    dst: ['work_session'],
    description: 'Session\'s teammate: this teammate is the one responsible for that work session.',
    acyclic: false,
  },
  produces: {
    src: ['task'],
    dst: ['artifact', 'doc', 'drawing', 'file', 'memory'],
    description: 'Deliverable: this task produced that doc, artifact, file, drawing or memory as its output.',
    acyclic: false,
  },
  pulled: {
    src: ['member', 'team_member'],
    dst: ['channel', 'task', 'doc', 'file', 'spell', 'skill', 'collection'],
    description: 'This member or teammate adopted that entity locally.',
    acyclic: false,
  },
  relates_to: {
    src: ['*'],
    dst: ['*'],
    description: 'See also: a deliberately vague link. Story walks and maps ignore it; prefer a specific edge.',
    acyclic: false,
  },
  remembers: {
    src: ['*'],
    dst: ['memory'],
    description: 'Memory set: that memory belongs to this holder\'s working set.',
    acyclic: false,
  },
  runs_in: {
    src: ['work_session'],
    dst: ['container'],
    description: 'This work session\'s processes run inside that container.',
    acyclic: false,
  },
  runs_on: {
    src: ['work_session'],
    dst: ['credential'],
    description: 'System: this work session runs on that credential.',
    acyclic: false,
  },
  selected_profile: {
    src: ['work_session'],
    dst: ['interaction_profile'],
    description: 'System: the interaction profile this work session was pinned to at spawn.',
    acyclic: false,
  },
  shared_into: {
    src: ['*'],
    dst: ['work_session'],
    description: 'System: this entity was handed off into that work session.',
    acyclic: false,
  },
  snapshot_of: {
    src: ['container'],
    dst: ['container'],
    description: 'This container was forked from that snapshot or template.',
    acyclic: true,
  },
  stars: {
    src: ['member'],
    dst: ['*'],
    description: 'Reaction: this member bookmarked that entity.',
    acyclic: false,
  },
  supersedes: {
    src: ['memory'],
    dst: ['memory'],
    description: 'This memory replaces that earlier memory.',
    acyclic: true,
  },
  tracks: {
    src: ['task'],
    dst: ['pull_request', 'commit'],
    description: 'Ships as code: this task is implemented by that pull request or commit.',
    acyclic: false,
  },
  triggered_by: {
    src: ['task', 'work_session'],
    dst: ['loop'],
    description: 'This task or session exists because that loop fired.',
    acyclic: false,
  },
  verifies: {
    src: ['message', 'memory'],
    dst: ['*'],
    description: 'This message or memory verifies that entity, with evidence.',
    acyclic: false,
  },
  visible_to: {
    src: ['*'],
    dst: ['member', 'team_member'],
    description: 'Restricted-visibility grant to that member or teammate (inert in v1).',
    acyclic: false,
  },
  working_on: {
    src: ['member', 'team_member', 'work_session'],
    dst: ['task'],
    description: 'Actively working on: this work session is working on that task now. A claim; it ends (endedAt) when the work stops.',
    acyclic: false,
  },
};

export type RelationDirection = 'outgoing' | 'incoming';

/** One way a kind can relate to other kinds through one edge type. */
export interface KindRelation {
  readonly type: string;
  /** `outgoing`: the kind is the edge's source; `incoming`: its target. */
  readonly direction: RelationDirection;
  /** The kinds at the far end. `*` means any kind. */
  readonly peers: readonly string[];
  /** True when this relation only reaches the kind because an end is `*`. */
  readonly viaWildcard: boolean;
  readonly description: string;
}

const WILD = '*';

/**
 * Every relation a kind can hold, in registry order, outgoing before incoming.
 *
 * A wildcard endpoint matches every kind, so a type like `relates_to` (`* → *`)
 * appears for all of them, flagged `viaWildcard` so a reader can rank the
 * relations that NAME the kind above the ones that merely admit it.
 */
export function relationsOf(kind: string): KindRelation[] {
  const out: KindRelation[] = [];
  for (const [type, row] of Object.entries(EDGE_KINDS)) {
    const srcNamed = row.src.includes(kind);
    const dstNamed = row.dst.includes(kind);
    const srcWild = row.src.includes(WILD);
    const dstWild = row.dst.includes(WILD);
    if (srcNamed || srcWild) {
      out.push({ type, direction: 'outgoing', peers: row.dst, viaWildcard: !srcNamed, description: row.description });
    }
    if (dstNamed || dstWild) {
      out.push({ type, direction: 'incoming', peers: row.src, viaWildcard: !dstNamed, description: row.description });
    }
  }
  return out;
}
