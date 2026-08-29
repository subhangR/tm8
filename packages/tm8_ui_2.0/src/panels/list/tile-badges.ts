import type { ActorSummary, EntitySummary, StatusCategory } from '@tm8/contract';
import type { TileBadgeSource } from '../../domain';
import { actorPresentation, getKind } from '../../domain';
import type { PillTone } from '../../kit';

/**
 * TILE BADGES — the Z1 vocabulary, rendered.
 *
 * `ListConfig.tile.badges` says WHICH facts a kind's row shows; this module
 * says HOW each one looks. That split is the whole point of L2: adding a kind
 * adds registry rows, and the only thing that ever needs code is a genuinely
 * NEW kind of fact.
 *
 * WHY THIS FILE EXISTS AT ALL — the defect it repairs. The list panel read
 * `tile.pulse` and never read `tile.badges`, so the entire badge vocabulary
 * was dead data: every kind rendered a bare one-line title. work_session was
 * the sole apparent exception, and only by accident — it gets its dot and word
 * from `liveTreatment`, a different field on a different code path — which is
 * exactly what made the break look task-specific when it was universal.
 *
 * THE GUARD THAT KEEPS IT FIXED: `HANDLED_SOURCES` is asserted in tests to
 * cover every source any registry row declares. A future kind adding an
 * unhandled source fails loudly instead of silently rendering nothing, which
 * is the failure mode that produced this bug and hid it behind one kind that
 * happened to work.
 */

export type TileSlot =
  /** Line 1: the leading dot + the trailing word pill. */
  | { slot: 'status'; word: string; tone: PillTone; dot: 'solid' | 'hollow' }
  /** Line 2 right: the small radius-4 tag (priority). */
  | { slot: 'tag'; label: string; tone: PillTone }
  /** Line 2 left: mono facts, joined with a middot. */
  | { slot: 'meta'; text: string }
  /** Line 1: provenance avatar. */
  | { slot: 'avatar'; actorId: string; label: string; provenance: 'human' | 'agent'; src?: string | null };

/**
 * A working/live actor slot, from the payload's own provenance. A RUN-shaped
 * actor (honest `work_session` kind — a session with no resolvable persona)
 * is NEVER an avatar: it renders as a session tag (▸ + title), because a
 * process drawn with a face is the lie the widened contract exists to end.
 * A persona resolved THROUGH a session still gets its avatar; `via` is a
 * detail-surface fact, not a tile one.
 */
function actorSlot(a: {
  id: string;
  kind: string;
  displayName: string;
  isAgent: boolean;
  avatar?: string | null;
}): TileSlot {
  if (actorPresentation(a as never) === 'run') {
    return { slot: 'tag', label: `▸ ${a.displayName}`, tone: 'idle' };
  }
  return {
    slot: 'avatar',
    actorId: a.id,
    label: a.displayName,
    provenance: a.isAgent ? 'agent' : 'human',
    src: a.avatar,
  };
}

/**
 * STATUS TONE COMES FROM THE ROW'S OWN REGISTRY DECLARATION — never from a
 * table in this file.
 *
 * This module used to keep `WORK_STATUS_TONE` / `SESSION_STATUS_TONE` /
 * `PR_STATE_TONE` copies of the per-kind tone vocabulary, and the work copy
 * had already drifted: it said `in_review: 'info', done: 'run'` while the
 * kind's registry row — BOTH `chip.tones` and `panel.statusPill.tones` — says
 * `wait` / `idle`. So the collapsed row's dot+word disagreed with the state
 * picker mounted ON that very dot (`RowStateControl` is handed
 * `panel.statusPill`) and with the detail header's pill: three surfaces, one
 * fact, two colours. That is §15.2's exact defect class — per-kind divergence
 * copied into a component — and a row and its own picker may never disagree.
 *
 * `statusPill.tones` is read first because it is the map the picker itself
 * renders from; the chip's tint map is the fallback for kinds that declare
 * only Z1 tones; a kind that declares neither gets neutral. `getKind` keeps
 * this module kind-BLIND: it looks the row's declaration up as data and
 * compares no kind names.
 */
