// `tm8 bridge` (BRIDGE-ENTITY-DESIGN §3.5, B0a): every verb is one bridges.*
// operation. Status and health are the server's derived facts; the CLI only
// renders them. Speaking needs no verb here: `tm8 message reply|send` crosses.
import { lstatSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BRIDGE_PROVIDERS, BridgeConnectionAuthFrameSchema, bindPath, type BridgeConnectionAuthFrame,
  type BridgeConnectionBeginResult, type BridgeConnectionListResult, type BridgeConnectionOfferResult,
  type BridgeConnectionView, type BridgeConnectionWithdrawResult, type BridgeConnectionRemoveResult,
  type BridgeConversationCreateResult, type BridgeConversationListResult, type BridgeGroupForkResult, type BridgeDetailView, type BridgeHandle, type BridgeHandoverResult, type BridgeHandleListResult,
  type BridgeListResult, type BridgeListenResult, type BridgeLogResult, type BridgePolicy, type BridgeView,
  type BridgeWake, type BridgeIdentityLink, type BridgeLinkCode, type BridgeLinksList, type BridgeProvider,
  type BridgeMemoryProposal, type BridgeMemoryProposalListResult, type BridgeParticipant,
  type BridgeParticipantListResult, type BridgeParticipantUpdateResult, type BridgeWorkStartResult,
  BRIDGE_MEMORY_PROPOSAL_STATUSES,
} from '@tm8/contract';
import { requireSpace, type CliContext } from '../context.js';
import { CliError, EXIT_OK, EXIT_RETRYABLE, EXIT_USAGE, type ExitCode } from '../exit.js';
import { observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';
import { assertKnownOptions, enumOption, requireArg } from './entity.js';
import { client, mutation } from './tool.js';
import { bridgeImportConfig } from './bridge-import.js';

const usage = (message: string, hint?: string): CliError => new CliError(message, EXIT_USAGE, hint ? { hint } : {});
const WAKES = ['directed', 'thread', 'all'] as const satisfies readonly BridgeWake[];

// Flags shared by create and update; update adds the clears and the ceiling.
const POLICY_OPTIONS = ['trigger', 'direction', 'outbound', 'who-may-trigger', 'voice', 'style'];
const SETTING_OPTIONS = [...POLICY_OPTIONS, 'teammate', 'purpose', 'quiet-hours', 'worker-posting', 'retention-days'];

function argumentsCount(cmd: CommandContext, count: number): void {
  if (cmd.args.length !== count || cmd.passthrough.length) {
    throw usage(`tm8 ${cmd.path.join(' ')} expects ${count} argument${count === 1 ? '' : 's'}; see its help`);
  }
}
function expectedVersion(cmd: CommandContext): number {
  const version = cmd.options.integer('expect-version');
  if (version === undefined) throw usage('--expect-version is required', 'read it with `tm8 bridge show <id>`');
  if (version < 1) throw usage('--expect-version must be a positive integer');
  return version;
}
const choice = <T extends string>(cmd: CommandContext, option: string, allowed: readonly T[]) =>
  enumOption(cmd, option, allowed) as T | undefined;
/** The `<value|none>` idiom: `none` is an explicit null (clear). */
function nullableText(cmd: CommandContext, option: string): string | null | undefined {
  const value = cmd.options.value(option);
  return value === undefined ? undefined : value === 'none' ? null : value;
}

/** `22:00-08:00` → `{start, end}`; `none` clears. */
export function parseQuietHours(raw: string | undefined): { start: string; end: string } | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'none') return null;
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])-([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(raw);
  if (!match) throw usage('--quiet-hours takes HH:MM-HH:MM, e.g. 22:00-08:00, or none');
  const start = `${match[1]}:${match[2]}`, end = `${match[3]}:${match[4]}`;
  if (start === end) throw usage('--quiet-hours start and end must differ');
  return { start, end };
}

function policyPatch(cmd: CommandContext): Partial<BridgePolicy> | undefined {
  const policy: Partial<BridgePolicy> = {};
  const trigger = choice(cmd, 'trigger', ['mention', 'every', 'none'] as const); if (trigger) policy.trigger = trigger;
  const direction = choice(cmd, 'direction', ['both', 'in', 'out'] as const); if (direction) policy.direction = direction;
  const outbound = choice(cmd, 'outbound', ['replies', 'all'] as const); if (outbound) policy.outbound = outbound;
  const who = choice(cmd, 'who-may-trigger', ['linked', 'anyone'] as const); if (who) policy.whoMayTrigger = who;
  const voice = choice(cmd, 'voice', ['named', 'plain'] as const); if (voice) policy.voice = voice;
  const style = nullableText(cmd, 'style'); if (style !== undefined) policy.style = style;
  return Object.keys(policy).length ? policy : undefined;
}

/** The settings both create and update take, in the contract's names. */
function settings(cmd: CommandContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const policy = policyPatch(cmd); if (policy) out.policy = policy;
  const teammate = nullableText(cmd, 'teammate'); if (teammate !== undefined) out.teammateId = teammate;
  const purpose = nullableText(cmd, 'purpose'); if (purpose !== undefined) out.purpose = purpose;
  const quiet = parseQuietHours(cmd.options.value('quiet-hours')); if (quiet !== undefined) out.quietHours = quiet;
  const posting = choice(cmd, 'worker-posting', ['on', 'off'] as const); if (posting) out.workerPosting = posting === 'on';
  const retention = cmd.options.value('retention-days');
  if (retention !== undefined) {
    if (retention === 'none') out.retentionDays = null;
    else {
      const days = cmd.options.integer('retention-days');
      if (days === undefined || days < 1 || days > 3650) throw usage('--retention-days takes 1-3650 or none');
      out.retentionDays = days;
    }
  }
  return out;
}

function stamp(at: string | null): string { return at ?? 'never'; }

export function renderBridge(b: BridgeView | BridgeDetailView): string {
  const p = b.policy;
  const lines = [
    `bridge ${b.id} v${b.version} · ${b.status} · ${b.provider} ${b.conversation.kind} "${b.conversation.title}"`,
    `purpose: ${b.purpose ?? '—'}`,
    `target: ${b.target.kind} ${b.target.id}${b.target.title ? ` "${b.target.title}"` : ''}`,
    `teammate: ${b.teammateId ?? 'none'} · connection ${b.connectionId} (${b.health.connection})`,
    `policy: trigger ${p.trigger} · direction ${p.direction} · outbound ${p.outbound} · who may trigger ${p.whoMayTrigger} · voice ${p.voice}` +
      `${p.style ? ` · style "${p.style}"` : ''}`,
    `workers: posting ${b.workerPosting ? 'on' : 'off'} · wake ceiling ${b.workers.wake}` +
      `${b.quietHours ? ` · quiet ${b.quietHours.start}-${b.quietHours.end}` : ''}` +
      ` · retention ${b.retentionDays === null ? 'keep' : `${b.retentionDays}d`}`,
    `health: last in ${stamp(b.health.lastInboundAt)} · last out ${stamp(b.health.lastOutboundAt)} · queued ${b.health.queued}` +
      ` · failed 24h ${b.health.failed24h}${b.health.detail ? ` · ${b.health.detail}` : ''}`,
    `people: ${b.people.participants} participants · ${b.people.linked} linked · ${b.people.guestsSeen7d} guests seen 7d · ${b.handles} handles`,
  ];
  if (b.pausedAt) lines.push(`paused since ${b.pausedAt}`);
  if (b.endedAt) lines.push(`removed ${b.endedAt}: the log stays readable; nothing crosses`);
  if ('recentPosters' in b) {
    lines.push(b.recentPosters.length ? 'recent posters:' : 'recent posters: none');
    for (const r of b.recentPosters) {
      lines.push(`  ${r.displayName}${r.handle ? ` (${r.handle})` : ''} · ${r.actorKind} ${r.actorId} · ${r.posts} posts · last ${r.lastPostAt}`);
    }
  }
  if ('summary' in b && b.summary) {
    const s = b.summary;
    lines.push(`summary: ${s.coveredMessages} messages through ${s.state.lastAt ?? '—'} · refreshed ${stamp(s.refreshedAt)}` +
      ` · ${s.unsummarizedMessages} newer verbatim · ${s.state.closedAsks} asks closed`);
    lines.push(s.state.openAsks.length ? 'open asks:' : 'open asks: none');
    for (const a of s.state.openAsks) lines.push(`  ${a.at} ${a.author}: ${a.excerpt}`);
    if (s.state.droppedAsks) lines.push(`  … ${s.state.droppedAsks} older open asks not named`);
    lines.push(s.onWhat.length ? 'on what:' : 'on what: nothing open');
    for (const w of s.onWhat) lines.push(`  ${w.assignees.join(', ') || 'unassigned'} · ${w.status} · ${w.title} (${w.taskId})`);
  }
  return lines.join('\n');
}

function renderList(page: BridgeListResult): string {
  if (!page.items.length) return 'no bridges';
  return page.items.map(b =>
    `${b.id}  ${b.status.padEnd(8)} ${b.provider.padEnd(9)} "${b.conversation.title}" → ${b.target.kind} ${b.target.id}` +
    `${b.purpose ? ` — ${b.purpose}` : ''}`).join('\n');
}

async function bridgeList(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['provider', 'target', 'include-ended']); argumentsCount(cmd, 0);
  const query: Record<string, string> = {};
  const provider = choice(cmd, 'provider', BRIDGE_PROVIDERS); if (provider) query.provider = provider;
  const target = cmd.options.value('target'); if (target) query.target = target;
  if (cmd.options.bool('include-ended')) query.includeEnded = 'true';
  cmd.out.data(await observedInvoke<BridgeListResult>(client(cmd), 'bridges.list', { params: { spaceId: requireSpace(cmd.ctx) }, query }), renderList);
  return EXIT_OK;
}

