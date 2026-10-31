/**
 * Bridges S (BRIDGE-ENTITY-DESIGN §7.2 step S, D25, D73, D74): one rolling
 * summary per group chat.
 *
 * A group's conversation is stored on the bridge's log anchor; only routed
 * messages become turns on its chat. A turn on a bridged chat therefore gets
 * the log as ONE group-context record in its portable history
 * (`projectHistory`'s `groupContext`): the stored summary of everything older
 * than the unsummarized part, plus that part verbatim (at least the last
 * `TAIL_MESSAGES`). When the unsummarized part passes `REFRESH_MESSAGES` beyond
 * the tail or `REFRESH_BYTES`, the turn assembly folds it into the summary and
 * stores it (`bridge_chat_summaries`, migration 400), so the record stays
 * bounded however long the group runs.
 *
 * The fold is the LLD's phase-one deterministic extractive reducer
 * (chat-harness-continuity-lld §5): no model call, so a summary never depends
 * on a credential, and the same log always folds to the same summary. It keeps
 * the open asks (a question or request nobody else has answered in its
 * thread), who has been talking, and counts. Who is on what is read live from
 * tm8 — tasks with `authored_from → bridge` and their `assigned_to` — never
 * stored, so it is never stale. Bodies are untrusted group text: excerpts are
 * data, and nothing here turns one into an instruction.
 */
import { createHash } from 'node:crypto';
import type {
  BridgeChatSummaryClosedAsk, BridgeChatSummaryOnWhat, BridgeChatSummaryOpenAsk, BridgeChatSummaryParticipant,
  BridgeChatSummaryState, BridgeChatSummaryView,
} from '@tm8/contract';
import type { Db, DbClaims, Querier } from '../db/types.js';
import { actorOf, loadActors } from '../facade/entity-read.js';
import { canonicalJson } from '../chat/continuity.js';

export const SUMMARY_POLICY = 'tm8-bridge-summary-v1';
/** The newest log messages always carried verbatim. */
export const TAIL_MESSAGES = 20;
/** Fold once this many unsummarized messages sit beyond the tail … */
export const REFRESH_MESSAGES = 50;
/** … or the unsummarized part beyond the tail passes this many body bytes (the token threshold). */
export const REFRESH_BYTES = 16_384;
/** The group record's share of the turn's history budget. */
export const GROUP_CONTEXT_MAX_BYTES = 16_384;

const ASK_CAP = 40;
const PARTICIPANT_CAP = 50;
const CLOSED_CAP = 5;
const EXCERPT = 200;
const READ_BODY = 2_000;
const READ_PAGE = 500;

export interface LogMessage {
  readonly id: string;
  readonly createdAt: string;
  /** Who wrote it: the participant's external id for an inbound message, else the author entity. */
  readonly authorKey: string;
  readonly authorName: string;
  readonly body: string;
  readonly parentId: string | null;
  readonly rootId: string | null;
  readonly direction: 'in' | 'out' | null;
}
export type OpenAsk = BridgeChatSummaryOpenAsk;
export type ClosedAsk = BridgeChatSummaryClosedAsk;
export type Participant = BridgeChatSummaryParticipant;
export type SummaryState = BridgeChatSummaryState;
export type OnWhat = BridgeChatSummaryOnWhat;
export interface StoredSummary {
  readonly policyVersion: string;
  readonly throughMessageId: string | null;
  readonly coveredMessages: number;
  readonly state: SummaryState;
  readonly refreshedAt: string;
}
export interface GroupContextRecord {
  readonly sourceId: string;
  readonly content: Record<string, unknown>;
}

export const EMPTY_SUMMARY: SummaryState = {
  firstAt: null, lastAt: null, participants: [], openAsks: [], droppedAsks: 0, closedAsks: 0, recentlyClosed: [],
};

