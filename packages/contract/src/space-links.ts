/**
 * Space links (migrations 250/251, Phase 1b W6). A home space links to a
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
 *   · spaceLinks.setSpawn — your own spawn switch and budget. Allow spawn is
 *                           enforced since W7b: on, your agents may spawn,
 *                           resume or dispatch in the target through the link;
 *                           the budget is stored but not enforced (owner form
 *                           response 01a0fbb4).
 *
 * The TARGET side (278, owner decision D2): an admin of the target space sees
 * every link into it (`spaceLinks.inbound.list`), the calls made through them
 * (`spaceLinks.inbound.audit`), and may revoke or restore a link. A revoked
 * link refuses every member's sign-in. Owning both spaces is no shortcut
 * (D7): the admin check holds the session pin, so it is made from the target.
 *
 * ACROSS SERVERS (W9c, migration 301; ships dark behind TM8_REMOTE_SPACE_LINKS).
 * The target may live on another server (`targetServerId`, a `server` entity
 * of the home space). On the TARGET server a member of B grants the remote
 * home (`spaceLinks.inbound.grant`) and gets a one-time pairing code; on the
 * HOME server `spaceLinks.login` with that `pairingCode` has the home server
 * claim it server-to-server (`REMOTE_SPACE_LINK_PATHS.claim`). The target
 * mints a `link` session for the member, pinned to B, and the home server
 * seals it. No human session ever crosses servers, and none is retained.
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
  /**
   * Set when an admin of the target space revoked the link (278): every
   * sign-in is refused until they restore it. Absent from a pre-278 server.
   */
  targetRevokedAt?: string | null;
  statusSummary: { signedIn: number; signedOut: number; left: number; unreachable: number };
  /** Null when the caller holds no row on this link. */
  mine: SpaceLinkMine | null;
}

/**
 * One member's row on an inbound link, as the TARGET's admins see it (278).
 * The member is named by their own member row in the target, never by a
 * home-side id. Null when that identity has no member row in the target.
 */