async function bridgeShow(cmd: CommandContext, raw: boolean): Promise<ExitCode> {
  assertKnownOptions(cmd, []); argumentsCount(cmd, 1);
  const view = await observedInvoke<BridgeDetailView>(client(cmd), 'bridges.get', { params: { bridgeId: requireArg(cmd, 0, '<bridge-id>') } });
  cmd.out.data(view, raw ? value => JSON.stringify(value, null, 2) : renderBridge);
  return EXIT_OK;
}

async function bridgeCreate(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['connection', 'conversation', 'title', 'kind', 'member-count', 'to', 'mutation-id', ...SETTING_OPTIONS]);
  argumentsCount(cmd, 0);
  const connectionId = cmd.options.value('connection');
  const externalId = cmd.options.value('conversation');
  const targetId = cmd.options.value('to');
  if (!connectionId) throw usage('--connection <connection-id> is required: the number you own, offered to this Space', 'tm8 bridge connection list');
  if (!externalId) throw usage('--conversation <external-id> is required: the provider\'s id for the group');
  if (!targetId) throw usage('--to <chat|session|channel id> is required');
  const kind = choice(cmd, 'kind', ['group', 'channel', 'dm'] as const) ?? 'group';
  const memberCount = cmd.options.integer('member-count');
  const body = {
    ...mutation(cmd), connectionId, targetId,
    conversation: { externalId, kind, title: cmd.options.value('title') ?? externalId, ...(memberCount !== undefined ? { memberCount } : {}) },
    ...settings(cmd),
  };
  cmd.out.data(await observedInvoke<BridgeView>(client(cmd), 'bridges.create', { params: { spaceId: requireSpace(cmd.ctx) }, body }), renderBridge);
  return EXIT_OK;
}