const ASK = new RegExp([
  String.raw`\?`,
  String.raw`\b(can|could|would|will) (you|someone|anyone|somebody|we|u)\b`,
  String.raw`\b(please|pls|plz)\b`,
  String.raw`\bneeds? (to|a|an|someone|help)\b`,
  String.raw`\bwho (can|will|is|has)\b`,
  String.raw`(^|[^\w])@tm8\b`,
  String.raw`\b(todo|action item)\b`,
].join('|'), 'i');
// A link's path and query carry `?`, `please-…` and the like; they say nothing about intent.
// Trailing punctuation stays with the sentence: `is it up at https://x.test?` still asks.
const LINK = /\b(?:(?:https?|ftp):\/\/|www\.)\S+?(?=[.,;:!?)]*(?:\s|$))/gi;
const SELF_CLOSE = /\b(done|fixed|resolved|sorted|never ?mind|nvm|no longer needed|thanks|thank you)\b/i;

/** A question or a request: what a group expects someone to answer. */
export function isAsk(body: string): boolean {
  return ASK.test(body.replace(LINK, ' '));
}

function excerpt(body: string, max: number): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Fold messages (oldest first) into the summary. Pure and deterministic.
 * An ask closes when someone other than its author replies in its thread, or
 * when its author says it is done there. Only inbound or tm8-side messages that
 * did not cross outward open asks: an outbound message is our own answer.
 */
export function foldSummary(state: SummaryState, messages: readonly LogMessage[]): SummaryState {
  const participants = new Map(state.participants.map(p => [p.key, p]));
  let open = [...state.openAsks];
  let { droppedAsks, closedAsks } = state;
  let closed = [...state.recentlyClosed];
  let { firstAt, lastAt } = state;
  for (const m of messages) {
    firstAt ??= m.createdAt;
    lastAt = m.createdAt;
    const known = participants.get(m.authorKey);
    participants.set(m.authorKey, { key: m.authorKey, name: m.authorName || known?.name || 'unknown',
      messages: (known?.messages ?? 0) + 1, lastAt: m.createdAt });
    const target = open.find(ask => ask.messageId === m.parentId || ask.messageId === m.rootId);
    if (target && (target.authorKey !== m.authorKey || SELF_CLOSE.test(m.body))) {
      open = open.filter(ask => ask !== target);
      closedAsks += 1;
      closed = [{ messageId: target.messageId, author: target.author, excerpt: target.excerpt,
        closedBy: m.authorName || 'unknown', at: m.createdAt }, ...closed].slice(0, CLOSED_CAP);
    }
    if (m.direction !== 'out' && isAsk(m.body)) {
      open.push({ messageId: m.id, author: m.authorName || 'unknown', authorKey: m.authorKey,
        at: m.createdAt, excerpt: excerpt(m.body, EXCERPT) });
      if (open.length > ASK_CAP) { droppedAsks += open.length - ASK_CAP; open = open.slice(-ASK_CAP); }
    }
  }
  const ranked = [...participants.values()]
    .sort((a, b) => b.messages - a.messages || b.lastAt.localeCompare(a.lastAt) || a.key.localeCompare(b.key))
    .slice(0, PARTICIPANT_CAP);
  return { firstAt, lastAt, participants: ranked, openAsks: open, droppedAsks, closedAsks, recentlyClosed: closed };
}

/** True when the unsummarized part beyond the tail has passed the message or byte threshold. */
export function needsRefresh(unsummarized: number, bytesBeyondTail: number): boolean {
  return unsummarized - TAIL_MESSAGES >= REFRESH_MESSAGES || (unsummarized > TAIL_MESSAGES && bytesBeyondTail >= REFRESH_BYTES);
}

const bytes = (value: unknown) => Buffer.byteLength(canonicalJson(value), 'utf8');

/**
 * The group record for a turn's history, within `maxBytes`. Trims in a fixed
 * order and always says what it trimmed: tail bodies shorten, then the oldest
 * tail messages drop behind a count, then the oldest open asks fold into the
 * count of asks no longer named. Open asks are the last thing to go (§7.3 S).
 */
