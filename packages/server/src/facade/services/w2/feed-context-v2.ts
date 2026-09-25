/**
 * `entities.context` v2 — `tm8.entity-context.v2` (Module 2, step S3a).
 *
 * Specs: c761 (doc 01a0cf33, the shape: §3–6) and c904 (doc 01a0cf2e, the
 * budget: §2.2–2.3, 2.6–2.10). Reachable only with `schema=v2` until the
 * rollout step (S5) flips the default; v1 in `feed-context.ts` is untouched.
 *
 * THREE RULES shape this file.
 *
 * 1. SELECT BEFORE LOAD (c904 §2.6, c761 §7). `v2LoadPlan` decides, from the
 *    root's kind and the requested sections, which loaders run. A section left
 *    in `notLoaded[]` issues NO statement: not a query-then-drop. Every
 *    statement is tagged `/* entities.context:<tag> *\/` so the shared suite's
 *    counter proves it. The v2 default never loads actions, activity, or any
 *    connection beyond blockers, gate PRs and a session's `working_on` tasks.
 *
 * 2. LEAN ROWS. v1 builds every ref as a full `EntitySummary` (actors,
 *    relations, reactions, badges: 6–9 statements a list). A v2 ref is
 *    `{id,kind,title,status}`, so each list is ONE statement over the detail
 *    tables that carry a title or a status, and nothing else. No count query
 *    anywhere: `more` comes from fetching one row past the limit, under RLS, so
 *    a row the caller cannot see is never counted (c761 §6 "hidden rows").
 *
 * 3. NEVER SILENT. A list loader that fails is reported in `errors[]` (behind a
 *    savepoint, so the rest of the read survives it); the root, the body and
 *    acceptance ride the root statement and fail the whole read. Every trimmed
 *    list says so in `omitted[]`; a section not loaded says so in `notLoaded[]`.
 *
 * THE BODY (M2/S4, c904 §2.4–2.5). A body over the ceiling arrives
 * `complete:false` with `offset` and an `expand` that names the next page:
 * `--sections assignment --offset <N>`, N in UTF-8 bytes, filled in by the
 * server. A core that cannot fit the caller's `totalBytes` is refused with 422
 * `context_budget_too_small`, never cut: the caller's budget buys rows, not body.
 *
 * SECTION PAGES (M2/S3b). Every `omitted[]` entry carries the exact expand
 * that continues it: `--sections X --cursor <c>` for children (hierarchy),
 * blockers, messages and connections, and `--sections connections
 * --edge-type working_on` for a session's tasks. The cursor is context-owned
 * (see `sectionFingerprint`) and is checked before any statement runs.
 *
 * THE ACTIONS EXPAND (c904 Q12: never advertise an expand whose consumer is
 * missing) is advertised only in its bounded form, `tm8 action list --for
 * <id>` over PR #669's pages; `ADVERTISE_ACTIONS_EXPAND` gates it.
 */
import { createHash } from 'node:crypto';

import {
  CollabError,
  SELECTION_HEADER_KINDS,
  decodeCursor,
  encodeCursor,
  type EntityContextAssignee,
  type EntityHeaderReadMode,
  type EntityContextAssignment,
  type EntityContextBlocker,
  type EntityContextConnection,
  type EntityContextError,
  type EntityContextExpandOp,
  type EntityContextGate,
  type EntityContextMessage,
  type EntityContextNotLoaded,
  type EntityContextOmitted,
  type EntityContextRef,
  type EntityContextV2View,
  type EntityHeaderView,
} from '@tm8/contract';

import type { Querier } from '../../../db/types.js';
import { resolveAuthoredHeaderView, resolveHeaderViews } from '../../../headers/resolve.js';
import { ENTITY_COLUMNS, ENTITY_FROM, MICROS, iso, isoOrNull, titleOf, type EntityRow } from '../../entity-read.js';
import { taggedQuerier, type ContextLoadTag } from './context-tags.js';

// ---------------------------------------------------------------------------
// Constants (c761 §3.2–3.3, c904 §2.2–2.8)
// ---------------------------------------------------------------------------

export const V2_SCHEMA_VERSION = 'tm8.entity-context.v2' as const;
/** c904 §2.5: the default `--total-bytes`, and the base of the body ceiling. */
export const V2_DEFAULT_TOTAL_BYTES = 16_384;
/** c904 §2.5: the top of the `--total-bytes` range. */
const V2_MAX_TOTAL_BYTES = 32_768;
/** Ref titles and message `from`: code points, the ellipsis included (Q28/Q28b). */
const TITLE_CAP = 80;
const FROM_CAP = 80;
/** children, blockers, connections, session tasks, gate PRs (c761 §3.3). */
const ROW_LIMIT = 10;
/** c761 §3.2: task/doc/project keep 3 at 280; chat and session keep 10 at 500, as core. */
const TRIMMABLE_MESSAGES = { limit: 3, cap: 280, core: false } as const;
const CORE_MESSAGES = { limit: 10, cap: 500, core: true } as const;
/** c761 Q9 / c904 §2.3: a cut doc's outline is about 1 KB. */
const OUTLINE_MAX_BYTES = 1024;
const ELLIPSIS = '…';

/**
 * The actions expand is advertised only in its bounded form (c904 §2.8 ruling
 * 3): `action list` pages since PR #669. The CLI string is bounded because an
 * agent or human `tm8 action list` asks for `tm8.actions.v2` pages by default;
 * the wire `expandOp` is bounded because it names `schema: 'v2'` itself —
 * `actions.list` with no schema is still the unpaged v1 inventory (M2/S5).
 */
export const ADVERTISE_ACTIONS_EXPAND = true;

const HEADER_KINDS: ReadonlySet<string> = new Set(SELECTION_HEADER_KINDS);

/** The v2 section names; `summary` is accepted as an alias of `assignment`. */
export type V2Section = 'assignment' | 'hierarchy' | 'blockers' | 'connections' | 'messages' | 'actions';

/** `null` = the per-kind default read; a set = exactly those sections (c904 §2.10). */
export function parseV2Sections(raw: readonly string[] | undefined): Set<V2Section> | null {
  if (raw === undefined) return null;
  return new Set(raw.map((section) => (section === 'summary' ? 'assignment' : section) as V2Section));
}

/** Which v2 sections exist for a kind, in the order `notLoaded[]` lists them. */
function sectionsFor(kind: string): readonly V2Section[] {
  switch (kind) {
    case 'task': return ['assignment', 'hierarchy', 'blockers', 'connections', 'messages', 'actions'];
    case 'doc': return ['assignment', 'hierarchy', 'connections', 'messages', 'actions'];
    // c761 §3.2: a message is its body and its refs; no thread expansion.
    case 'message': return ['assignment', 'connections', 'actions'];
    default: return ['hierarchy', 'connections', 'messages', 'actions'];
  }
}

// ---------------------------------------------------------------------------
// The v2 load plan — the ContextLoadPlan seam, for v2
// ---------------------------------------------------------------------------

interface MessagePlan { readonly limit: number; readonly cap: number; readonly core: boolean }

/**
 * Which loaders a v2 read runs. Decided once, from the root's kind and the
 * requested sections, before any list loader issues a statement — the v2 twin
 * of `v1LoadPlan` (S2's seam). `actions` and `activity` are not fields because
 * v2 never loads them: actions are `tm8 action list`, activity is dropped from
 * v2 (c761 Q22).
 */
