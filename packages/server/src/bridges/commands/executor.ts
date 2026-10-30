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
 * and settles `done`; a fault answers "couldn't" and settles `failed`.
 */
import { CollabError } from '@tm8/contract';
import type { Db, DbClaims, Querier } from '../../db/types.js';
import {
  isConfirmText, parseBridgeCommand, parseDuration, parseWorkItems, parseWorkerRef, stripTail, titleOf,
  type BridgeVerb, type ParsedBridgeCommand, type WorkItem, type WorkerRef,
} from './parse.js';
import type {
  BridgeCommandDetectContext, BridgeCommandHook, BridgeCommandInput, BridgeCommandOrigin, BridgeCommandPorts,
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
  work: 'linked', task: 'linked', stop: 'linked',
  who: 'reader', bridge: 'everyone',
  mute: 'admin', unmute: 'admin', new: 'admin',
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

/** A reply, plus a confirm to open on the notice it becomes. */
interface Answer { text: string; confirm?: StoredConfirm }

/** What a confirm stores, to run on YES (§4.6). Intent, never an approval (D9). */
interface StoredConfirm { verb: 'work' | 'stop'; args: string; body: string[]; externalMessageId: string; messageId: string }

interface ListRow {
  id: string; kind: string; title: string; status: string | null; created_at: Date | string;
  created_by: string; handle: string | null; origins: Array<{ sender?: { memberId?: string }; command?: string | null }>;
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

export interface BridgeCommandExecutor extends BridgeCommandHook {
  /** One command, loaded; run() is claim + load + this + settle. */
  execute(input: BridgeCommandInput): Promise<void>;
  /** Exposed for tests: the in-memory per-sender lists and rate windows. */
  reset(): void;
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
    if (cmd.sender.reader && (t === '' || t.startsWith('work') || t.startsWith('task') || t.startsWith('doc'))) {
      lines.push('/workers [all] · /status <worker> — what is running');
      lines.push('/tasks [open] · /docs [artifacts|drawings] — what this group made');
    }
    if (cmd.sender.admin && (t === '' || t.startsWith('admin') || t.startsWith('mute'))) {
      lines.push('/mute 1h · /unmute — hold tm8\'s posts here; commands keep working');
    }
    lines.push('/whoami · /bridge — who you are, where this group goes');
    if (!cmd.sender.memberId) lines.push(GUEST_FIRST);
    return { text: lines.slice(0, 9).join('\n') };
  }

  function whoami(cmd: Command): Answer {
    const s = cmd.sender;
    if (!s.memberId) return { text: `you're a guest here — ${GUEST_FIRST.replace(/\. \/whoami to check$/, '')}` };
    const how = s.trust === 'linked' ? 'linked ✓' : 'asserted by an admin';
    const can = s.admin ? 'you can start and stop any worker' : 'you can start workers';
    return { text: `you are ${s.displayName || 'a member'} (${how}) in ${cmd.bridge.title || 'this group'} — ${can}` };
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
    if (!id) throw new Refusal('this bridge has no worker teammate: set one on the bridge in tm8, or add teammate:<name>');
    return id;
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
    const items = parsed.items;
    if (items.length > MAX_WORKERS_PER_COMMAND) {
      throw new Refusal(`${items.length} items is over this bridge's limit of ${MAX_WORKERS_PER_COMMAND} workers per command — nothing started`);
    }
    const live = (await provenance(cmd, ['work_session'], 200)).filter(r => LIVE_SESSION.has(r.status ?? '')).length;
    if (live + items.length > MAX_LIVE_WORKERS_PER_BRIDGE) {
      throw new Refusal(`${live} workers are running from this group; ${items.length} more is over the limit of ${MAX_LIVE_WORKERS_PER_BRIDGE} — nothing started`);
    }
    // Resolve every option before creating anything: a bad name refuses the whole command.
    const teammates = await Promise.all(items.map(item => resolveTeammate(cmd, claims, item.options.teammate)));
    const projects = await Promise.all(items.map(item => resolveProject(cmd, claims, item.options.project)));
    if (items.length > CONFIRM_WORK_OVER && !confirmed) {
      return {
        text: [`start ${items.length} workers?`, ...items.map((item, i) => `${i + 1} ${titleOf(item.text, 60)}`), 'reply YES within 2 min'].join('\n'),
        confirm: { verb: 'work', args, body, externalMessageId: cmd.input.externalMessageId, messageId: cmd.input.messageId },
      };
    }

    // One transaction for every task (§4.8 partial failure: refused whole).
    const origin = cmd.origin('/work');
    const { taskIds } = await ports.db.tx(claims, async q => {
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
    return { text: [head, ...lines, 'Reply to a line, or @handle, to ask one directly. /workers to check.'].join('\n') };
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

  async function stop(cmd: Command, args: string, confirmed: boolean): Promise<Answer> {
    const claims = requireLinked(cmd);
    const ref = parseWorkerRef(args);
    if (!ref) throw new Refusal('usage: /stop <worker>, /stop mine or /stop all');
    let targets: ListRow[];
    if (ref.kind === 'all' || ref.kind === 'mine') {
      if (ref.kind === 'all') requireAdminTier(cmd);
      targets = (await provenance(cmd, ['work_session']))
        .filter(r => LIVE_SESSION.has(r.status ?? ''))
        .filter(r => ref.kind === 'all' || mine(cmd, r));
      if (targets.length === 0) return { text: 'no workers to stop' };
      if (!confirmed) {
        return {
          text: `stop ${targets.length} worker${targets.length === 1 ? '' : 's'}? reply YES within 2 min`,
          confirm: { verb: 'stop', args, body: [], externalMessageId: cmd.input.externalMessageId, messageId: cmd.input.messageId },
        };
      }
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
      if (!LIVE_SESSION.has(row.status ?? '')) return { text: `${named(row)} already ${sessionWord(row.status)}` };
      targets = [row];
    }
    const by = cmd.sender.displayName || 'a member';
    const reason = `stopped from ${PROVIDER_NAMES[cmd.bridge.provider] ?? cmd.bridge.provider} by ${by}`;
    const stopped: string[] = [];
    const failed: string[] = [];
    for (const row of targets) {
      try {
        await ports.stopWorker(claims, row.id, { reason, clientMutationId: `${cmd.key}:stop:${row.id}` });
        const t = await workerTask(cmd, row.id);
        if (t && OPEN_TASK.has(t.status) && t.status !== 'blocked') {
          // set_work_state keeps a note only on the caller's own working_on
          // claim, and the stopper is not working on the task; so the reason
          // is posted on the task, as the stopper, beside the transition.
          await ports.db.rpc(claims, 'set_work_state', [t.id, 'blocked', null, null, null, `${cmd.key}:block:${t.id}`, false, false]);
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

  async function yes(cmd: Command): Promise<Answer | null> {
    const stored = await exec(q => q.rpc<StoredConfirm | null>('bridge_command_confirm_take', [
      cmd.input.bridgeId, cmd.input.senderExternalId, cmd.input.replyTo?.externalMessageId ?? null,
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
      case 'link': return { text: 'linking a number by code isn\'t available yet — ask a space admin in tm8 to link it' };
      case 'task': return task(cmd, parsed.args);
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
      // Retarget is human-only by design (D28): an admin does it in tm8.
      case 'new': return { text: 'starting a fresh chat for this group is done in tm8: open the bridge → Retarget' };
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

  async function answer(cmd: Command, reply: Answer): Promise<void> {
    const notice = await ports.postNotice(ports.db, {
      bridgeId: cmd.input.bridgeId,
      text: reply.text,
      replyToMessageId: cmd.input.messageId,
      idempotencyKey: `cmd:${cmd.input.bridgeId}:${cmd.input.externalMessageId}`,
    });
    if (reply.confirm) {
      await exec(q => q.rpc('bridge_command_confirm_open', [
        notice.messageId, cmd.input.bridgeId, cmd.input.senderExternalId, JSON.stringify(reply.confirm),
      ]));
    }
  }

  return {
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
          await answer(cmd, { text: 'that didn\'t work on our side — try again in a minute' }).catch(() => undefined);
          throw error;
        }
      } finally {
        clearTimeout(ack);
      }
      if (reply) await answer(cmd, reply);
    },

    async run(messageId: string): Promise<void> {
      try {
        if (!(await ports.claim(messageId))) return;
      } catch (error) {
        ports.logger?.warn(`bridge command ${messageId}: claim failed: ${errorText(error)}`);
        return; // still pending: the sweep retries it.
      }
      let outcome: 'done' | 'failed' = 'done';
      try {
        const input = await exec(q => q.rpc<BridgeCommandInput | null>('bridge_command_input', [messageId]));
        if (input && typeof input === 'object' && 'bridgeId' in input) await this.execute(input);
      } catch (error) {
        outcome = 'failed';
        ports.logger?.warn(`bridge command ${messageId} failed: ${errorText(error)}`);
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One short line, never a stack, an id dump or token-shaped text (§4.8 privacy). */
function safeReason(error: unknown): string {
  const text = errorText(error).split('\n')[0]!.replace(/[A-Za-z0-9_-]{32,}/g, '…').trim();
  return text.length > 120 ? `${text.slice(0, 119)}…` : text || 'unknown error';
}
