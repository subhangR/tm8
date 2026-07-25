/**
 * Internal record shapes for the MockWorld. These mirror the V2 entity-graph
 * design (envelope + kind detail + edges + ledger) and are NEVER exported from
 * the collab-v2 barrel — components only ever see contract DTO projections.
 */
import type {
  AcceptanceCriterion, EntityId, EntityKind, FileAttachment, Mention,
  SpaceId, Visibility, WorkStatus,
} from '../types/contract';

/** Millisecond clock, injectable so tests and the simulation control time. */
export type Clock = () => number;

export const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Envelope + kind detail (design doc §5)
// ---------------------------------------------------------------------------

export interface TaskData {
  title: string; description: string;
  axes: Record<string, string>;
  workStatus: WorkStatus;
  priority: 'low'|'medium'|'high'|'urgent';
  acceptanceCriteria: AcceptanceCriterion[];
  pointsEstimate: number | null;
  dueDate: string | null;
}
export interface ChannelData { name: string; topic: string }
export interface DocData { title: string; body: string; format: 'markdown'|'mermaid'|'excalidraw' }
export interface MessageData {
  anchorId: EntityId; rootMessageId: EntityId | null; authorId: EntityId;
  body: string; mentions: Mention[]; attachments: FileAttachment[];
  editedAt: number | null;
}
export interface MemberData {
  userId: string; displayName: string; role: 'owner'|'admin'|'member';
  avatar: string | null; joinedAt: number;
}
export interface TeamMemberData {
  ownerMemberId: EntityId; name: string; role: string; identity: string;
  memories: unknown[]; model: string | null; agentTool: string | null;
  mode: string | null; avatar: string | null;
  capabilities: Record<string, unknown>; commandPermissions: Record<string, unknown>;
}
export interface PullRequestData {
  provider: string; url: string; repo: string; number: number; title: string;
  state: 'open'|'merged'|'closed'|'draft'; headSha: string | null; fetchedAt: number | null;
}
export interface CommitData { repo: string; sha: string; message: string; author: string; url: string | null; committedAt: number | null }
export interface FileData { name: string; mimeType: string; sizeBytes: number; storagePath: string }
export interface SpellData { name: string; description: string }
export interface SkillData { name: string; description: string; content: string }

export type KindData =
  | { kind: 'task'; task: TaskData }
  | { kind: 'channel'; channel: ChannelData }
  | { kind: 'doc'; doc: DocData }
  | { kind: 'message'; message: MessageData }
  | { kind: 'member'; member: MemberData }
  | { kind: 'team_member'; teamMember: TeamMemberData }
  | { kind: 'pull_request'; pullRequest: PullRequestData }
  | { kind: 'commit'; commit: CommitData }
  | { kind: 'file'; file: FileData }
  | { kind: 'spell'; spell: SpellData }
  | { kind: 'skill'; skill: SkillData };

export interface CountersRec {
  likes: number; dislikes: number; stars: number; points: number; messages: number;
}

export interface EntityRec {
  id: EntityId;
  spaceId: SpaceId;
  kind: EntityKind;
  parentId: EntityId | null;
  position: number;
  visibility: Visibility;
  version: number;
  activityAt: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  createdById: EntityId;
  counters: CountersRec;
  data: KindData;
}

export interface EdgeRec {
  id: string;
  spaceId: SpaceId;
  srcId: EntityId;
  dstId: EntityId;
  type: string;
  props: Record<string, unknown>;
  createdById: EntityId;
  createdAt: number;
}

export interface PointEventRec {
  id: string; spaceId: SpaceId;
  entityId: EntityId;              // what/who the points land on
  actorId: EntityId;               // who granted
  amount: number;
  reason: 'grant'|'award'|'seed';
  refId: EntityId | null;
  createdAt: number;
}

export interface NotificationRec {
  id: string; spaceId: SpaceId; kind: string;
  actorId: EntityId | null; targetId: EntityId | null;
  message: string; readAt: number | null; createdAt: number;
  /** Which member's inbox this row belongs to. */
  recipientMemberId: EntityId;
}

export interface ActivityRec {
  id: string; spaceId: SpaceId; entityId: EntityId | null; actorId: EntityId | null;
  verb: string; summary: Record<string, unknown>; refId: string | null; createdAt: number;
}

export interface VersionRec { version: number; changedById: EntityId; changedAt: number }

export interface PresenceRec { viewerIds: EntityId[]; typingActorIds: EntityId[]; updatedAt: number }

export interface TaskAxisRec {
  id: string; spaceId: SpaceId; name: string; axisValues: string[];
  kind: 'default'|'manual'; position: number;
}