export interface ContextV2LoadPlan {
  /** `false`: the per-kind default (full core). `true`: header + the named sections (§2.10). */
  readonly explicit: boolean;
  /** Body + acceptance (+ outline). No statement of its own: it rides the root row. */
  readonly assignment: boolean;
  /**
   * The selection header, on the default read of a kind that resolves one
   * (`SELECTION_HEADER_KINDS`), shown when authored. Core: it is how a reader
   * decides whether the body is worth loading, and its `version` is what a
   * header write takes.
   */
  readonly header: boolean;
  readonly parent: boolean;
  readonly assignees: boolean;
  readonly gate: boolean;
  readonly blockers: boolean;
  readonly children: boolean;
  /** work_session: `tasks[]` from `working_on`, and the persona's name. */
  readonly sessionCard: boolean;
  /** message: anchor and parent-message refs, attachment sizes. */
  readonly messageCard: boolean;
  readonly messages: MessagePlan | null;
  readonly connections: boolean;
  /** Sections not loaded, each advertised with its expand. */
  readonly notLoaded: readonly V2Section[];
}

export function v2LoadPlan(
  kind: string,
  requested: ReadonlySet<V2Section> | null,
  after: ContextV2After | null = null,
): ContextV2LoadPlan {
  const available = sectionsFor(kind);
  const messagePlan: MessagePlan = kind === 'chat' || kind === 'work_session' ? CORE_MESSAGES : TRIMMABLE_MESSAGES;
  const isTask = kind === 'task';

  if (requested === null) {
    // The per-kind default (c761 §3.2): the core, plus the kind's default lists.
    const loaded = new Set<V2Section>();
    if (available.includes('assignment')) loaded.add('assignment');
    if (isTask) {
      loaded.add('hierarchy');
      loaded.add('blockers');
    }
    if (kind !== 'message') loaded.add('messages');
    return {
      explicit: false,
      assignment: loaded.has('assignment'),
      header: HEADER_KINDS.has(kind),
      parent: kind !== 'message',
      assignees: isTask,
      gate: isTask,
      blockers: isTask,
      children: isTask,
      sessionCard: kind === 'work_session',
      messageCard: kind === 'message',
      messages: loaded.has('messages') ? messagePlan : null,
      connections: false,
      notLoaded: available.filter((section) => !loaded.has(section)),
    };
  }

  const has = (section: V2Section): boolean => requested.has(section) && available.includes(section);
  return {
    explicit: true,
    assignment: has('assignment'),
    header: false,
    // A `--cursor` page is the section's rows only (c761 §3.5): no parent ref.
    parent: has('hierarchy') && after === null,
    assignees: false,
    gate: false,
    blockers: has('blockers'),
    children: has('hierarchy'),
    sessionCard: false,
    messageCard: false,
    messages: has('messages') ? messagePlan : null,
    connections: has('connections'),
    // `actions` is always notLoaded: v2 never renders the palette itself.
    notLoaded: available.filter((section) => section === 'actions' || !has(section)),
  };
}

// ---------------------------------------------------------------------------
// Section cursors — context-owned, one section each (c761 §5, M2/S3b)
// ---------------------------------------------------------------------------

/** The sections a `--cursor` continues. */
export type V2PagedSection = 'hierarchy' | 'blockers' | 'connections' | 'messages';
const PAGED: readonly V2PagedSection[] = ['hierarchy', 'blockers', 'connections', 'messages'];

/**
 * Each paged section's order, exactly as its loader sorts. It is part of the
 * fingerprint, so a change to a loader's ORDER BY invalidates every cursor
 * minted under the old one instead of silently skipping or repeating rows.
 */
const ORDERS: Record<V2PagedSection, string> = {
  hierarchy: 'closed asc, updated_at desc, id desc',
  blockers: 'edge created_at asc, edge id asc',
  connections: 'edge created_at desc, edge id desc',
  messages: 'created_at desc, id desc',
};

/**
 * c761 §5: "the fingerprint binds entity, section, filter and order". A context
 * cursor is consumed ONLY by `entities.context` v2 for the same entity, section
 * and `--edge-type`; it is never an `entities.children` or
 * `entities.connections` token, whose row shape and order differ.
 */
function sectionFingerprint(entityId: string, section: V2PagedSection, filter: string | null): string {
  return createHash('sha256')
    .update(JSON.stringify({ operation: 'entities.context.v2', entityId, section, filter, order: ORDERS[section] }))
    .digest('hex');
}