async function bridgeUpdate(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['expect-version', 'mutation-id', 'worker-wake', 'conversation-title', ...SETTING_OPTIONS]);
  argumentsCount(cmd, 1);
  const version = expectedVersion(cmd);
  const patch = settings(cmd);
  const wake = choice(cmd, 'worker-wake', WAKES); if (wake) patch.workerWake = wake;
  const title = cmd.options.value('conversation-title'); if (title !== undefined) patch.conversationTitle = title;
  if (!Object.keys(patch).length) throw usage('name at least one setting to change; see `tm8 help bridge update`');
  cmd.out.data(await observedInvoke<BridgeView>(client(cmd), 'bridges.update', {
    params: { bridgeId: requireArg(cmd, 0, '<bridge-id>') }, body: { ...mutation(cmd), expectedVersion: version, patch },
  }), renderBridge);
  return EXIT_OK;
}

async function bridgeRetarget(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['to', 'expect-version', 'mutation-id']); argumentsCount(cmd, 1);
  const version = expectedVersion(cmd);
  const targetId = cmd.options.value('to');
  if (!targetId) throw usage('--to <chat|session|channel id> is required');
  cmd.out.data(await observedInvoke<BridgeView>(client(cmd), 'bridges.retarget', {
    params: { bridgeId: requireArg(cmd, 0, '<bridge-id>') }, body: { ...mutation(cmd), expectedVersion: version, targetId },
  }), renderBridge);
  return EXIT_OK;
}

async function bridgeState(cmd: CommandContext, operation: 'bridges.pause' | 'bridges.resume' | 'bridges.remove'): Promise<ExitCode> {
  assertKnownOptions(cmd, ['expect-version', 'mutation-id']); argumentsCount(cmd, 1);
  const version = expectedVersion(cmd);
  cmd.out.data(await observedInvoke<BridgeView>(client(cmd), operation, {
    params: { bridgeId: requireArg(cmd, 0, '<bridge-id>') }, body: { ...mutation(cmd), expectedVersion: version },
  }), renderBridge);
  return EXIT_OK;
}

function renderParticipant(p: BridgeParticipant): string {
  const who = p.member ? `${p.member.displayName}${p.you ? ' (you)' : ''}` : 'guest';
  const word = p.trust === 'linked' ? 'linked ✓' : p.trust;
  return `${(p.displayName ?? '(no name)').padEnd(20)} ${p.externalId.padEnd(16)} ${word.padEnd(9)} ${who}`
    + ` · ${p.messageCount} msg · last ${p.lastSeenAt}${p.muted ? ' · muted' : ''}`;
}

async function bridgePeople(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['guests', 'linked']); argumentsCount(cmd, 1);
  const guests = cmd.options.bool('guests');
  const linked = cmd.options.bool('linked');
  if (guests && linked) throw usage('pass --guests or --linked, not both');
  const page = await observedInvoke<BridgeParticipantListResult>(client(cmd), 'bridges.participants.list', { params: { bridgeId: requireArg(cmd, 0, '<bridge-id>') } });
  // Linked means counted as a member: verified (linked) or an admin's assertion.
  const items = page.items.filter(p => (guests ? p.trust === 'guest' : linked ? p.trust !== 'guest' : true));
  cmd.out.data({ ...page, items }, p => p.items.length
    ? p.items.map(renderParticipant).join('\n')
    : guests ? 'no guests on this bridge' : linked ? 'nobody on this bridge is linked' : 'nobody has spoken on this bridge yet');
  return EXIT_OK;
}

// One door for the row actions (D52): mute, and the admin's assertion or its revocation.
async function bridgeParticipant(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['member', 'unassert', 'mute', 'mutation-id']); argumentsCount(cmd, 2);
  const patch: { muted?: boolean; memberId?: string | null } = {};
  const member = cmd.options.value('member');
  if (member !== undefined && cmd.options.bool('unassert')) throw usage('pass --member or --unassert, not both');
  if (member !== undefined) patch.memberId = member;
  if (cmd.options.bool('unassert')) patch.memberId = null;
  const mute = choice(cmd, 'mute', ['on', 'off'] as const);
  if (mute) patch.muted = mute === 'on';
  if (Object.keys(patch).length === 0) throw usage('nothing to change', 'pass --member <member-id>, --unassert or --mute on|off');
  const result = await observedInvoke<BridgeParticipantUpdateResult>(client(cmd), 'bridges.participants.update', {
    params: { bridgeId: requireArg(cmd, 0, '<bridge-id>'), externalId: requireArg(cmd, 1, '<external-id>') },
    body: { ...mutation(cmd), patch },
  });
  cmd.out.data(result, r => `${r.changed ? 'updated' : 'already so; nothing changed'}`
    + (r.participant ? `\n${renderParticipant(r.participant)}` : ` · ${r.externalId} has not spoken on this bridge yet`));
  return EXIT_OK;
}

async function bridgeHandles(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, []); argumentsCount(cmd, 1);
  const page = await observedInvoke<BridgeHandleListResult>(client(cmd), 'bridges.handles.list', { params: { bridgeId: requireArg(cmd, 0, '<bridge-id>') } });
  cmd.out.data(page, p => p.items.length
    ? p.items.map(h => `${h.handle.padEnd(20)} ${h.kind} ${h.entityId}${h.title ? ` "${h.title}"` : ''} · ${h.status} · last ${h.lastAt}`).join('\n')
    : 'no handles have appeared on this bridge');
  return EXIT_OK;
}

async function bridgeHandleClaim(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['title']);
  if (cmd.args.length > 1 || cmd.passthrough.length) throw usage('tm8 bridge handle claim takes at most one <bridge-id>');
  // A handle is space-wide (D23): a bridge id only names the space to claim in.
  let spaceId: string;
  if (cmd.args[0]) {
    const view = await observedInvoke<BridgeView>(client(cmd), 'bridges.get', { params: { bridgeId: cmd.args[0] } });
    spaceId = view.spaceId;
  } else {
    spaceId = requireSpace(cmd.ctx);
  }
  const title = cmd.options.value('title');
  const handle = await observedInvoke<BridgeHandle>(client(cmd), 'bridges.handles.claim', {
    params: { spaceId }, body: title !== undefined ? { title } : {},
  });
  cmd.out.data(handle, h => `${h.handle} — this session's name in every group of the space${h.title ? ` ("${h.title}")` : ''}`);
  return EXIT_OK;
}