function registryStatusTone(row: EntitySummary, value: string): PillTone {
  const config = getKind(row.kind);
  return config.panel.statusPill?.tones[value] ?? config.chip.tones?.[value] ?? 'idle';
}
/**
 * Hollow ring = not yet started / not alive; solid = in motion or settled.
 *
 * PHASE 9 — DERIVED FROM THE CATEGORY, not from a hand-kept list of status
 * words. `WORK_STATUS_HOLLOW = new Set(['open','pulled','cancelled'])` said the
 * same thing this does, exactly (open/pulled ARE `to_do` and `cancelled` IS
 * `cancelled`), but it said it in a vocabulary that goes stale the moment a
 * space names its own statuses — a `Triaged` state would silently draw solid
 * because nobody added the word here.
 *
 * The two hollow categories are the two that are not in motion: `to_do` has
 * not started, `cancelled` stopped without finishing. `in_progress` and `done`
 * are solid. A row with NO category has no status to draw a verdict about, and
 * hollow is the honest ring for that.
 */
const HOLLOW_CATEGORIES: ReadonlySet<StatusCategory> = new Set<StatusCategory>([
  'to_do',
  'cancelled',
]);

const categoryDot = (category: StatusCategory | undefined): 'hollow' | 'solid' =>
  category === undefined || HOLLOW_CATEGORIES.has(category) ? 'hollow' : 'solid';

const PRIORITY_TONE: Record<string, PillTone> = {
  urgent: 'block',
  high: 'block',
  medium: 'idle',
  low: 'idle',
};

/** Read a state member structurally — never by comparing `kind` (§15.2). */
function field(row: EntitySummary, key: string): unknown {
  return (row.state as unknown as Record<string, unknown>)[key];
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const actor = (v: unknown): ActorSummary | null =>
  typeof v === 'object' && v !== null && 'displayName' in v ? (v as ActorSummary) : null;

const humanBytes = (n: number): string =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * A calendar-day ISO string, humanized — `'2026-09-01'` → `'due Sep 1'` (the
 * year is named only when it is not this year), plus the PAST verdict the
 * overdue treatment keys on. Raw machine dates read as debug output on a
 * premium row, and `'due 2026-09-01'` gave no urgency signal at all —
 * overdue and next-week looked identical.
 *
 * Field arithmetic on the string's own digits, never `new Date(iso)`: a
 * date-only ISO parses as UTC MIDNIGHT, so any viewer west of Greenwich would
 * read `2026-09-01` back as "Aug 31". A due date is a calendar fact, not an
 * instant, and it compares against the viewer's local calendar day — due
 * TODAY is due, not past.
 *
 * Exported because the expanded control card prints the same fact
 * (`factsForControlCard`) and one fact gets one spelling.
 *
 * @returns null when the value is not a leading `YYYY-MM-DD` — the caller
 * decides what honesty looks like for garbage.
 */
export function dueLabel(iso: string, today = new Date()): { label: string; past: boolean } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const label = `due ${MONTHS[mo - 1]} ${d}${y === today.getFullYear() ? '' : ` ${y}`}`;
  const todayKey = today.getFullYear() * 10_000 + (today.getMonth() + 1) * 100 + today.getDate();
  return { label, past: y * 10_000 + mo * 100 + d < todayKey };
}

const meta = (text: string | null): TileSlot | null => (text ? { slot: 'meta', text } : null);

/**
 * One badge source → one slot, or null when the row simply has no such value.
 * Null is a legitimate answer (`hideWhenEmpty` is the default) — what is NOT
 * legitimate is a source nobody renders, which the coverage test catches.
 */
