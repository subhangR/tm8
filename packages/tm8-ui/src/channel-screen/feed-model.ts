import type {
  ActorSummary,
  DeliverySummary,
  EntityId,
  EntitySummary,
  FeedItem,
  FeedVia,
  Mention,
  MessageDeliveryStatus,
} from '@tm8/contract';
import type { PillTone } from '../kit';

/**
 * THE PURE HALF OF THE T10 CHAT SURFACE — every value the canvas draws that is
 * DERIVED rather than read straight off a DTO.
 *
 * WHY IT IS A MODULE AND NOT INLINE JSX. The oracle writes several sentences in
 * copy ("via ×2", "1 of 2 delivered", "grouped by logical-operation key op_7f2e
 * — never by timestamps") whose honesty depends entirely on where the number
 * came from. Pulling them out here makes "did we invent this?" a decidable
 * question with a test beside it: if a value cannot be computed from a
 * `FeedItem` in this file, the component has no business rendering it.
 *
 * ORACLE: `T10 Chat Surface Hi-Fi.dc.html` (repo root, ` (1)` directory),
 * frames "Hero — Chat surface", "Provenance treatments", "Delivery and send
 * layers", S16, S19, S20.
 */

// ---------------------------------------------------------------------------
// Direction — the oracle's §5 margin rail (treatment 1a, the hero default)
// ---------------------------------------------------------------------------

/**
 * `inbound` — someone posted INTO this anchor; `outbound` — this anchor is the
 * author; `elsewhere` — the item lives on another anchor and surfaces here.
 *
 * A TONE, NOT A COLOUR. The oracle's own rule for this row: "Everything
 * left-aligned; direction carried by words. Colour and tint are secondary —
 * each treatment reads in monochrome." So the word is the fact and the tone
 * only tints it; a monochrome render loses nothing.
 */
export type DirectionTone = 'inbound' | 'outbound' | 'elsewhere';

export interface Direction {
  word: string;
  tone: DirectionTone;
}

/**
 * THE ONLY SOURCE IS `via` — the server's own ordering predicates, which the
 * oracle itself names in the tooltip it draws ("server-ordered via: authored ·
 * replies"). Nothing here reads an entity KIND, and nothing infers direction
 * from who the author happens to be.
 *
 * `anchorNoun` is the caller's word for the surface ("this channel", "this
 * session"). It is a PROP rather than a lookup because naming the anchor is
 * kind knowledge, and kind knowledge lives in the registry, never in a
 * component (§15.2 / D-ledger law 5).
 *
 * Returns `null` when no predicate decides it. The oracle's rail is itself
 * conditional (`sc-if value="{{f.dirT}}"`), so an absent direction is a state
 * the canvas draws — not a hole to be filled with a guess.
 */
export function directionOf(item: FeedItem, anchorId: EntityId, anchorNoun: string): Direction | null {
  const foreignAnchor = item.anchor && item.anchor.id !== anchorId ? item.anchor : null;
  if (foreignAnchor) return { word: `in ${foreignAnchor.title}`, tone: 'elsewhere' };
  if (item.via.includes('authored') || item.via.includes('subject')) {
    return { word: `from ${anchorNoun}`, tone: 'outbound' };
  }
  if (item.via.includes('anchored')) return { word: `to ${anchorNoun}`, tone: 'inbound' };
  if (item.via.includes('caused')) return { word: `caused by ${anchorNoun}`, tone: 'outbound' };
  return null;
}

/** The oracle's `via ×N` tooltip, verbatim (hero line 90). */
export function viaTitle(via: readonly FeedVia[]): string {
  return `server-ordered via: ${via.join(' · ')}`;
}

// ---------------------------------------------------------------------------
// Delivery — the §6 facet. A badge on the stored message, never its own row.
// ---------------------------------------------------------------------------

export interface DeliveryPresentation {
  label: string;
  tone: PillTone;
  /** Progress animates; outcomes do not. */
  pulse: boolean;
  tooltip: string;
}

/**
 * EIGHT STATUSES, EIGHT DRAWN STATES — the map is total over
 * `MessageDeliveryStatus`, and the exhaustive `Record` type is what makes a
 * ninth contract status a COMPILE error here rather than a blank badge on a
 * real screen.
 *
 * The two rulings the oracle states in prose and this table enforces:
 *
 *   · `unknown` is a WARNING, never success. "Bytes may or may not have been
 *     written." Identical in shape to R-UI-5's liveness 'unknown' — an absent
 *     verdict is not a negative one, and it is certainly not a positive one.
 *   · `delivered` claims the PTY WRITE and nothing beyond it. The oracle spells
 *     out the required tooltip because the tempting shorter word ("delivered")
 *     invites the reader to conclude the model READ it.
 */