async function bridgeLog(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['unread', 'since', 'latest', 'before', 'thread', 'limit']); argumentsCount(cmd, 1);
  const query: Record<string, string> = {};
  const unread = cmd.options.bool('unread');
  const since = cmd.options.value('since');
  const latest = cmd.options.bool('latest');
  const before = cmd.options.value('before');
  if ([unread, Boolean(since), latest, Boolean(before)].filter(Boolean).length > 1) {
    throw usage('pass one of --unread, --since, --latest or --before');
  }
  if (unread) query.unread = 'true';
  if (since) query.since = since;
  if (latest) query.latest = 'true';
  if (before) query.before = before;
  const thread = cmd.options.value('thread'); if (thread) query.thread = thread;
  const limit = cmd.options.integer('limit');
  if (limit !== undefined) {
    if (limit < 1 || limit > 200) throw usage('--limit must be between 1 and 200');
    query.limit = String(limit);
  }
  const page = await observedInvoke<BridgeLogResult>(client(cmd), 'bridges.log.read', { params: { bridgeId: requireArg(cmd, 0, '<bridge-id>') }, query });
  cmd.out.data(page, p => {
    if (!p.items.length) return unread ? 'nothing unread' : 'no messages';
    const lines = p.items.map(m => {
      const who = `${m.authorName || m.authorId || 'unknown'}${m.handle ? ` (${m.handle})` : ''}`;
      const via = m.origin ? ` [${m.origin.direction === 'in' ? 'from' : 'to'} ${m.origin.externalMessageId}]` : '';
      const reply = m.parentMessageId ? ` ↳${m.parentMessageId}` : '';
      const tick = m.delivery ? ` {${m.delivery.status}${m.delivery.reason ? `: ${m.delivery.reason}` : ''}}` : '';
      return `${m.createdAt} ${m.id}${reply} ${who}${via}${tick}: ${m.body.replace(/\s+/g, ' ')}`;
    });
    if (p.olderCursor) lines.push(`older: tm8 bridge log ${p.bridgeId} --before ${p.olderCursor}`);
    if (p.more) lines.push(`more: tm8 bridge log ${p.bridgeId} --since ${p.lastMessageId}`);
    return lines.join('\n');
  });
  return EXIT_OK;
}

async function bridgeListen(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, []); argumentsCount(cmd, 2);
  const wake = requireArg(cmd, 1, 'directed|thread|all');
  if (!(WAKES as readonly string[]).includes(wake)) throw usage('listen takes directed, thread or all');
  const result = await observedInvoke<BridgeListenResult>(client(cmd), 'bridges.listen', {
    params: { bridgeId: requireArg(cmd, 0, '<bridge-id>') }, body: { wake },
  });
  cmd.out.data(result, r => `listening at ${r.wake} (the bridge allows up to ${r.ceiling})`);
  return EXIT_OK;
}

// ── connections (§2.5, §3.4; migration 421) ─────────────────────────────────

export function renderConnection(c: BridgeConnectionView): string {
  const lines = [
    `connection ${c.id} · ${c.provider} "${c.label}" · ${c.status}${c.externalAccountId ? ` · ${c.externalAccountId}` : ''}`,
    `runtime: ${c.runtimeId ?? 'none'} · last seen ${stamp(c.lastSeenAt)}`,
  ];
  if (!c.offers.length) lines.push('offered to: no space yet (tm8 bridge connection offer <id> --space <space-id>)');
  for (const o of c.offers) {
    lines.push(`offered to space ${o.spaceId} as credential ${o.credentialId} · ${o.visibility === 'public' ? 'space' : 'private'} · ${o.status} · ${o.bridges} bridge${o.bridges === 1 ? '' : 's'}`);
  }
  return lines.join('\n');
}

async function connectionList(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['provider']); argumentsCount(cmd, 0);
  const query: Record<string, string> = {};
  const provider = choice(cmd, 'provider', BRIDGE_PROVIDERS); if (provider) query.provider = provider;
  cmd.out.data(await observedInvoke<BridgeConnectionListResult>(client(cmd), 'bridges.connections.list', { query }),
    page => page.items.length ? page.items.map(renderConnection).join('\n\n') : 'no connections: link a number with `tm8 bridge connection begin --provider whatsapp`');
  return EXIT_OK;
}

/** The begin caller's own event socket: where its QR or pairing code arrives, never in the HTTP answer. */
export interface ConnectionAuthStream {
  open(): Promise<void>;
  onFrame(fn: (frame: BridgeConnectionAuthFrame) => void): void;
  close(): void;
}
type AuthStreamFactory = (ctx: CliContext) => ConnectionAuthStream;

function socketAuthStream(ctx: CliContext): ConnectionAuthStream {
  const Ctor = (globalThis as { WebSocket?: new (url: string, init?: { headers?: Record<string, string> }) => AuthSocketLike }).WebSocket;
  if (Ctor === undefined) {
    throw new CliError(`this runtime (node ${process.version}) has no WebSocket, so it cannot receive the QR`, EXIT_USAGE,
      { hint: 'pass --no-wait and finish linking in the tm8 UI' });
  }
  const url = new URL(bindPath('events.subscribe', {}), ctx.baseUrl.value);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  // The bearer travels as a header (node's WebSocket takes one), so the server
  // knows the socket is this person's: the QR is addressed by identity.
  const ws = new Ctor(url.href, ctx.token ? { headers: { authorization: `Bearer ${ctx.token}` } } : undefined);
  return {
    open: () => new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new CliError(`could not open the event socket at ${url.href}`, EXIT_RETRYABLE)), { once: true });
    }),
    onFrame: fn => ws.addEventListener('message', (e: { data: unknown }) => {
      try {
        const parsed = BridgeConnectionAuthFrameSchema.safeParse(JSON.parse(String(e.data)));
        if (parsed.success) fn(parsed.data);
      } catch { /* not a frame for us */ }
    }),
    close: () => ws.close(),
  };
}
interface AuthSocketLike {
  close(): void;
  addEventListener(type: 'open' | 'error', fn: () => void, opts?: { once: boolean }): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
}

