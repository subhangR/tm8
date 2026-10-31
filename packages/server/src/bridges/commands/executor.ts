/**
 * Bridges B1b-4: the server-side command executor (BRIDGES-V2-DESIGN §4.1-§4.6,
 * §4.8, §8; BRIDGE-ENTITY-DESIGN §2.3 step 2, §2.8).
 *
 * A command arrives from the inbound door (B1b-2) already stored on the log
 * anchor and never routed: no command text ever reaches the target as a turn.
 * The executor
 *
 * - runs it AS THE LINKED MEMBER: every write goes through the member's own
 *   claims and the ordinary RPCs the UI uses (`create_task`, `set_work_state`,
 *   spawn, terminate), so a command can do exactly what that member could do
 *   in the browser and nothing more. A guest has no authority to lend;
 * - is IDEMPOTENT: every write carries a mutation id from
 *   (bridgeId, externalMessageId, item) — per bridge, not per connection (D20)
 *   — so a redelivery, a retry or the inbound sweep re-running the command
 *   lands on the same tasks and sessions;
 * - stamps PROVENANCE on everything it creates: `authored_from -> bridge` with
 *   `command` = the verb (D22, D31), written in the create's own transaction;
 *   a worker's origins ride the spawn as a server fact (B1b-3);
 * - ANSWERS with one bridge notice quoting the command, idempotent on the
 *   command's message, and reacts ⏳ when the answer takes longer than the
 *   2 s budget.
 *
 * Durability (frozen by the B1b coordinator): B1b-2 marks a command pending in
 * the inbound tx and calls run(messageId) after commit; run() claims it, loads
 * it, executes, answers and settles it. sweep() (called by B1b-2's watchdog)
 * re-runs commands a crash left pending or running. A refusal is an answer
 * and settles `done`; a fault settles back to `pending`, so 398's claim retries
 * it and turns it `failed` after its attempts run out.
 */
import { CollabError, type BridgeWorkStartInput, type BridgeWorkStartResult } from '@tm8/contract';
import type { Db, DbClaims, Querier } from '../../db/types.js';
import {
  isConfirmText, parseBridgeCommand, parseDuration, parsePeople, parseSplit, parseWorkItems, parseWorkerRef, stripTail, titleOf,
  type BridgeVerb, type ParsedBridgeCommand, type PersonRef, type WorkItem, type WorkerRef,
} from './parse.js';
import { proposeBridgeMemory } from '../memory-proposals.js';
import type {
  BridgeCommandDetectContext, BridgeCommandHook, BridgeCommandInput, BridgeCommandOrigin, BridgeCommandPorts, BridgeGroupResult,
  BridgeWorkStarter,
} from './ports.js';

/** v2 §4.3 Routing → Workers defaults; the bridge row does not carry them yet. */
export const MAX_WORKERS_PER_COMMAND = 5;
export const MAX_LIVE_WORKERS_PER_BRIDGE = 10;
/** §4.6: a /work over this many items, and /stop all|mine, answer with a confirm first. */
export const CONFIRM_WORK_OVER = 3;
/** §4.8 rate limits. */
export const SENDER_COMMANDS_PER_MIN = 10;
export const BRIDGE_COMMANDS_PER_MIN = 30;
/** §4.2: a `#n` names the last list the bridge sent this sender, for 30 minutes. */
export const LIST_TTL_MS = 30 * 60 * 1000;
/** §4.8: ≤ 2 s to the answer, else a ⏳ reaction first. */
export const ACK_AFTER_MS = 1500;
/** §4.8: ≤ 10 lines per reply. */
export const MAX_LIST_LINES = 8;

/** §4.6 tiers, per verb. /stop is Linked for one's own workers and Admin otherwise (checked at the branch). */
export const VERB_TIER: Readonly<Record<BridgeVerb, 'everyone' | 'reader' | 'linked' | 'admin'>> = {
  help: 'everyone', whoami: 'everyone', link: 'everyone',
  workers: 'reader', status: 'reader', tasks: 'reader', docs: 'reader',
  work: 'linked', task: 'linked', stop: 'linked', remember: 'linked',
  who: 'reader', bridge: 'everyone',
  mute: 'admin', unmute: 'admin', new: 'linked',
  start: 'linked', retry: 'linked', tell: 'linked', result: 'reader',
  // 426: they act through the number owner's own WhatsApp, so a verified space admin only.
  split: 'admin', invite: 'admin',
};

const LIVE_SESSION = new Set(['spawning', 'running', 'idle']);
const OPEN_TASK = new Set(['open', 'pulled', 'working', 'in_review', 'blocked']);
const DOC_KINDS = { docs: ['doc'], artifacts: ['artifact'], drawings: ['drawing'], all: ['doc', 'artifact', 'drawing'] } as const;
const PROVIDER_NAMES: Record<string, string> = {
  whatsapp: 'WhatsApp', telegram: 'Telegram', slack: 'Slack', discord: 'Discord', instagram: 'Instagram', messenger: 'Messenger',
};

/** What run() learns from public.bridge_command_context. */
interface BridgeFacts {
  bridgeId: string;
  spaceId: string;
  provider: string;
  title: string;
  targetKind: 'chat' | 'work_session' | 'channel';
  targetId: string;
  teammateId: string | null;
  targetTeammateId: string | null;
  whoMayTrigger: 'linked' | 'anyone';
  direction: 'both' | 'in' | 'out';
  trigger: 'mention' | 'every' | 'none';
  targetTitle: string | null;
  mutedUntil: string | null;
  /** The group's log (399's internal.bridge_log_anchor): the bridge, or its channel. */
  logAnchor: string;
  pausedAt: string | null;
  endedAt: string | null;
  deleted: boolean;
  memberRole: 'owner' | 'admin' | 'member' | null;
  replyTo: { messageId: string | null; direction: 'in' | 'out' | null } | null;
}

/** The sender, as the tiers (§4.6) see them. */
interface Sender {
  externalId: string;
  displayName: string;
  /** Linked or asserted, with an active member row in the bridge's space. */
  memberId: string | null;
  identityId: string | null;
  trust: 'linked' | 'asserted' | 'guest';
  /** Space admin by a VERIFIED link; asserted links never count as admin (§4.6). */
  admin: boolean;
  /** Allowed the Readers tier: a member, or anyone when whoMayTrigger is 'anyone'. */
  reader: boolean;
}

interface Command {
  input: BridgeCommandInput;
  bridge: BridgeFacts;
  sender: Sender;
  /** The member's own claims; null for a guest. */
  claims: DbClaims | null;
  /** Mutation-id root, per bridge (D20). */
  key: string;
  origin: (verb: string) => BridgeCommandOrigin;
}

/** A reply, plus a confirm to open on the notice it becomes, plus /work's own facts (for bridges.work.start). */
interface Answer {
  text: string;
  confirm?: StoredConfirm;
  work?: { parentTaskId: string | null; items: Array<{ taskId: string; sessionId: string | null; handle: string | null; error: string | null }> };
}

/** What a confirm stores, to run on YES (§4.6). Intent, never an approval (D9). */
interface StoredConfirm { verb: 'work' | 'stop'; args: string; body: string[]; externalMessageId: string; messageId: string }

interface ListRow {
  id: string; kind: string; title: string; status: string | null; created_at: Date | string;
  created_by: string; handle: string | null;
  origins: Array<{ sender?: { memberId?: string }; command?: string | null; providerMessageId?: string | null }>;
}

const GUEST_FIRST = 'link your number first: ask a space admin in tm8 to link it. /whoami to check';

/** A refusal the sender should read; never retried. */
class Refusal extends Error {}

const ANSWERABLE = new Set(['invalid_input', 'forbidden', 'not_found', 'conflict', 'rate_limited', 'invariant_violation', 'not_implemented']);