export function renderBadge(source: TileBadgeSource, row: EntitySummary): TileSlot | null {
  switch (source) {
    // -- status: the dot + word pair on line 1 ------------------------------
    case 'status': {
      const v = str(field(row, 'status'));
      if (!v) return null;
      return {
        slot: 'status',
        word: v.replace(/_/g, ' '),
        tone: registryStatusTone(row, v),
        dot: categoryDot(row.category),
      };
    }
    case 'sessionStatus': {
      const v = str(field(row, 'status'));
      if (!v) return null;
      return {
        slot: 'status',
        word: v,
        tone: registryStatusTone(row, v),
        dot: v === 'exited' ? 'hollow' : 'solid',
      };
    }
    case 'prState': {
      const v = str(field(row, 'state'));
      if (!v) return null;
      // The connector's own staleness is a DIFFERENT fact from the PR state,
      // and it gets its own word rather than overwriting it.
      const stale = field(row, 'stale') === true;
      return {
        slot: 'status',
        word: stale ? `${v} · stale` : v,
        tone: stale ? 'wait' : registryStatusTone(row, v),
        dot: v === 'open' ? 'solid' : 'hollow',
      };
    }
    case 'profileStatus': {
      const v = str(field(row, 'status'));
      if (!v) return null;
      // Tone from the declaration, like every status arm — the old inline
      // ternary here said draft:'wait' while the kind's chip AND pill said
      // 'idle', the same one-fact-two-colours drift the deleted tables had.
      return {
        slot: 'status',
        word: v,
        tone: registryStatusTone(row, v),
        dot: v === 'active' ? 'solid' : 'hollow',
      };
    }

    // -- tag: line 2, right -------------------------------------------------
    case 'priority': {
      const v = str(field(row, 'priority'));
      if (!v) return null;
      return { slot: 'tag', label: v.toUpperCase(), tone: PRIORITY_TONE[v] ?? 'idle' };
    }

    // -- avatars: provenance on line 1 -------------------------------------
    case 'entityActor': {
      // Registry selects this only for actor entities. Provenance stays DATA:
      // the member state carries `role`; the teammate state carries `owner`.
      const isAgent = field(row, 'owner') !== undefined;
      return { slot: 'avatar', actorId: row.id, label: row.title, provenance: isAgent ? 'agent' : 'human' };
    }
    case 'createdBy': {
      const a = row.createdBy;
      return { slot: 'avatar', actorId: a.id, label: a.displayName, provenance: a.isAgent ? 'agent' : 'human', src: a.avatar };
    }
    case 'workingActors': {
      const a = row.badges.workingActors?.[0]?.actor;
      return a ? actorSlot(a) : null;
    }
    case 'liveWork': {
      const a = actor((field(row, 'liveWork') as Record<string, unknown> | null)?.actor);
      return a ? actorSlot(a) : null;
    }
    case 'owner': {
      const a = actor(field(row, 'owner'));
      return a ? { slot: 'avatar', actorId: a.id, label: a.displayName, provenance: a.isAgent ? 'agent' : 'human', src: a.avatar } : null;
    }
    case 'messageAuthor': {
      const a = actor(field(row, 'author'));
      return a ? { slot: 'avatar', actorId: a.id, label: a.displayName, provenance: a.isAgent ? 'agent' : 'human', src: a.avatar } : null;
    }

    // -- meta: mono facts on line 2, left ----------------------------------
    case 'assignees': {
      const list = field(row, 'assignees');
      if (!Array.isArray(list) || list.length === 0) return null;
      const first = actor(list[0]);
      const rest = list.length - 1;
      return meta(first ? `${first.displayName}${rest > 0 ? ` +${rest}` : ''}` : null);
    }
    case 'acceptance': {
      const a = field(row, 'acceptance') as { total?: number; completed?: number } | null;
      // `'2/4 criteria'` — the expanded control card's exact spelling
      // (`factsForControlCard`), because a bare fraction in the mono meta
      // line sat beside facts that all name themselves ('blocked ×2',
      // 'type:bug') and said two-of-four WHAT.
      return a && typeof a.total === 'number' && a.total > 0
        ? meta(`${a.completed ?? 0}/${a.total} criteria`)
        : null;
    }
    case 'dueDate': {
      const v = str(field(row, 'dueDate'));
      if (!v) return null;
      const due = dueLabel(v);
      // A non-calendar value still gets stated — a fact with no rendering is
      // invisible — but it earns no verdict about time.
      if (!due) return meta(`due ${v}`);
      // Overdue is the one date state that carries a TONE, and meta slots are
      // toneless by design: the tag is this vocabulary's tone-bearing chip.
      // (The tile renders one tag; when a kind declares both this source and
      // 'priority', its registry badge order decides which tag wins.)
      return due.past ? { slot: 'tag', label: due.label, tone: 'block' } : meta(due.label);
    }
    case 'axes': {
      // The task's per-space axis values (`state.axes`, a {axis: value}
      // record). Rendered as `axis:value` pairs because two axes with bare
      // values would be ambiguous on one line; an unset axis is simply
      // absent, which `hideWhenEmpty` already makes distinguishable.
      const a = field(row, 'axes');
      if (a === null || typeof a !== 'object') return null;
      const entries = Object.entries(a as Record<string, unknown>).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1].length > 0,
      );
      if (entries.length === 0) return null;
      return meta(entries.map(([axis, value]) => `${axis}:${value}`).join(' · '));
    }
    case 'blocked': {
      const n = row.badges.blocked?.unresolvedHardDependencyCount ?? 0;
      return n > 0 ? meta(`blocked ×${n}`) : null;
    }
    case 'pulls': {
      const n = row.badges.pulls?.length ?? 0;
      return n > 0 ? meta(`${n} pulled`) : null;
    }
    case 'restricted':
      return row.badges.restricted ? meta('restricted') : null;
    case 'messages': {
      const n = row.counters.messages;
      return n > 0 ? meta(`${n} msg`) : null;
    }
    case 'points': {
      const n = row.counters.points;
      return n > 0 ? meta(`▲ ${n}`) : null;
    }
    case 'agentTool':
      return meta(str(field(row, 'agentTool')));
    case 'model':
      return meta(str(field(row, 'model')));
    case 'shareMode': {
      const v = str(field(row, 'shareMode'));
      return v && v !== 'none' ? meta(`shared: ${v}`) : null;
    }
    case 'channelTopic':
      return meta(str(field(row, 'topic')));
    case 'unread': {
      const n = num(field(row, 'unreadCount'));
      return n && n > 0 ? meta(`${n} unread`) : null;
    }
    case 'workingAgents': {
      const n = num(field(row, 'workingAgentCount'));
      return n && n > 0 ? meta(`${n} working`) : null;
    }
    case 'docFormat':
      return meta(str(field(row, 'format')));
    case 'childCount': {
      const n = num(field(row, 'childCount'));
      return n && n > 0 ? meta(`${n} children`) : null;
    }
    case 'memberRole':
      return meta(str(field(row, 'role')));
    case 'score': {
      const n = num(field(row, 'score'));
      return n && n > 0 ? meta(`${n} pts`) : null;
    }
    case 'taskDoneCount': {
      const n = num(field(row, 'taskDoneCount'));
      return n && n > 0 ? meta(`${n} done`) : null;
    }
    case 'repository':
      return meta(str(field(row, 'repository')));
    case 'sha': {
      const v = str(field(row, 'sha'));
      return meta(v ? v.slice(0, 7) : null);
    }
    case 'mimeType':
      return meta(str(field(row, 'mimeType')));
    case 'sizeBytes': {
      const n = num(field(row, 'sizeBytes'));
      return n ? meta(humanBytes(n)) : null;
    }
    case 'equipped':
      return meta(field(row, 'equipped') === true ? 'equipped' : 'library');
    case 'collectionType':
      return meta(str(field(row, 'collectionType')));
    case 'itemCount': {
      const n = num(field(row, 'itemCount'));
      return meta(`${n ?? 0} items`);
    }
    case 'projectVersion': {
      const n = num(field(row, 'materializedVersion'));
      return n ? meta(`v${n}`) : null;
    }
    case 'profileVersions': {
      const active = num(field(row, 'activeVersion'));
      return active ? meta(`v${active}`) : null;
    }
    case 'customFields': {
      const f = field(row, 'fields');
      const n = f && typeof f === 'object' ? Object.keys(f as object).length : 0;
      return n > 0 ? meta(`${n} fields`) : null;
    }
    default:
      return null;
  }
}

/**
 * Every source this module renders. The coverage test asserts the registry
 * declares nothing outside it — so a new badge source cannot ship as a row
 * that silently loses its anatomy.
 */
export const HANDLED_SOURCES: ReadonlySet<TileBadgeSource> = new Set<TileBadgeSource>([
  'status', 'sessionStatus', 'prState', 'profileStatus',
  'priority', 'axes', 'entityActor', 'createdBy',
  'workingActors', 'liveWork', 'owner', 'messageAuthor',
  'assignees', 'acceptance', 'dueDate', 'blocked', 'pulls', 'restricted',
  'messages', 'points', 'agentTool', 'model', 'shareMode',
  'channelTopic', 'unread', 'workingAgents', 'docFormat', 'childCount',
  'memberRole', 'score', 'taskDoneCount', 'repository', 'sha',
  'mimeType', 'sizeBytes', 'equipped', 'collectionType', 'itemCount',
  'projectVersion', 'profileVersions', 'customFields',
]);
