import type { ActorSummary, EntitySummary } from '@tm8/contract';
import type { TileBadgeSource } from '../../domain';
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
  | { slot: 'avatar'; label: string; provenance: 'human' | 'agent' };

const WORK_STATUS_TONE: Record<string, PillTone> = {
  open: 'idle',
  pulled: 'info',
  working: 'run',
  in_review: 'info',
  done: 'run',
  blocked: 'block',
  cancelled: 'idle',
};
/** Hollow ring = not yet started / not alive; solid = in motion or settled. */
const WORK_STATUS_HOLLOW = new Set(['open', 'pulled', 'cancelled']);

const SESSION_STATUS_TONE: Record<string, PillTone> = {
  spawning: 'wait',
  running: 'run',
  idle: 'info',
  exited: 'idle',
  failed: 'block',
};

const PR_STATE_TONE: Record<string, PillTone> = {
  open: 'run',
  draft: 'idle',
  merged: 'brand',
  closed: 'idle',
};

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

const meta = (text: string | null): TileSlot | null => (text ? { slot: 'meta', text } : null);

/**
 * One badge source → one slot, or null when the row simply has no such value.
 * Null is a legitimate answer (`hideWhenEmpty` is the default) — what is NOT
 * legitimate is a source nobody renders, which the coverage test catches.
 */
export function renderBadge(source: TileBadgeSource, row: EntitySummary): TileSlot | null {
  switch (source) {
    // -- status: the dot + word pair on line 1 ------------------------------
    case 'workStatus': {
      const v = str(field(row, 'workStatus'));
      if (!v) return null;
      return {
        slot: 'status',
        word: v.replace(/_/g, ' '),
        tone: WORK_STATUS_TONE[v] ?? 'idle',
        dot: WORK_STATUS_HOLLOW.has(v) ? 'hollow' : 'solid',
      };
    }
    case 'sessionStatus': {
      const v = str(field(row, 'status'));
      if (!v) return null;
      return {
        slot: 'status',
        word: v,
        tone: SESSION_STATUS_TONE[v] ?? 'idle',
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
        tone: stale ? 'wait' : (PR_STATE_TONE[v] ?? 'idle'),
        dot: v === 'open' ? 'solid' : 'hollow',
      };
    }
    case 'profileStatus': {
      const v = str(field(row, 'status'));
      if (!v) return null;
      return {
        slot: 'status',
        word: v,
        tone: v === 'active' ? 'run' : v === 'draft' ? 'wait' : 'idle',
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
    case 'workingActors': {
      const a = row.badges.workingActors?.[0]?.actor;
      return a ? { slot: 'avatar', label: a.displayName, provenance: a.isAgent ? 'agent' : 'human' } : null;
    }
    case 'liveWork': {
      const a = actor((field(row, 'liveWork') as Record<string, unknown> | null)?.actor);
      return a ? { slot: 'avatar', label: a.displayName, provenance: a.isAgent ? 'agent' : 'human' } : null;
    }
    case 'owner': {
      const a = actor(field(row, 'owner'));
      return a ? { slot: 'avatar', label: a.displayName, provenance: a.isAgent ? 'agent' : 'human' } : null;
    }
    case 'messageAuthor': {
      const a = actor(field(row, 'author'));
      return a ? { slot: 'avatar', label: a.displayName, provenance: a.isAgent ? 'agent' : 'human' } : null;
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
      return a && typeof a.total === 'number' && a.total > 0 ? meta(`${a.completed ?? 0}/${a.total}`) : null;
    }
    case 'dueDate':
      return meta(str(field(row, 'dueDate')) && `due ${str(field(row, 'dueDate'))}`);
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
  'workStatus', 'sessionStatus', 'prState', 'profileStatus',
  'priority',
  'workingActors', 'liveWork', 'owner', 'messageAuthor',
  'assignees', 'acceptance', 'dueDate', 'blocked', 'pulls', 'restricted',
  'messages', 'points', 'agentTool', 'model', 'shareMode',
  'channelTopic', 'unread', 'workingAgents', 'docFormat', 'childCount',
  'memberRole', 'score', 'taskDoneCount', 'repository', 'sha',
  'mimeType', 'sizeBytes', 'equipped', 'collectionType', 'itemCount',
  'projectVersion', 'profileVersions', 'customFields',
]);