let authStreamFactory: AuthStreamFactory = socketAuthStream;
/** Tests replace the socket; nothing else does. */
export function setConnectionAuthStreamForTests(factory: AuthStreamFactory | null): void {
  authStreamFactory = factory ?? socketAuthStream;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function pathExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/**
 * Write a QR so only this user can read it: a sibling created exclusively
 * ('wx' is O_CREAT|O_EXCL, which also refuses a symlink in its place) at 0600,
 * then renamed over the target. A rename replaces a symlink, never follows it.
 * The first write refuses a target that appeared since the check.
 */
export function writeQrFile(path: string, bytes: Uint8Array, n: number): void {
  if (n === 0 && pathExists(path)) throw usage(`${path} already exists; refusing to write the QR there`);
  const tmp = `${path}.${process.pid}.${n}.tmp`;
  writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

async function connectionBegin(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['provider', 'label', 'connection', 'pairing', 'qr-file', 'wait', 'no-wait', 'mutation-id']);
  argumentsCount(cmd, 0);
  const provider = choice(cmd, 'provider', BRIDGE_PROVIDERS);
  if (!provider) throw usage('--provider is required', 'whatsapp is the provider with a runtime today');
  const wait = !cmd.options.bool('no-wait');
  // A QR is a credential for a minute (§7.3 item 8): never into a file someone else made or points at.
  const qrFile = cmd.options.value('qr-file');
  if (qrFile !== undefined && pathExists(qrFile)) {
    throw usage(`--qr-file ${qrFile} already exists; name a new path (the QR is written only to a file this command creates)`);
  }
  let qrPath: string | undefined;
  let qrWrites = 0;
  const waitSeconds = cmd.options.integer('wait') ?? 180;
  if (waitSeconds < 1 || waitSeconds > 1800) throw usage('--wait takes 1-1800 seconds');
  const pairing = cmd.options.value('pairing');
  const body: Record<string, unknown> = { ...mutation(cmd), provider };
  const label = cmd.options.value('label'); if (label !== undefined) body.label = label;
  const connectionId = cmd.options.value('connection'); if (connectionId !== undefined) body.connectionId = connectionId;
  if (pairing !== undefined) body.authFlow = { kind: 'pairing', phone: pairing };

  // The socket is open before begin, so a QR the runtime sends at once is not missed.
  const frames: BridgeConnectionAuthFrame[] = [];
  let notify: (() => void) | null = null;
  const stream = wait ? authStreamFactory(cmd.ctx) : null;
  if (stream) {
    await stream.open();
    stream.onFrame(frame => { frames.push(frame); notify?.(); });
  }
  try {
    const result = await observedInvoke<BridgeConnectionBeginResult>(client(cmd), 'bridges.connections.begin', { body });
    const id = result.connection.id;
    cmd.out.note(`connection ${id} · ${result.connection.provider} "${result.connection.label}" · ${result.connection.status}`);
    if (result.runtime === 'offline') {
      cmd.out.data(result, r => `${renderConnection(r.connection)}\nno ${provider} runtime is running on this node; once it is, run: tm8 bridge connection begin --provider ${provider} --connection ${id}`);
      return EXIT_OK;
    }
    if (!stream) {
      cmd.out.data(result, r => `${renderConnection(r.connection)}\nthe runtime is connecting; run begin without --no-wait to see the QR or pairing code here`);
      return EXIT_OK;
    }
    const deadline = Date.now() + waitSeconds * 1000;
    let shown = 0, lastPoll = 0;
    while (Date.now() < deadline) {
      for (; shown < frames.length; shown++) {
        const frame = frames[shown]!;
        if (frame.connectionId !== id) continue;
        if (frame.pairingCode) {
          cmd.out.warn(`pairing code: ${frame.pairingCode} (expires ${frame.expiresAt}) — WhatsApp → Linked devices → Link with phone number`);
        } else if (frame.qrPng) {
          const path = qrPath ??= cmd.options.value('qr-file') ?? join(mkdtempSync(join(tmpdir(), 'tm8-bridge-qr-')), 'qr.png');
          writeQrFile(path, Buffer.from(frame.qrPng.replace(/^data:image\/png;base64,/, ''), 'base64'), qrWrites++);
          cmd.out.warn(`QR written to ${path} (expires ${frame.expiresAt}) — WhatsApp → Linked devices → Link a device`);
        }
      }
      if (Date.now() - lastPoll >= 3000) {
        lastPoll = Date.now();
        const page = await observedInvoke<BridgeConnectionListResult>(client(cmd), 'bridges.connections.list', { query: { provider } });
        const now = page.items.find(c => c.id === id);
        if (now?.status === 'linked') {
          cmd.out.data(now, c => `${renderConnection(c)}\nlinked. Next: tm8 bridge connection offer ${id} --space <space-id>`);
          return EXIT_OK;
        }
      }
      await Promise.race([sleep(500), new Promise<void>(resolve => { notify = resolve; })]);
      notify = null;
    }
    throw new CliError(`not linked within ${waitSeconds}s`, EXIT_RETRYABLE,
      { hint: `run tm8 bridge connection begin --provider ${provider} --connection ${id} to try again` });
  } finally {
    stream?.close();
  }
}

async function connectionOffer(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['visibility', 'label', 'agent-groups', 'mutation-id']); argumentsCount(cmd, 1);
  const visibility = choice(cmd, 'visibility', ['private', 'space'] as const);
  const body: Record<string, unknown> = { ...mutation(cmd), spaceId: requireSpace(cmd.ctx) };
  if (visibility) body.visibility = visibility === 'space' ? 'public' : 'private';
  const label = cmd.options.value('label'); if (label !== undefined) body.label = label;
  // D83: agent sessions here may fork groups on this number (on an existing offer, only this changes).
  const agentGroups = choice(cmd, 'agent-groups', ['on', 'off'] as const); if (agentGroups) body.agentGroups = agentGroups === 'on';
  const result = await observedInvoke<BridgeConnectionOfferResult>(client(cmd), 'bridges.connections.offer', {
    params: { connectionId: requireArg(cmd, 0, '<connection-id>') }, body,
  });
  cmd.out.data(result, r => `offered as credential ${r.credentialId}\n${renderConnection(r.connection)}`);
  return EXIT_OK;
}