const DELIVERY: Record<MessageDeliveryStatus, DeliveryPresentation> = {
  pending: {
    label: 'stored · waiting to send',
    tone: 'idle',
    pulse: false,
    tooltip: 'Durable in the graph, not sent. This is a neutral state, not a failure.',
  },
  dispatching: {
    label: 'sending to session',
    tone: 'info',
    pulse: true,
    tooltip: 'Progress only — receipt is never claimed while a delivery is in flight.',
  },
  delivered: {
    label: 'delivered ✓',
    tone: 'run',
    pulse: false,
    tooltip:
      'The governed PTY write completed — not that the model read or obeyed it.',
  },
  failed_retryable: {
    label: 'delivery failed · can send again',
    tone: 'block',
    pulse: false,
    tooltip:
      'Stored, not delivered. There is no automatic retry — Send again creates a deliberate new message.',
  },
  failed_permanent: {
    label: 'delivery failed',
    tone: 'block',
    pulse: false,
    tooltip: 'Stored, not delivered, and not retryable. The stored message remains.',
  },
  unknown: {
    label: 'delivery unknown ⚠',
    tone: 'wait',
    pulse: false,
    tooltip:
      'The outcome was never observed — the bytes may or may not have been written. Never read this as success.',
  },
  expired: {
    label: 'delivery expired',
    tone: 'idle',
    pulse: false,
    tooltip: 'The delivery window closed before it settled. The stored message remains.',
  },
  cancelled: {
    label: 'delivery cancelled',
    tone: 'idle',
    pulse: false,
    tooltip: 'The delivery was cancelled before it settled. The stored message remains.',
  },
};

export function deliveryPresentation(status: MessageDeliveryStatus): DeliveryPresentation {
  return DELIVERY[status];
}

/**
 * The S20 summary chip. `null` with no facets — a message nobody attempted to
 * deliver gets NO badge, because "0 of 0" would state a measurement that never
 * ran. (Compare: an empty feed IS a measurement and does get its own state.)
 */
export function deliverySummaryLine(rows: readonly DeliverySummary[]): string | null {
  if (rows.length === 0) return null;
  const done = rows.filter((r) => r.status === 'delivered').length;
  return `delivery · ${done} of ${rows.length} delivered`;
}

/**
 * Send again is offered on `failed_retryable` ALONE.
 *
 * Not on `failed_permanent`: the oracle files that under "Error, with details
 * where the viewer is authorized", and an affordance for a path that cannot
 * succeed is a worse lie than no affordance. Not while in flight, for the
 * obvious duplicate-send reason.
 *
 * And the verb is deliberately not "Retry": there is no delivery-only retry in
 * this product. Send again posts a NEW message with a new identity, which is
 * why the control routes through the composer's own dispatcher.
 */
export function canSendAgain(rows: readonly DeliverySummary[]): boolean {
  return rows.some((r) => r.status === 'failed_retryable');
}

const SAFE_DELIVERY_REASONS: Readonly<Record<string, string>> = {
  no_live_terminal: 'No live terminal was available',
  delivery_queue_refused: 'The live delivery queue refused the write',
  automated_wake_limit: 'The automated wake limit was reached',
  message_deleted: 'The message was redacted before delivery',
  session_not_live: 'The target session is no longer live',
  pending_ttl_expired: 'The delivery window expired before dispatch',
  restart_during_dispatch: 'Node restarted during delivery',
  write_attempt_failed: 'The write attempt ended without a safe delivery verdict',
  session_replaced_or_exited: 'The target session was replaced or exited during delivery',
  submit_unverified: 'The terminal submission could not be verified',
};

/**
 * Delivery reasons cross a transport boundary and may contain implementation
 * details. Only stable, server-owned reason codes are translated for display;
 * arbitrary strings are never echoed into the browser.
 */
export function safeDeliveryReason(reason: string | null): string | null {
  if (reason === null) return null;
  return SAFE_DELIVERY_REASONS[reason] ?? 'Details unavailable';
}

