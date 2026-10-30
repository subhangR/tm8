// `tm8 bridge import-config` (BRIDGE-ENTITY-DESIGN §7.1, §7.2 B1c): a Phase-1
// wa-bridge `config.json` becomes bridges and admin-asserted links, through
// the ordinary doors only (bridges.list, bridges.create, and P's
// bridges.participants.update, D52). The config is read locally and never sent.
//
// Every channel is an explicit choice (D28): `--channel` names each one, and
// nothing else in the file is touched. The plan is computed in full before
// the first write, and a gap (no target chat, an unmapped address, a channel
// of another space, shadow mode) refuses the whole run. A rerun changes
// nothing: an existing bridge on the conversation is reused, and an assertion
// that already holds is a no-op on the server.
import { randomUUID } from 'node:crypto';
import type { BridgeListResult, BridgeParticipant, BridgePolicy, BridgeView } from '@tm8/contract';
import { requireSpace } from '../context.js';
import { readTextSource } from '../args.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { observedInvoke } from '../discovery/observe.js';
import type { CommandContext } from '../run.js';
import { assertKnownOptions } from './entity.js';
import { client } from './tool.js';

const usage = (message: string, hint?: string): CliError => new CliError(message, EXIT_USAGE, hint ? { hint } : {});

/** The Phase-1 fields the import reads (integrations/whatsapp-bridge/src/config.ts); the rest is ignored. */
export interface Phase1Channel {
  id: string; jid: string; altJids?: string[]; title?: string; teammate?: string;
  allowedSenders?: string[]; trustedSenders?: string[]; mainChatId?: string | null;
  trigger?: 'mention' | 'all'; deliverTo?: string; style?: string;
  tm8?: { spaceId?: string; defaultTeammate?: string };
}
export interface Phase1Config {
  ownerJids?: string[]; trustedSenders?: string[];
  tm8?: { spaceId?: string; defaultTeammate?: string };
  channels?: Phase1Channel[];
}

export interface ImportOptions {
  spaceId: string;
  channels: string[];
  mainChats: Record<string, string>;
  purposes: Record<string, string>;
  members: Record<string, string>;
  ownerMember: string | null;
}

export interface PlannedLink { externalId: string; memberId: string; why: 'owner' | 'trusted' }
export interface PlannedBridge {
  channel: string;
  conversation: { externalId: string; kind: 'group' | 'dm'; title: string };
  targetId: string;
  teammateId: string | null;
  purpose: string;
  policy: Partial<BridgePolicy>;
  links: PlannedLink[];
}

const PERSON_JID = /^[0-9]{5,20}@(s\.whatsapp\.net|lid)$/;

/** `a=b` pairs from a repeatable flag; the key is everything before the first `=`. */
export function pairs(flag: string, raw: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of raw) {
    const at = item.indexOf('=');
    if (at < 1 || at === item.length - 1) throw usage(`--${flag} takes <key>=<value>, got "${item}"`);
    const key = item.slice(0, at), value = item.slice(at + 1);
    if (key in out && out[key] !== value) throw usage(`--${flag} names ${key} twice`);
    out[key] = value;
  }
  return out;
}

/**
 * The whole import as data. Pure: the config and the flags in, the bridges and
 * links out, or one error naming every gap at once.
 */