async function connectionWithdraw(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['mutation-id']); argumentsCount(cmd, 1);
  const result = await observedInvoke<BridgeConnectionWithdrawResult>(client(cmd), 'bridges.connections.withdraw', {
    params: { connectionId: requireArg(cmd, 0, '<connection-id>') }, body: { ...mutation(cmd), spaceId: requireSpace(cmd.ctx) },
  });
  cmd.out.data(result, r => `withdrew credential ${r.credentialId}; paused ${r.pausedBridgeIds.length} bridge${r.pausedBridgeIds.length === 1 ? '' : 's'}` +
    `${r.pausedBridgeIds.length ? `: ${r.pausedBridgeIds.join(', ')}` : ''}\n${renderConnection(r.connection)}`);
  return EXIT_OK;
}

async function connectionRemove(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['mutation-id']); argumentsCount(cmd, 1);
  const result = await observedInvoke<BridgeConnectionRemoveResult>(client(cmd), 'bridges.connections.remove', {
    params: { connectionId: requireArg(cmd, 0, '<connection-id>') }, body: mutation(cmd),
  });
  cmd.out.data(result, r => [
    `removed connection ${r.connection.id} "${r.connection.label}"`,
    `ended ${r.endedBridgeIds.length} bridge${r.endedBridgeIds.length === 1 ? '' : 's'}${r.endedBridgeIds.length ? `: ${r.endedBridgeIds.join(', ')}` : ''}`,
    `revoked ${r.revokedCredentialIds.length} space credential${r.revokedCredentialIds.length === 1 ? '' : 's'}`,
    r.runtime === 'logged_out'
      ? 'the device was logged out'
      : 'no runtime was connected: unlink the device on the phone (WhatsApp → Linked devices)',
  ].join('\n'));
  return EXIT_OK;
}

/** `tm8 bridge work` (v2 §4.3): bridges.work.start — the /work path, for agents asked in natural language. */
async function bridgeWork(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['item', 'teammate', 'project', 'effort', 'mutation-id']); argumentsCount(cmd, 1);
  const items = cmd.options.values('item').map(i => i.trim()).filter(i => i !== '');
  if (items.length === 0) throw usage('--item "<one line of work>" is required (repeat it, at most 5)');
  const effort = cmd.options.value('effort');
  if (effort !== undefined && !['low', 'high', 'max'].includes(effort)) throw usage('--effort takes low, high or max');
  const teammate = cmd.options.value('teammate');
  const project = cmd.options.value('project');
  const options = {
    ...(teammate ? { teammate } : {}), ...(project ? { project } : {}), ...(effort ? { effort } : {}),
  };
  const result = await observedInvoke<BridgeWorkStartResult>(client(cmd), 'bridges.work.start', {
    params: { bridgeId: requireArg(cmd, 0, '<bridge-id>') },
    body: { ...mutation(cmd), items, ...(Object.keys(options).length > 0 ? { options } : {}) },
  });
  cmd.out.data(result, r => [
    ...(r.parentTaskId ? [`parent task ${r.parentTaskId}`] : []),
    ...r.items.map((item, i) => item.sessionId
      ? `${i + 1} task ${item.taskId} · ${item.handle ?? item.sessionId} starting`
      : `${i + 1} task ${item.taskId} · not started: ${item.error ?? 'unknown'}`),
    r.noticeMessageId ? 'announced in the group' : 'not announced (the bridge refused the post)',
  ].join('\n'));
  return EXIT_OK;
}

async function bridgeConversations(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, []); argumentsCount(cmd, 1);
  const page = await observedInvoke<BridgeConversationListResult>(client(cmd), 'bridges.conversations.list', {
    params: { connectionId: requireArg(cmd, 0, '<connection-id>') },
  });
  cmd.out.data(page, p => p.items.length
    ? p.items.map(c => `${c.conversationId}  ${c.kind.padEnd(5)} "${c.name}"${c.size === null ? '' : ` · ${c.size} members`}` +
      `${c.canSend ? '' : ` · read-only (${c.reason ?? 'cannot send'}): a bridge here falls back to direction in`}`).join('\n')
    : 'no groups on this number');
  return EXIT_OK;
}

// A new group on your own number, always bridged in the same call: to --to, or a new session for --teammate.
async function bridgeGroupCreate(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['title', 'participant', 'to', 'mutation-id', ...SETTING_OPTIONS]); argumentsCount(cmd, 1);
  const title = cmd.options.value('title');
  if (!title) throw usage('--title <group name> is required');
  const targetId = cmd.options.value('to');
  const bridgeSettings = settings(cmd);
  if (!targetId && !bridgeSettings.teammateId) {
    throw usage('name --teammate <id> to start a new session for the group, or --to <chat|session|channel id> to bridge it there');
  }
  const body = {
    ...mutation(cmd), title, participants: cmd.options.values('participant'),
    bridge: { spaceId: requireSpace(cmd.ctx), ...(targetId ? { targetId } : {}), ...bridgeSettings },
  };
  const result = await observedInvoke<BridgeConversationCreateResult>(client(cmd), 'bridges.conversations.create', {
    params: { connectionId: requireArg(cmd, 0, '<connection-id>') }, body,
  });
  cmd.out.data(result, r => [
    `group ${r.group.conversationId} "${r.group.subject}"`,
    ...r.group.results.map(p => `  ${p.id} ${p.status === 'invite_needed' ? 'not added (their privacy settings): send them the invite link' : p.status}`),
    ...(r.group.inviteLink ? [`invite link: ${r.group.inviteLink}`] : []),
    ...(r.sessionId ? [`new session ${r.sessionId}`] : []),
    renderBridge(r.bridge),
  ].join('\n'));
  return EXIT_OK;
}