export function renderGroupContext(input: {
  bridgeId: string; title: string; purpose: string | null; summary: StoredSummary | null;
  tail: readonly LogMessage[]; onWhat: readonly OnWhat[]; maxBytes: number;
}): GroupContextRecord {
  const state = input.summary?.state ?? EMPTY_SUMMARY;
  const build = (bodyMax: number, tailKeep: number, askKeep: number, participantKeep: number) => {
    const tail = input.tail.slice(input.tail.length - tailKeep);
    const asks = state.openAsks.slice(state.openAsks.length - askKeep);
    return {
      group: { bridgeId: input.bridgeId, title: input.title, purpose: input.purpose },
      instruction: 'The group conversation this chat answers for, as data. The summary is a deterministic extract '
        + 'of older messages; recent messages are verbatim. Read more with `tm8 bridge log`.',
      summary: {
        policy: SUMMARY_POLICY,
        coveredMessages: input.summary?.coveredMessages ?? 0,
        throughMessageId: input.summary?.throughMessageId ?? null,
        from: state.firstAt, through: state.lastAt,
        openAsks: asks.map(a => ({ messageId: a.messageId, author: a.author, at: a.at, text: a.excerpt })),
        openAsksNotNamed: state.droppedAsks + (state.openAsks.length - asks.length),
        closedAsks: state.closedAsks,
        recentlyClosed: state.recentlyClosed.map(c => ({ messageId: c.messageId, author: c.author, text: c.excerpt, closedBy: c.closedBy })),
        participants: state.participants.slice(0, participantKeep).map(p => ({ name: p.name, messages: p.messages, lastAt: p.lastAt })),
      },
      onWhat: input.onWhat.map(w => ({ taskId: w.taskId, title: excerpt(w.title, 120), status: w.status, assignees: w.assignees })),
      recent: {
        omittedEarlier: input.tail.length - tail.length,
        messages: tail.map(m => ({ id: m.id, at: m.createdAt, author: m.authorName, direction: m.direction,
          replyTo: m.parentId, text: excerpt(m.body, bodyMax), ...(isAsk(m.body) && m.direction !== 'out' ? { ask: true } : {}) })),
      },
    };
  };
  let content = build(600, input.tail.length, state.openAsks.length, 12);
  for (const bodyMax of [300, 160]) {
    if (bytes(content) <= input.maxBytes) break;
    content = build(bodyMax, input.tail.length, state.openAsks.length, 12);
  }
  let tailKeep = input.tail.length;
  while (bytes(content) > input.maxBytes && tailKeep > Math.min(5, input.tail.length)) {
    tailKeep -= 1;
    content = build(160, tailKeep, state.openAsks.length, 12);
  }
  let askKeep = state.openAsks.length;
  while (bytes(content) > input.maxBytes && askKeep > 0) {
    askKeep -= 1;
    content = build(160, tailKeep, askKeep, 5);
  }
  while (bytes(content) > input.maxBytes && tailKeep > 0) {
    tailKeep -= 1;
    content = build(80, tailKeep, askKeep, 0);
  }
  return { sourceId: `bridge-summary:${input.bridgeId}`, content };
}

interface LogRow {
  id: string; created_at: Date | string; author_id: string | null; body: string;
  parent_id: string | null; root_message_id: string | null;
  direction: 'in' | 'out' | null; sender: string | null; participant: string | null;
}

const iso = (value: Date | string) => new Date(value).toISOString();

/**
 * The cursor: a log message id, and the stored summary's `through_created_at`
 * for when that message is no longer readable (deleted after the fold), so the
 * log after it stays reachable.
 */
interface Cursor { readonly id: string | null; readonly at: string | null }
const CURSOR_AFTER = `($2::uuid is null or (m.created_at, m.entity_id) >
             (coalesce((select m2.created_at from public.messages m2 where m2.entity_id = $2::uuid), $3::timestamptz), $2::uuid))`;

