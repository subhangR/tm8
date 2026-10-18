/**
 * THE PHONE LIST ROW, AS DATA — one shape for every entity kind.
 *
 * The phone entity-lists mockup (artifact 01a14cc0) draws ONE row anatomy and
 * fills it per kind: a 36px kind glyph, the title with a trailing time on line
 * one, and ONE meta line under it. Chats put the last message there, sessions
 * their owner and status, docs a two-line excerpt and the author, tasks the
 * assignee, status and priority. Every other kind fills the same slots from
 * the fields every summary carries, so a new kind needs no new layout.
 *
 * Pure on purpose: what a row SAYS is decided here and tested here, and the
 * component only draws it.
 */
import type { EntitySummary, WorkSessionStatus } from '@tm8/contract';
import { listTime } from '../kit/time';

/** The pill's colour family — mapped onto `--pn-run/wait/block/idle/info`. */
export type PhoneTone = 'run' | 'wait' | 'block' | 'idle' | 'info' | 'review';

export interface PhonePill {
  label: string;
  tone: PhoneTone;
}

export interface PhoneRow {
  id: string;
  kind: string;
  title: string;
  /** Trailing time on line one: 'now', '4m', '2h', 'yesterday', 'Tue', 'Oct 11'. */
  time: string;
  /** The full instant, for `<time dateTime>` and the accessible name. */
  at: string;
  /** Line two's text. Chats: last message; sessions/tasks: the person. */
  meta: string;
  /** A face for line two, when the meta names a person. */
  who?: { name: string; initial: string };
  /** Docs: the excerpt, clamped to two lines. Drawn ABOVE the author line. */
  excerpt?: string;
  pill?: PhonePill;
  /** Tasks: `P0`…`P3`. */
  rank?: { label: string; hot: boolean };
  /** Chats/channels: a 9px accent dot and a bold title. */
  unread: boolean;
  /** The glyph's tint family, so the row and the drawer agree on a kind's colour. */
  tint: 'chat' | 'session' | 'doc' | 'task' | 'other';
}

/* ── time ─────────────────────────────────────────────────────────────── */

/** The mockup's trailing time — formatted by the app's one date module. */
export const phoneTime = (iso: string | null | undefined, now: number = Date.now()): string =>
  listTime(iso, now);

/* ── per-kind facts ───────────────────────────────────────────────────── */

/**
 * Session status in the phone's words. `idle` reads **waiting** — the craft's
 * default until the owner picks between it and the drawer's "needs you".
 */
const SESSION_PILL: Record<WorkSessionStatus, PhonePill> = {
  spawning: { label: 'starting', tone: 'run' },
  running: { label: 'running', tone: 'run' },
  idle: { label: 'waiting', tone: 'wait' },
  exited: { label: 'exited', tone: 'idle' },
  failed: { label: 'failed', tone: 'block' },
};

/** Most urgent first — the order a collapsed root borrows its children's state in. */
const URGENCY: readonly PhoneTone[] = ['block', 'wait', 'run', 'review', 'info', 'idle'];

export function moreUrgent(a: PhonePill, b: PhonePill): PhonePill {
  return URGENCY.indexOf(b.tone) < URGENCY.indexOf(a.tone) ? b : a;
}

const TASK_PILL: Record<string, PhonePill> = {
  open: { label: 'to do', tone: 'idle' },
  pulled: { label: 'pulled', tone: 'info' },
  working: { label: 'working', tone: 'info' },
  in_review: { label: 'in review', tone: 'review' },
  blocked: { label: 'blocked', tone: 'block' },
  done: { label: 'done', tone: 'run' },
  cancelled: { label: 'cancelled', tone: 'idle' },
};

const RANK: Record<string, { label: string; hot: boolean }> = {
  urgent: { label: 'P0', hot: true },
  high: { label: 'P1', hot: true },
  medium: { label: 'P2', hot: false },
  low: { label: 'P3', hot: false },
};

const CATEGORY_PILL: Record<string, PhonePill> = {
  to_do: { label: 'to do', tone: 'idle' },
  in_progress: { label: 'in progress', tone: 'info' },
  done: { label: 'done', tone: 'run' },
  cancelled: { label: 'cancelled', tone: 'idle' },
};

function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? [...trimmed][0]!.toUpperCase() : '·';
}