/** The keyset a page resumes after: the last row of the previous page. */
export type ContextV2After =
  | { section: 'hierarchy'; closed: boolean; at: string; id: string }
  | { section: 'blockers' | 'connections' | 'messages'; at: string; id: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MICROS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * Decode and bind a context cursor BEFORE any statement runs, so a foreign,
 * cross-filter or malformed token fails the read as `invalid_cursor` instead
 * of reaching SQL as a cast error. The query schema already refuses a cursor
 * without exactly one paged section; this re-checks for direct callers.
 */
export function decodeV2Cursor(input: {
  id: string;
  sections: ReadonlySet<V2Section> | null;
  edgeType?: string | undefined;
  cursor?: string | undefined;
}): ContextV2After | null {
  if (input.cursor === undefined) return null;
  const only = input.sections?.size === 1 ? [...input.sections][0] : undefined;
  if (!only || !PAGED.includes(only as V2PagedSection)) {
    throw new CollabError(
      'invalid_input',
      'a context cursor continues exactly one paged section (hierarchy, blockers, connections or messages)',
    );
  }
  const section = only as V2PagedSection;
  const filter = section === 'connections' ? (input.edgeType ?? null) : null;
  const { k } = decodeCursor(input.cursor);
  const arity = section === 'hierarchy' ? 3 : 2;
  if (k.length !== arity + 1 || k[0] !== sectionFingerprint(input.id, section, filter)) {
    throw new CollabError('invalid_cursor', `cursor does not continue ${section} of this entity with this filter`);
  }
  const at = String(k.at(-2));
  const rowId = String(k.at(-1));
  if (!MICROS_RE.test(at) || !UUID_RE.test(rowId)) throw new CollabError('invalid_cursor', 'cursor keys are malformed');
  if (section === 'hierarchy') {
    if (k[1] !== 0 && k[1] !== 1) throw new CollabError('invalid_cursor', 'cursor keys are malformed');
    return { section, closed: k[1] === 1, at, id: rowId };
  }
  return { section, at, id: rowId };
}

/** The expand for one section page: `--cursor` present unless it is the first. */
function pageExpand(
  id: string,
  section: V2PagedSection,
  filter: string | null,
  keys: Array<string | number> | null,
): { expand: string; expandOp: EntityContextExpandOp } {
  const cursor = keys === null ? null : encodeCursor([sectionFingerprint(id, section, filter), ...keys]);
  return {
    expand: `tm8 entity context ${id} --sections ${section}`
      + (filter === null ? '' : ` --edge-type ${filter}`)
      + (cursor === null ? '' : ` --cursor ${cursor}`),
    expandOp: {
      operation: 'entities.context',
      params: {
        id,
        sections: [section],
        ...(filter === null ? {} : { edgeType: filter }),
        ...(cursor === null ? {} : { cursor }),
      },
    },
  };
}

/**
 * The `--sections messages` expand that continues an anchor's messages after
 * one message (its `created_at` in MICROS form, and its id) — the same cursor
 * this section's own pager mints, so `events.changes` `messagesNext` pages
 * exactly as a context read would.
 */
export function messagesSectionExpand(anchorId: string, atMicros: string, messageId: string): string {
  return pageExpand(anchorId, 'messages', null, [atMicros, messageId]).expand;
}

/**
 * The expand that continues a list after its first `kept` rows (in load
 * order). Built lazily so a budget trim (c904 §2.7) re-points it at the last
 * row it actually kept. `kept = 0` is the section's first page.
 */
type Pager = (kept: number) => { expand: string; expandOp: EntityContextExpandOp };

function pagerOf<R>(
  id: string,
  section: V2PagedSection,
  filter: string | null,
  rows: readonly R[],
  keysOf: (row: R) => Array<string | number>,
): Pager {
  return (kept) => pageExpand(id, section, filter, kept === 0 ? null : keysOf(rows[kept - 1]!));
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * Just enough of each detail table to name a ref and give its status. The
 * column names match `ENTITY_COLUMNS`, so `titleOf` reads these rows as-is;
 * a kind whose name column is not joined here falls back to `titleOf`'s own
 * default for it. Bodies are never selected (a doc ref would drag 40 KB).
 */
const REF_COLUMNS = `
  e.id, e.kind, e.deleted_at, e.status_category,
  t.title task_title, t.work_status,
  d.title doc_title,
  ws.title ws_title, ws.status ws_status,
  cht.title chat_title, cht.runtime_state chat_runtime_state,
  ppd.name ppd_name,
  ch.name channel_name, vc.name voice_channel_name,
  mem.display_name member_display_name, tm.name team_member_name,
  col.name collection_name, sk.name skill_name, sp.name spell_name, f.name file_name,
  lp.title loop_title, gr.title graph_title, drw.title drawing_title, ctr.title ctr_title,
  wt.branch wt_branch, art.name artifact_name,
  pr.title pr_title, pr.repo pr_repo, pr.number pr_number, pr.state pr_state,
  cm.sha commit_sha, left(cm.message, 200) commit_message,
  left(memo.statement, 200) memory_statement,
  left(msg.body, 400) message_body`;

const REF_FROM = `
  from public.entities e
  left join public.tasks t on t.entity_id = e.id
  left join public.documents d on d.entity_id = e.id
  left join public.work_sessions ws on ws.entity_id = e.id
  left join public.chats cht on cht.entity_id = e.id
  left join public.project_projection_details ppd on ppd.entity_id = e.id
  left join public.channels ch on ch.entity_id = e.id
  left join public.voice_channels vc on vc.entity_id = e.id
  left join public.members mem on mem.entity_id = e.id
  left join public.team_members tm on tm.entity_id = e.id
  left join public.collections col on col.entity_id = e.id
  left join public.skills sk on sk.entity_id = e.id
  left join public.spells sp on sp.entity_id = e.id
  left join public.files f on f.entity_id = e.id
  left join public.loops lp on lp.entity_id = e.id
  left join public.graphs gr on gr.entity_id = e.id
  left join public.drawings drw on drw.entity_id = e.id
  left join public.containers ctr on ctr.entity_id = e.id
  left join public.worktrees wt on wt.entity_id = e.id
  left join public.artifacts art on art.entity_id = e.id
  left join public.pull_requests pr on pr.entity_id = e.id
  left join public.commits cm on cm.entity_id = e.id
  left join public.memories memo on memo.entity_id = e.id
  left join public.messages msg on msg.entity_id = e.id`;

/** A `REF_COLUMNS` row: a sparse `EntityRow` that `titleOf` accepts. */
type RefRow = Pick<EntityRow, 'id' | 'kind' | 'deleted_at'> & Partial<EntityRow>;

/**
 * The caller's actor ids in this space: the acting actor, the caller's member
 * row, and — when the actor is a work session — the persona it runs as. `$2`
 * is the root's space. Used for `you:true` and `toMe:true`.
 */
const ME_CTE = `me(id) as (
    select internal.actor_id()
    union select internal.current_member_id($2::uuid)
    union select pe.src_id from public.edges pe
           where pe.type = 'participates_in' and pe.dst_id = internal.actor_id()
  )`;

/** A display name for an actor id: persona, member, session title. */
function actorNameSql(column: string, alias: string): { select: string; joins: string } {
  return {
    select: `coalesce(${alias}_tm.name, ${alias}_mem.display_name, ${alias}_persona.name, ${alias}_ws.title)`,
    joins: `
      left join public.team_members ${alias}_tm on ${alias}_tm.entity_id = ${column}
      left join public.members ${alias}_mem on ${alias}_mem.entity_id = ${column}
      left join public.work_sessions ${alias}_ws on ${alias}_ws.entity_id = ${column}
      left join lateral (
        select ptm.name from public.edges pe
          join public.team_members ptm on ptm.entity_id = pe.src_id
         where pe.type = 'participates_in' and pe.dst_id = ${column}
         order by pe.created_at desc limit 1
      ) ${alias}_persona on true`,
  };
}

// ---------------------------------------------------------------------------
// Text caps
// ---------------------------------------------------------------------------

/** At most `max` code points, the ellipsis included (coordinator ruling, #674). */
function capChars(value: string, max: number): { text: string; truncated: boolean } {
  const points = [...value];
  if (points.length <= max) return { text: value, truncated: false };
  return { text: points.slice(0, max - 1).join('') + ELLIPSIS, truncated: true };
}

const utf8Bytes = (value: string): number => Buffer.byteLength(value, 'utf8');
const jsonBytes = (value: unknown): number => utf8Bytes(JSON.stringify(value));

/**
 * The longest head of `value` that is at most `limit` UTF-8 bytes, cut on a
 * code point and, when one is near, just after a newline (c904 §2.4).
 */
function cutUtf8(value: string, limit: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= limit) return value;
  let end = Math.max(0, limit);
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  const newline = buffer.lastIndexOf(0x0a, end - 1);
  if (newline >= 0 && end - (newline + 1) <= 1024) end = newline + 1;
  return buffer.subarray(0, end).toString('utf8');
}

/** Bytes `value` occupies inside the minified DTO: escaped, without its quotes. */
const encodedBytes = (value: string): number => jsonBytes(value) - 2;

/**
 * The longest head of `value` whose ENCODED size is at most `limit`. The
 * budget is measured on the minified DTO, where a newline or a quote costs two
 * bytes, so a cut on raw bytes alone would overrun it by the escapes.
 */
function cutEncoded(value: string, limit: number): string {
  if (encodedBytes(value) <= limit) return value;
  // Binary search on the raw cut: `cutUtf8` is monotone in its limit, but it
  // snaps back to a line end, so an over-by-N step from the snapped text can
  // undershoot the correction and never converge (#697 stalled on escapes).
  let lo = 0;
  let hi = Math.min(Math.max(0, limit), utf8Bytes(value));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encodedBytes(cutUtf8(value, mid)) <= limit) lo = mid;
    else hi = mid - 1;
  }
  return cutUtf8(value, lo);
}

// ---------------------------------------------------------------------------
// Row → DTO
// ---------------------------------------------------------------------------

/** One status word per kind: the workflow status where a kind has one. */
function statusOf(row: Partial<EntityRow>): string {
  switch (row.kind) {
    case 'task': return row.work_status ?? 'open';
    case 'work_session': return row.ws_status ?? 'spawning';
    case 'pull_request': return row.pr_state ?? 'unknown';
    case 'chat': return row.chat_runtime_state ?? 'cold';
    default: return row.status_category ?? 'none';
  }
}

function refOf(row: RefRow): EntityContextRef {
  // `titleOf` renders a deleted row as a tombstone; a deleted ref keeps its
  // real title and says `deleted:true` instead (c761 Q15).
  const title = capChars(titleOf({ ...row, deleted_at: null } as EntityRow), TITLE_CAP);
  return {
    id: row.id,
    kind: row.kind,
    title: title.text,
    status: statusOf(row),
    ...(title.truncated ? { titleTruncated: true as const } : {}),
    ...(row.deleted_at ? { deleted: true as const } : {}),
  };
}

function blockerOf(row: RefRow): EntityContextBlocker {
  const ref = refOf(row) as Extract<EntityContextRef, { kind: string }>;
  return {
    id: ref.id,
    title: ref.title,
    status: ref.status,
    resolved: false,
    ...(ref.titleTruncated ? { titleTruncated: true as const } : {}),
    ...(ref.deleted ? { deleted: true as const } : {}),
  };
}

interface MessageRow {
  id: string;
  reply_to: string | null;
  body: string | null;
  redacted_at: Date | string | null;
  created_at: Date | string;
  author_name: string | null;
  to_me: boolean;
}

