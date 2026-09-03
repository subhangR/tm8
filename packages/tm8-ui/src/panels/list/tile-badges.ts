import type { ActorSummary, EntitySummary, StatusCategory } from '@tm8/contract';
import type { TileBadgeSource } from '../../domain';
import { actorPresentation } from '../../domain';
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

const WORK_STATUS_TONE: Record<string, PillTone> = {
  open: 'idle',
  pulled: 'info',
  working: 'run',
  in_review: 'info',
  done: 'run',
  blocked: 'block',
  cancelled: 'idle',
};
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

/**
 * The chat queue's two working words. `idle` is deliberately absent: it is
 * filtered before the lookup (see the case), so a tone for it would be dead.
 */
const CHAT_TURN_TONE: Record<string, PillTone> = {
  queued: 'wait',
  running: 'run',
};

/**
 * The container's nine statuses (§11.1). THE SAME MAP the registry row's chip
 * and status pill declare — `registry.test.ts` asserts the three agree rather
 * than trusting three hand-kept copies, because a missing arm renders the
 * neutral tone SILENTLY and no vitest can see a colour (jsdom loads no
 * stylesheets).
 */
const CONTAINER_STATUS_TONE: Record<string, PillTone> = {
  requested: 'wait',
  provisioning: 'wait',
  running: 'run',
  paused: 'info',
  stopping: 'wait',
  stopped: 'idle',
  destroying: 'wait',
  destroyed: 'idle',
  failed: 'block',
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
    case 'status': {
      const v = str(field(row, 'status'));
      if (!v) return null;
      return {
        slot: 'status',
        word: v.replace(/_/g, ' '),
        tone: WORK_STATUS_TONE[v] ?? 'idle',
        dot: categoryDot(row.category),
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
    /*
     * CONTAINER (migration 177). The dot is SOLID only while the machine is
     * actually up: `running` and `paused` are the two statuses with a live
     * runtime behind them. Every other status — including `provisioning`,
     * which is on its way up but is not up — draws hollow, so the tile never
     * claims a machine exists before the node says it does.
     *
     * THIS IS NOT LIVENESS AND MUST NOT BE READ AS IT (R-UI-5). This dot is a
     * fold of the ENTITY'S recorded status; the LIVE dot comes from
     * `seam.liveness.statusOf`. A row is `running` in the graph for as long as
     * nobody has told the graph otherwise, which is exactly the ghost case.
     */
    case 'containerStatus': {
      const v = str(field(row, 'status'));
      if (!v) return null;
      return {
        slot: 'status',
        word: v,
        tone: CONTAINER_STATUS_TONE[v] ?? 'idle',
        dot: v === 'running' || v === 'paused' ? 'solid' : 'hollow',
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
      return a && typeof a.total === 'number' && a.total > 0 ? meta(`${a.completed ?? 0}/${a.total}`) : null;
    }
    case 'dueDate':
      return meta(str(field(row, 'dueDate')) && `due ${str(field(row, 'dueDate'))}`);
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
    /*
     * CHAT (migration 176). Three facts no other kind has; `model` above
     * already answers for a chat, because that source reads `state.model`
     * structurally and a chat state carries one.
     *
     * `turnState` is the QUEUE and it is drawn as a STATUS PILL rather than a
     * meta word, because it is the one fact on the row that changes while you
     * are looking at it. `idle` renders NOTHING: a chat that is not working is
     * the resting state of every row in the list, and a pill on all of them
     * would be a pill that says nothing. That is the same rule `shareMode`
     * follows two cases down for `none`.
     */
    case 'chatMode':
      return meta(str(field(row, 'mode')));
    case 'chatTurnState': {
      const v = str(field(row, 'turnState'));
      if (!v || v === 'idle') return null;
      return { slot: 'status', word: v, tone: CHAT_TURN_TONE[v] ?? 'info', dot: 'solid' };
    }
    case 'chatLastTurnAt': {
      /* The ISO instant, verbatim — this module formats no dates (`dueDate`
         above prints the stored string too). The tile's own chrome renders
         relative time from `activityAt`; this is the chat's OWN clock, which
         is a different fact: a renamed chat moves `activityAt` and not this. */
      const v = str(field(row, 'lastTurnAt'));
      return meta(v && `last turn ${v}`);
    }
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
    /* The three spec facts a reader tells containers apart by, as mono meta on
       line 2 — what it runs, who runs it, and how hard the walls are. */
    case 'profile':
      return meta(str(field(row, 'profile')));
    case 'provider':
      return meta(str(field(row, 'provider')));
    case 'isolation':
      return meta(str(field(row, 'isolation')));
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
  'chatMode', 'chatTurnState', 'chatLastTurnAt',
  // container (migration 177) — a source listed here and nowhere else would
  // still be dead data; each of these four has a `renderBadge` arm above.
  'containerStatus', 'profile', 'provider', 'isolation',
]);
