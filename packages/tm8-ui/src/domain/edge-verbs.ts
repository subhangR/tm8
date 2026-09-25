/**
 * EDGE VERBS — how a connection reads from the entity whose panel is open.
 *
 * The Connections tab used to print the edge's registry id and an arrow:
 * `← authored_from (incoming)`. Seven of the ten edge types on an ordinary
 * work session had no human label anywhere (the server's `EDGE_LABELS` and the
 * store's `LIVE_EDGE_LABELS` cover fifteen of forty-three), so the fallback
 * leaked the id — and the arrow left the reader to work out which end was
 * which. Here each (type, direction) pair is ONE verb phrase written from the
 * open entity's side: an outgoing `working_on` reads "Working on", an incoming
 * `created_in` reads "Created here". Direction is inside the words, so no
 * arrow is needed.
 *
 * EVERY REGISTERED TYPE HAS A ROW. `edge-verbs.test.ts` reads the edge types
 * the migrations register and fails on any type missing here (and on any row
 * here for a type nothing registers). A new edge type therefore cannot reach
 * this tab as a raw id — the omission that produced the leak is now a red test.
 */

export interface EdgeVerb {
  /** This entity is the edge's SOURCE. */
  out: string;
  /** This entity is the edge's TARGET. */
  in: string;
  /**
   * The phrase when one peer holds the edge in BOTH directions ("Messaged" and
   * "Heard from" the same session is one conversation). Absent ⇒ the two
   * directions stay two relations, because for most types they mean different
   * things ("Depends on" and "Needed by" are not one fact).
   */
  both?: string;
  /**
   * Peer kinds whose INCOMING edge of this type is conversation traffic rather
   * than a connection: a message posted on, or from, this entity. Those are
   * the Discussion tab's content, and listing them here as rows is what buried
   * a session's real links under its own status posts. They are summarised as
   * one row instead of drawn one per message.
   */
  conversationFrom?: readonly string[];
}

/** The kind a conversation edge's far end is — drawn as the summary row's mark. */
export const CONVERSATION_KIND = 'message';

const MESSAGE_KINDS = [CONVERSATION_KIND] as const;

export const EDGE_VERBS: Readonly<Record<string, EdgeVerb>> = {
  about: { out: 'About', in: 'Subject of' },
  anchored_to: { out: 'Posted on', in: 'Posted here', conversationFrom: MESSAGE_KINDS },
  approval_requested_from: { out: 'Approval asked of', in: 'Asked to approve' },
  approved_by: { out: 'Approved by', in: 'Approved' },
  assigned_to: { out: 'Assigned to', in: 'Assigned' },
  attached_to: { out: 'Attached to', in: 'Attached here' },
  authored_from: { out: 'Authored in', in: 'Authored here', conversationFrom: MESSAGE_KINDS },
  based_on: { out: 'Based on', in: 'Basis for' },
  completed_by: { out: 'Completed by', in: 'Completed' },
  contains: { out: 'Contains', in: 'In collection' },
  controls: { out: 'Controls', in: 'Controlled by' },
  consumes: { out: 'Consumes', in: 'Consumed by' },
  copy_of: { out: 'Copy of', in: 'Copied as' },
  created_in: { out: 'Created in', in: 'Created here' },
  defaults_to_profile: { out: 'Defaults to', in: 'Default for' },
  depends_on: { out: 'Depends on', in: 'Needed by' },
  derived_from: { out: 'Launches', in: 'Launched by' },
  dislikes: { out: 'Dislikes', in: 'Disliked by' },
  dispatched_by: { out: 'Dispatched by', in: 'Dispatched' },
  disputes: { out: 'Disputes', in: 'Disputed by' },
  drives: { out: 'Drives', in: 'Driven by' },
  equips: { out: 'Equips', in: 'Equipped by' },
  has_member: { out: 'Has member', in: 'Member of' },
  in_project: { out: 'In project', in: 'In this project' },
  in_worktree: { out: 'In worktree', in: 'In this worktree' },
  likes: { out: 'Likes', in: 'Liked by' },
  member_of: { out: 'Member of', in: 'Has member' },
  messaged: { out: 'Messaged', in: 'Heard from', both: 'Talked with' },
  mounts: { out: 'Mounts', in: 'Mounted in' },
  participates_in: { out: 'Participates in', in: 'Acting as' },
  produces: { out: 'Produces', in: 'Produced by' },
  pulled: { out: 'Pulled', in: 'Pulled by' },
  relates_to: { out: 'Related', in: 'Related' },
  remembers: { out: 'Remembers', in: 'Remembered by' },
  runs_in: { out: 'Runs in', in: 'Hosts' },
  selected_profile: { out: 'Profile', in: 'Profile of' },
  shared_into: { out: 'Shared into', in: 'Shared here' },
  snapshot_of: { out: 'Forked from', in: 'Forked as' },
  stars: { out: 'Starred', in: 'Starred by' },
  supersedes: { out: 'Supersedes', in: 'Superseded by' },
  tracks: { out: 'Tracks', in: 'Tracked by' },
  triggered_by: { out: 'Triggered by', in: 'Triggered' },
  verifies: { out: 'Verifies', in: 'Verified by' },
  visible_to: { out: 'Visible to', in: 'Can see' },
  working_on: { out: 'Working on', in: 'Worked on by' },
};

export type EdgeDirection = 'outgoing' | 'incoming';

/**
 * The verb for one direction of one type. An unmapped type (a server newer
 * than this build) reads as its id with spaces, and its incoming side keeps an
 * arrow — the one case where the words cannot carry the direction.
 */
export function edgeVerb(type: string, direction: EdgeDirection): string {
  const row = EDGE_VERBS[type];
  if (row) return direction === 'outgoing' ? row.out : row.in;
  const words = type.replace(/_/g, ' ');
  return direction === 'outgoing' ? words : `← ${words}`;
}

/** The single phrase for a peer that holds `type` both ways, or null. */
export function edgeVerbBoth(type: string): string | null {
  return EDGE_VERBS[type]?.both ?? null;
}

/**
 * Is this edge a message posted on or from the entity, rather than a
 * connection? Only the INCOMING side counts: on a message's own panel, its
 * `authored_from` edge to the session that wrote it is a real connection.
 */
export function isConversationEdge(type: string, direction: EdgeDirection, peerKind: string): boolean {
  if (direction !== 'incoming') return false;
  return EDGE_VERBS[type]?.conversationFrom?.includes(peerKind) ?? false;
}