// ---------------------------------------------------------------------------
// Typed activity presentation — exact verb/field checks, never prose parsing.
// ---------------------------------------------------------------------------

export type ActivityPresentation =
  | { kind: 'entity-change'; entity: EntitySummary; verb: 'created' | 'updated' }
  | { kind: 'state'; label: string; from: string | null; to: string }
  | { kind: 'event'; label: string }
  | { kind: 'unknown' };

const EVENT_LABELS: Readonly<Record<string, string>> = {
  linked: 'Linked an entity',
  unlinked: 'Unlinked an entity',
  reacted: 'Changed a reaction',
  awarded: 'Awarded points',
};

function summaryString(summary: Record<string, unknown>, key: string): string | null {
  const value = summary[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function activityPresentation(
  item: Extract<FeedItem, { itemKind: 'activity' }>,
): ActivityPresentation {
  const { activity } = item;
  if ((activity.verb === 'created' || activity.verb === 'updated') && item.anchor) {
    return { kind: 'entity-change', entity: item.anchor, verb: activity.verb };
  }
  if (activity.verb === 'work.changed') {
    const status = summaryString(activity.summary, 'status');
    return status ? { kind: 'state', label: 'Work status', from: null, to: status } : { kind: 'unknown' };
  }
  if (activity.verb === 'moved') {
    const from = summaryString(activity.summary, 'fromParentId');
    const to = summaryString(activity.summary, 'toParentId') ?? 'top level';
    return { kind: 'state', label: 'Parent', from: from ?? 'top level', to };
  }
  const terminalState: Readonly<Record<string, string>> = {
    completed: 'Completed',
    deleted: 'Deleted',
    restored: 'Restored',
    joined: 'Joined',
    pulled: 'Pulled',
    'pr.linked': 'Pull request linked',
    unblocked: 'Unblocked',
  };
  const to = terminalState[activity.verb];
  if (to) return { kind: 'state', label: 'State', from: null, to };
  const label = EVENT_LABELS[activity.verb];
  if (label) return { kind: 'event', label };
  return { kind: 'unknown' };
}

// ---------------------------------------------------------------------------
// Grouping — S16. By the operation key, and by nothing else.
// ---------------------------------------------------------------------------

export type FeedGroup =
  | { kind: 'single'; item: FeedItem }
  | { kind: 'operation'; key: string; items: FeedItem[] };

/**
 * Collapse RUNS of consecutive activity that share a non-null
 * `logicalOperationId`.
 *
 * THE THREE REFUSALS, each stated by the oracle and each tested:
 *
 *   1. Never by timestamps. The oracle's tooltip says so in the product's own
 *      voice ("grouped by logical-operation key op_7f2e — never by timestamps
 *      alone"), and S16 closes it: "No key from the feed → separate honest
 *      rows." Two writes a second apart with no key are two facts.
 *   2. Never a message. A message is a thing a person or agent SAID; folding
 *      it into "3 records" would hide speech inside a machine summary.
 *   3. Never a group of one. A single keyed row is already the clearest
 *      statement of itself; wrapping it in an expander adds a click and no
 *      information.
 */
export function groupByOperation(items: readonly FeedItem[]): FeedGroup[] {
  const out: FeedGroup[] = [];
  let run: FeedItem[] = [];
  let key: string | null = null;

  const flush = (): void => {
    if (run.length > 1 && key) out.push({ kind: 'operation', key, items: run });
    else for (const item of run) out.push({ kind: 'single', item });
    run = [];
    key = null;
  };

  for (const item of items) {
    const groupable = item.itemKind === 'activity' && item.logicalOperationId !== null;
    if (groupable && item.logicalOperationId === key) {
      run.push(item);
      continue;
    }
    flush();
    if (groupable) {
      key = item.logicalOperationId;
      run = [item];
    } else {
      out.push({ kind: 'single', item });
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Small shared shapes
// ---------------------------------------------------------------------------

/** What the composer emits. The host adds `clientMutationId` and posts it. */
export interface ChannelPostInput {
  anchorIds: EntityId[];
  body: string;
  parentMessageId: EntityId | null;
  mentionIds?: EntityId[];
  attachmentIds?: EntityId[];
  /** Client-only Channel routing selections; the host resolves these to anchors. */
  tagTargetIds?: EntityId[];
}

/** A read that was refused, as a replacement state rather than an overlay. */
export interface ChannelRefusal {
  kind: 'forbidden' | 'not_found';
  message: string;
}

// ---------------------------------------------------------------------------
// Message bodies are MARKDOWN
// ---------------------------------------------------------------------------

/**
 * A message body is markdown and always was — agents post headings, tables and
 * fenced code, and the feed used to draw all of it as one plain paragraph of
 * literal asterisks and pipes. `chatMarkdownSource` prepares such a body for
 * `kit/Markdown`, and it does exactly two things to it.
 *
 * ONE — CANONICAL MENTIONS BECOME LINKS. A mention has to survive as a
 * CONTROL, not as text, so each `@display` token that the message's own
 * mention list vouches for is rewritten to a markdown link carrying the entity
 * id. `FeedRow`'s `a` override turns those back into buttons; every other link
 * is left to the kit. Matching is exact-token against this message's own list
 * — nothing in the body is guessed at — and a token inside a fenced block is
 * left alone, because in a code block an `@name` is code.
 *
 * TWO — A NEWLINE IS A LINE BREAK. Chat is written with Enter, not with
 * markdown's two-space hard break, so a lone newline that CommonMark would
 * fold into a space would silently reflow every message anyone has already
 * posted. Non-empty prose lines therefore end in a hard break. Fenced blocks
 * keep their bytes: their whitespace is content.
 */
export function chatMarkdownSource(
  body: string,
  mentions: readonly Mention[],
): { source: string; inlined: ReadonlySet<string> } {
  const inlined = new Set<string>();
  const out: string[] = [];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    const linked = linkMentions(line, mentions, inlined).trimEnd();
    out.push(linked === '' ? '' : `${linked}  `);
  }
  return { source: out.join('\n'), inlined };
}

/** The key both halves of the mention split agree on. */
export function mentionKey(mention: Mention): string {
  return `${mention.kind}:${mention.entityId}`;
}

const MENTION_HREF_PREFIX = '#tm8-mention-';

/**
 * The entity a rendered link names, or `null` if it names none.
 *
 * A body can legally contain a hand-written `[x](#tm8-mention-…)`, so the
 * caller checks the id against the message's OWN mention list before it draws
 * a control — the prefix proposes, the mention list decides.
 */
export function mentionIdInHref(href: string | undefined): EntityId | null {
  if (typeof href !== 'string' || !href.startsWith(MENTION_HREF_PREFIX)) return null;
  const id = href.slice(MENTION_HREF_PREFIX.length);
  return id === '' ? null : (id as EntityId);
}

function linkMentions(line: string, mentions: readonly Mention[], inlined: Set<string>): string {
  type Match = { start: number; end: number; mention: Mention };
  const candidates: Match[] = [];
  for (const mention of mentions) {
    const token = `@${mention.display}`;
    for (let at = line.indexOf(token); at !== -1; at = line.indexOf(token, at + token.length)) {
      candidates.push({ start: at, end: at + token.length, mention });
    }
  }
  if (candidates.length === 0) return line;
  // Earliest first; on a tie the longer token wins so "@Haiku 4.5" beats "@Haiku".
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let from = 0;
  for (const match of candidates) {
    if (match.start < from) continue;
    out += line.slice(from, match.start);
    out += `[@${escapeInlineMarkdown(match.mention.display)}](${MENTION_HREF_PREFIX}${match.mention.entityId})`;
    inlined.add(mentionKey(match.mention));
    from = match.end;
  }
  return out + line.slice(from);
}

/** A display name is a NAME, never markup — `a_b_c` must not come out italic. */
function escapeInlineMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, '\\$1');
}

/**
 * The facepile's caption: first two participants by name, the rest counted.
 * Participants arrive ordered by FIRST reply (the server promises the order),
 * so the caption is as stable as the branch it describes.
 */
export function participantNames(actors: readonly ActorSummary[]): string {
  const names = actors.map((actor) => actor.displayName).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length <= 2) return names.join(', ');
  return `${names[0]}, ${names[1]} +${names.length - 2}`;
}

/**
 * The rail clock and the assistive full stamp both come from `kit/time` — this
 * file used to own three private date formatters and said so in its own
 * comment ("flagged, not solved"). They are solved: `clockTime` is re-exported
 * unchanged for the callers that mount it, and the relative form is `relTime`.
 */
export { absTime as accessibleDateTime, clockTime } from '../kit/time';