export interface SpaceLinkInboundHolder {
  targetMemberId: EntityId | null;
  displayName: string | null;
  status: SpaceLinkStatus;
  allowSpawn: boolean;
  spawnBudget: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

/** A link INTO a space, for that space's admins (`spaceLinks.inbound.list`). */
export interface SpaceLinkInboundView {
  /** The link entity's id (it lives in the home space). */
  id: EntityId;
  homeSpaceId: string;
  homeSpaceName: string | null;
  targetSpaceId: string;
  createdAt: string;
  /** Set while revoked by a target admin; every sign-in is refused. */
  revokedAt: string | null;
  revokedByMemberId: EntityId | null;
  lastCallAt: string | null;
  /**
   * W9c (301): set when the link's home is a space on ANOTHER server. Then
   * `homeSpaceId` is that remote space's id and `homeSpaceName` its label.
   * Absent from a pre-301 server.
   */
  remoteHome?: SpaceLinkRemoteHome | null;
  holders: SpaceLinkInboundHolder[];
}

/** The remote home of an inbound link, as the home server identified itself when it claimed. */
export interface SpaceLinkRemoteHome {
  spaceId: string;
  label: string | null;
  /** The home server's stable node id, sent on claim. Null until claimed. */
  serverId: string | null;
  /** The home server's public origin, sent on claim. Null when it has none configured. */
  baseUrl: string | null;
}

/** One call made into the target through a link (`spaceLinks.inbound.audit`). */
export interface SpaceLinkInboundAuditEntry {
  id: string;
  linkId: EntityId;
  homeSpaceId: string;
  targetSpaceId: string;
  /** The caller's own member row in the target. */
  targetMemberId: EntityId | null;
  displayName: string | null;
  op: string;
  viaChain: string[];
  result: 'ok' | 'refused' | 'error';
  reason: string | null;
  /** The target-side entity or request id the call produced. */
  remoteId: string | null;
  createdAt: string;
}

/** The body of spaceLinks.add: the home Space is the path's `:spaceId`. */
export interface SpaceLinksAddInput {
  targetSpaceId: string;
  /**
   * W9c: a `server` entity of the home space when the target space lives on
   * that server. Omitted or null: the target is on this server.
   */
  targetServerId?: string | null;
  alias?: string | null;
  clientMutationId: string;
}

/**
 * The body of spaceLinks.login / relogin. `pairingCode` (W9c) signs in to a
 * link whose target is on another server: the code the target's
 * `spaceLinks.inbound.grant` returned. Required for a remote link, refused for
 * a local one.
 */
export interface SpaceLinksLoginInput {
  pairingCode?: string | null;
  clientMutationId: string;
}

/**
 * The body of spaceLinks.inbound.grant (W9c), on the TARGET server: the
 * caller lets `homeSpaceId` on another server act in `:spaceId` as them.
 */
export interface SpaceLinksInboundGrantInput {
  /** The home space's id on the other server. The claim must name the same id. */
  homeSpaceId: string;
  /** How B's admins see the home, e.g. "tm8 on laptop". */
  homeLabel?: string | null;
  /** This server's own spawn switch for the link (the home row has its own). Default off. */
  allowSpawn?: boolean | null;
  clientMutationId: string;
}

export interface SpaceLinksInboundGrantResult {
  link: SpaceLinkInboundView;
  targetSpaceId: string;
  /** Single use; pass it to `spaceLinks.login` on the home server. Never stored here, only its hash. */
  pairingCode: string;
  pairingExpiresAt: string;
}

/** The body of spaceLinks.login / relogin / logout / remove. */
export interface SpaceLinksMutationInput {
  clientMutationId: string;
}

/**
 * The body of spaceLinks.setSpawn. Allow spawn gates spawn, resume and
 * dispatch through the link (W7b); `spawnBudget` is stored, not enforced.
 */
export interface SpaceLinksSetSpawnInput {
  allowSpawn: boolean;
  /** 0..100; omitted keeps the current budget. */
  spawnBudget?: number | null;
  clientMutationId: string;
}

const clientMutationId = z.string().trim().min(1);

export const SpaceLinksAddInputSchema: z.ZodType<SpaceLinksAddInput> = z.object({
  targetSpaceId: z.string().uuid(),
  targetServerId: z.string().uuid().nullable().optional(),
  alias: z.string().max(200).nullable().optional(),
  clientMutationId,
}).strict();

export const SpaceLinksMutationInputSchema: z.ZodType<SpaceLinksMutationInput> = z.object({
  clientMutationId,
}).strict();

export const SpaceLinksLoginInputSchema: z.ZodType<SpaceLinksLoginInput> = z.object({
  pairingCode: z.string().trim().min(16).max(200).nullable().optional(),
  clientMutationId,
}).strict();

export const SpaceLinksInboundGrantInputSchema: z.ZodType<SpaceLinksInboundGrantInput> = z.object({
  homeSpaceId: z.string().uuid(),
  homeLabel: z.string().trim().min(1).max(200).nullable().optional(),
  allowSpawn: z.boolean().nullable().optional(),
  clientMutationId,
}).strict();

/** The body of spaceLinks.inbound.revoke / restore: the path names the space and the link. */
export type SpaceLinksInboundMutationInput = SpaceLinksMutationInput;

export const SpaceLinksInboundMutationInputSchema: z.ZodType<SpaceLinksInboundMutationInput> = SpaceLinksMutationInputSchema;

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
  | 'grant'
  | 'process_start'
  | 'session_body'
  | 'membership'
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
 *
 * Side-channel grants (#884, security finding S1 from the W9 review): an op
 * that mints a bearer capability for ANOTHER channel (a PTY/stream attach
 * grant, an upload slot grant, a preview capability URL, a container surface
 * or CDP endpoint, a shared port URL) is refused, reads too. The grant is
 * authorised by itself on its socket or route, so returning it to A would let
 * A drive B outside every per-op check here. `execution.streams.*` is a
 * prefix so any future stream grant is covered; the rest are exact.
 *
 * Session and process starts (#884, security re-review R-1): an op that starts
 * a session, a shell or a process in B, or resumes or dispatches one, is
 * refused at home. `execution.terminal.start` starts an unbudgeted shell work
 * session that no spawn switch or link gate covers, so through a link it
 * would be a shell in B.
 *
 * Cross-space spawn (W7b, lane L4). This DELIBERATELY reverses #884's lead
 * tightening ("main must never carry an unbudgeted link spawn"). The owner
 * decided it in form response 01a0fbb4 (decisions D1, D4 and D8 of form
 * 01a0fb65: "if link is there spawn for now"): with no budget and no
 * reservation, `execution.spawn`, `execution.resume` and `execution.dispatch`
 * (SPACE_LINK_SPAWN_OPS) are NOT in this set. They pass only while the
 * caller's own row has allow_spawn on (`spaceLinkRefusal` below, re-checked
 * against the row before forwarding). Every other guard stays: no explicit
 * credential field (spawn_explicit_credentials), the via-chain hop limit, the
 * per-row rate bucket, and in SQL the child takes B's DEFAULT credential only
 * and is minted only while the row is signed in with spawning allowed
 * (256 `live_link_session`, 277). `chat.start` and `chat.setModel` stay
 * refused: a chat's turns are launched by the chat runtime under the
 * requesting human's identity with no via_link stamp
 * (chat/compose.ts `createChatLaunchConfigResolver`), so they would not be
 * link-bound, would not take B's default credential only, and would outlive
 * the link (ruling (i)). The indirect starts
 * are listed too: a form response submit (and redeliver) queues a delivery
 * that resumes the requesting session or spawns a new one
 * (form-delivery-spawn.ts). `containers.pools.set` keeps warm containers
 * running. `chat.setModel` (276) is that same shape and is refused for the same
 * reason `chat.start` is: it starts nothing when called, but the next claimed
 * turn CLOSES the live child and re-spawns it on the model the caller named,
 * and a model carries the PROVIDER that decides which of B's API keys that
 * child is handed. Passing it would mean a link identity that cannot start a
 * chat on B could still repoint an existing one onto any catalog model and
 * spend B's credential running it — the asymmetry is the hole. `execution.git*` (reads too) runs git in B's worktree without
 * `core.hooksPath` or `core.fsmonitor` overridden, so a commit, merge or
 * status there can run a hook or monitor B's worktree configures: a process
 * started in B. It is a prefix, so a future git op is covered. The other
 * entries are exact, so a NEW start op is not
 * refused by name; instead packages/server/test/space-link-classification.test.ts
 * walks the catalog and fails until every start or grant op is classified.
 * `forms.create` and `forms.update` are refused by INPUT (below) when the
 * delivery policy they set can start one: create unless it sets
 * `onSessionNotLive: 'queue'` with the default target (the default is resume),
 * update when it sets `new_session`, `resume` or `spawn_new`.
 *
 * Session bodies (W9 v4 alignment): `execution.journal` and
 * `execution.transcript` read a session's body, and a journal can hold a live
 * token (the F3 journal-redaction item), so they are refused, reads too.
 * ONE exception (299, SPACE_LINK_OWN_SPAWN_OPS): the body of a session the
 * caller's own link started as the caller's own member, which B confirms from
 * `space_link_spawns` under the link session before its handler runs.
 *
 * Membership and role writes (owner decision D6, lane L6): who belongs to B
 * and with what role is B's humans' call, made in B. Through a link every
 * `spaces.members.*` and `spaces.invites.*` write (role change, removal, the
 * member space-password resets, invite create/revoke/redeem) and
 * `spaces.leave` is refused at home, even for a member who is admin in B;
 * reads (members and invite lists) pass. A human acting directly in B is
 * unaffected: this list only gates spaceLinks.invoke.
 *
 * The reason is the CLASS the refusal error carries: `grant`,
 * `process_start`, `session_body`, `membership`, and the
 * credential/link/session classes.
 */
export const SPACE_LINK_REFUSED: readonly SpaceLinkRefusedPrefix[] = [
  { prefix: 'credentials.', kinds: 'all', reason: 'credential_management' },
  { prefix: 'node.credentials.', kinds: 'all', reason: 'credential_management' },
  { prefix: 'spaceLinks.', kinds: 'command', reason: 'link_management' },
  // L3 (279): `add` itself opens a hop through the caller's OWN link. Through
  // a link the caller is B's member, so allowing it would let an agent in A
  // ride B's member's links on into C (transitive link use, D7). list and
  // remove stay open: they touch B's stored rows only and open nothing.
  { prefix: 'entities.refs.add', kinds: 'all', reason: 'link_management', exact: true },
  { prefix: 'auth.', kinds: 'all', reason: 'session_minting' },
  { prefix: 'serverConnections.', kinds: 'all', reason: 'credential_management' },
  // 282 path grants: who may browse which node folders. Node-level, never a
  // cross-space act — a link caller neither administers them nor reads a
  // member's grants (they name node paths).
  { prefix: 'node.pathGrants.', kinds: 'all', reason: 'grant' },
  { prefix: 'identity.pathGrants.list', kinds: 'all', reason: 'grant', exact: true },
  { prefix: 'voice.token.create', kinds: 'all', reason: 'grant', exact: true },
  { prefix: 'execution.streams.', kinds: 'all', reason: 'grant' },
  { prefix: 'files.uploadInit', kinds: 'all', reason: 'grant', exact: true },
  { prefix: 'projects.folderUploads.init', kinds: 'all', reason: 'grant', exact: true },
  { prefix: 'artifacts.preview.start', kinds: 'all', reason: 'grant', exact: true },
  { prefix: 'containers.attach', kinds: 'all', reason: 'grant', exact: true },
  { prefix: 'containers.browser.endpoint', kinds: 'all', reason: 'grant', exact: true },
  { prefix: 'containers.expose', kinds: 'all', reason: 'grant', exact: true },
  { prefix: 'execution.terminal.start', kinds: 'all', reason: 'process_start', exact: true },
  { prefix: 'execution.prompt', kinds: 'all', reason: 'process_start', exact: true },
  { prefix: 'chat.start', kinds: 'all', reason: 'process_start', exact: true },
  { prefix: 'chat.setModel', kinds: 'all', reason: 'process_start', exact: true },
  { prefix: 'forms.responses.submit', kinds: 'all', reason: 'process_start', exact: true },
  { prefix: 'forms.responses.redeliver', kinds: 'all', reason: 'process_start', exact: true },
  { prefix: 'containers.create', kinds: 'all', reason: 'process_start', exact: true },
  { prefix: 'containers.start', kinds: 'all', reason: 'process_start', exact: true },
  { prefix: 'containers.resume', kinds: 'all', reason: 'process_start', exact: true },
  { prefix: 'containers.run', kinds: 'all', reason: 'process_start', exact: true },
  { prefix: 'containers.terminal.start', kinds: 'all', reason: 'process_start', exact: true },
  { prefix: 'containers.computer', kinds: 'all', reason: 'process_start', exact: true },
  { prefix: 'containers.fork', kinds: 'all', reason: 'process_start', exact: true },
  { prefix: 'containers.pools.set', kinds: 'all', reason: 'process_start', exact: true },
  { prefix: 'execution.git', kinds: 'all', reason: 'process_start' },
  { prefix: 'execution.journal', kinds: 'all', reason: 'session_body', exact: true },
  { prefix: 'execution.transcript', kinds: 'all', reason: 'session_body', exact: true },
  { prefix: 'spaces.members.', kinds: 'command', reason: 'membership' },
  { prefix: 'spaces.invites.', kinds: 'command', reason: 'membership' },
  { prefix: 'spaces.leave', kinds: 'all', reason: 'membership', exact: true },
];

/** The spawn op, refused through a link with the switch off or explicit credentials (F9). */
export const SPACE_LINK_SPAWN_OP = 'execution.spawn';

/**
 * W7b (L4, form response 01a0fbb4): the ops that start or resume a session in
 * B through a link. Each passes only while the caller's own row has
 * allow_spawn on; with it off, or not yet known to be on, they are refused
 * `spawn_switch_off`. Their child is pinned to B, stamped with the link
 * (256 via_link_id) and recorded in `space_link_spawns` (277).
 */
export const SPACE_LINK_SPAWN_OPS: readonly string[] = Object.freeze([
  SPACE_LINK_SPAWN_OP,
  'execution.resume',
  'execution.dispatch',
]);

/**
 * 299: the `session_body` ops that pass for a session the caller's own link
 * spawned (`space_link_spawns`: this link, this member), keyed to the path
 * param naming that session. The home server cannot see B's provenance, so
 * for these ops `spaceLinkRefusal` refuses `session_body` until the target
 * has confirmed it (`ownSpawn` true); every other session's body stays
 * refused. A spawner that can only see liveness cannot follow its child.
 */
export const SPACE_LINK_OWN_SPAWN_OPS: Readonly<Record<string, string>> = Object.freeze({
  'execution.journal': 'workSessionId',
  'execution.transcript': 'workSessionId',
});

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
 * as the member. `allowSpawn` is the caller's own row's switch, `undefined`
 * before the row is read: a spawn op is then not refused by the switch, and
 * the caller MUST call again with the row's value before forwarding.
 * `ownSpawn` is true only once the target has confirmed the session an
 * SPACE_LINK_OWN_SPAWN_OPS op names was started by the caller's own link as
 * its own member (299); anything else keeps that op refused `session_body`.
 */
export function spaceLinkRefusal(
  op: string,
  opKind: 'read' | 'command' | 'stream',
  input: unknown,
  allowSpawn: boolean | undefined,
  ownSpawn = false,
): SpaceLinkRefusalReason | null {
  for (const entry of SPACE_LINK_REFUSED) {
    const hit = entry.exact ? op === entry.prefix : op.startsWith(entry.prefix);
    if (!hit || (entry.kinds !== 'all' && opKind === 'read')) continue;
    if (entry.reason === 'session_body' && ownSpawn && op in SPACE_LINK_OWN_SPAWN_OPS) continue;
    return entry.reason;
  }
  if (formDeliveryCanStart(op, input)) return 'process_start';
  if (SPACE_LINK_SPAWN_OPS.includes(op)) {
    const body = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
    if (SPACE_LINK_SPAWN_CREDENTIAL_FIELDS.some((field) => body[field] !== undefined)) {
      return 'spawn_explicit_credentials';
    }
    if (allowSpawn === false) return 'spawn_switch_off';
  }
  return null;
}

/**
 * True when a forms.create or forms.update input sets a delivery policy that
 * resumes or spawns a session (form-delivery-spawn.ts runs it under the
 * node's claims). create: anything but `queue` to the requesting session,
 * since the default is `resume`. update: only what it sets.
 */
function formDeliveryCanStart(op: string, input: unknown): boolean {
  if (op !== 'forms.create' && op !== 'forms.update') return false;
  const body = typeof input === 'object' && input !== null ? input as { settings?: unknown } : {};
  const settings = typeof body.settings === 'object' && body.settings !== null ? body.settings as { delivery?: unknown } : {};
  const delivery = typeof settings.delivery === 'object' && settings.delivery !== null
    ? settings.delivery as { target?: unknown; onSessionNotLive?: unknown }
    : undefined;
  if (op === 'forms.create') {
    return (delivery?.target ?? 'requesting_session') !== 'requesting_session'
      || (delivery?.onSessionNotLive ?? 'resume') !== 'queue';
  }
  if (delivery === undefined) return false;
  return (delivery.target !== undefined && delivery.target !== 'requesting_session')
    || (delivery.onSessionNotLive !== undefined && delivery.onSessionNotLive !== 'queue');
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

// ---------------------------------------------------------------------------
// W9c: the server-to-server wire (not catalog operations). The TARGET server
// answers these; the HOME server calls them through its guarded client.
//   claim  — no bearer; the pairing code is the credential.
//   invoke — `authorization: Bearer <link session>`; the only wire a link
//            session is accepted on, and only an inbound remote one.
//   revoke — the same bearer; ends the session (home logout/remove).
// A target that answers 404 on these is older or has the switch off.
// ---------------------------------------------------------------------------

export const REMOTE_SPACE_LINK_PATHS = Object.freeze({
  claim: '/link/v1/claim',
  invoke: '/link/v1/invoke',
  revoke: '/link/v1/revoke',
});

export const REMOTE_SPACE_LINKS_UNSUPPORTED_MESSAGE =
  'target server does not support remote space links (upgrade it or enable TM8_REMOTE_SPACE_LINKS)';

export interface RemoteSpaceLinkClaimRequest {
  pairingCode: string;
  homeSpaceId: string;
  /** The home server's stable node id. */
  homeServerId: string;
  /** The home server's public origin, when it has one. */
  homeBaseUrl: string | null;
}

export interface RemoteSpaceLinkClaimResponse {
  /** The link session for the HOME server to seal. Returned once. */
  token: string;
  sessionId: string;
  expiresAt: string;
  targetSpaceId: string;
  /** The inbound link's id on the target server. */
  remoteLinkId: string;
}

export const RemoteSpaceLinkClaimRequestSchema: z.ZodType<RemoteSpaceLinkClaimRequest> = z.object({
  pairingCode: z.string().trim().min(16).max(200),
  homeSpaceId: z.string().uuid(),
  homeServerId: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
  homeBaseUrl: z.string().url().max(500).nullable(),
}).strict();

/** The invoke body is spaceLinks.invoke's; the reply carries the target-side audit id. */
export interface RemoteSpaceLinkInvokeResponse {
  result: unknown;
  /** The audit row the TARGET wrote for this call. */
  auditId: string;
  /** A spawn op's child work session on the target. */
  spawnedSessionId?: string | null;
}