function person(name: string | null | undefined): PhoneRow['who'] {
  if (!name) return undefined;
  return { name, initial: initialOf(name) };
}

/** A kind's glyph tint, shared with rows drawn outside the list (the generic page's Linked). */
export function tintOf(kind: string): PhoneRow['tint'] {
  if (kind === 'chat' || kind === 'channel') return 'chat';
  if (kind === 'work_session') return 'session';
  if (kind === 'doc') return 'doc';
  if (kind === 'task') return 'task';
  return 'other';
}

/** Collapse whitespace so a markdown excerpt reads as one run of prose. */
function prose(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

export function sessionPill(row: EntitySummary): PhonePill | undefined {
  return row.state.kind === 'work_session' ? SESSION_PILL[row.state.status] : undefined;
}

/**
 * One summary → one phone row. `now` is a parameter so the time column is
 * testable and so a whole list formats against one instant.
 */
export function phoneRowOf(row: EntitySummary, now: number = Date.now()): PhoneRow {
  const at = row.activityAt || row.updatedAt;
  const base: PhoneRow = {
    id: row.id,
    kind: row.kind,
    title: row.title,
    time: phoneTime(at, now),
    at,
    meta: '',
    unread: false,
    tint: tintOf(row.kind),
  };
  const author = row.createdBy?.displayName ?? '';
  const state = row.state;

  switch (state.kind) {
    case 'chat': {
      return { ...base, meta: prose(row.excerpt) || (state.turnCount > 0 ? `${state.turnCount} turns` : 'No messages yet') };
    }
    case 'channel': {
      return {
        ...base,
        meta: prose(row.excerpt) || prose(state.topic) || 'No messages yet',
        unread: state.unreadCount > 0,
      };
    }
    case 'work_session': {
      const pill = SESSION_PILL[state.status];
      return { ...base, meta: author, who: person(author), ...(pill ? { pill } : {}) };
    }
    case 'doc': {
      const updated = row.updatedAt || at;
      return {
        ...base,
        time: phoneTime(updated, now),
        at: updated,
        meta: author,
        who: person(author),
        ...(prose(row.excerpt) ? { excerpt: prose(row.excerpt) } : {}),
      };
    }
    case 'task': {
      const assignee = state.assignees[0]?.displayName ?? null;
      const pill = TASK_PILL[state.status];
      const rank = RANK[state.priority];
      return {
        ...base,
        meta: assignee ?? 'Unassigned',
        who: person(assignee) ?? { name: 'Unassigned', initial: '–' },
        ...(pill ? { pill } : {}),
        ...(rank ? { rank } : {}),
      };
    }
    default: {
      const pill = row.category ? CATEGORY_PILL[row.category] : undefined;
      return {
        ...base,
        meta: prose(row.excerpt) || author,
        ...(prose(row.excerpt) ? {} : { who: person(author) }),
        ...(pill ? { pill } : {}),
      };
    }
  }
}

/* ── session trees ────────────────────────────────────────────────────── */

export interface PhoneTreeRow {
  row: EntitySummary;
  children: readonly EntitySummary[];
}

/**
 * Root rows only, each carrying the children that are loaded beside it.
 *
 * A row whose parent is NOT in the loaded set is a root here: the mockup lists
 * "root sessions only", but a child whose root sits on a later page must not
 * vanish, so it stands as its own row until its parent arrives.
 */
export function phoneTree(rows: readonly EntitySummary[]): PhoneTreeRow[] {
  const ids = new Set(rows.map((r) => r.id));
  const kids = new Map<string, EntitySummary[]>();
  const roots: EntitySummary[] = [];
  for (const r of rows) {
    if (r.parentId && r.parentId !== r.id && ids.has(r.parentId)) {
      const list = kids.get(r.parentId) ?? [];
      list.push(r);
      kids.set(r.parentId, list);
    } else {
      roots.push(r);
    }
  }
  /* Grandchildren fold into their root, so one disclosure shows the whole run. */
  const collect = (id: string): EntitySummary[] =>
    (kids.get(id) ?? []).flatMap((child) => [child, ...collect(child.id)]);
  return roots.map((row) => ({ row, children: collect(row.id) }));
}

/** Title-and-excerpt search over loaded rows — the same client-side read the desktop list does. */
export function matchesSearch(row: EntitySummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return row.title.toLowerCase().includes(q) || (row.excerpt ?? '').toLowerCase().includes(q);
}