async function readLogAfter(q: Querier, anchorId: string, after: Cursor, limit: number): Promise<LogMessage[]> {
  const rows = await q.query<LogRow>(
    `select m.entity_id as id, m.created_at, m.author_id, left(m.body, ${READ_BODY}) as body, e.parent_id, m.root_message_id,
            o.direction, o.external_sender_id as sender,
            case when o.direction = 'in' then p.display_name end as participant
       from public.messages m
       join public.entities e on e.id = m.entity_id
       left join public.message_origins o on o.message_id = m.entity_id
       left join public.bridge_participants p on p.bridge_id = o.bridge_id and p.external_id = o.external_sender_id
      where m.anchor_id = $1 and e.deleted_at is null
        and ${CURSOR_AFTER}
      order by m.created_at, m.entity_id
      limit $4`, [anchorId, after.id, after.at, limit]);
  const actors = await loadActors(q, [...new Set(rows.flatMap(r => (r.author_id ? [r.author_id] : [])))]);
  return rows.map(r => ({
    id: r.id, createdAt: iso(r.created_at),
    authorKey: r.direction === 'in' && r.sender ? `ext:${r.sender}` : r.author_id ?? 'unknown',
    authorName: r.participant ?? (r.author_id ? actorOf(actors, r.author_id).displayName : '') ?? '',
    body: r.body, parentId: r.parent_id, rootId: r.root_message_id, direction: r.direction,
  }));
}

/** Who is on what: open work this group asked for (`authored_from → bridge`), with its assignees. Live, never stored. */
export async function readOnWhat(q: Querier, bridgeId: string): Promise<OnWhat[]> {
  const rows = await q.query<{ id: string; title: string; work_status: string; assignees: string[] | null }>(
    `select t.entity_id as id, t.title, t.work_status,
            array(select a.dst_id::text from public.edges a
                   where a.src_id = t.entity_id and a.type = 'assigned_to' order by a.dst_id) as assignees
       from public.edges af
       join public.tasks t on t.entity_id = af.src_id
       join public.entities e on e.id = t.entity_id and e.deleted_at is null
      where af.dst_id = $1 and af.type = 'authored_from'
        and t.work_status in ('pulled', 'working', 'in_review', 'blocked')
      group by t.entity_id, t.title, t.work_status, t.updated_at
      order by t.updated_at desc, t.entity_id
      limit 15`, [bridgeId]);
  const actors = await loadActors(q, [...new Set(rows.flatMap(r => r.assignees ?? []))]);
  return rows.map(r => ({ taskId: r.id, title: r.title, status: r.work_status,
    assignees: (r.assignees ?? []).map(id => actorOf(actors, id).displayName) }));
}

interface BridgeRow { id: string; target_kind: string; title: string | null; purpose: string | null; anchor: string }
interface SummaryRow {
  policy_version: string; through_message_id: string | null; covered_messages: number;
  state: SummaryState; refreshed_at: Date | string; through_at: string | null;
}
type Stored = StoredSummary & { readonly cursor: Cursor };
const START: Cursor = { id: null, at: null };

async function bridgeOf(q: Querier, where: 'chat' | 'bridge', id: string): Promise<BridgeRow | null> {
  const [row] = await q.query<BridgeRow>(
    `select b.entity_id as id, b.target_kind, b.conversation ->> 'title' as title, b.purpose,
            internal.bridge_log_anchor(b.entity_id::uuid) as anchor
       from public.bridges b
       join public.entities e on e.id = b.entity_id and e.deleted_at is null
      where ${where === 'chat' ? `b.target_id = $1 and b.target_kind = 'chat' and b.ended_at is null` : 'b.entity_id = $1'}`, [id]);
  return row ?? null;
}

async function storedSummary(q: Querier, bridgeId: string): Promise<Stored | null> {
  const [row] = await q.query<SummaryRow>(
    `select policy_version, through_message_id, covered_messages, state, refreshed_at,
            through_created_at::text as through_at
       from public.bridge_chat_summaries where bridge_id = $1`, [bridgeId]);
  // A summary folded under another policy is folded again from the start.
  if (!row || row.policy_version !== SUMMARY_POLICY) return null;
  return { policyVersion: row.policy_version, throughMessageId: row.through_message_id,
    coveredMessages: Number(row.covered_messages), state: row.state, refreshedAt: iso(row.refreshed_at),
    cursor: { id: row.through_message_id, at: row.through_at } };
}

async function unsummarizedCount(q: Querier, anchorId: string, after: Cursor): Promise<number> {
  const [row] = await q.query<{ n: number }>(
    `select count(*)::int as n from public.messages m join public.entities e on e.id = m.entity_id
      where m.anchor_id = $1 and e.deleted_at is null
        and ${CURSOR_AFTER}`, [anchorId, after.id, after.at]);
  return Number(row?.n ?? 0);
}