// D83: the session a bridge lands on forks its group into a new one, bridged to a new session.
async function bridgeGroupFork(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['title', 'participant', 'teammate', 'brief', 'mutation-id']); argumentsCount(cmd, 1);
  const title = cmd.options.value('title');
  if (!title) throw usage('--title <group name> is required');
  const participants = cmd.options.values('participant');
  if (participants.length === 0) throw usage('--participant <name|+phone|…1234|everyone> is required (repeat it): people from this group');
  const teammate = cmd.options.value('teammate');
  const brief = cmd.options.value('brief');
  const result = await observedInvoke<BridgeGroupForkResult>(client(cmd), 'bridges.groups.fork', {
    params: { bridgeId: requireArg(cmd, 0, '<bridge-id>') },
    body: { ...mutation(cmd), title, participants, ...(teammate ? { teammate } : {}), ...(brief ? { brief } : {}) },
  });
  cmd.out.data(result, r => [
    `group ${r.group.conversationId} "${r.group.subject}" (fork ${r.forkId})`,
    ...(r.group.community ? [`community ${r.group.community.id} "${r.group.community.name}"`] : []),
    ...r.group.results.map(p => `  ${p.id} ${p.status === 'invite_needed' ? 'not added (their privacy settings): send them the invite link' : p.status}`),
    ...(r.group.inviteLink ? [`invite link: ${r.group.inviteLink}`] : []),
    `bridge ${r.newBridgeId} → session ${r.sessionId}${r.handle ? ` (${r.handle})` : ''}`,
    r.noticeMessageId ? 'announced in the source group' : 'not announced (the bridge refused the post)',
  ].join('\n'));
  return EXIT_OK;
}

function renderProposal(p: BridgeMemoryProposal): string {
  const who = `${p.proposerName || p.proposedBy} (${p.proposerTrust === 'linked' ? 'verified link' : 'admin-asserted link'})`;
  const state = p.status === 'pending'
    ? `pending until ${p.expiresAt}${p.canDecide ? ' · you can accept or drop it' : ''}`
    : `${p.status}${p.decidedAt ? ` ${p.decidedAt}` : ''}${p.memoryId ? ` → memory ${p.memoryId}` : ''}`;
  return `${p.id} ${who} · ${state}${p.mentionsSecret ? '\n  ⚠ mentions a secret: accept only if it holds none' : ''}\n  "${p.statement.replace(/\s+/g, ' ')}"`;
}

// D29: `/remember` proposals are listed and decided here, in tm8, by a person.
async function bridgeProposals(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['status', 'limit']); argumentsCount(cmd, 1);
  const query: Record<string, string> = {};
  const status = choice(cmd, 'status', BRIDGE_MEMORY_PROPOSAL_STATUSES); if (status) query.status = status;
  const limit = cmd.options.integer('limit');
  if (limit !== undefined) {
    if (limit < 1 || limit > 200) throw usage('--limit must be between 1 and 200');
    query.limit = String(limit);
  }
  const page = await observedInvoke<BridgeMemoryProposalListResult>(client(cmd), 'bridges.memories.proposals.list', {
    params: { bridgeId: requireArg(cmd, 0, '<bridge-id>') }, query,
  });
  cmd.out.data(page, p => p.items.length ? p.items.map(renderProposal).join('\n') : 'no memory proposals');
  return EXIT_OK;
}

async function bridgeProposalResolve(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['statement', 'note']); argumentsCount(cmd, 3);
  const decision = requireArg(cmd, 2, 'accept|drop');
  if (decision !== 'accept' && decision !== 'drop') throw usage('a proposal is resolved with accept or drop');
  const statement = cmd.options.value('statement');
  if (statement !== undefined && decision !== 'accept') throw usage('--statement corrects the text to accept; it is for accept only');
  const note = cmd.options.value('note');
  const result = await observedInvoke<BridgeMemoryProposal>(client(cmd), 'bridges.memories.proposals.resolve', {
    params: { bridgeId: requireArg(cmd, 0, '<bridge-id>'), proposalId: requireArg(cmd, 1, '<proposal-id>') },
    body: { decision, ...(statement !== undefined ? { statement } : {}), ...(note !== undefined ? { note } : {}) },
  });
  cmd.out.data(result, renderProposal);
  return EXIT_OK;
}

// B3 (417, §4.6, D58): the caller's own links. A code is shown once, here.
async function bridgeLinkBegin(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['provider']); argumentsCount(cmd, 0);
  const provider = (choice(cmd, 'provider', BRIDGE_PROVIDERS) ?? 'whatsapp') as BridgeProvider;
  const code = await observedInvoke<BridgeLinkCode>(client(cmd), 'bridges.links.begin', { body: { provider } });
  cmd.out.data(code, c => [
    `/link ${c.code}`,
    `Send that from your phone, in a ${c.provider} conversation connected to tm8. It works once and expires at ${c.expiresAt}.`,
    'When it arrives, your messages from that number count as you, here and in every space you are in.',
  ].join('\n'));
  return EXIT_OK;
}

const renderLink = (l: BridgeIdentityLink): string =>
  `${l.id} ${l.provider} ${l.masked} · ${l.trust === 'linked' ? `linked ✓ by ${l.method}` : `asserted in ${l.spaceName ?? l.spaceId}`} · ${l.verifiedAt}${l.revokedAt ? ` · revoked ${l.revokedAt}` : ''}`;

async function bridgeLinkList(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, []); argumentsCount(cmd, 0);
  const list = await observedInvoke<BridgeLinksList>(client(cmd), 'bridges.links.list', {});
  cmd.out.data(list, l => {
    const lines = l.items.map(renderLink);
    for (const p of l.pending) lines.push(`pending ${p.provider} code, expires ${p.expiresAt} (shown once when minted)`);
    return lines.length ? lines.join('\n') : 'no linked identities; mint a code with `tm8 bridge link begin`';
  });
  return EXIT_OK;
}

async function bridgeLinkRevoke(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, []); argumentsCount(cmd, 1);
  const link = await observedInvoke<BridgeIdentityLink>(client(cmd), 'bridges.links.revoke', {
    params: { linkId: requireArg(cmd, 0, '<link-id>') }, body: {},
  });
  cmd.out.data(link, l => `unlinked: ${renderLink(l)}`);
  return EXIT_OK;
}