function messageOf(row: MessageRow, cap: number): EntityContextMessage {
  const from = capChars(row.author_name ?? 'unknown', FROM_CAP);
  const base = {
    id: row.id,
    from: from.text,
    ...(from.truncated ? { fromTruncated: true as const } : {}),
    at: iso(row.created_at),
  };
  // c761 Q15: a redacted message stays in the list as a stub, never silently gone.
  if (row.redacted_at) return { ...base, redacted: true };
  const text = capChars(row.body ?? '', cap);
  return {
    ...base,
    text: text.text,
    ...(text.truncated ? { truncated: true as const } : {}),
    ...(row.reply_to ? { replyTo: row.reply_to } : {}),
    ...(row.to_me ? { toMe: true as const } : {}),
  };
}

/** c761 Q9: `[{level,text,offset}]`, offsets in UTF-8 bytes, about 1 KB at most. */
function outlineOf(body: string): { outline: Array<{ level: number; text: string; offset: number }>; truncated: boolean } {
  const outline: Array<{ level: number; text: string; offset: number }> = [];
  let offset = 0;
  let truncated = false;
  for (const line of body.split('\n')) {
    const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      // A prefix, not an ellipsis: `offset` + the heading must read back as `text`.
      const entry = { level: heading[1]!.length, text: [...heading[2]!].slice(0, TITLE_CAP).join(''), offset };
      if (jsonBytes([...outline, entry]) > OUTLINE_MAX_BYTES) {
        truncated = true;
        break;
      }
      outline.push(entry);
    }
    offset += utf8Bytes(line) + 1;
  }
  return { outline, truncated };
}

function acceptanceOf(row: EntityRow): Array<{ id: string; done: boolean; text: string }> {
  const criteria = Array.isArray(row.acceptance_criteria) ? row.acceptance_criteria : [];
  return criteria.map((c) => ({ id: String(c?.id ?? ''), done: c?.done === true, text: String(c?.text ?? '') }));
}

/**
 * `acceptance` plus, while any criterion is unticked, its WRITE: the read name
 * (`acceptance`) is not the stored member (`acceptanceCriteria`), so the list
 * alone never told an agent how to tick one — measured live, it fell back to a
 * 29.5 KB `entity get` to find the key. The command is exact (c904 §2.8): the
 * unticked ids and the version this read saw, filled in.
 */
function acceptanceFields(root: EntityRow): Record<string, unknown> {
  const acceptance = acceptanceOf(root);
  const open = acceptance.filter((c) => !c.done).map((c) => c.id);
  if (open.length === 0) return { acceptance };
  const version = Number(root.version);
  return {
    acceptance,
    acceptanceWrite: {
      write: `tm8 task tick ${root.id} ${open.join(' ')} --expect-version ${version}`,
      writeOp: {
        operation: 'entities.commands.tick',
        params: { id: root.id, expectedVersion: version, criterionIds: open },
      },
    } satisfies EntityContextV2View['acceptanceWrite'],
  };
}

function bodyOf(row: EntityRow): string {
  switch (row.kind) {
    case 'task': return row.task_description ?? '';
    case 'doc': return row.doc_body ?? '';
    case 'message': return row.message_redacted_at ? '' : (row.message_body ?? '');
    default: return '';
  }
}

// ---------------------------------------------------------------------------
// Expands (c904 §2.8 — exact strings, no placeholders)
// ---------------------------------------------------------------------------

function sectionExpand(id: string, section: V2Section): { expand: string; expandOp: EntityContextExpandOp } {
  return {
    expand: `tm8 entity context ${id} --sections ${section}`,
    expandOp: { operation: 'entities.context', params: { id, sections: [section] } },
  };
}

function notLoadedEntry(id: string, section: V2Section): EntityContextNotLoaded {
  if (section === 'actions') {
    return ADVERTISE_ACTIONS_EXPAND
      ? {
          section,
          expand: `tm8 action list --for ${id}`,
          expandOp: { operation: 'actions.list', params: { contextEntityId: id, schema: 'v2' } },
        }
      : { section };
  }
  return { section, ...sectionExpand(id, section) };
}