export function planPhase1Import(config: Phase1Config, opts: ImportOptions): PlannedBridge[] {
  const channels = config.channels ?? [];
  const owners = [...new Set(config.ownerJids ?? [])];
  const problems: string[] = [];
  if (!opts.channels.length) {
    throw usage('name each channel to import with --channel <id>',
      `this config has: ${channels.map(c => c.id).join(', ') || 'no channels'}`);
  }
  const plan: PlannedBridge[] = [];
  for (const id of opts.channels) {
    const ch = channels.find(c => c.id === id);
    if (!ch) { problems.push(`${id}: no such channel in the config`); continue; }
    const space = ch.tm8?.spaceId ?? config.tm8?.spaceId;
    if (space && space !== opts.spaceId) {
      problems.push(`${id}: belongs to space ${space}; run the import with --space ${space}`);
    }
    if (ch.deliverTo) problems.push(`${id}: shadow mode (deliverTo ${ch.deliverTo}) has no bridge equivalent; take it live in Phase 1 first`);
    const kind = ch.jid.endsWith('@g.us') ? 'group' : 'dm';
    if (kind === 'dm' && !owners.includes(ch.jid)) {
      problems.push(`${id}: a non-group channel must be the owner's self chat (one of ownerJids)`);
    }
    const targetId = opts.mainChats[id] ?? ch.mainChatId ?? null;
    if (!targetId) {
      problems.push(`${id}: no target chat; pass --main-chat ${id}=<chat-id> (Phase-1 /health → channels.${id}.main_chat_id)`);
    }

    // ownerJids always (the owner's /work keeps working everywhere it did);
    // "owner" in a trusted list means the same addresses.
    const trusted = [...(config.trustedSenders ?? []), ...(ch.trustedSenders ?? [])];
    const addresses = new Map<string, 'owner' | 'trusted'>();
    for (const jid of owners) addresses.set(jid, 'owner');
    for (const entry of trusted) {
      if (entry === 'owner') continue;
      if (!addresses.has(entry)) addresses.set(entry, 'trusted');
    }
    const links: PlannedLink[] = [];
    for (const [externalId, why] of addresses) {
      if (!PERSON_JID.test(externalId)) { problems.push(`${id}: ${externalId} is not a person's WhatsApp address`); continue; }
      const memberId = opts.members[externalId] ?? (why === 'owner' ? opts.ownerMember : null);
      if (!memberId) {
        problems.push(`${id}: ${externalId} (${why}) has no member; pass ${why === 'owner' ? '--owner-member <member-id> or ' : ''}--member ${externalId}=<member-id>`);
        continue;
      }
      links.push({ externalId, memberId, why });
    }

    const title = (ch.title ?? id).trim() || id;
    const policy: Partial<BridgePolicy> = {
      trigger: ch.trigger === 'all' ? 'every' : 'mention',
      whoMayTrigger: (ch.allowedSenders ?? []).includes('everyone') ? 'anyone' : 'linked',
    };
    if (ch.style) policy.style = ch.style;
    plan.push({
      channel: id,
      conversation: { externalId: ch.jid, kind, title },
      targetId: targetId ?? '',
      teammateId: ch.teammate ?? ch.tm8?.defaultTeammate ?? config.tm8?.defaultTeammate ?? null,
      purpose: opts.purposes[id] ?? `${title}, imported from the Phase-1 bridge`,
      policy,
      links,
    });
  }
  const unused = Object.keys(opts.mainChats).filter(k => !opts.channels.includes(k));
  if (unused.length) problems.push(`--main-chat names channels not being imported: ${unused.join(', ')}`);
  if (problems.length) throw usage(`nothing was imported:\n  ${problems.join('\n  ')}`);
  return plan;
}

function renderPlan(plan: PlannedBridge[]): string {
  return plan.map(p => [
    `${p.channel}: ${p.conversation.kind} "${p.conversation.title}" → chat ${p.targetId} · teammate ${p.teammateId ?? 'none'}` +
      ` · trigger ${p.policy.trigger} · who may trigger ${p.policy.whoMayTrigger}`,
    `  purpose: ${p.purpose}`,
    ...p.links.map(l => `  link ${mask(l.externalId)} → member ${l.memberId} (${l.why}, asserted)`),
  ].join('\n')).join('\n');
}

/** `+…1999@s.whatsapp.net`: enough to tell addresses apart in a log, not a number. */
export function mask(jid: string): string {
  const at = jid.indexOf('@');
  const user = at < 0 ? jid : jid.slice(0, at);
  return `…${user.slice(-4)}${at < 0 ? '' : jid.slice(at)}`;
}

interface ImportResult {
  dryRun: boolean;
  bridges: Array<{
    channel: string; bridgeId: string | null; created: boolean;
    links: Array<{ externalId: string; memberId: string; trust: string | null }>;
  }>;
}

