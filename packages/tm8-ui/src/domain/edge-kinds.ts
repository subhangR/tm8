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
 * 282 (2026-10-02), which appends `story` to `contains` and `attached_to` sources.
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
    description: 'Subject routing: this memory or chat concerns X. Mutable and unpinned — filing errors must be correctable.',
    acyclic: false,
  },
  anchored_to: {
    src: ['message'],
    dst: ['*'],
    description: 'Server-derived projection of messages.anchor_id: this message hangs on that entity',
    acyclic: false,
  },
  approval_requested_from: {
    src: ['task'],
    dst: ['member', 'team_member'],
    description: 'Approval request; props {verdict, note}. Inert in v1 (01 §S5)',
    acyclic: false,
  },
  approved_by: {
    src: ['task'],
    dst: ['member', 'team_member'],
    description: 'Approval verdict; props {verdict, note}. Inert in v1 (01 §S5)',
    acyclic: false,
  },
  assigned_to: {
    src: ['task'],
    dst: ['member', 'team_member'],
    description: 'Task assignment',
    acyclic: false,
  },
  attached_to: {
    src: ['task', 'member', 'team_member', 'doc', 'file', 'spell', 'skill', 'pull_request', 'commit', 'work_session', 'collection', 'memory', 'artifact', 'drawing', 'form', 'story'],
    dst: ['*'],
    description: 'Context attachment; channel destinations power hub tabs and pinned shelves',
    acyclic: false,
  },
  authored_from: {
    src: ['message', 'memory', 'artifact', 'form'],
    dst: ['work_session', 'chat'],
    description: 'Immutable Server-recorded work-session or chat provenance',
    acyclic: false,
  },
  based_on: {
    src: ['memory'],
    dst: ['*'],
    description: 'Epistemic dependency, version-pinned. Drift is derived at read time from pinnedVersion < target.version.',
    acyclic: false,
  },
  completed_by: {
    src: ['task'],
    dst: ['member', 'team_member'],
    description: 'Task completion attribution',
    acyclic: false,
  },
  consumes: {
    src: ['task'],
    dst: ['doc', 'artifact', 'memory'],
    description: 'Data flow: this task reads that input. Written 1:1 by Craft materialize; the blueprint edge\'s note rides in props.note.',
    acyclic: false,
  },
  contains: {
    // 282 appends `story`: a story's roots are its `contains` targets.
    src: ['collection', 'story'],
    dst: ['*'],
    description: 'Curated membership; props.position orders it',
    acyclic: false,
  },
  controls: {
    src: ['team_member', 'member'],
    dst: ['container'],
    description: 'explicit input (takeover/exec) grant from the creator',
    acyclic: false,
  },
  copy_of: {
    src: ['*'],
    dst: ['*'],
    description: 'Copy provenance',
    acyclic: false,
  },
  created_in: {
    src: ['*'],
    dst: ['work_session'],
    description: 'Client-asserted: this entity was created during that work session. Unverified until agents carry session-scoped tokens; see authored_from for the verified form.',
    acyclic: false,
  },
  defaults_to_profile: {
    src: ['team_member'],
    dst: ['interaction_profile'],
    description: 'Guarded future-spawn Interaction Profile default',
    acyclic: false,
  },
  depends_on: {
    src: ['*'],
    dst: ['*'],
    description: 'Sequencing or prerequisite relation',
    acyclic: true,
  },
  derived_from: {
    src: ['task'],
    dst: ['*'],
    description: 'Provenance: this task was auto-created to launch that entity (064). Written only by public.derive_task_for_entity.',
    acyclic: false,
  },
  dislikes: {
    src: ['member'],
    dst: ['*'],
    description: 'Negative reaction',
    acyclic: false,
  },
  dispatched_by: {
    src: ['work_session'],
    dst: ['work_session'],
    description: 'This session was spawned by that dispatcher session. Provenance for a routed spawn; the reasoning is the dispatcher\'s message on the task anchor.',
    acyclic: false,
  },
  disputes: {
    src: ['message', 'memory'],
    dst: ['*'],
    description: 'The cheap suspect mark. Source must be evidence-bearing, so a dispute without evidence is structurally impossible.',
    acyclic: false,
  },
  drives: {
    src: ['work_session'],
    dst: ['container'],
    description: 'the session uses the container through tools (run/computer/attach)',
    acyclic: false,
  },
  equips: {
    src: ['task', 'team_member', 'work_session'],
    dst: ['spell', 'skill'],
    description: 'Capability selection feeding manifests',
    acyclic: false,
  },
  has_member: {
    src: ['channel'],
    dst: ['member', 'team_member'],
    description: 'Channel membership: this channel has that person or teammate as a member. props {role, joinedAt}; role is advisory (owner|member) and not DB-constrained. A roster, not an ACL and not a subscription.',
    acyclic: false,
  },
  in_project: {
    src: ['task', 'work_session', 'pull_request', 'commit', 'artifact'],
    dst: ['project'],
    description: 'Space-local association to a live Project projection',
    acyclic: false,
  },
  in_worktree: {
    src: ['task', 'work_session', 'pull_request', 'commit'],
    dst: ['worktree'],
    description: 'Space-local association to a live Worktree',
    acyclic: false,
  },
  likes: {
    src: ['member'],
    dst: ['*'],
    description: 'Positive reaction',
    acyclic: false,
  },
  member_of: {
    src: ['team_member'],
    dst: ['team_member'],
    description: 'Secondary team affiliation (primary org line is the hierarchy)',
    acyclic: false,
  },
  messaged: {
    src: ['work_session'],
    dst: ['work_session'],
    description: 'Server-derived from session_message_deliveries: this session addressed that session',
    acyclic: false,
  },
  mounts: {
    src: ['container'],
    dst: ['project'],
    description: 'the project working dir is bind-mounted in the container',
    acyclic: false,
  },
  participates_in: {
    src: ['team_member'],
    dst: ['work_session'],
    description: 'Responsible Teammate participation in a work session',
    acyclic: false,
  },
  produces: {
    src: ['task'],
    dst: ['doc', 'artifact', 'memory'],
    description: 'Data flow: this task produces that output. Written 1:1 by Craft materialize; the blueprint edge\'s note rides in props.note.',
    acyclic: false,
  },
  pulled: {
    src: ['member', 'team_member'],
    dst: ['channel', 'task', 'doc', 'file', 'spell', 'skill', 'collection'],
    description: 'Local projection/adoption',
    acyclic: false,
  },
  relates_to: {
    src: ['*'],
    dst: ['*'],
    description: 'Generic relation',
    acyclic: false,
  },
  remembers: {
    src: ['*'],
    dst: ['memory'],
    description: 'Working-set association: whose (or what\'s) memory set this belongs to — teammates, sessions, tasks, any holder. Mutable — a working set needs correcting.',
    acyclic: false,
  },
  runs_in: {
    src: ['work_session'],
    dst: ['container'],
    description: 'the session\'s process tree executes inside the container',
    acyclic: false,
  },
  runs_on: {
    src: ['work_session'],
    dst: ['credential'],
    description: 'This session runs on that credential. The graph projection of a session_space_credentials row, written only by that table\'s trigger (session_credential_binding); props.provider names the provider.',
    acyclic: false,
  },
  selected_profile: {
    src: ['work_session'],
    dst: ['interaction_profile'],
    description: 'Recorder-owned projection of the immutable runtime profile pin',
    acyclic: false,
  },
  shared_into: {
    src: ['*'],
    dst: ['work_session'],
    description: 'Recorder-owned historical successful entity handoff',
    acyclic: false,
  },
  snapshot_of: {
    src: ['container'],
    dst: ['container'],
    description: 'this container was forked from that snapshot/template',
    acyclic: true,
  },
  stars: {
    src: ['member'],
    dst: ['*'],
    description: 'Bookmark/favourite reaction',
    acyclic: false,
  },
  supersedes: {
    src: ['memory'],
    dst: ['memory'],
    description: 'Successor marks predecessor. Reads resolve to the chain head.',
    acyclic: true,
  },
  tracks: {
    src: ['task'],
    dst: ['pull_request', 'commit'],
    description: 'Task implementation tracking',
    acyclic: false,
  },
  triggered_by: {
    src: ['task', 'work_session'],
    dst: ['loop'],
    description: 'This task or session exists because that loop fired. The loop\'s inbound triggered_by edges ARE its run history.',
    acyclic: false,
  },
  verifies: {
    src: ['message', 'memory'],
    dst: ['*'],
    description: 'The expensive clear: mechanism, answered disputes, current-version pin, and a checked independence basis.',
    acyclic: false,
  },
  visible_to: {
    src: ['*'],
    dst: ['member', 'team_member'],
    description: 'Restricted-visibility grant. Registered now, inert in v1 (01 §S4)',
    acyclic: false,
  },
  working_on: {
    src: ['member', 'team_member', 'work_session'],
    dst: ['task'],
    description: 'Active work',
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