/**
 * The group record for a turn on `chatId`, or null when no live bridge targets
 * it. Folds and stores the summary first when the threshold is passed.
 */
export async function assembleGroupContext(q: Querier, chatId: string, maxBytes: number): Promise<GroupContextRecord | null> {
  const bridge = await bridgeOf(q, 'chat', chatId);
  if (!bridge) return null;
  const row = await storedSummary(q, bridge.id);
  let summary: StoredSummary | null = row;
  const stored = row?.cursor ?? START;
  const after = stored.id;
  const pending = await unsummarizedCount(q, bridge.anchor, stored);
  // The newest window is all a no-fold turn needs: tail + up to a threshold's worth.
  let unsummarized = await readLogAfter(q, bridge.anchor, stored, Math.min(pending, TAIL_MESSAGES + REFRESH_MESSAGES));
  const beyondTail = (list: readonly LogMessage[]) => list.slice(0, Math.max(0, list.length - TAIL_MESSAGES));
  const beyondBytes = beyondTail(unsummarized).reduce((n, m) => n + Buffer.byteLength(m.body, 'utf8'), 0);
  if (needsRefresh(pending, beyondBytes)) {
    // Fold everything but the tail, a page at a time, oldest first.
    let state = summary?.state ?? EMPTY_SUMMARY;
    let covered = summary?.coveredMessages ?? 0;
    let cursor = stored;
    let left = pending - TAIL_MESSAGES;
    const hash = createHash('sha256').update(`${SUMMARY_POLICY}\n${after ?? ''}\n${canonicalJson(state)}`);
    while (left > 0) {
      const page = await readLogAfter(q, bridge.anchor, cursor, Math.min(READ_PAGE, left));
      if (!page.length) break;
      state = foldSummary(state, page);
      for (const m of page) hash.update(`${m.id}\n`);
      covered += page.length;
      left -= page.length;
      cursor = { id: page.at(-1)!.id, at: null };
    }
    const won = await q.rpc<boolean>('public.store_bridge_chat_summary', [
      bridge.id, after, cursor.id, covered, SUMMARY_POLICY, JSON.stringify(state), hash.digest('hex')]);
    summary = { policyVersion: SUMMARY_POLICY, throughMessageId: cursor.id, coveredMessages: covered, state,
      refreshedAt: won ? new Date().toISOString() : summary?.refreshedAt ?? new Date().toISOString() };
    unsummarized = await readLogAfter(q, bridge.anchor, cursor, TAIL_MESSAGES + REFRESH_MESSAGES);
  }
  return renderGroupContext({ bridgeId: bridge.id, title: bridge.title ?? '', purpose: bridge.purpose,
    summary, tail: unsummarized, onWhat: await readOnWhat(q, bridge.id), maxBytes });
}

/** `assembleGroupContext` in its own transaction under the turn's claims. */
export function readGroupContext(db: Db, auth: DbClaims, chatId: string, maxBytes: number): Promise<GroupContextRecord | null> {
  return db.tx(auth, q => assembleGroupContext(q, chatId, maxBytes));
}

/** The summary as members see it on `bridges.get` (D74), or null for a target that keeps none. */
export async function readBridgeChatSummary(q: Querier, bridgeId: string): Promise<BridgeChatSummaryView | null> {
  const bridge = await bridgeOf(q, 'bridge', bridgeId);
  if (!bridge || bridge.target_kind !== 'chat') return null;
  const summary = await storedSummary(q, bridgeId);
  return {
    policyVersion: SUMMARY_POLICY,
    coveredMessages: summary?.coveredMessages ?? 0,
    throughMessageId: summary?.throughMessageId ?? null,
    refreshedAt: summary?.refreshedAt ?? null,
    unsummarizedMessages: await unsummarizedCount(q, bridge.anchor, summary?.cursor ?? START),
    state: summary?.state ?? EMPTY_SUMMARY,
    onWhat: await readOnWhat(q, bridgeId),
  };
}
