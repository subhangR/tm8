// `tm8 bridge` (BRIDGE-ENTITY-DESIGN §3.5, B0a): every verb is one bridges.*
// operation. Status and health are the server's derived facts; the CLI only
// renders them. Speaking needs no verb here: `tm8 message reply|send` crosses.
import {
  BRIDGE_PROVIDERS,
  type BridgeDetailView, type BridgeHandle, type BridgeIdentityLink, type BridgeLinkCode, type BridgeLinksList,
  type BridgeProvider, type BridgeHandleListResult, type BridgeListResult, type BridgeListenResult,
  type BridgeLogResult, type BridgePolicy, type BridgeView, type BridgeWake,
} from '@tm8/contract';
import { requireSpace } from '../context.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';
import { assertKnownOptions, enumOption, requireArg } from './entity.js';
import { client, mutation } from './tool.js';

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
  if (!connectionId) throw usage('--connection <connection-id> is required: the number you own');
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
      return `${m.createdAt} ${m.id}${reply} ${who}${via}: ${m.body.replace(/\s+/g, ' ')}`;
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

// B3 (408, §4.6, D58): the caller's own links. A code is shown once, here.
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

export const BRIDGE_COMMANDS: CommandModule[] = [
  { path: ['bridge', 'list'], run: bridgeList },
  { path: ['bridge', 'show'], run: cmd => bridgeShow(cmd, false) },
  { path: ['bridge', 'get'], run: cmd => bridgeShow(cmd, true) },
  { path: ['bridge', 'create'], run: bridgeCreate },
  { path: ['bridge', 'update'], run: bridgeUpdate },
  { path: ['bridge', 'retarget'], run: bridgeRetarget },
  { path: ['bridge', 'pause'], run: cmd => bridgeState(cmd, 'bridges.pause') },
  { path: ['bridge', 'resume'], run: cmd => bridgeState(cmd, 'bridges.resume') },
  { path: ['bridge', 'remove'], run: cmd => bridgeState(cmd, 'bridges.remove') },
  { path: ['bridge', 'handles'], run: bridgeHandles },
  { path: ['bridge', 'handle', 'claim'], run: bridgeHandleClaim },
  { path: ['bridge', 'log'], run: bridgeLog },
  { path: ['bridge', 'listen'], run: bridgeListen },
  { path: ['bridge', 'link', 'begin'], run: bridgeLinkBegin },
  { path: ['bridge', 'link', 'list'], run: bridgeLinkList },
  { path: ['bridge', 'link', 'revoke'], run: bridgeLinkRevoke },
  { path: ['bridge', 'invite'], run: bridgeInvite },
];
