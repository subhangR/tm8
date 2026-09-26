/**
 * Space links (migrations 243/244, Phase 1b W6). A home space links to a
 * target space; each member of the home space who is also a member of the
 * target signs in once and the server stores that member's own `link`
 * session for the target, sealed, 90 days. Agents launched by that member use
 * it (W7); nobody else can.
 *
 *   · spaceLinks.list     — every home member sees the links (no secrets)
 *   · spaceLinks.add      — link a space you are also a member of
 *   · spaceLinks.login    — sign in: store your own session for the target
 *   · spaceLinks.relogin  — replace it; the old one is revoked
 *   · spaceLinks.logout   — revoke it and forget the stored bytes
 *   · spaceLinks.remove   — delete your own row (the link stays for others)
 *   · spaceLinks.setSpawn — your own spawn switch and budget
 *
 * Every write is human-only (browser or cli) in SQL. No response ever carries
 * the stored session.
 */
import { z } from 'zod';

import type { EntityId } from './contract.js';

export type SpaceLinkStatus = 'signed_in' | 'signed_out' | 'left' | 'unreachable';

/** The caller's own row: metadata only. */
export interface SpaceLinkMine {
  memberId: EntityId;
  status: SpaceLinkStatus;
  allowSpawn: boolean;
  spawnBudget: number;
  alias: string | null;
  sessionId: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface SpaceLinkView {
  id: EntityId;
  homeSpaceId: string;
  targetSpaceId: string;
  /** Null = this server. */
  targetServerId: EntityId | null;
  /** Only when the caller is a member of the target. */
  targetSpaceName: string | null;
  createdAt: string;
  statusSummary: { signedIn: number; signedOut: number; left: number; unreachable: number };
  /** Null when the caller holds no row on this link. */
  mine: SpaceLinkMine | null;
}

/** The body of spaceLinks.add: the home Space is the path's `:spaceId`. */
export interface SpaceLinksAddInput {
  targetSpaceId: string;
  alias?: string | null;
  clientMutationId: string;
}

/** The body of spaceLinks.login / relogin / logout / remove. */
export interface SpaceLinksMutationInput {
  clientMutationId: string;
}

/** The body of spaceLinks.setSpawn. */
export interface SpaceLinksSetSpawnInput {
  allowSpawn: boolean;
  /** 0..100; omitted keeps the current budget. */
  spawnBudget?: number | null;
  clientMutationId: string;
}

const clientMutationId = z.string().trim().min(1);

export const SpaceLinksAddInputSchema: z.ZodType<SpaceLinksAddInput> = z.object({
  targetSpaceId: z.string().uuid(),
  alias: z.string().max(200).nullable().optional(),
  clientMutationId,
}).strict();

export const SpaceLinksMutationInputSchema: z.ZodType<SpaceLinksMutationInput> = z.object({
  clientMutationId,
}).strict();

export const SpaceLinksSetSpawnInputSchema: z.ZodType<SpaceLinksSetSpawnInput> = z.object({
  allowSpawn: z.boolean(),
  spawnBudget: z.number().int().min(0).max(100).nullable().optional(),
  clientMutationId,
}).strict();

// ---------------------------------------------------------------------------
// spaceLinks.invoke (W7, decisions 31 + E2). Through a link an agent acts as
// its launching member IN FULL, except for the refused set below. The set is
// ONE constant, matched by PREFIX on the canonical catalog op name (plus
// entries flagged `exact`, which match one op), so a future `credentials.*`
// op is refused without an edit here. It is checked on
// the HOME server before anything is unsealed or forwarded (T22).
// ---------------------------------------------------------------------------

export interface SpaceLinkRefusedPrefix {
  readonly prefix: string;
  /** `all` refuses reads too; `command` refuses writes only. */
  readonly kinds: 'all' | 'command';
  readonly reason: SpaceLinkRefusalReason;
  /** The whole op name, not a prefix: a single op, not a namespace. */
  readonly exact?: true;
}

export type SpaceLinkRefusalReason =
  | 'credential_management'
  | 'link_management'
  | 'session_minting'
  | 'token_minting'
  | 'spawn_switch_off'
  | 'spawn_explicit_credentials'
  | 'unknown_op'
  | 'via_loop'
  | 'via_hops';

/**
 * THE refused set. Credential MANAGEMENT is refused (E2); credential USE is
 * not: a spawn with defaults in B resolves B's own credential as the member.
 * `spaceLinks.*` reads (list, audit) carry no secret and pass; every
 * `spaceLinks.*` write, including a nested invoke, is the link's own token
 * management. `auth.*` is refused whole: it mints, reads and ends sessions.
 *
 * Stricter than D31 (lead 09:08Z, fail-closed; reversible): `serverConnections.*`
 * manages the credential-bearing remote-server surface, and `voice.token.create`
 * mints a token. Both are the class of credential management D31 refuses.
 */
export const SPACE_LINK_REFUSED: readonly SpaceLinkRefusedPrefix[] = [
  { prefix: 'credentials.', kinds: 'all', reason: 'credential_management' },
  { prefix: 'node.credentials.', kinds: 'all', reason: 'credential_management' },
  { prefix: 'spaceLinks.', kinds: 'command', reason: 'link_management' },
  { prefix: 'auth.', kinds: 'all', reason: 'session_minting' },
  { prefix: 'serverConnections.', kinds: 'all', reason: 'credential_management' },
  { prefix: 'voice.token.create', kinds: 'all', reason: 'token_minting', exact: true },
];

/** The spawn op, refused through a link with the switch off or explicit credentials (F9). */
export const SPACE_LINK_SPAWN_OP = 'execution.spawn';

/** Spawn input fields that name a credential source; any one present refuses (K11). */
export const SPACE_LINK_SPAWN_CREDENTIAL_FIELDS = [
  'credentialSources',
  'credentialSource',
  'spaceCredentialIds',
] as const;

/** The loop-guard header. It can only ADD spaces to the chain, never remove one. */
export const SPACE_LINK_VIA_HEADER = 'x-tm8-via';
/** At most two link hops from the origin space. */
export const SPACE_LINK_MAX_HOPS = 2;

/**
 * The refused-set rule on a CANONICAL op name (the caller resolves the name
 * against the catalog first; an unknown name never reaches here as passable).
 * `opKind` is the catalog kind. Returns the reason, or null when the op passes
 * as the member. `allowSpawn` is the caller's own row's switch.
 */
export function spaceLinkRefusal(
  op: string,
  opKind: 'read' | 'command' | 'stream',
  input: unknown,
  allowSpawn: boolean | undefined,
): SpaceLinkRefusalReason | null {
  for (const entry of SPACE_LINK_REFUSED) {
    const hit = entry.exact ? op === entry.prefix : op.startsWith(entry.prefix);
    if (hit && (entry.kinds === 'all' || opKind !== 'read')) return entry.reason;
  }
  if (op === SPACE_LINK_SPAWN_OP) {
    const body = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
    if (SPACE_LINK_SPAWN_CREDENTIAL_FIELDS.some((field) => body[field] !== undefined)) {
      return 'spawn_explicit_credentials';
    }
    // Unknown (not yet resolved) is not refused here; the handler re-checks
    // with the row's value before forwarding.
    if (allowSpawn === false) return 'spawn_switch_off';
  }
  return null;
}

/**
 * The via chain after this hop: the spaces already traversed (header) plus
 * the home space. Refused when the target is already in it, or when this hop
 * would be past SPACE_LINK_MAX_HOPS.
 */
export function spaceLinkViaRefusal(
  via: readonly string[],
  homeSpaceId: string,
  targetSpaceId: string | null,
): SpaceLinkRefusalReason | null {
  const chain = [...via, homeSpaceId];
  if (new Set(chain).size !== chain.length) return 'via_loop';
  if (targetSpaceId !== null && chain.includes(targetSpaceId)) return 'via_loop';
  if (chain.length > SPACE_LINK_MAX_HOPS) return 'via_hops';
  return null;
}

/** The body of spaceLinks.invoke: one catalog op, run in the target as the member. */
export interface SpaceLinksInvokeInput {
  /** Canonical catalog op name, exactly as the catalog spells it. */
  op: string;
  /** Path params of that op (`:id` → `params.id`). */
  params?: Record<string, string>;
  /** Query string of a read. */
  query?: Record<string, string>;
  /** The op's own body, validated by the op's own schema. */
  input?: unknown;
}

export const SpaceLinksInvokeInputSchema: z.ZodType<SpaceLinksInvokeInput> = z.object({
  op: z.string().min(1).max(200),
  params: z.record(z.string().max(500)).optional(),
  query: z.record(z.string().max(2000)).optional(),
  input: z.unknown().optional(),
}).strict();

export interface SpaceLinksInvokeResult {
  op: string;
  linkId: EntityId;
  targetSpaceId: string;
  /** The home-space audit row for this call. */
  auditId: string;
  /** The op's own `data`. */
  result: unknown;
}

export interface SpaceLinkAuditEntry {
  id: string;
  linkId: EntityId | null;
  homeSpaceId: string;
  targetSpaceId: string | null;
  memberId: EntityId;
  teamMemberId: EntityId | null;
  workSessionId: EntityId | null;
  op: string;
  viaChain: string[];
  result: 'ok' | 'refused' | 'error';
  reason: string | null;
  remoteId: string | null;
  requestId: string | null;
  createdAt: string;
}