function ago(at: Date | string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(at).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function sessionWord(status: string | null): string {
  switch (status) {
    case 'spawning': return 'starting';
    case 'running': return 'working';
    case 'idle': return 'idle';
    case 'exited': return 'ended';
    case 'failed': return 'failed';
    default: return status ?? 'unknown';
  }
}

function taskWord(status: string | null): string {
  return (status ?? 'open').replace('_', ' ');
}

/** "Login timeout fix (keen-otter)". */
function named(row: { title: string; handle: string | null }): string {
  return row.handle ? `${row.title} (${row.handle})` : row.title;
}

function hhmm(now: Date): string {
  return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} UTC`;
}

export interface BridgeCommandExecutor extends BridgeCommandHook, BridgeWorkStarter {
  /** One command, loaded; run() is claim + load + this + settle. */
  execute(input: BridgeCommandInput): Promise<void>;
  /** Exposed for tests: the in-memory per-sender lists and rate windows. */
  reset(): void;
}

/**
 * The code a /link names, as the group typed it (B3 follow-up, D59): a phone
 * may split TM8-XXXXXX at the hyphen ("TM8 XXXXXX", "TM8 – XXX XXX"), so words
 * are taken until they hold a whole code's letters and digits (TM8 plus six,
 * or six without the prefix). The SQL door normalizes the separators.
 */
export function linkCodeText(args: string): string {
  const words = stripTail(args).split(/\s+/).filter(Boolean);
  let out = '';
  for (const word of words) {
    out = out ? `${out} ${word}` : word;
    const chars = out.replace(/[^0-9A-Za-z]/g, '');
    if (chars.length >= (/^tm8/i.test(chars) ? 9 : 6)) break;
  }
  return out;
}

export function createBridgeCommandExecutor(ports: BridgeCommandPorts): BridgeCommandExecutor {
  const now = () => ports.now?.() ?? new Date();
  const lists = new Map<string, { at: number; ids: string[] }>();
  const windows = new Map<string, { start: number; count: number; told: boolean }>();

  const exec = async <T>(fn: (q: Querier) => Promise<T>): Promise<T> => ports.db.tx(await ports.executorClaims(), fn);

  // ---------------------------------------------------------------- limits
  /** §4.8: per sender 10/min, per bridge 30/min; over → one notice, then silence. */
  function rateLimit(input: BridgeCommandInput): 'ok' | 'tell' | 'silent' {
    const at = now().getTime();
    let verdict: 'ok' | 'tell' | 'silent' = 'ok';
    for (const [key, cap] of [[`s:${input.bridgeId}:${input.senderExternalId}`, SENDER_COMMANDS_PER_MIN], [`b:${input.bridgeId}`, BRIDGE_COMMANDS_PER_MIN]] as const) {
      let w = windows.get(key);
      if (!w || at - w.start >= 60_000) { w = { start: at, count: 0, told: false }; windows.set(key, w); }
      w.count += 1;
      if (w.count > cap) {
        if (!w.told) { w.told = true; if (verdict === 'ok') verdict = 'tell'; } else verdict = 'silent';
      }
    }
    return verdict;
  }

  function remember(cmd: Command, ids: string[]): void {
    lists.set(`${cmd.input.bridgeId}:${cmd.input.senderExternalId}`, { at: now().getTime(), ids });
  }

  function fromList(cmd: Command, index: number): string | null {
    const list = lists.get(`${cmd.input.bridgeId}:${cmd.input.senderExternalId}`);
    if (!list || now().getTime() - list.at > LIST_TTL_MS) return null;
    return list.ids[index - 1] ?? null;
  }

  // ---------------------------------------------------------------- reads
  /** Entities with an authored_from edge to this bridge, by kind, that the sender may read (§2.8). */
  async function provenance(cmd: Command, kinds: readonly string[], limit = 100): Promise<ListRow[]> {
    if (cmd.claims) {
      return ports.db.query<ListRow>(cmd.claims,
        'select * from internal.bridge_provenance_rows($1, $2::text[], $3)', [cmd.input.bridgeId, kinds, limit]);
    }
    return exec(q => q.query<ListRow>('select * from public.bridge_command_guest_list($1, $2::text[], $3)',
      [cmd.input.bridgeId, kinds, limit]));
  }

  const mine = (cmd: Command, row: ListRow) =>
    cmd.sender.memberId !== null
    && (row.created_by === cmd.sender.memberId || row.origins.some(o => o.sender?.memberId === cmd.sender.memberId));

  /** One worker by handle, `#n`, or title prefix, among this bridge's live workers. */
  async function resolveWorker(cmd: Command, ref: Extract<WorkerRef, { kind: 'index' | 'handle' }>): Promise<ListRow | null> {
    const rows = await provenance(cmd, ['work_session']);
    if (ref.kind === 'index') {
      const id = fromList(cmd, ref.index);
      return id ? rows.find(r => r.id === id) ?? null : null;
    }
    const byHandle = rows.find(r => r.handle === ref.handle);
    if (byHandle) return byHandle;
    const prefix = ref.prefix.toLowerCase();
    const live = rows.filter(r => LIVE_SESSION.has(r.status ?? ''));
    return live.find(r => r.title.toLowerCase().startsWith(prefix)) ?? null;
  }

  // ---------------------------------------------------------------- tiers
  const requireLinked = (cmd: Command): DbClaims => {
    if (!cmd.claims || !cmd.sender.memberId) throw new Refusal(GUEST_FIRST);
    return cmd.claims;
  };
  const requireReader = (cmd: Command): void => {
    if (!cmd.sender.reader) throw new Refusal(GUEST_FIRST);
  };
  /**
   * The Admin tier (§4.6): a linked member who is a space admin. An ASSERTED
   * link never counts as admin, and a guest has no member at all. Every
   * admin-tier path goes through this before its door runs: a verb whose
   * whole tier is admin via VERB_TIER in dispatch, a mixed verb (/stop of
   * another's worker, /stop all) by calling it at the branch.
   */
  const requireAdminTier = (cmd: Command): DbClaims => {
    const claims = requireLinked(cmd);
    if (cmd.sender.trust === 'asserted') throw new Refusal('that needs a space admin with a verified link — an admin-asserted link doesn\'t count');
    if (!cmd.sender.admin) throw new Refusal('that needs a space admin');
    return claims;
  };

  // ---------------------------------------------------------------- verbs
  function help(cmd: Command, topic: string): Answer {
    const lines = ['tm8 commands here:'];
    const t = topic.toLowerCase();
    if (cmd.sender.memberId && (t === '' || t.startsWith('work'))) {
      lines.push('/work <one item per line> — start a worker per item');
      lines.push('/task <title> — make a task, no worker');
      lines.push('/stop <worker> — stop your worker');
    }
    if (cmd.sender.memberId && (t === '' || t.startsWith('rem') || t.startsWith('mem'))) {
      lines.push('/remember <text> — propose a memory; a linked member accepts it in tm8');
    }
    if (cmd.sender.reader && (t === '' || t.startsWith('work') || t.startsWith('task') || t.startsWith('doc'))) {
      lines.push('/workers [all] · /status <worker> — what is running');
      lines.push('/tasks [open] · /docs [artifacts|drawings] — what this group made');
    }
    if (cmd.sender.memberId && cmd.bridge.targetKind !== 'channel' && (t === '' || t.startsWith('new') || t.startsWith('session'))) {
      lines.push('/new session — start a fresh session for this group; @tm8 goes there');
    }
    if (cmd.sender.admin && (t === '' || t.startsWith('admin') || t.startsWith('mute'))) {
      lines.push('/mute 1h · /unmute — hold tm8\'s posts here; commands keep working');
    }
    if (cmd.sender.admin && (t.startsWith('admin') || t.startsWith('group') || t.startsWith('split') || t.startsWith('invite'))) {
      lines.push('/split <name> with @a @b — a new group with them, on its own session');
      lines.push('/invite @a +91… — add people to this group');
    }
    lines.push('/whoami · /bridge — who you are, where this group goes');
    if (!cmd.sender.memberId) lines.push(GUEST_FIRST);
    return { text: lines.slice(0, 10).join('\n') };
  }

  function whoami(cmd: Command): Answer {
    const s = cmd.sender;
    if (!s.memberId) return { text: `you're a guest here — ${GUEST_FIRST.replace(/\. \/whoami to check$/, '')}` };
    const how = s.trust === 'linked' ? 'linked ✓' : 'asserted by an admin';
    const can = s.admin ? 'you can start and stop any worker' : 'you can start workers';
    return { text: `you are ${s.displayName || 'a member'} (${how}) in ${cmd.bridge.title || 'this group'} — ${can}` };
  }

  /** The reasons propose_bridge_memory refuses with (403), as the sender reads them. */
  const REMEMBER_REFUSALS: Readonly<Record<string, string>> = {
    remember_needs_link: GUEST_FIRST,
    proposal_holds_secret: 'that looks like a password or key — a memory never holds one, so nothing was saved. Send it again without the secret',
    too_many_proposals: 'this group already has 20 memory proposals waiting — accept or drop some in tm8 first',
    bridge_ended: 'this group is no longer connected',
  };

  /**
   * D29, D61: `/remember <text>` records a PROPOSAL, never a memory. A linked
   * member of this group accepts it in tm8, from the inbox item it raises;
   * nothing sent here (a YES, `/remember accept`) can accept one.
   */
  async function rememberProposal(cmd: Command): Promise<Answer> {
    requireLinked(cmd);
    const statement = cmd.input.text.replace(/^\s*[/!]\S+[ \t]*\n?/, '').trim();
    if (statement === '') throw new Refusal('usage: /remember <what agents working for this group should know>');
    try {
      const proposal = await exec(q => proposeBridgeMemory(q, {
        bridgeId: cmd.input.bridgeId, senderExternalId: cmd.input.senderExternalId, statement,
        messageId: cmd.input.messageId, providerMessageId: cmd.input.externalMessageId,
      }));
      const warn = proposal.mentionsSecret ? ' It mentions a secret: whoever accepts it should check it holds none.' : '';
      return { text: `memory proposed — a linked member of this group accepts it in tm8 within 14 days.${warn}` };
    } catch (error) {
      const reason = error instanceof CollabError ? (error.details as { reason?: string } | undefined)?.reason : undefined;
      const text = reason ? REMEMBER_REFUSALS[reason] : undefined;
      if (text) throw new Refusal(text);
      throw error;
    }
  }

  async function task(cmd: Command, args: string): Promise<Answer> {
    const claims = requireLinked(cmd);
    const title = titleOf(stripTail(args));
    if (title === '') throw new Refusal('usage: /task <title>');
    const id = await ports.db.tx(claims, async q => {
      const created = await createTask(q, cmd, { title, description: describe(cmd, args), parentId: null, cmid: `${cmd.key}:task` });
      await ports.recordOrigin(q, created, cmd.origin('/task'));
      return created;
    });
    remember(cmd, [id]);
    return { text: `task #1 created: ${title}` };
  }

  function describe(cmd: Command, line: string): string {
    const parts = [line.trim()];
    if (cmd.input.replyTo?.text) parts.push('', `In reply to: "${cmd.input.replyTo.text.slice(0, 500)}"`);
    parts.push('', `From ${PROVIDER_NAMES[cmd.bridge.provider] ?? cmd.bridge.provider} · ${cmd.bridge.title} · asked by ${cmd.sender.displayName || 'a member'} (bridge ${cmd.input.bridgeId})`);
    return parts.join('\n');
  }

  async function createTask(q: Querier, cmd: Command, task: { title: string; description: string; parentId: string | null; cmid: string }): Promise<string> {
    const raw = await q.rpc<{ entity?: { id?: string } }>('create_task', [
      cmd.input.spaceId, task.title, null, task.description, {}, task.parentId, null, 'medium', '[]',
      null, null, null, null, 'attached_to', task.cmid,
    ]);
    const id = raw?.entity?.id;
    if (!id) throw new Error('create_task returned no entity');
    return id;
  }

  async function resolveTeammate(cmd: Command, claims: DbClaims, name: string | undefined): Promise<string> {
    if (name) {
      const rows = await ports.db.query<{ id: string }>(claims,
        `select tm.entity_id::text id
           from public.team_members tm join public.entities e on e.id = tm.entity_id
          where e.space_id = $1 and e.deleted_at is null
            and (lower(tm.name) = lower($2) or lower(tm.name) like lower($2) || '%' or lower(tm.name) like '%' || lower($2) || '%')
          order by (lower(tm.name) = lower($2)) desc, (lower(tm.name) like lower($2) || '%') desc, tm.name
          limit 2`, [cmd.input.spaceId, name]);
      if (!rows[0]) throw new Refusal(`no teammate called "${name}" in this space`);
      return rows[0].id;
    }
    const id = cmd.bridge.teammateId ?? cmd.bridge.targetTeammateId;
    if (!id) throw new Refusal(await noTeammate(cmd, claims));
    return id;
  }

  /** Who a worker would run as is unknown: say where to set it, with a teammate this space really has. */
  async function noTeammate(cmd: Command, claims: DbClaims): Promise<string> {
    const rows = await ports.db.query<{ name: string }>(claims,
      `select tm.name from public.team_members tm join public.entities e on e.id = tm.entity_id
        where e.space_id = $1 and e.deleted_at is null order by tm.name limit 3`, [cmd.input.spaceId]).catch(() => []);
    const names = rows.map(r => r.name);
    const example = names[0] ?? '<name>';
    return [
      `no teammate to run this as: this bridge has none, and its ${cmd.bridge.targetKind === 'chat' ? 'chat' : 'session'} has none either.`,
      `Name one in the command: /work teammate:${example} <what to do>`,
      `Or set the bridge's teammate in tm8: the bridge's page → Routing → Teammate.`,
      ...(names.length ? [`Teammates here: ${names.join(', ')}`] : []),
    ].join('\n');
  }

  async function resolveProject(cmd: Command, claims: DbClaims, name: string | undefined): Promise<string | null> {
    if (!name) return null;
    const rows = await ports.db.query<{ id: string }>(claims,
      `select p.id::text id from public.projects p
        where p.space_id = $1 and (lower(p.name) = lower($2) or lower(p.name) like lower($2) || '%')
        order by (lower(p.name) = lower($2)) desc, p.name limit 1`, [cmd.input.spaceId, name]).catch(() => []);
    if (!rows[0]) throw new Refusal(`no project called "${name}" in this space`);
    return rows[0].id;
  }

  async function work(cmd: Command, args: string, body: string[], confirmed: boolean): Promise<Answer> {
    const claims = requireLinked(cmd);
    const parsed = parseWorkItems(args, body);
    if (!parsed.ok) {
      switch (parsed.reason) {
        case 'empty': throw new Refusal('usage: /work <item>, or one item per line under /work');
        case 'unknown_option': throw new Refusal(`unknown option "${parsed.detail}:" — use teammate:, project: or effort:`);
        case 'bad_effort': throw new Refusal(`effort is low, high or max, not "${parsed.detail}"`);
        case 'race_not_available': throw new Refusal(`${parsed.detail} (several attempts at one item) isn't available yet`);
      }
    }
    return runWork(cmd, claims, parsed.items, confirmed
      ? null
      : { verb: 'work', args, body, externalMessageId: cmd.input.externalMessageId, messageId: cmd.input.messageId });
  }

  /**
   * The one /work path (§4.3), for the command and for bridges.work.start:
   * limits, then one transaction for every task, then every worker at once.
   * `confirm` null means confirmed (or not asked, for the agent's door).
   */
  async function runWork(cmd: Command, claims: DbClaims, items: WorkItem[], confirm: StoredConfirm | null): Promise<Answer> {
    if (items.length > MAX_WORKERS_PER_COMMAND) {
      throw new Refusal(`${items.length} items is over this bridge's limit of ${MAX_WORKERS_PER_COMMAND} workers per command — nothing started`);
    }
    // A re-run of this same command must not count its own workers against it.
    const self = cmd.origin('/work').providerMessageId;
    const live = (await provenance(cmd, ['work_session'], 200))
      .filter(r => LIVE_SESSION.has(r.status ?? '') && !(self && r.origins.some(o => o.providerMessageId === self))).length;
    if (live + items.length > MAX_LIVE_WORKERS_PER_BRIDGE) {
      throw new Refusal(`${live} workers are running from this group; ${items.length} more is over the limit of ${MAX_LIVE_WORKERS_PER_BRIDGE} — nothing started`);
    }
    // Resolve every option before creating anything: a bad name refuses the whole command.
    const teammates = await Promise.all(items.map(item => resolveTeammate(cmd, claims, item.options.teammate)));
    const projects = await Promise.all(items.map(item => resolveProject(cmd, claims, item.options.project)));
    if (items.length > CONFIRM_WORK_OVER && confirm) {
      return {
        text: [`start ${items.length} workers?`, ...items.map((item, i) => `${i + 1} ${titleOf(item.text, 60)}`), 'reply YES within 2 min'].join('\n'),
        confirm,
      };
    }

    // One transaction for every task (§4.8 partial failure: refused whole).
    const origin = cmd.origin('/work');
    const { parentId, taskIds } = await ports.db.tx(claims, async q => {
      let parent: string | null = null;
      if (items.length >= 2) {
        const provider = PROVIDER_NAMES[cmd.bridge.provider] ?? cmd.bridge.provider;
        parent = await createTask(q, cmd, {
          title: `From ${provider} · ${cmd.bridge.title || 'group'} · ${hhmm(now())}`,
          description: describe(cmd, items.map(i => `- ${i.text}`).join('\n')),
          parentId: null, cmid: `${cmd.key}:parent`,
        });
        await ports.recordOrigin(q, parent, origin);
      }
      const ids: string[] = [];
      for (const [index, item] of items.entries()) {
        const id = await createTask(q, cmd, {
          title: titleOf(item.text), description: describe(cmd, item.text), parentId: parent, cmid: `${cmd.key}:item:${index}`,
        });
        await ports.recordOrigin(q, id, origin);
        ids.push(id);
      }
      return { parentId: parent, taskIds: ids };
    });

    // Every worker starts at once (no queue, D26); a failed launch is reported on its line.
    const started = await Promise.all(items.map(async (item: WorkItem, index) => {
      try {
        const { sessionId } = await ports.spawnWorker(claims, {
          spaceId: cmd.input.spaceId, teamMemberId: teammates[index]!, taskId: taskIds[index]!,
          projectId: projects[index]!, effort: item.options.effort ?? null, title: titleOf(item.text, 80),
          clientMutationId: `${cmd.key}:spawn:${index}`, origins: [origin],
        });
        const handle = await ports.workerHandle(claims, cmd.input.bridgeId, sessionId).catch(() => null);
        return { ok: true as const, sessionId, handle: handle?.handle ?? null };
      } catch (error) {
        ports.logger?.warn(`bridge ${cmd.input.bridgeId}: /work item ${index + 1} failed to start: ${errorText(error)}`);
        return { ok: false as const, reason: safeReason(error) };
      }
    }));
    remember(cmd, started.map((s, i) => (s.ok ? s.sessionId : taskIds[i]!)));
    const okCount = started.filter(s => s.ok).length;
    const head = okCount === items.length
      ? `${okCount} worker${okCount === 1 ? '' : 's'} on it`
      : `${okCount} of ${items.length} workers started`;
    const lines = items.map((item, i) => {
      const s = started[i]!;
      const title = titleOf(item.text, 60);
      return s.ok ? `${i + 1} ${s.handle ? `${title} (${s.handle})` : title} — starting` : `${i + 1} ${title} — didn't start: ${s.reason}`;
    });
    return {
      text: [head, ...lines, 'Reply to a line, or @handle, to ask one directly. /workers to check.'].join('\n'),
      work: {
        parentTaskId: parentId,
        items: started.map((s, i) => s.ok
          ? { taskId: taskIds[i]!, sessionId: s.sessionId, handle: s.handle, error: null }
          : { taskId: taskIds[i]!, sessionId: null, handle: null, error: s.reason }),
      },
    };
  }

  async function workers(cmd: Command, args: string): Promise<Answer> {
    requireReader(cmd);
    const all = stripTail(args).toLowerCase() === 'all' || !cmd.sender.memberId;
    const rows = (await provenance(cmd, ['work_session']))
      .filter(r => LIVE_SESSION.has(r.status ?? ''))
      .filter(r => all || mine(cmd, r));
    if (rows.length === 0) return { text: all ? 'no workers running from this group' : 'none of yours are running — /workers all for everyone\'s' };
    remember(cmd, rows.map(r => r.id));
    const at = now();
    const lines = rows.slice(0, MAX_LIST_LINES).map((r, i) => `${i + 1} ${named(r)} · ${sessionWord(r.status)} ${ago(r.created_at, at)}`);
    if (rows.length > MAX_LIST_LINES) lines.push(`… and ${rows.length - MAX_LIST_LINES} more in tm8`);
    return { text: lines.join('\n') };
  }

  async function status(cmd: Command, args: string): Promise<Answer> {
    requireReader(cmd);
    const ref = parseWorkerRef(args);
    if (!ref || ref.kind === 'all' || ref.kind === 'mine') throw new Refusal('usage: /status <worker> — a handle, or #n from /workers');
    const row = await resolveWorker(cmd, ref);
    if (!row) throw new Refusal(`no worker "${stripTail(args)}" from this group — /workers to list them`);
    const taskTitle = await workerTask(cmd, row.id);
    return { text: `${named(row)} · ${sessionWord(row.status)} ${ago(row.created_at, now())}${taskTitle ? ` · task: ${taskTitle.title} (${taskWord(taskTitle.status)})` : ''}` };
  }

  async function workerTask(cmd: Command, sessionId: string): Promise<{ id: string; title: string; status: string } | null> {
    const sql = `select t.entity_id::text id, t.title, t.work_status status
                   from public.edges ed join public.tasks t on t.entity_id = ed.dst_id
                  where ed.src_id = $1 and ed.type = 'working_on'
                  order by ed.created_at limit 1`;
    const rows = cmd.claims
      ? await ports.db.query<{ id: string; title: string; status: string }>(cmd.claims, sql, [sessionId])
      : [];
    return rows[0] ?? null;
  }

  /** The reason this command records; a session ended with it was ended by this command (a re-run). */
  const stopReason = (cmd: Command) =>
    `stopped from ${PROVIDER_NAMES[cmd.bridge.provider] ?? cmd.bridge.provider} by ${cmd.sender.displayName || 'a member'}`;

  /**
   * Sessions THIS command ended: they carry its reason and ended at or after
   * its own message arrived (the original message, for a /stop confirmed by
   * YES). The reason alone is the same for every /stop the sender ever sent.
   */
  async function endedByThis(cmd: Command, claims: DbClaims, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await ports.db.query<{ id: string }>(claims,
      `select ws.entity_id::text id from public.work_sessions ws
        where ws.entity_id = any($1::uuid[]) and ws.ended_reason = $2
          and coalesce(ws.exited_at, ws.status_changed_at) >= (select m.created_at from public.messages m where m.entity_id = $3)`,
      [ids, stopReason(cmd), cmd.origin('/stop').messageId]);
    return new Set(rows.map(r => r.id));
  }

  async function stop(cmd: Command, args: string, confirmed: boolean): Promise<Answer> {
    const claims = requireLinked(cmd);
    const ref = parseWorkerRef(args);
    if (!ref) throw new Refusal('usage: /stop <worker>, /stop mine or /stop all');
    const reason = stopReason(cmd);
    const isLive = (r: ListRow) => LIVE_SESSION.has(r.status ?? '');
    let targets: ListRow[];
    if (ref.kind === 'all' || ref.kind === 'mine') {
      if (ref.kind === 'all') requireAdminTier(cmd);
      const candidates = (await provenance(cmd, ['work_session'])).filter(r => ref.kind === 'all' || mine(cmd, r));
      const live = candidates.filter(isLive);
      if (!confirmed) {
        if (live.length === 0) return { text: 'no workers to stop' };
        return {
          text: `stop ${live.length} worker${live.length === 1 ? '' : 's'}? reply YES within 2 min`,
          confirm: { verb: 'stop', args, body: [], externalMessageId: cmd.input.externalMessageId, messageId: cmd.input.messageId },
        };
      }
      // A re-run after a crash: the workers this command already ended still
      // need their task blocked and noted.
      const ended = await endedByThis(cmd, claims, candidates.filter(r => !isLive(r)).map(r => r.id));
      targets = candidates.filter(r => isLive(r) || ended.has(r.id));
      if (targets.length === 0) return { text: 'no workers to stop' };
    } else {
      const row = await resolveWorker(cmd, ref);
      if (!row) throw new Refusal(`no worker "${stripTail(args)}" from this group — /workers to list them`);
      if (!mine(cmd, row)) {
        try {
          requireAdminTier(cmd);
        } catch (error) {
          throw error instanceof Refusal
            ? new Refusal(`${named(row)} isn't yours — only its starter or a space admin can stop it`)
            : error;
        }
      }
      if (!isLive(row) && !(await endedByThis(cmd, claims, [row.id])).has(row.id)) {
        return { text: `${named(row)} already ${sessionWord(row.status)}` };
      }
      targets = [row];
    }
    const stopped: string[] = [];
    const failed: string[] = [];
    for (const row of targets) {
      try {
        if (isLive(row)) await ports.stopWorker(claims, row.id, { reason, clientMutationId: `${cmd.key}:stop:${row.id}` });
        const t = await workerTask(cmd, row.id);
        if (t && OPEN_TASK.has(t.status)) {
          // set_work_state keeps a note only on the caller's own working_on
          // claim, and the stopper is not working on the task; so the reason
          // is posted on the task, as the stopper, beside the transition. Both
          // writes are keyed on this command, so a re-run lands on the same two.
          if (t.status !== 'blocked') {
            await ports.db.rpc(claims, 'set_work_state', [t.id, 'blocked', null, null, null, `${cmd.key}:block:${t.id}`, false, false]);
          }
          // messages.post's own door: anchors, body, parent, mentions, attachments,
          // source session, actor, mutation id, chat mode, source chat.
          await ports.db.rpc(claims, 'w2_post_message_batch', [
            [t.id], `${reason}.`, null, [], [], null, null, `${cmd.key}:note:${t.id}`, null, null,
          ]);
        }
        stopped.push(row.handle ?? row.title);
      } catch (error) {
        failed.push(`${row.handle ?? row.title}: ${safeReason(error)}`);
      }
    }
    const lines = stopped.length > 0 ? [`stopped ${stopped.join(', ')}`] : [];
    if (failed.length > 0) lines.push(`couldn't stop ${failed.join('; ')}`);
    return { text: lines.join('\n') };
  }

  async function tasks(cmd: Command, args: string): Promise<Answer> {
    requireReader(cmd);
    const open = stripTail(args).toLowerCase() === 'open';
    const rows = (await provenance(cmd, ['task'])).filter(r => !open || OPEN_TASK.has(r.status ?? ''));
    if (rows.length === 0) return { text: open ? 'no open tasks from this group' : 'no tasks from this group yet' };
    remember(cmd, rows.map(r => r.id));
    const lines = rows.slice(0, MAX_LIST_LINES).map((r, i) => `${i + 1} ${r.title} · ${taskWord(r.status)}`);
    if (rows.length > MAX_LIST_LINES) lines.push(`… and ${rows.length - MAX_LIST_LINES} more in tm8`);
    return { text: lines.join('\n') };
  }

  async function docs(cmd: Command, args: string): Promise<Answer> {
    requireReader(cmd);
    const a = stripTail(args).toLowerCase();
    const index = /^#?(\d{1,3})$/.exec(a);
    if (index) {
      const id = fromList(cmd, Number(index[1]));
      const rows = id ? (await provenance(cmd, DOC_KINDS.all)).filter(r => r.id === id) : [];
      if (!rows[0]) throw new Refusal('that number is not on your last /docs list — send /docs again');
      return { text: `${rows[0].title} — open it in tm8 (${rows[0].kind})` };
    }
    const which = a.startsWith('artifact') ? 'artifacts' : a.startsWith('drawing') ? 'drawings' : a === '' ? 'all' : null;
    if (!which) throw new Refusal('usage: /docs, /docs artifacts or /docs drawings');
    const rows = await provenance(cmd, DOC_KINDS[which]);
    const noun = which === 'all' ? 'docs, artifacts or drawings' : which;
    if (rows.length === 0) return { text: `no ${noun} from this group yet` };
    remember(cmd, rows.map(r => r.id));
    const lines = rows.slice(0, MAX_LIST_LINES).map((r, i) => `${i + 1} ${r.title}${which === 'all' && r.kind !== 'doc' ? ` (${r.kind})` : ''}`);
    if (rows.length > MAX_LIST_LINES) lines.push(`… and ${rows.length - MAX_LIST_LINES} more in tm8`);
    return { text: lines.join('\n') };
  }

  /**
   * /link TM8-XXXXXX (B3, §2.4, D58/D59): the code a member minted in Account →
   * Linked identities. Anyone may send it; a guest is exactly who links. The
   * door answers an outcome, never throws for a bad code, and burns a live code
   * a failed try named (everyone in the group has read it).
   */
  async function link(cmd: Command, args: string): Promise<Answer> {
    const code = linkCodeText(args);
    if (!code) return { text: 'usage: /link TM8-XXXXXX — get a code in tm8: Account → Linked identities' };
    const r = await exec(q => q.rpc<{ ok: boolean; reason?: string; already?: boolean; burned?: boolean }>(
      'bridge_command_link_redeem', [cmd.input.bridgeId, cmd.input.senderExternalId, code]));
    if (r.ok) {
      return {
        text: r.already
          ? 'this number is already linked to you'
          : 'linked ✓ — messages from this number now count as you in tm8, in every space you are in. Unlink any time in tm8: Account → Linked identities',
      };
    }
    const fresh = r.burned ? ' That code is used up now: make a new one.' : '';
    switch (r.reason) {
      case 'rate_limited': return { text: `too many wrong codes from this number — try again in an hour.${fresh}` };
      case 'expired': return { text: 'that code has expired — make a new one in tm8: Account → Linked identities' };
      case 'used': return { text: 'that code was already used — make a new one in tm8: Account → Linked identities' };
      case 'wrong_provider': return { text: `that code is for another network.${fresh}` };
      case 'linked_elsewhere': return { text: `this number is linked to another tm8 account; unlink it there first.${fresh}` };
      case 'bridge_ended': return { text: 'this group is no longer connected to tm8' };
      default: return { text: `that is not a valid code — copy it exactly from tm8: Account → Linked identities.${fresh}` };
    }
  }

  /** Today's /who (§4.4): the chat that answers here, and everyone's live workers. */
  async function who(cmd: Command): Promise<Answer> {
    const head = `chat: ${cmd.bridge.targetTitle ?? 'the group chat'} (tm8)`;
    const list = await workers(cmd, 'all');
    return { text: list.text.startsWith('no workers') ? `${head}\nno workers running` : `${head}\n${list.text}` };
  }

  /** One card: where this group goes, who answers, what crosses back, paused or muted (§4.4). */
  function bridgeCard(cmd: Command): Answer {
    const b = cmd.bridge;
    const at = now();
    const muted = b.mutedUntil && new Date(b.mutedUntil) > at ? `muted until ${hhmm(new Date(b.mutedUntil))}` : null;
    const state = b.pausedAt ? 'paused' : muted ?? 'live';
    const trigger = b.trigger === 'every' ? 'every message' : b.trigger === 'mention' ? 'messages that mention tm8' : 'commands only';
    const back = b.direction === 'in' ? 'nothing (listen only)' : b.direction === 'out' ? 'tm8 posts only' : 'replies to this group';
    return {
      text: [
        `${b.title || 'this group'} → ${b.targetTitle ?? 'a tm8 chat'} (${b.targetKind.replace('_', ' ')}) · ${state}`,
        `answers: ${trigger}, from ${b.whoMayTrigger === 'anyone' ? 'anyone' : 'linked members'}`,
        `crosses back: ${back}`,
      ].join('\n'),
    };
  }

  async function mute(cmd: Command, args: string): Promise<Answer> {
    const claims = requireAdminTier(cmd);
    const ms = parseDuration(args);
    if (ms === null) throw new Refusal('usage: /mute 30m, 2h or 1d (at most a week) — commands keep working; /unmute to undo');
    const until = new Date(now().getTime() + ms);
    await ports.db.rpc(claims, 'bridge_set_mute', [cmd.input.bridgeId, until.toISOString()]);
    return { text: `muted until ${hhmm(until)} — commands still work; /unmute to undo` };
  }

  async function unmute(cmd: Command): Promise<Answer> {
    const claims = requireAdminTier(cmd);
    await ports.db.rpc(claims, 'bridge_set_mute', [cmd.input.bridgeId, null]);
    return { text: 'unmuted' };
  }

  /** A task by `#n` from the sender's last list, or a title prefix, among this bridge's tasks. */
  async function resolveTask(cmd: Command, args: string): Promise<ListRow | null> {
    const text = stripTail(args).trim();
    if (text === '') return null;
    const rows = await provenance(cmd, ['task']);
    const index = /^#?(\d{1,3})$/.exec(text);
    if (index) {
      const id = fromList(cmd, Number(index[1]));
      return id ? rows.find(r => r.id === id) ?? null : null;
    }
    const prefix = text.toLowerCase();
    return rows.find(r => r.title.toLowerCase().startsWith(prefix)) ?? null;
  }

  /** Spawn one worker on one task (/start, /retry's new launch), handle at request time. */
  async function launchOn(cmd: Command, claims: DbClaims, task: { id: string; title: string }, verb: string, cmid: string) {
    const teammate = await resolveTeammate(cmd, claims, undefined);
    const { sessionId } = await ports.spawnWorker(claims, {
      spaceId: cmd.input.spaceId, teamMemberId: teammate, taskId: task.id, projectId: null, effort: null,
      title: titleOf(task.title, 80), clientMutationId: cmid, origins: [cmd.origin(verb)],
    });
    const handle = await ports.workerHandle(claims, cmd.input.bridgeId, sessionId).catch(() => null);
    return { sessionId, handle: handle?.handle ?? null };
  }

  /** /start #n (§4.4): a worker on an existing task from this group, the /work path. */
  async function start(cmd: Command, args: string): Promise<Answer> {
    const claims = requireLinked(cmd);
    const task = await resolveTask(cmd, args);
    if (!task) throw new Refusal('usage: /start #n from /tasks, or the start of a task\'s title');
    if (task.status === 'done' || task.status === 'cancelled') throw new Refusal(`"${task.title}" is ${taskWord(task.status)}`);
    const launched = await launchOn(cmd, claims, task, '/start', `${cmd.key}:spawn:start`);
    remember(cmd, [launched.sessionId]);
    return { text: `${launched.handle ? `${task.title} (${launched.handle})` : task.title} — starting` };
  }

  /** /retry <worker> (§4.4): resume the ended session, else a new launch on the same task. */
  async function retry(cmd: Command, args: string): Promise<Answer> {
    const claims = requireLinked(cmd);
    const ref = parseWorkerRef(args);
    if (!ref || ref.kind === 'all' || ref.kind === 'mine') throw new Refusal('usage: /retry <worker> — a handle, or #n from /workers');
    const row = await resolveWorker(cmd, ref);
    if (!row) throw new Refusal(`no worker "${stripTail(args)}" from this group — /workers all to list them`);
    if (LIVE_SESSION.has(row.status ?? '')) return { text: `${named(row)} is still ${sessionWord(row.status)}` };
    try {
      await ports.resumeWorker(claims, row.id, { clientMutationId: `${cmd.key}:resume` });
      return { text: `${named(row)} resumed` };
    } catch (error) {
      ports.logger?.debug?.(`bridge ${cmd.input.bridgeId}: /retry could not resume ${row.id}: ${errorText(error)}`);
    }
    const t = await workerTask(cmd, row.id);
    if (!t) throw new Refusal(`${named(row)} can't be resumed and has no task to start again`);
    const launched = await launchOn(cmd, claims, t, '/retry', `${cmd.key}:spawn:retry`);
    return { text: `${named(row)} couldn't resume — started ${launched.handle ?? 'a new worker'} on "${t.title}"` };
  }

  /**
   * /new [session] (R11): a fresh session for this group, and the bridge
   * moves to it, so the next @tm8 lands there. The old session is left as it
   * is (it keeps its handle and its history); the group's log never moves,
   * because a chat or session bridge logs on the bridge itself. A new CHAT is
   * started by a person in tm8 (chat.start is human-only), so `/new chat` and a
   * bare `/new` on a chat bridge say where to do that.
   */
  async function newSession(cmd: Command, args: string): Promise<Answer> {
    const claims = requireLinked(cmd);
    const word = stripTail(args).toLowerCase();
    if (cmd.bridge.targetKind === 'channel') {
      throw new Refusal('this group mirrors a tm8 channel, so there is no session to replace');
    }
    if (word !== '' && word !== 'session' && word !== 'chat') throw new Refusal('usage: /new, or /new session');
    if (word === 'chat' || (word === '' && cmd.bridge.targetKind === 'chat')) {
      throw new Refusal('a new chat is started in tm8: open this bridge → New chat. /new session starts a session from here');
    }
    const facts = await exec(q => q.rpc<{ teammateId: string | null } | null>('bridge_managed_context', [cmd.input.bridgeId]));
    const teammate = cmd.bridge.teammateId ?? cmd.bridge.targetTeammateId ?? facts?.teammateId ?? null;
    if (!teammate) throw new Refusal('this bridge has no teammate to run a session as: set one on the bridge in tm8');
    const provider = PROVIDER_NAMES[cmd.bridge.provider] ?? cmd.bridge.provider;
    const { sessionId } = await ports.spawnWorker(claims, {
      spaceId: cmd.input.spaceId, teamMemberId: teammate, taskId: null, projectId: null, effort: null,
      title: titleOf(`${cmd.bridge.title || 'Group'} (${provider})`, 80),
      clientMutationId: `${cmd.key}:spawn:new`, origins: [cmd.origin('/new')],
    });
    await exec(q => q.rpc('bridge_managed_retarget', [cmd.input.bridgeId, sessionId, cmd.sender.memberId, 'new']));
    const handle = await ports.workerHandle(claims, cmd.input.bridgeId, sessionId).catch(() => null);
    const old = cmd.bridge.targetTitle ? `"${cmd.bridge.targetTitle}"` : `the old ${cmd.bridge.targetKind === 'chat' ? 'chat' : 'session'}`;
    return {
      text: `new session started${handle?.handle ? ` (${handle.handle})` : ''} — @tm8 goes there now. ${old} keeps its history`,
    };
  }

  // ---------------------------------------------------------------- groups (426)
  interface RosterRow { external_id: string; alt_external_ids: string[]; display_name: string | null; muted: boolean }

  /** A participant's best address to add to a group: their phone-number JID when known, else the id they used. */
  const addressOf = (r: RosterRow): string =>
    [r.external_id, ...r.alt_external_ids].find(j => j.endsWith('@s.whatsapp.net')) ?? r.external_id;

  /** Names on a /split or /invite, against this group's roster (the people who have spoken here). */
  async function resolvePeople(cmd: Command, claims: DbClaims, refs: PersonRef[]) {
    const roster = await ports.db.query<RosterRow>(claims,
      `select external_id, alt_external_ids, display_name, muted from public.bridge_participants where bridge_id = $1`,
      [cmd.input.bridgeId]);
    const jids = new Map<string, string>();  // address -> how to name it in the answer
    const unknown: string[] = [];
    const named = (r: RosterRow) => r.display_name || `…${r.external_id.replace(/@.*$/, '').slice(-4)}`;
    for (const ref of refs) {
      if (ref.kind === 'everyone') {
        for (const r of roster) if (!r.muted) jids.set(addressOf(r), named(r));
      } else if (ref.kind === 'mention' || ref.kind === 'phone') {
        const hit = roster.find(r => [r.external_id, ...r.alt_external_ids].some(j => j.startsWith(`${ref.digits}@`)));
        jids.set(hit ? addressOf(hit) : `${ref.digits}@s.whatsapp.net`, hit ? named(hit) : `+${ref.digits}`);
      } else {
        const want = ref.text.toLowerCase();
        const exact = roster.filter(r => (r.display_name ?? '').toLowerCase() === want);
        const prefix = exact.length ? exact : roster.filter(r => (r.display_name ?? '').toLowerCase().startsWith(want));
        if (prefix.length === 1) jids.set(addressOf(prefix[0]!), named(prefix[0]!));
        else unknown.push(prefix.length > 1 ? `"${ref.text}" (several people)` : `"${ref.text}"`);
      }
    }
    return { jids, unknown, roster };
  }

  /** "added 3; Maya needs the invite link: https://…" — one line per outcome that happened. */
  function groupOutcome(g: BridgeGroupResult, names: Map<string, string>): string {
    const who = (status: string) => g.results.filter(r => r.status === status).map(r => names.get(r.id) ?? `…${r.id.replace(/@.*$/, '').slice(-4)}`);
    const parts: string[] = [];
    const added = who('added'), already = who('already'), invite = who('invite_needed'), failed = who('failed');
    if (added.length) parts.push(`added ${added.join(', ')}`);
    if (already.length) parts.push(`already in: ${already.join(', ')}`);
    if (invite.length) parts.push(`${invite.join(', ')} can't be added directly (their privacy settings)${g.inviteLink ? ` — send them ${g.inviteLink}` : ''}`);
    if (failed.length) parts.push(`couldn't add ${failed.join(', ')}`);
    return parts.join('. ');
  }

  /**
   * /split <name> with <people> (426): a new WhatsApp group on this number,
   * with the sender and the people named (from this group's roster, or by
   * +number), connected by its own bridge onto a new session as this bridge's
   * teammate, with this bridge's policy. A retry never makes a second group:
   * the group is recorded on the command message the moment WhatsApp answers.
   */
  async function split(cmd: Command, args: string, body: string[]): Promise<Answer> {
    const claims = requireLinked(cmd);
    if (!ports.groups) throw new Refusal('this node cannot make groups yet');
    const { name, people } = parseSplit(args, body);
    if (!name) throw new Refusal('usage: /split <group name> with @someone @someone — @mention them, give a +number, a name, or everyone');
    const done = await exec(q => q.rpc<{ conversationId: string; title: string; bridgeId: string | null } | null>('bridge_split_of', [cmd.input.messageId]));
    if (done?.bridgeId) return { text: `"${done.title}" is made and connected` };

    let title = name;
    let outcome = '';
    let size: number | null = null;
    if (!done) {
      const { jids, unknown, roster } = await resolvePeople(cmd, claims, people);
      if (unknown.length) throw new Refusal(`I don't know ${unknown.join(', ')} in this group — @mention them or give a +number`);
      const me = roster.find(r => r.external_id === cmd.input.senderExternalId);
      jids.set(me ? addressOf(me) : cmd.input.senderExternalId, cmd.sender.displayName || 'you');
      const g = await ports.groups.create({
        connectionId: cmd.input.connectionId, subject: titleOf(name, 100), participants: [...jids.keys()], requestId: `${cmd.key}:split`,
      });
      title = g.subject || name;
      await exec(q => q.rpc('bridge_split_record', [cmd.input.messageId, cmd.input.bridgeId, g.conversationId, title]));
      outcome = groupOutcome(g, jids);
      size = g.results.filter(r => r.status === 'added').length + 1;
    } else {
      title = done.title;
    }

    const facts = await exec(q => q.rpc<{ teammateId: string | null } | null>('bridge_managed_context', [cmd.input.bridgeId]));
    const teammate = cmd.bridge.teammateId ?? cmd.bridge.targetTeammateId ?? facts?.teammateId ?? null;
    if (!teammate) {
      return { text: `made "${title}"${outcome ? `: ${outcome}` : ''}. It isn't connected to tm8: this bridge has no teammate for its session — connect it in tm8` };
    }
    const provider = PROVIDER_NAMES[cmd.bridge.provider] ?? cmd.bridge.provider;
    const { sessionId } = await ports.spawnWorker(claims, {
      spaceId: cmd.input.spaceId, teamMemberId: teammate, taskId: null, projectId: null, effort: null,
      title: titleOf(`${title} (${provider})`, 80), clientMutationId: `${cmd.key}:spawn:split`, origins: [cmd.origin('/split')],
    });
    const connected = await exec(q => q.rpc<{ bridgeId: string }>('bridge_split_connect', [cmd.input.messageId, sessionId, cmd.sender.memberId, size]));
    const handle = await ports.workerHandle(claims, connected.bridgeId, sessionId).catch(() => null);
    return {
      text: `made "${title}"${outcome ? `: ${outcome}` : ''}. It has its own session${handle?.handle ? ` (${handle.handle})` : ''}; @tm8 there goes to it`,
    };
  }

  /** /invite <people> (426): add them to this group through the number (it must be the group's admin). */
  async function invite(cmd: Command, args: string, body: string[]): Promise<Answer> {
    const claims = requireLinked(cmd);
    if (!ports.groups) throw new Refusal('this node cannot add people to groups yet');
    const refs = parsePeople([args, ...body].join('\n'));
    if (refs.length === 0) throw new Refusal('usage: /invite @someone +91… — @mention them or give a +number');
    if (refs.some(r => r.kind === 'everyone')) throw new Refusal('everyone here is in this group already — name who to add');
    const { jids, unknown } = await resolvePeople(cmd, claims, refs);
    if (unknown.length) throw new Refusal(`I don't know ${unknown.join(', ')} — give a +number for someone who isn't in this group`);
    const [row] = await ports.db.query<{ conv: string }>(claims,
      'select external_conversation_id conv from public.bridges where entity_id = $1', [cmd.input.bridgeId]);
    if (!row) throw new Refusal('this group is no longer connected to tm8');
    let g: BridgeGroupResult;
    try {
      g = await ports.groups.add({ connectionId: cmd.input.connectionId, conversationId: row.conv, participants: [...jids.keys()], requestId: `${cmd.key}:invite` });
    } catch (error) {
      if (/not-authorized|forbidden|403/i.test(errorText(error))) throw new Refusal('this number has to be an admin of the group to add people');
      throw error;
    }
    return { text: groupOutcome(g, jids) || 'nobody to add' };
  }

  /** /result <worker> (§4.4): its latest post on this group's log, ≤ 10 lines, never secret-shaped text (§4.8). */
  async function result(cmd: Command, args: string): Promise<Answer> {
    requireReader(cmd);
    const ref = parseWorkerRef(args);
    if (!ref || ref.kind === 'all' || ref.kind === 'mine') throw new Refusal('usage: /result <worker> — a handle, or #n from /workers');
    const row = await resolveWorker(cmd, ref);
    if (!row) throw new Refusal(`no worker "${stripTail(args)}" from this group — /workers all to list them`);
    const rows = cmd.claims
      ? await ports.db.query<{ body: string }>(cmd.claims,
        // Only what the worker posted on THIS bridge's log: the answer is read
        // by the whole group, so nothing from elsewhere in the space (§4.8).
        `select m.body from public.edges ed join public.messages m on m.entity_id = ed.src_id
          where ed.type = 'authored_from' and ed.dst_id = $1 and m.anchor_id = $2 and m.redacted_at is null
          order by m.created_at desc limit 1`, [row.id, cmd.bridge.logAnchor])
      : await exec(q => q.query<{ body: string }>('select body from public.bridge_command_guest_result($1, $2) as body',
        [cmd.input.bridgeId, row.id]));
    const body = rows[0]?.body;
    if (!body) return { text: `${named(row)} hasn't reported yet` };
    if (looksSecret(body)) return { text: `${named(row)}'s latest report looks like it holds a secret — read it in tm8` };
    const lines = body.split('\n').map(l => l.trimEnd()).filter(l => l !== '');
    const shown = lines.slice(0, MAX_LIST_LINES);
    if (lines.length > shown.length) shown.push('… more in tm8');
    return { text: [`${named(row)}:`, ...shown].join('\n') };
  }

  /** /tell <worker> <text> (§4.4): directs this message to the worker (B1b-3's bridge_tell: origin + answerer). */
  async function tell(cmd: Command, args: string, body: string[]): Promise<Answer> {
    const claims = requireLinked(cmd);
    const [first = '', ...rest] = args.split(/\s+/);
    const text = [rest.join(' '), ...body].join('\n').trim();
    if (first === '' || text === '') throw new Refusal('usage: /tell <worker> <message>');
    const handle = first.replace(/^@/, '').toLowerCase();
    const session = await ports.db.rpc<string | null>(claims, 'bridge_tell', [
      cmd.input.bridgeId, cmd.input.messageId, handle, JSON.stringify(cmd.origin('/tell').sender),
    ]);
    if (!session) throw new Refusal(`no live worker called ${handle} — /workers to list them`);
    return { text: `told ${handle}` };
  }

  async function yes(cmd: Command): Promise<Answer | null> {
    // Idempotent per YES message: a re-run of this YES gets the same command back.
    const stored = await exec(q => q.rpc<StoredConfirm | null>('bridge_command_confirm_take', [
      cmd.input.bridgeId, cmd.input.senderExternalId, cmd.input.replyTo?.externalMessageId ?? null, cmd.input.messageId,
    ]));
    if (!stored || typeof stored !== 'object' || !('verb' in stored)) {
      // The door only lets a YES through when it quotes an open confirm of this
      // sender's, so this is the expiry race (or a second YES): say so.
      return { text: 'nothing to confirm — it expired or was already done' };
    }
    // Re-run the confirmed command under ITS OWN message's keys, so a second
    // YES, or a retry, lands on the same tasks and sessions.
    const original: Command = {
      ...cmd,
      key: `bridge:${cmd.input.bridgeId}:${stored.externalMessageId}`,
      origin: verb => ({ ...cmd.origin(verb), messageId: stored.messageId, providerMessageId: stored.externalMessageId }),
    };
    return stored.verb === 'work'
      ? work(original, stored.args, stored.body, true)
      : stop(original, stored.args, true);
  }

  async function dispatch(cmd: Command, parsed: ParsedBridgeCommand): Promise<Answer | null> {
    if (parsed.kind === 'none') return null;
    // One entry for every verb a later slice builds (B1b-6, lanes L and R).
    if (parsed.kind === 'planned') return { text: `coming soon: /${parsed.word} — /help for what works now` };
    if (parsed.kind === 'unknown') {
      const tail = parsed.args ? ` ${parsed.args}` : '';
      return {
        text: parsed.suggestion
          ? `did you mean /${parsed.suggestion}${tail}? (/help for the list)`
          : `/${parsed.word} isn't a command — /help for the list`,
      };
    }
    const verb: BridgeVerb = parsed.verb;
    // §4.6, structurally: the verb's tier is checked here, before its handler
    // (and so before any door it calls) runs.
    switch (VERB_TIER[verb]) {
      case 'everyone': break;
      case 'reader': requireReader(cmd); break;
      case 'linked': requireLinked(cmd); break;
      case 'admin': requireAdminTier(cmd); break;
    }
    switch (verb) {
      case 'help': return help(cmd, parsed.args);
      case 'whoami': return whoami(cmd);
      case 'link': return link(cmd, parsed.args);
      case 'task': return task(cmd, parsed.args);
      case 'remember': return rememberProposal(cmd);
      case 'work': return work(cmd, parsed.args, parsed.body, false);
      case 'workers': return workers(cmd, parsed.args);
      case 'status': return status(cmd, parsed.args);
      case 'stop': return stop(cmd, parsed.args, false);
      case 'tasks': return tasks(cmd, parsed.args);
      case 'docs': return docs(cmd, parsed.args);
      case 'who': return who(cmd);
      case 'bridge': return bridgeCard(cmd);
      case 'mute': return mute(cmd, parsed.args);
      case 'unmute': return unmute(cmd);
      case 'new': return newSession(cmd, parsed.args);
      case 'start': return start(cmd, parsed.args);
      case 'retry': return retry(cmd, parsed.args);
      case 'result': return result(cmd, parsed.args);
      case 'tell': return tell(cmd, parsed.args, parsed.body);
      case 'split': return split(cmd, parsed.args, parsed.body);
      case 'invite': return invite(cmd, parsed.args, parsed.body);
    }
  }

  async function loadFacts(input: BridgeCommandInput): Promise<BridgeFacts | null> {
    const memberId = input.author.kind === 'member' ? input.author.actorId : null;
    return exec(q => q.rpc<BridgeFacts | null>('bridge_command_context', [
      input.bridgeId, memberId, input.replyTo?.externalMessageId ?? null,
    ]));
  }

  function senderOf(input: BridgeCommandInput, bridge: BridgeFacts): Sender {
    const author = input.author;
    const member = author.kind === 'member' && bridge.memberRole !== null;
    return {
      externalId: input.senderExternalId,
      displayName: author.participant?.displayName ?? '',
      memberId: member ? author.actorId : null,
      identityId: member && author.kind === 'member' ? author.identityId : null,
      trust: member ? (author.trust as 'linked' | 'asserted') : 'guest',
      admin: member && author.trust === 'linked' && (bridge.memberRole === 'owner' || bridge.memberRole === 'admin'),
      reader: member || bridge.whoMayTrigger === 'anyone',
    };
  }

  async function answer(cmd: Command, reply: Answer, keySuffix = ''): Promise<void> {
    const notice = await ports.postNotice(ports.db, {
      bridgeId: cmd.input.bridgeId,
      text: reply.text,
      replyToMessageId: cmd.input.messageId,
      idempotencyKey: `cmd:${cmd.input.bridgeId}:${cmd.input.externalMessageId}${keySuffix}`,
    });
    if (reply.confirm) {
      await exec(q => q.rpc('bridge_command_confirm_open', [
        notice.messageId, cmd.input.bridgeId, cmd.input.senderExternalId, JSON.stringify(reply.confirm),
      ]));
    }
  }

  /**
   * 398's claim turns a command `failed` once its attempts run out (and
   * answers false): the group is told once, on its own key, so "retrying" is
   * never the last word.
   */
  async function tellFailed(messageId: string): Promise<void> {
    try {
      const input = await exec(q => q.rpc<(BridgeCommandInput & { commandState?: string | null }) | null>('bridge_command_input', [messageId]));
      if (!input || input.commandState !== 'failed') return;
      await ports.postNotice(ports.db, {
        bridgeId: input.bridgeId,
        text: 'couldn\'t do that after several tries — please send it again later',
        replyToMessageId: input.messageId,
        idempotencyKey: `cmd:${input.bridgeId}:${input.externalMessageId}:failed`,
      });
    } catch (error) {
      ports.logger?.warn(`bridge command ${messageId}: could not post the final notice: ${errorText(error)}`);
    }
  }

  /**
   * bridges.work.start (v2 §4.3): the agent's door to /work — the same path,
   * limits, handles, provenance and announcement, as the CALLER (their own
   * claims: a member, or an agent session acting for one). Idempotent on the
   * client mutation id, which keys every write the way a message id keys a
   * command's. No confirm: the caller asked explicitly.
   */
  async function workStart(claims: DbClaims, input: BridgeWorkStartInput & { bridgeId: string }): Promise<BridgeWorkStartResult> {
    const [row] = await ports.db.query<{ space_id: string; member_id: string | null; display_name: string | null }>(claims,
      `select b.space_id::text, m.entity_id::text member_id, m.display_name
         from public.bridges b join public.entities e on e.id = b.entity_id and e.deleted_at is null
         left join public.members m on m.entity_id = internal.current_member_id(b.space_id)
        where b.entity_id = $1`, [input.bridgeId]);
    if (!row) throw new CollabError('not_found', 'Bridge is unavailable');
    if (!row.member_id) throw new CollabError('forbidden', 'start work on a bridge in a space you are a member of');
    const bridge = await loadFacts({ bridgeId: input.bridgeId, author: { kind: 'member', actorId: row.member_id } } as BridgeCommandInput);
    if (!bridge || bridge.deleted || bridge.endedAt) throw new CollabError('conflict', 'this bridge was removed', { details: { reason: 'bridge_ended' } });
    // Like a loop's 'loop:<id>' key: the origin's dedupe key when no provider message started it.
    const originKey = `api:${input.clientMutationId}`;
    const sender: Sender = {
      externalId: '', displayName: row.display_name ?? '', memberId: row.member_id, identityId: claims.identityId ?? null,
      trust: 'linked', admin: false, reader: true,
    };
    const cmd: Command = {
      input: {
        bridgeId: input.bridgeId, spaceId: row.space_id, connectionId: '', messageId: '', externalMessageId: originKey,
        senderExternalId: `api:${row.member_id}`, author: { kind: 'member', actorId: row.member_id, trust: 'linked', identityId: claims.identityId ?? '', linkId: '', participant: { displayName: row.display_name ?? '' } },
        text: '',
      },
      bridge, sender, claims,
      key: `bridge:${input.bridgeId}:${originKey}`,
      // The same provenance as /work (v2 §4.3), keyed on the call instead of a message.
      origin: () => ({ bridgeId: input.bridgeId, messageId: null, providerMessageId: originKey, sender: { memberId: row.member_id! }, command: '/work' }),
    };
    const options = input.options ?? {};
    const items: WorkItem[] = input.items.map(text => ({
      text: text.trim(),
      options: {
        ...(options.teammate ? { teammate: options.teammate } : {}),
        ...(options.project ? { project: options.project } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
      },
    }));
    let answered: Answer;
    try {
      answered = await runWork(cmd, claims, items, null);
    } catch (error) {
      if (error instanceof Refusal) throw new CollabError('invalid_input', error.message);
      throw error;
    }
    // The same announcement /work posts, to the group, on the call's own key.
    let noticeMessageId: string | null = null;
    try {
      const notice = await ports.postNotice(ports.db, {
        bridgeId: input.bridgeId, text: answered.text, replyToMessageId: null,
        idempotencyKey: `work:${input.bridgeId}:${input.clientMutationId}`,
      });
      noticeMessageId = notice.delivery.status === 'pending' ? notice.messageId : null;
    } catch (error) {
      ports.logger?.warn(`bridge ${input.bridgeId}: bridges.work.start could not announce: ${errorText(error)}`);
    }
    const work = answered.work ?? { parentTaskId: null, items: [] };
    return { bridgeId: input.bridgeId, parentTaskId: work.parentTaskId, items: work.items, noticeMessageId };
  }

  return {
    workStart,
    reset() { lists.clear(); windows.clear(); },

    async detect(text: string, ctx: BridgeCommandDetectContext): Promise<boolean> {
      if (parseBridgeCommand(text).kind !== 'none') return true;
      // §4.6: a bare YES is a command only when it quotes this sender's open confirm.
      if (!ctx.replyToExternalMessageId || !isConfirmText(text)) return false;
      const rows = await ctx.q.query<{ open: boolean }>(
        'select public.bridge_command_confirm_open_for($1, $2, $3) as open',
        [ctx.bridgeId, ctx.senderExternalId, ctx.replyToExternalMessageId]);
      return rows[0]?.open === true;
    },

    async execute(input: BridgeCommandInput): Promise<void> {
      if (input.edited) return; // §4.2: an edit never re-runs a command.
      const parsed = parseBridgeCommand(input.text);
      const confirming = parsed.kind === 'none' && isConfirmText(input.text);
      if (parsed.kind === 'none' && !confirming) return;
      const limited = rateLimit(input);
      if (limited === 'silent') return;

      const bridge = await loadFacts(input);
      if (!bridge || bridge.deleted || bridge.endedAt) return;
      const sender = senderOf(input, bridge);
      const cmd: Command = {
        input, bridge, sender,
        claims: sender.memberId && sender.identityId
          ? { identityId: sender.identityId, nodeAdmin: false, requestId: `bridge-command:${input.messageId}` }
          : null,
        key: `bridge:${input.bridgeId}:${input.externalMessageId}`,
        origin: verb => ({
          bridgeId: input.bridgeId,
          messageId: input.messageId,
          providerMessageId: input.externalMessageId,
          sender: sender.memberId ? { memberId: sender.memberId } : { participant: sender.displayName || 'Guest' },
          command: verb,
        }),
      };
      if (limited === 'tell') {
        await answer(cmd, { text: 'too many commands — try again in a minute' });
        return;
      }

      // §4.8: ≤ 2 s, or ⏳ first and the answer when it lands.
      const ack = setTimeout(() => {
        void ports.react?.(ports.db, {
          bridgeId: input.bridgeId, messageId: input.messageId, emoji: '⏳', idempotencyKey: `ack:${cmd.key}`,
        }).catch(() => undefined);
      }, ACK_AFTER_MS);
      let reply: Answer | null;
      try {
        reply = confirming ? await yes(cmd) : await dispatch(cmd, parsed);
      } catch (error) {
        if (error instanceof Refusal) reply = { text: error.message };
        else if (error instanceof CollabError && ANSWERABLE.has(error.code)) reply = { text: `couldn't do that: ${safeReason(error)}` };
        else {
          // Once per command (its own key), so the answer of a retry that then
          // succeeds still goes out under the command's key.
          await answer(cmd, { text: 'that hit a problem on our side — retrying' }, ':fault').catch(() => undefined);
          throw error;
        }
      } finally {
        clearTimeout(ack);
      }
      if (reply) await answer(cmd, reply);
    },

    async run(messageId: string): Promise<void> {
      try {
        if (!(await ports.claim(messageId))) {
          await tellFailed(messageId);
          return;
        }
      } catch (error) {
        ports.logger?.warn(`bridge command ${messageId}: claim failed: ${errorText(error)}`);
        return; // still pending: the sweep retries it.
      }
      // A fault goes back to pending: 398's claim retries it (the sweep) and
      // turns it failed after its attempts run out. A refusal is an answer: done.
      let outcome: 'done' | 'pending' = 'done';
      try {
        const input = await exec(q => q.rpc<BridgeCommandInput | null>('bridge_command_input', [messageId]));
        if (input && typeof input === 'object' && 'bridgeId' in input) await this.execute(input);
      } catch (error) {
        outcome = 'pending';
        ports.logger?.warn(`bridge command ${messageId} faulted, left for a retry: ${errorText(error)}`);
      }
      try {
        await ports.settle(messageId, outcome);
      } catch (error) {
        ports.logger?.warn(`bridge command ${messageId}: settle failed: ${errorText(error)}`);
      }
    },

    async sweep(): Promise<number> {
      const due = await exec(q => q.query<{ id: string }>('select id from public.bridge_commands_due($1) as id', [20]));
      for (const row of due) await this.run(row.id);
      return due.length;
    },
  };
}

/** Credential-shaped text (398's internal.bridge_text_looks_secret, mirrored): never quoted into a group. */
const SECRET_SHAPED = /(tm8[a-z]?_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
function looksSecret(text: string): boolean {
  return SECRET_SHAPED.test(text);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One short line, never a stack, an id dump or token-shaped text (§4.8 privacy). */
function safeReason(error: unknown): string {
  const text = errorText(error).split('\n')[0]!.replace(/[A-Za-z0-9_-]{32,}/g, '…').trim();
  return text.length > 120 ? `${text.slice(0, 119)}…` : text || 'unknown error';
}