export async function bridgeImportConfig(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['config', 'channel', 'connection', 'main-chat', 'purpose', 'member', 'owner-member', 'dry-run']);
  if (cmd.args.length || cmd.passthrough.length) throw usage('tm8 bridge import-config takes flags only; see its help');
  const source = cmd.options.value('config');
  if (!source) throw usage('--config <path> is required: the Phase-1 wa-bridge config.json');
  let config: Phase1Config;
  try {
    config = JSON.parse(await readTextSource(source.startsWith('@') || source === '-' ? source : `@${source}`)) as Phase1Config;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw usage(`--config is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const spaceId = requireSpace(cmd.ctx);
  const plan = planPhase1Import(config, {
    spaceId,
    channels: [...new Set(cmd.options.values('channel'))],
    mainChats: pairs('main-chat', cmd.options.values('main-chat')),
    purposes: pairs('purpose', cmd.options.values('purpose')),
    members: pairs('member', cmd.options.values('member')),
    ownerMember: cmd.options.value('owner-member') ?? null,
  });
  const dryRun = cmd.options.bool('dry-run');
  const connectionId = cmd.options.value('connection');
  if (!dryRun && !connectionId) throw usage('--connection <connection-id> is required: the number the bridges run on');

  const result: ImportResult = { dryRun, bridges: [] };
  if (dryRun) {
    result.bridges = plan.map(p => ({ channel: p.channel, bridgeId: null, created: false,
      links: p.links.map(l => ({ externalId: l.externalId, memberId: l.memberId, trust: null })) }));
    cmd.out.data(result, () => `dry run, nothing written:\n${renderPlan(plan)}`);
    return EXIT_OK;
  }

  const api = client(cmd);
  const existing = await observedInvoke<BridgeListResult>(api, 'bridges.list', { params: { spaceId }, query: { provider: 'whatsapp' } });
  const found = new Map(plan.map(p => [p.channel, existing.items.find(b => b.conversation.externalId === p.conversation.externalId)]));
  // A bridge already on the conversation must already point where the plan does; checked for all before any write.
  const moved = plan.flatMap(p => {
    const b = found.get(p.channel);
    return b && b.target.id !== p.targetId
      ? [`${p.channel}: already bridged to ${b.target.kind} ${b.target.id}, not ${p.targetId}; retarget it with \`tm8 bridge retarget ${b.id}\` or fix --main-chat`]
      : [];
  });
  if (moved.length) throw usage(`nothing was imported:\n  ${moved.join('\n  ')}`);
  const lines: string[] = [];
  for (const p of plan) {
    let bridge = found.get(p.channel);
    let created = false;
    if (!bridge) {
      bridge = await observedInvoke<BridgeView>(api, 'bridges.create', {
        params: { spaceId },
        body: {
          clientMutationId: randomUUID(), connectionId, targetId: p.targetId, conversation: p.conversation,
          policy: p.policy, teammateId: p.teammateId, purpose: p.purpose,
        },
      });
      created = true;
    }
    lines.push(`${p.channel}: bridge ${bridge.id} ${created ? 'created' : 'already there'} · ${bridge.status}`);
    const links: ImportResult['bridges'][number]['links'] = [];
    for (const l of p.links) {
      // P's door (D52): an admin assertion; the same one again is a no-op, so a rerun is safe.
      const r = await observedInvoke<BridgeParticipant>(api, 'bridges.participants.update', {
        params: { bridgeId: bridge.id, externalId: l.externalId },
        body: { clientMutationId: randomUUID(), patch: { memberId: l.memberId } },
      });
      links.push({ externalId: l.externalId, memberId: l.memberId, trust: r.trust });
      lines.push(`  link ${mask(l.externalId)} → member ${r.memberId ?? l.memberId}: ${r.trust}`);
    }
    result.bridges.push({ channel: p.channel, bridgeId: bridge.id, created, links });
  }
  cmd.out.data(result, () => lines.join('\n'));
  return EXIT_OK;
}