function errorOf(section: string, error: unknown): EntityContextError {
  if (error instanceof CollabError) return { section, code: error.code, retry: error.retryable };
  return { section, code: 'upstream_unavailable', retry: true };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface Loaded {
  root: EntityRow;
  parent: EntityContextRef | null | undefined;
  header?: EntityHeaderView;
  assignees?: EntityContextAssignee[];
  gate?: EntityContextGate;
  blockers?: EntityContextBlocker[];
  children?: EntityContextRef[];
  teammate?: string | null;
  tasks?: EntityContextRef[];
  anchor?: EntityContextRef;
  parentMessage?: EntityContextRef | null;
  attachments?: Array<{ id: string; name: string; bytes: number | null }>;
  messages?: EntityContextMessage[];
  connections?: EntityContextConnection[];
  /** rowLimit trims, from fetching one row past the limit. */
  omitted: EntityContextOmitted[];
  /** `omitted[]` section → the expand that continues it after N kept rows. */
  pagers: Map<string, Pager>;
  errors: EntityContextError[];
  asOfSeq: number;
}

/**
 * Run one LIST loader behind a savepoint. A failure becomes an `errors[]`
 * entry and the read goes on (c761 Q17); without the savepoint the aborted
 * transaction would fail every statement after it. Core loaders do not come
 * through here: their failure fails the read, with its real code.
 */
async function listLoader<T>(
  q: Querier,
  tag: ContextLoadTag,
  section: string,
  errors: EntityContextError[],
  load: (tq: Querier) => Promise<T>,
): Promise<T | undefined> {
  const tq = taggedQuerier(q, tag);
  const savepoint = `entities_context_${tag}`;
  let open = false;
  try {
    await tq.query(`savepoint ${savepoint}`);
    open = true;
    const value = await load(tq);
    await tq.query(`release savepoint ${savepoint}`);
    return value;
  } catch (error) {
    if (open) await tq.query(`rollback to savepoint ${savepoint}`).catch(() => undefined);
    errors.push(errorOf(section, error));
    return undefined;
  }
}

/**
 * `rows` fetched as `limit + 1`: keep `limit`, and note `more` in `omitted[]`
 * with the expand that continues after the last kept row.
 */
function keep<T>(
  rows: readonly T[],
  limit: number,
  section: string,
  loaded: Pick<Loaded, 'omitted' | 'pagers'>,
  pager: Pager,
): T[] {
  loaded.pagers.set(section, pager);
  if (rows.length <= limit) return [...rows];
  loaded.omitted.push({ section, kept: limit, more: true, reason: 'rowLimit', ...pager(limit) });
  return rows.slice(0, limit);
}

async function loadRefs(q: Querier, ids: readonly string[]): Promise<Map<string, RefRow>> {
  if (ids.length === 0) return new Map();
  const rows = await q.query<RefRow>(
    `select ${REF_COLUMNS} ${REF_FROM} where e.id = any($1::uuid[])`,
    [[...new Set(ids)]],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

/** A ref the root NAMES: `{id, unreadable:true}` when RLS hides it (c761 Q16). */
function namedRef(refs: Map<string, RefRow>, id: string): EntityContextRef {
  const row = refs.get(id);
  return row ? refOf(row) : { id, unreadable: true };
}

interface V2Request {
  readonly sections: ReadonlySet<V2Section> | null;
  readonly edgeType: string | null;
  readonly after: ContextV2After | null;
  /** `resolved` (I9a): the native/derived header when none is authored, on any read but a cursor page. */
  readonly header: EntityHeaderReadMode;
}

async function loadV2(q: Querier, id: string, request: V2Request): Promise<{ loaded: Loaded; plan: ContextV2LoadPlan }> {
  const { after, edgeType } = request;
  // The root carries the body, acceptance and every per-kind scalar, so a
  // failure here — or on anything the core needs — fails the read (c761 Q17).
  const rootRows = await taggedQuerier(q, 'root').query<EntityRow>(
    `select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = $1`,
    [id],
  );
  const root = rootRows[0];
  // c761 Q15: a deleted root is not_found (no caller asks for deleted rows yet).
  if (!root || root.deleted_at) throw new CollabError('not_found', `no readable entity: ${id}`);
  // Edge types are a closed catalog: an unknown filter would read exactly like
  // "no such edges" (an empty page, rc 0), so a typo must fail here instead.
  if (edgeType !== null) {
    const types = await taggedQuerier(q, 'connections').query<{ type: string }>(
      'select type from public.edge_types order by type',
    );
    if (!types.some((t) => t.type === edgeType)) {
      throw new CollabError('invalid_input', `unknown edge type ${JSON.stringify(edgeType)}`, {
        details: { reason: 'unknown_edge_type', field: 'edgeType', validTypes: types.map((t) => t.type) },
      });
    }
  }

  const plan = v2LoadPlan(root.kind, request.sections, after);
  const omitted: EntityContextOmitted[] = [];
  const errors: EntityContextError[] = [];
  const loaded: Loaded = { root, parent: undefined, omitted, pagers: new Map(), errors, asOfSeq: 0 };

  if (plan.parent) {
    if (root.parent_id) {
      const refs = await loadRefs(taggedQuerier(q, 'parents'), [root.parent_id]);
      loaded.parent = namedRef(refs, root.parent_id);
    } else {
      loaded.parent = null;
    }
  }

  // `header=resolved` asks for the header by name, so it loads on an
  // explicit-sections read too — but never on a cursor page, which is one
  // section's rows and nothing else (c761 §3.5).
  const resolved = request.header === 'resolved' && HEADER_KINDS.has(root.kind) && after === null;
  if (plan.header || resolved) {
    // Core, like the root: a failure fails the read. Under the caller's RLS,
    // so a header is exactly as visible as its entity. By default only an
    // AUTHORED header is shown: a derived one restates the body this read
    // already carries (a task's is its own description), and an entity nobody
    // has written a header for reads byte-identical to before (headers design
    // §9.5). `resolved` opts into the fallback a launch reads, at version 0.
    loaded.header = resolved
      ? (await resolveHeaderViews(taggedQuerier(q, 'header'), root.space_id, [id])).get(id)
      : await resolveAuthoredHeaderView(taggedQuerier(q, 'header'), root.space_id, id);
  }

  if (plan.assignees) {
    const assignedBy = actorNameSql('g.assigned_by', 'by');
    const assignee = actorNameSql('g.dst_id', 'to');
    const rows = await taggedQuerier(q, 'assignees').query<{
      id: string; name: string | null; by_name: string | null; assigned_by: string | null;
      assigned_on: Date | string; you: boolean;
    }>(
      `with ${ME_CTE}
       select g.dst_id id, ${assignee.select} name, g.assigned_by, ${assignedBy.select} by_name,
              coalesce(g.assigned_at, g.created_at) assigned_on,
              g.dst_id in (select me.id from me where me.id is not null) you
         from public.edges g
         ${assignee.joins}
         ${assignedBy.joins}
        where g.src_id = $1 and g.type = 'assigned_to'
        order by g.created_at asc, g.dst_id asc`,
      [id, root.space_id],
    );
    loaded.assignees = rows.map((row) => ({
      id: row.id,
      name: capChars(row.name ?? 'unknown', FROM_CAP).text,
      ...(row.you ? { you: true as const } : {}),
      ...(row.assigned_by ? { by: capChars(row.by_name ?? 'unknown', FROM_CAP).text } : {}),
      at: iso(row.assigned_on),
    }));
  }

  if (plan.gate) {
    if (root.completion_gate === 'pr_merged') {
      // c761 Q13: one indexed read, gated tasks only. `tracks` is the edge the
      // gate itself evaluates (151_completion_gate_on_the_transition.sql).
      // LEFT joins: edges are space-visible, so a tracked PR the caller cannot
      // read still has its edge, and renders `{id, unreadable:true}` (c761 §6)
      // rather than vanishing into `prs:[]`. A readable non-PR target (a
      // tracked commit) is not a PR and is skipped in SQL, before the limit.
      // A failure is reported under `connections`: the gate is a core field,
      // not a section, and its expand is `--sections connections --edge-type
      // tracks` (c761 §5, "gate PRs beyond 10").
      const prs = await listLoader(q, 'gate', 'connections', errors, (tq) => tq.query<{
        id: string; readable: boolean; url: string | null; state: string | null; ci_status: string | null;
      }>(
        `select g.dst_id id, target.id is not null readable, pr.url, pr.state, pr.ci_status
           from public.edges g
           left join public.entities target on target.id = g.dst_id
           left join public.pull_requests pr on pr.entity_id = target.id
          where g.src_id = $1 and g.type = 'tracks'
            and (target.id is null or target.kind = 'pull_request')
          order by g.created_at asc, g.id asc
          limit ${ROW_LIMIT + 1}`,
        [id],
      ));
      if (prs) {
        loaded.gate = {
          kind: 'pr_merged',
          prs: prs.slice(0, ROW_LIMIT).map((pr) => (pr.readable
            ? { url: pr.url ?? '', state: pr.state ?? 'unknown', ci: pr.ci_status }
            : { id: pr.id, unreadable: true as const })),
          ...(prs.length > ROW_LIMIT ? { more: true as const } : {}),
        };
      }
    } else {
      loaded.gate = 'none';
    }
  }

  if (plan.blockers) {
    // c761 Q14: unresolved `depends_on` only, ONE filtered query. A target the
    // caller cannot read is dropped by RLS with no marker (c761 Q16).
    const page = after?.section === 'blockers' ? after : null;
    const rows = await listLoader(q, 'blockers', 'blockers', errors, (tq) => tq.query<RefRow & {
      edge_id: string; edge_key: string;
    }>(
      `select ${REF_COLUMNS}, g.id edge_id, ${MICROS('g.created_at')} edge_key ${REF_FROM}
         join public.edges g on g.dst_id = e.id and g.src_id = $1 and g.type = 'depends_on'
        where not internal.is_resolved(g.dst_id)
          ${page ? 'and (g.created_at, g.id) > ($2::timestamptz, $3::uuid)' : ''}
        order by g.created_at asc, g.id asc
        limit ${ROW_LIMIT + 1}`,
      page ? [id, page.at, page.id] : [id],
    ));
    if (rows) {
      loaded.blockers = keep(rows, ROW_LIMIT, 'blockers', loaded,
        pagerOf(id, 'blockers', null, rows, (row) => [row.edge_key, row.edge_id])).map(blockerOf);
    }
  }

  if (plan.children) {
    // c761 Q5: open children first, then most recently updated.
    const page = after?.section === 'hierarchy' ? after : null;
    const rows = await listLoader(q, 'children', 'children', errors, (tq) => tq.query<RefRow & {
      closed: boolean; updated_key: string;
    }>(
      `select c.* from (
         select ${REF_COLUMNS}, e.updated_at, ${MICROS('e.updated_at')} updated_key,
                coalesce(e.status_category in ('done', 'cancelled')
                         or t.work_status in ('done', 'cancelled'), false) closed
           ${REF_FROM}
          where e.parent_id = $1 and e.deleted_at is null
       ) c
       ${page ? `where c.closed > $2::boolean
                   or (c.closed = $2::boolean and (c.updated_at < $3::timestamptz
                       or (c.updated_at = $3::timestamptz and c.id < $4::uuid)))` : ''}
        order by c.closed asc, c.updated_at desc, c.id desc
        limit ${ROW_LIMIT + 1}`,
      page ? [id, page.closed, page.at, page.id] : [id],
    ));
    if (rows) {
      loaded.children = keep(rows, ROW_LIMIT, 'children', loaded,
        pagerOf(id, 'hierarchy', null, rows, (row) => [row.closed ? 1 : 0, row.updated_key, row.id])).map(refOf);
    }
  }

  if (plan.sessionCard) {
    const persona = await taggedQuerier(q, 'root').query<{ name: string | null }>(
      `select tm.name from public.edges pe
         join public.team_members tm on tm.entity_id = pe.src_id
        where pe.type = 'participates_in' and pe.dst_id = $1
        order by pe.created_at desc limit 1`,
      [id],
    );
    loaded.teammate = persona[0]?.name ?? null;
    // c761 Q7: the session's tasks, one indexed read of `working_on`.
    // A failure is reported under `connections`, the section whose
    // `--edge-type working_on` expand lists these tasks: `tasks` is a core
    // field of a session, not a section a caller can request.
    const rows = await listLoader(q, 'tasks', 'connections', errors, (tq) => tq.query<RefRow>(
      `select ${REF_COLUMNS} ${REF_FROM}
         join public.edges g on g.dst_id = e.id and g.src_id = $1 and g.type = 'working_on'
        order by g.created_at asc, g.id asc
        limit ${ROW_LIMIT + 1}`,
      [id],
    ));
    if (rows) {
      // Tasks are oldest-first and connections newest-first, so no cursor can
      // continue one from the other: the expand is the filtered section itself.
      const tasksPage = pageExpand(id, 'connections', 'working_on', null);
      loaded.tasks = keep(rows, ROW_LIMIT, 'tasks', loaded, () => tasksPage).map(refOf);
    }
  }

  if (plan.messageCard) {
    // c761 Q12: the anchor and parent refs, and attachment refs with sizes.
    const rq = taggedQuerier(q, 'root');
    const named = [root.anchor_id, root.parent_id].filter((value): value is string => Boolean(value));
    const refs = await loadRefs(rq, named);
    if (root.anchor_id) loaded.anchor = namedRef(refs, root.anchor_id);
    loaded.parentMessage = root.parent_id ? namedRef(refs, root.parent_id) : null;
    const attached = (Array.isArray(root.message_attachments) ? root.message_attachments : []) as Array<{
      fileEntityId?: string; name?: string;
    }>;
    const fileIds = attached.map((a) => a.fileEntityId).filter((value): value is string => Boolean(value));
    const sizes = fileIds.length === 0 ? [] : await rq.query<{ id: string; size_bytes: string | number | null }>(
      `select f.entity_id id, f.size_bytes from public.files f where f.entity_id = any($1::uuid[])`,
      [fileIds],
    );
    const bytesOf = new Map(sizes.map((row) => [row.id, row.size_bytes === null ? null : Number(row.size_bytes)]));
    loaded.attachments = attached
      .filter((a) => a.fileEntityId)
      .map((a) => ({ id: a.fileEntityId!, name: a.name ?? '', bytes: bytesOf.get(a.fileEntityId!) ?? null }));
  }

  if (plan.messages) {
    const limit = plan.messages.limit;
    const author = actorNameSql('m.author_id', 'author');
    // A page continues to OLDER messages, so walking it reassembles the thread.
    const page = after?.section === 'messages' ? after : null;
    const rows = await listLoader(q, 'messages', 'messages', errors, (tq) => tq.query<MessageRow & { at_key: string }>(
      `with ${ME_CTE}
       select m.entity_id id, e.parent_id reply_to, m.body, m.redacted_at, m.created_at,
              ${MICROS('m.created_at')} at_key,
              ${author.select} author_name,
              exists (
                select 1 from jsonb_array_elements(coalesce(m.mentions, '[]'::jsonb)) mention
                  join me on me.id::text = mention ->> 'entityId'
              ) to_me
         from public.messages m
         join public.entities e on e.id = m.entity_id and e.deleted_at is null
         ${author.joins}
        where m.anchor_id = $1
          ${page ? 'and (m.created_at, m.entity_id) < ($3::timestamptz, $4::uuid)' : ''}
        order by m.created_at desc, m.entity_id desc
        limit ${limit + 1}`,
      page ? [id, root.space_id, page.at, page.id] : [id, root.space_id],
    ));
    if (rows) {
      // Latest N selected, emitted oldest→newest (c761 Q6).
      loaded.messages = keep(rows, limit, 'messages', loaded,
        pagerOf(id, 'messages', null, rows, (row) => [row.at_key, row.id])).reverse()
        .map((row) => messageOf(row, plan.messages!.cap));
    }
  }

  if (plan.connections) {
    // Explicit `--sections connections`: every edge type but `anchored_to`
    // (c761 Q11), newest first; `--edge-type` narrows it to one type,
    // `anchored_to` included when named. A hidden endpoint drops the row
    // silently. The two directions are a UNION ALL of two index-driven scans
    // rather than an OR join, which the planner can only satisfy by probing
    // every edge per entity row; the in-direction skips a self-loop so it is
    // listed once, as `out`, exactly as the OR join listed it. The limit
    // applies after the join, so a hidden endpoint never shortens a page.
    const page = after?.section === 'connections' ? after : null;
    const params: unknown[] = [id];
    const typeFilter = edgeType === null ? `g.type <> 'anchored_to'` : `g.type = $${params.push(edgeType)}`;
    const keyset = page
      ? `and (g.created_at, g.id) < ($${params.push(page.at)}::timestamptz, $${params.push(page.id)}::uuid)`
      : '';
    const rows = await listLoader(q, 'connections', 'connections', errors, (tq) => tq.query<RefRow & {
      edge_type: string; outgoing: boolean; edge_resolved: boolean | null; edge_id: string; edge_key: string;
    }>(
      `select c.edge_type, c.outgoing,
              case when c.edge_type = 'depends_on' and c.outgoing
                   then internal.is_resolved(c.other_id) end edge_resolved,
              c.edge_id, ${MICROS('c.edge_at')} edge_key,
              ${REF_COLUMNS} ${REF_FROM}
         join (
           (select g.id edge_id, g.type edge_type, g.created_at edge_at, true outgoing, g.dst_id other_id
              from public.edges g
             where g.src_id = $1 and ${typeFilter} ${keyset})
           union all
           (select g.id, g.type, g.created_at, false, g.src_id
              from public.edges g
             where g.dst_id = $1 and g.src_id <> $1 and ${typeFilter} ${keyset})
         ) c on c.other_id = e.id
        order by c.edge_at desc, c.edge_id desc
        limit ${ROW_LIMIT + 1}`,
      params,
    ));
    if (rows) {
      loaded.connections = keep(rows, ROW_LIMIT, 'connections', loaded,
        pagerOf(id, 'connections', edgeType, rows, (row) => [row.edge_key, row.edge_id])).map((row) => ({
        type: row.edge_type,
        dir: row.outgoing ? 'out' as const : 'in' as const,
        other: refOf(row),
        ...(row.edge_resolved === null ? {} : { resolved: row.edge_resolved }),
      }));
    }
  }

  // The as-of watermark, as v1 reads it (`space_event_seq` has no RLS policy).
  const seqRows = await taggedQuerier(q, 'seq').query<{ seq: string | number }>(
    `select coalesce(max(w.seq), 0) seq from public.workspace_events w where w.space_id = $1`,
    [root.space_id],
  );
  loaded.asOfSeq = Number(seqRows[0]?.seq ?? 0);
  return { loaded, plan };
}

// ---------------------------------------------------------------------------
// Assembly and the budget (c904 §2.2, 2.6, 2.9)
// ---------------------------------------------------------------------------

type View = EntityContextV2View & Record<string, unknown>;

/** `budget.used` counts its own digits, so settle it on a fixed point. */
function settle(view: View, requested: number): number {
  view.budget = { requested, used: 0 };
  let used = jsonBytes(view);
  for (let round = 0; round < 4; round += 1) {
    view.budget = { requested, used };
    const next = jsonBytes(view);
    if (next === used) break;
    used = next;
  }
  return used;
}

/** The lists the budget may trim, in drop order (c904 §2.6). */
function droppableLists(messagesAreCore: boolean): Array<'connections' | 'children' | 'messages'> {
  return messagesAreCore ? ['connections', 'children'] : ['connections', 'children', 'messages'];
}

/**
 * The core envelope the body ceiling is measured against (c904 §2.4): the
 * whole DTO — the body's own marker (`offset`, `expand`, `expandOp`) and a
 * budget block at the default included — with the body text and every list
 * the BUDGET can empty (§2.6) emptied. "Every list empty" is read as every
 * droppable list: the never-drop lists (acceptance, assignees, blockers, the
 * outline, notLoaded, errors, a chat's or session's messages) stay in, because
 * a ceiling that ignored them would make the default read overrun its own
 * 16,384 B with nothing left to drop — a default read that 422s.
 * A list the budget may empty is measured as the `omitted[]` entry its trim
 * would leave (with a section cursor, whose length does not depend on which
 * row it names), so trimming rows can never push a default read past its own
 * ceiling into a 422 (M2/S3b).
 */
function envelopeBytes(view: View, messagesAreCore: boolean, pagers: ReadonlyMap<string, Pager>): number {
  const clone = structuredClone(view) as View;
  (clone['assignment'] as EntityContextAssignment).text = '';
  for (const key of droppableLists(messagesAreCore)) {
    const rows = clone[key];
    if (!Array.isArray(rows)) continue;
    if (rows.length > 0) trimmed(clone, key, rows.length, pagers);
    clone[key] = [];
  }
  return jsonBytes(clone);
}

/**
 * The body from `offset` on (c904 §2.4). The head read (no offset) carries
 * acceptance with it; a page carries the body and nothing else, because the
 * head already delivered the rest of the section. An offset the server could
 * not have emitted — past the end, or inside a character — is refused.
 */
function assignmentOf(root: EntityRow, offset: number | undefined): Record<string, unknown> {
  const body = bodyOf(root);
  const whole = Buffer.from(body, 'utf8');
  if (offset === undefined) {
    return {
      assignment: { text: body, bytes: whole.length, complete: true } satisfies EntityContextAssignment,
      ...(root.kind === 'task' ? acceptanceFields(root) : {}),
    };
  }
  if (offset > whole.length) {
    throw new CollabError('invalid_input', `offset ${offset} is past the end of the ${whole.length}-byte body`, {
      details: { reason: 'offset_out_of_range', bytes: whole.length },
    });
  }
  if (offset < whole.length && (whole[offset]! & 0xc0) === 0x80) {
    throw new CollabError('invalid_input', `offset ${offset} splits a character; use the offset from the expand`, {
      details: { reason: 'offset_not_on_code_point' },
    });
  }
  return {
    assignment: {
      text: whole.subarray(offset).toString('utf8'),
      bytes: whole.length,
      complete: true,
      offset,
    } satisfies EntityContextAssignment,
  };
}

function assemble(id: string, loaded: Loaded, plan: ContextV2LoadPlan, offset: number | undefined): View {
  const { root } = loaded;
  const header = {
    schemaVersion: V2_SCHEMA_VERSION,
    id: root.id,
    kind: root.kind,
    title: titleOf(root),
    version: Number(root.version),
  };
  const status = statusOf(root);
  const notLoaded = plan.notLoaded.map((section) => notLoadedEntry(id, section));
  const tail = { omitted: loaded.omitted, notLoaded, errors: loaded.errors, budget: { requested: 0, used: 0 } };

  const assignmentFields = plan.assignment ? assignmentOf(root, offset) : {};

  if (plan.explicit) {
    // c904 §2.10: the header, the requested sections, notLoaded, errors, budget.
    return {
      ...header,
      status,
      asOfSeq: loaded.asOfSeq,
      ...(plan.parent ? { parent: loaded.parent ?? null } : {}),
      // Only ever loaded here when `header=resolved` asked for it by name.
      ...(loaded.header ? { header: loaded.header } : {}),
      ...assignmentFields,
      ...(loaded.blockers ? { blockers: loaded.blockers } : {}),
      ...(loaded.children ? { children: loaded.children } : {}),
      ...(loaded.connections ? { connections: loaded.connections } : {}),
      ...(loaded.messages ? { messages: loaded.messages } : {}),
      ...tail,
    } as View;
  }

  const kindFields: Record<string, unknown> = {};
  switch (root.kind) {
    case 'task':
      Object.assign(kindFields, {
        priority: root.priority ?? null,
        ...(loaded.gate !== undefined ? { gate: loaded.gate } : {}),
        assignees: loaded.assignees ?? [],
      });
      break;
    case 'work_session': {
      const ended = root.ws_exited_at !== null && root.ws_exited_at !== undefined;
      Object.assign(kindFields, {
        teammate: loaded.teammate ?? null,
        agentTool: root.ws_agent_tool ?? null,
        model: root.ws_model ?? null,
        checkoutBranch: root.ws_checkout_branch ?? null,
        startedAt: isoOrNull(root.ws_started_at),
        ...(ended
          ? {
              exitedAt: isoOrNull(root.ws_exited_at),
              endedKind: root.ws_ended_kind ?? null,
              endedReason: root.ws_ended_reason ?? null,
            }
          : {}),
      });
      break;
    }
    case 'chat':
      Object.assign(kindFields, {
        runtimeState: root.chat_runtime_state ?? null,
        turnState: root.chat_turn_state ?? null,
        turnCount: root.chat_turn_count === null ? null : Number(root.chat_turn_count),
        lastTurnAt: isoOrNull(root.chat_last_turn_at),
        model: root.chat_model ?? null,
        mode: root.chat_mode ?? null,
      });
      break;
    case 'project':
      Object.assign(kindFields, { projectId: root.ppd_project_id ?? null });
      break;
    default:
      break;
  }

  return {
    ...header,
    status,
    ...kindFields,
    ...(loaded.header ? { header: loaded.header } : {}),
    ...(plan.parent ? { parent: loaded.parent ?? null } : {}),
    ...(plan.messageCard
      ? {
          ...(loaded.anchor ? { anchor: loaded.anchor } : {}),
          parentMessage: loaded.parentMessage ?? null,
          attachments: loaded.attachments ?? [],
        }
      : {}),
    ...assignmentFields,
    ...(plan.blockers && loaded.blockers ? { blockers: loaded.blockers } : {}),
    ...(loaded.children ? { children: loaded.children } : {}),
    ...(loaded.tasks ? { tasks: loaded.tasks } : {}),
    ...(loaded.messages ? { messages: loaded.messages } : {}),
    asOfSeq: loaded.asOfSeq,
    ...tail,
  } as View;
}

/** Insert `outline` right after `assignment`, keeping the DTO's key order. */
function withOutline(view: View, body: string): void {
  const { outline, truncated } = outlineOf(body);
  const reordered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(view)) {
    reordered[key] = value;
    if (key === 'assignment') {
      reordered['outline'] = outline;
      if (truncated) reordered['outlineTruncated'] = true;
    }
  }
  for (const key of Object.keys(view)) delete view[key];
  Object.assign(view, reordered);
}

/**
 * Record a budget trim on the section's `omitted[]` entry (c904 §2.7), its
 * expand re-pointed at the last row the trim kept.
 */
function trimmed(view: View, section: string, kept: number, pagers: ReadonlyMap<string, Pager>): void {
  const page = pagers.get(section)?.(kept);
  const entry = view.omitted.find((o) => o.section === section);
  if (entry) {
    entry.kept = kept;
    entry.more = true;
    entry.reason = 'budget';
    if (page) Object.assign(entry, page);
  } else {
    view.omitted.push({ section, kept, more: true, reason: 'budget', ...page });
  }
}

/** The body's continuation (c904 §2.8): exact, server-filled, no placeholder. */
function bodyExpand(id: string, offset: number): { expand: string; expandOp: EntityContextExpandOp } {
  return {
    expand: `tm8 entity context ${id} --sections assignment --offset ${offset}`,
    expandOp: { operation: 'entities.context', params: { id, sections: ['assignment'], offset } },
  };
}

/**
 * Cut the body at the ceiling (c904 §2.4): 16,384 − the core envelope,
 * whatever the caller's budget, so a larger budget never buys more body and a
 * read cuts where the launch snapshot does. The marker is part of the
 * envelope, and the marker names the next offset, so the cut is settled on a
 * fixed point: cut, re-mark, re-measure, until the cut stops moving.
 */
function cutAtCeiling(view: View, id: string, messagesAreCore: boolean, pagers: ReadonlyMap<string, Pager>): void {
  const assignment = view.assignment;
  if (!assignment) return;
  const rest = assignment.text;
  // A page carries `offset` from assembly; the head read has none until cut.
  const head = assignment.offset === undefined;
  const start = assignment.offset ?? 0;
  const ceiling = (): number => {
    settle(view, V2_DEFAULT_TOTAL_BYTES);
    return Math.max(0, V2_DEFAULT_TOTAL_BYTES - envelopeBytes(view, messagesAreCore, pagers));
  };
  if (encodedBytes(rest) <= ceiling()) return;

  const mark = (text: string): void => {
    assignment.text = text;
    assignment.complete = false;
    assignment.offset = start;
    Object.assign(assignment, bodyExpand(id, start + utf8Bytes(text)));
  };
  // c761 Q9: a cut doc's outline is core, so it is in the envelope before the
  // ceiling that cuts the body is measured. Only the head carries it.
  if (view.kind === 'doc' && head) {
    withOutline(view, rest);
  }
  let text = rest;
  for (let round = 0; round < 8; round += 1) {
    mark(text);
    const cut = cutEncoded(rest, ceiling());
    if (cut === text) break;
    text = cut;
  }
  // A digit boundary in the next offset can make the fixed point alternate;
  // settle on the shorter side so the page is never over its ceiling.
  while (encodedBytes(assignment.text) > ceiling() && assignment.text.length > 0) {
    mark(cutEncoded(rest, encodedBytes(assignment.text) - 1));
  }
}

/** The never-drop sections a view carries, for the 422's `details.core`. */
function coreSections(view: View, messagesAreCore: boolean): string[] {
  const core = ['root'];
  for (const key of ['header', 'assignment', 'acceptance', 'acceptanceWrite', 'outline', 'blockers', 'gate', 'assignees', 'anchor', 'attachments', 'tasks']) {
    if (view[key] !== undefined) core.push(key);
  }
  if (messagesAreCore && view.messages !== undefined) core.push('messages');
  if (view.errors.length > 0) core.push('errors');
  return core;
}

/**
 * c904 §2.5: the smallest `totalBytes` the core fits in. `budget` counts its
 * own digits, so this is the least R with size(R) ≤ R — a fixed point, then a
 * step down in case one digit fewer in `requested` is what makes it fit.
 */
function minimumBytes(view: View): number {
  let minimum = settle(view, V2_DEFAULT_TOTAL_BYTES);
  for (let round = 0; round < 8; round += 1) {
    const size = settle(view, minimum);
    if (size === minimum) break;
    minimum = size;
  }
  while (minimum > 1 && settle(view, minimum - 1) <= minimum - 1) minimum -= 1;
  return minimum;
}

/**
 * The core does not fit the caller's budget: refuse, never cut (c904 §2.5).
 * `next` rounds up to the next KB so a small concurrent edit does not fail the
 * retry, and repeats the caller's selection so it runs verbatim. A minimum
 * past the flag's range has no runnable retry, so it carries no `next`.
 */
function budgetTooSmall(
  view: View,
  id: string,
  requested: number,
  input: { sections: ReadonlySet<V2Section> | null; offset?: number },
  messagesAreCore: boolean,
): CollabError {
  const minimum = minimumBytes(view);
  const retry = Math.ceil(minimum / 1024) * 1024;
  const selection = input.sections === null ? '' : ` --sections ${[...input.sections].join(',')}`;
  const page = input.offset === undefined ? '' : ` --offset ${input.offset}`;
  const next = retry <= V2_MAX_TOTAL_BYTES ? `tm8 entity context ${id}${selection}${page} --total-bytes ${retry}` : undefined;
  return new CollabError(
    'context_budget_too_small',
    `the never-drop core needs ${minimum} bytes; ${requested} were requested`,
    {
      details: {
        requestedBytes: requested,
        minimumBytes: minimum,
        core: coreSections(view, messagesAreCore),
        ...(next === undefined ? {} : { next }),
      },
    },
  );
}

/**
 * Fit the view to `requested` (c904 §2.4–2.6): the body first, to the ceiling;
 * then drop rows outside the core — edges, then children, then messages (task,
 * doc, project; chat and session messages are core) — farthest or oldest
 * first, each trim recorded in `omitted[]`. A core that still does not fit is
 * a 422, never a shorter body.
 */
function fit(
  view: View,
  id: string,
  requested: number,
  input: { sections: ReadonlySet<V2Section> | null; offset?: number },
  messagesAreCore: boolean,
  pagers: ReadonlyMap<string, Pager>,
): View {
  cutAtCeiling(view, id, messagesAreCore, pagers);

  let used = settle(view, requested);
  for (const key of droppableLists(messagesAreCore)) {
    const rows = view[key] as unknown[] | undefined;
    while (used > requested && rows && rows.length > 0) {
      // Farthest first: children and connections are nearest-first lists;
      // messages are emitted oldest→newest, so the oldest is at the front.
      if (key === 'messages') rows.shift();
      else rows.pop();
      trimmed(view, key, rows.length, pagers);
      used = settle(view, requested);
    }
  }
  if (used > requested) throw budgetTooSmall(view, id, requested, input, messagesAreCore);
  return view;
}

/**
 * The call that fetches the body of a kind whose body lives outside the
 * envelope (design 01a0d348 §4.1: `tm8 entity context` is the one load
 * pointer, and its expand names the next call).
 */
const BODY_FETCH: Readonly<Record<string, (id: string) => string>> = {
  skill: (id) => `tm8 skill show ${id}`,
  file: (id) => `tm8 file download ${id} --output -`,
  artifact: (id) => `tm8 artifact export ${id} --out ${id}.zip`,
};

/**
 * A skill, file or artifact target names its body fetch, right after
 * `status`. Never the body, and no read of its own. (The selection header on
 * this read is I4's, authored only.)
 */
function withBodyFetch(view: View, root: EntityRow): void {
  const reordered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(view)) {
    reordered[key] = value;
    if (key === 'status') reordered['bodyFetch'] = { expand: BODY_FETCH[root.kind]!(root.id) };
  }
  for (const key of Object.keys(view)) delete view[key];
  Object.assign(view, reordered);
}

/**
 * The v2 read: load per the plan, assemble, fit to the budget. Runs inside the
 * caller's claim-bound transaction; every statement is tagged.
 */
export async function loadContextV2(
  q: Querier,
  id: string,
  input: {
    sections: ReadonlySet<V2Section> | null;
    totalBytes: number;
    offset?: number;
    edgeType?: string | undefined;
    /** Decoded by `decodeV2Cursor` before the transaction opens. */
    after?: ContextV2After | null;
    header?: EntityHeaderReadMode | undefined;
  },
): Promise<EntityContextV2View> {
  const { loaded, plan } = await loadV2(q, id, {
    sections: input.sections,
    edgeType: input.edgeType ?? null,
    after: input.after ?? null,
    header: input.header ?? 'authored',
  });
  const view = assemble(id, loaded, plan, input.offset);
  if (!plan.explicit && BODY_FETCH[loaded.root.kind]) withBodyFetch(view, loaded.root);
  const messagesAreCore = plan.messages?.core === true;
  return fit(view, id, input.totalBytes, input, messagesAreCore, loaded.pagers);
}