// D60: a one-use invite pinned to a participant. The bridge never DMs (D28):
// the admin shares the join link themselves.
async function bridgeInvite(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['role', 'mutation-id']); argumentsCount(cmd, 2);
  const bridgeId = requireArg(cmd, 0, '<bridge-id>');
  const externalId = requireArg(cmd, 1, '<external-id>');
  const role = choice(cmd, 'role', ['member', 'admin'] as const);
  const view = await observedInvoke<BridgeView>(client(cmd), 'bridges.get', { params: { bridgeId } });
  const invite = await observedInvoke<{ id: string; code: string }>(client(cmd), 'spaces.invites.create', {
    params: { spaceId: view.spaceId },
    body: { ...mutation(cmd), maxUses: 1, ...(role ? { role } : {}), bridgeParticipant: { bridgeId, externalId } },
  });
  cmd.out.data(invite, i => [
    `invite ${i.id} for ${externalId} on ${view.title}`,
    `Share this join link with them yourself (tm8 never messages them): /join/${i.code} on your tm8 server.`,
    'When they join with it, their number is linked to their account.',
  ].join('\n'));
  return EXIT_OK;
}

// Hand-over (D55): offer, then the receiving number's owner accepts in tm8.
function renderHandover(r: BridgeHandoverResult): string {
  const h = r.handover;
  const lines = [`hand-over ${h.id} · ${h.status} · connection ${h.fromConnectionId} → ${h.toConnectionId}`];
  if (h.status === 'offered') lines.push(`the receiving number's owner accepts with: tm8 bridge handover accept ${h.id}`);
  if (r.readdressed) lines.push(`${r.readdressed} queued post${r.readdressed === 1 ? '' : 's'} now go out on the new number`);
  return `${lines.join('\n')}\n${renderBridge(r.bridge)}`;
}

async function handoverOffer(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['to', 'mutation-id']); argumentsCount(cmd, 1);
  const to = cmd.options.value('to');
  if (!to) throw usage('--to <connection-id> is required: the receiving member\'s connection, offered to this Space', 'tm8 bridge connection list');
  cmd.out.data(await observedInvoke<BridgeHandoverResult>(client(cmd), 'bridges.handover.offer', {
    params: { bridgeId: requireArg(cmd, 0, '<bridge-id>') }, body: { ...mutation(cmd), toConnectionId: to },
  }), renderHandover);
  return EXIT_OK;
}

async function handoverSettle(cmd: CommandContext,
  operation: 'bridges.handover.accept' | 'bridges.handover.decline' | 'bridges.handover.withdraw'): Promise<ExitCode> {
  assertKnownOptions(cmd, ['mutation-id']); argumentsCount(cmd, 1);
  cmd.out.data(await observedInvoke<BridgeHandoverResult>(client(cmd), operation, {
    params: { handoverId: requireArg(cmd, 0, '<handover-id>') }, body: mutation(cmd),
  }), renderHandover);
  return EXIT_OK;
}

export const BRIDGE_COMMANDS: CommandModule[] = [
  { path: ['bridge', 'connection', 'remove'], run: connectionRemove },
  { path: ['bridge', 'conversations'], run: bridgeConversations },
  { path: ['bridge', 'group', 'create'], run: bridgeGroupCreate },
  { path: ['bridge', 'group', 'fork'], run: bridgeGroupFork },
  { path: ['bridge', 'connection', 'list'], run: connectionList },
  { path: ['bridge', 'connection', 'begin'], run: connectionBegin },
  { path: ['bridge', 'connection', 'offer'], run: connectionOffer },
  { path: ['bridge', 'connection', 'withdraw'], run: connectionWithdraw },
  { path: ['bridge', 'handover', 'offer'], run: handoverOffer },
  { path: ['bridge', 'handover', 'accept'], run: cmd => handoverSettle(cmd, 'bridges.handover.accept') },
  { path: ['bridge', 'handover', 'decline'], run: cmd => handoverSettle(cmd, 'bridges.handover.decline') },
  { path: ['bridge', 'handover', 'withdraw'], run: cmd => handoverSettle(cmd, 'bridges.handover.withdraw') },
  { path: ['bridge', 'list'], run: bridgeList },
  { path: ['bridge', 'show'], run: cmd => bridgeShow(cmd, false) },
  { path: ['bridge', 'get'], run: cmd => bridgeShow(cmd, true) },
  { path: ['bridge', 'create'], run: bridgeCreate },
  { path: ['bridge', 'update'], run: bridgeUpdate },
  { path: ['bridge', 'retarget'], run: bridgeRetarget },
  { path: ['bridge', 'pause'], run: cmd => bridgeState(cmd, 'bridges.pause') },
  { path: ['bridge', 'resume'], run: cmd => bridgeState(cmd, 'bridges.resume') },
  { path: ['bridge', 'remove'], run: cmd => bridgeState(cmd, 'bridges.remove') },
  { path: ['bridge', 'people'], run: bridgePeople },
  { path: ['bridge', 'participant'], run: bridgeParticipant },
  { path: ['bridge', 'handles'], run: bridgeHandles },
  { path: ['bridge', 'handle', 'claim'], run: bridgeHandleClaim },
  { path: ['bridge', 'log'], run: bridgeLog },
  { path: ['bridge', 'listen'], run: bridgeListen },
  { path: ['bridge', 'work'], run: bridgeWork },
  { path: ['bridge', 'proposals'], run: bridgeProposals },
  { path: ['bridge', 'proposal', 'resolve'], run: bridgeProposalResolve },
  { path: ['bridge', 'link', 'begin'], run: bridgeLinkBegin },
  { path: ['bridge', 'link', 'list'], run: bridgeLinkList },
  { path: ['bridge', 'link', 'revoke'], run: bridgeLinkRevoke },
  { path: ['bridge', 'invite'], run: bridgeInvite },
  { path: ['bridge', 'import-config'], run: bridgeImportConfig },
];