export interface SavedViewRec {
  id: string; spaceId: SpaceId; name: string; shareMode: 'private'|'space';
  query: unknown; graphLayout?: Record<EntityId, { x: number; y: number }>;
  createdById: EntityId; createdAt: number;
}

export interface SpaceRec {
  id: SpaceId; name: string; description: string; githubRepo: string | null; createdAt: number;
  invites: Array<{ id: string; code: string; maxUses: number; uses: number; expiresAt: number | null; revoked: boolean }>;
}

// ---------------------------------------------------------------------------
// Edge type registry (design §7.3 + contract §4 attached_to expansion)
// ---------------------------------------------------------------------------

const ANY: EntityKind[] = ['channel','task','message','member','team_member','doc','file','spell','skill','pull_request','commit'];
const ACTORS: EntityKind[] = ['member', 'team_member'];

export interface EdgeTypeDef { src: EntityKind[]; dst: EntityKind[]; label: string; acyclic?: boolean }

/**
 * Core taxonomy. `attached_to` uses the contract's expanded registry: every
 * hub-displayable kind may attach to anything (channel shelf/tabs use it).
 * Unregistered types must be namespaced `x:*`.
 */
export const EDGE_TYPES: Record<string, EdgeTypeDef> = {
  depends_on:   { src: ANY, dst: ANY, label: 'Depends on', acyclic: true },
  assigned_to:  { src: ['task'], dst: ACTORS, label: 'Assigned to' },
  pulled:       { src: ACTORS, dst: ANY, label: 'Pulled by' },
  working_on:   { src: ACTORS, dst: ['task'], label: 'Working on' },
  completed_by: { src: ['task'], dst: ACTORS, label: 'Completed by' },
  tracks:       { src: ['task'], dst: ['pull_request', 'commit'], label: 'Tracks' },
  attached_to:  { src: ['task','doc','file','spell','skill','member','team_member','pull_request','commit'], dst: ANY, label: 'Attached' },
  equips:       { src: ['task','team_member'], dst: ['spell','skill'], label: 'Equips' },
  copy_of:      { src: ANY, dst: ANY, label: 'Copy of' },
  likes:        { src: ACTORS, dst: ANY, label: 'Likes' },
  dislikes:     { src: ACTORS, dst: ANY, label: 'Dislikes' },
  stars:        { src: ACTORS, dst: ANY, label: 'Stars' },
  relates_to:   { src: ANY, dst: ANY, label: 'Related' },
};

/** Reaction edges are internal bookkeeping — hidden from Connections rails. */
export const REACTION_TYPES = new Set(['likes', 'dislikes', 'stars']);

export function edgeTypeLabel(type: string): string {
  const def = EDGE_TYPES[type];
  if (def) return def.label;
  return type.startsWith('x:')
    ? type.slice(2).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
    : type;
}

export function validateEdgeType(type: string, srcKind: EntityKind, dstKind: EntityKind): string | null {
  const def = EDGE_TYPES[type];
  if (!def) {
    return type.startsWith('x:') ? null : `unregistered edge type "${type}" must be namespaced "x:*"`;
  }
  if (!def.src.includes(srcKind)) return `edge "${type}" does not allow source kind "${srcKind}"`;
  if (!def.dst.includes(dstKind)) return `edge "${type}" does not allow destination kind "${dstKind}"`;
  return null;
}

// ---------------------------------------------------------------------------
// Opaque keyset cursors (DEV-5 / 04 §3)
// ---------------------------------------------------------------------------

// btoa/atob are global in browsers AND Node ≥16 — no Buffer dependency.
const b64encode = (s: string): string => btoa(s);
const b64decode = (s: string): string => atob(s);

/**
 * Cursor = base64 of `{ v: 2, k: [lastKey] }` — the keyset resume point is the
 * identity of the last item served, never an offset. Version-tagged so legacy
 * or foreign cursors are rejected cleanly, not misinterpreted.
 */
export const encodeCursor = (lastKey: string): string =>
  b64encode(JSON.stringify({ v: 2, k: [lastKey] }));

/** Returns the keyset resume key, or null for an unusable cursor. */
export const decodeCursor = (cursor: string): string | null => {
  try {
    const parsed = JSON.parse(b64decode(cursor)) as { v?: number; k?: unknown[] };
    if (parsed.v !== 2 || !Array.isArray(parsed.k) || typeof parsed.k[parsed.k.length - 1] !== 'string') return null;
    return parsed.k[parsed.k.length - 1] as string;
  } catch {
    return null;
  }
};

/** Convention for entity embeds inside message bodies (drop-chip-to-embed). */
export const embedToken = (entityId: EntityId): string => `{{embed:${entityId}}}`;

export const excerptOf = (text: string, len = 140): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= len ? flat : `${flat.slice(0, len - 1)}…`;
};
