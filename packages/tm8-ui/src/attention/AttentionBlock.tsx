/**
 * THE ATTENTION BLOCK — on top of every entity detail (chapter 4 "Entity
 * detail", mock tab 3 variant A).
 *
 * Every open request that counts on this entity, its own and rolled up, with
 * one optional note and one Resolve all. The entity stays usable underneath
 * (Q1): this is a band above the tabs, not a gate. Hidden when nothing is
 * pending; history lives in the Activity tab (R9).
 *
 * Reads only the module's selectors and commands. Outside an
 * `AttentionProvider` it renders nothing, so a host that has not mounted the
 * module keeps the legacy dock (see `LegacyAttentionDock`).
 *
 * OPENING MARKS SEEN, NOTHING MORE (G4). The mount effect calls `markSeen` for
 * the requests this viewer has not seen yet; a request arriving later is
 * unseen again and is marked on the next render that shows it.
 */
import { useEffect, useMemo, useState } from 'react';
import type { AttentionRequest, EntityAttentionSummary, EntityId } from '@tm8/contract';
import { useMobileSurface } from '../mobile';
import { AttentionChipView, useAttentionOptional } from './index';
import {
  attentionAge,
  isRolledUp,
  noteTarget,
  sourceLine,
  viaLabel,
} from './attention-subtitles';
import { isAnswerableForm } from '../domain/attention-kinds';
import { useKeepTypedOnFailure } from './use-keep-typed-on-failure';
import './attention-surfaces.css';

const COLLAPSE_KEY = 'tm8.attention.block.collapsed.';

function readCollapsed(entityId: string, fallback: boolean): boolean {
  try {
    const stored = globalThis.localStorage?.getItem(COLLAPSE_KEY + entityId);
    return stored === null || stored === undefined ? fallback : stored === '1';
  } catch {
    return fallback;
  }
}

function writeCollapsed(entityId: string, collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(COLLAPSE_KEY + entityId, collapsed ? '1' : '0');
  } catch {
    /* Private mode: the caret still works, it just is not remembered. */
  }
}

export interface AttentionBlockProps {
  entityId: EntityId | string;
  /** The entity's badges, so the header chip is the SAME chip its tile shows. */
  badges?: { attention?: EntityAttentionSummary | null } | null;
  /** The singular noun of the entity's kind, for "posted on this task". */
  noun?: string;
  onOpenEntity?: (id: string) => void;
  /** Titles the host already holds, for `via <child title>`. */
  titleOf?: (id: string) => string | null | undefined;
  /** Kinds the host already holds; a rolled-up form gets **Answer form**. */
  kindOf?: (id: string) => string | null | undefined;
  /** Member names the host already holds, for `assigned to <name>`. */
  nameOf?: (id: string) => string | null | undefined;
  /**
   * The work session or chat THIS viewer is, when the viewer is an agent. Only
   * that session sees `Withdraw` on its own open requests; humans never do.
   */
  viewerSessionId?: string | null;
  /** Overrides the phone default (collapsed) and the desktop one (open). */
  defaultCollapsed?: boolean;
  /**
   * On a session's or chat's own detail: the requests IT raised are the
   * banner's ("waiting on you"), so the block lists everything else pinned on
   * it. Opening still marks all of them seen.
   */
  excludeRaisedBy?: string | null;
}

export function AttentionBlock(props: AttentionBlockProps) {
  const api = useAttentionOptional();
  const { oneSurface } = useMobileSurface();
  const root = props.entityId as EntityId;
  const all = api ? api.requestsFor(root) : [];
  const requests = props.excludeRaisedBy
    ? all.filter((r) => r.sourceWorkSessionId !== props.excludeRaisedBy)
    : all;
  const [collapsed, setCollapsed] = useState(() =>
    readCollapsed(root, props.defaultCollapsed ?? oneSurface),
  );
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Seen covers EVERY request on the entity, including the ones the banner
  // shows instead of the block (G4: opening marks everything seen).
  const unseenKey = useMemo(
    () => all.filter((r) => r.seenByMe !== true).map((r) => r.id).join(','),
    [all],
  );
  const stashNote = useKeepTypedOnFailure(api, setNote);
  useEffect(() => {
    if (!api || unseenKey === '') return;
    void api.markSeen(root);
    // The unseen SET is the trigger: a request arriving later re-marks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, unseenKey]);

  if (!api || requests.length === 0) return null;

  // Filtered (a session's own detail): the chip must count what the block
  // shows, so it is derived from those rows rather than the root's badge.
  const hidden = all.length - requests.length;
  const chip = hidden > 0
    ? chipOf(requests)
    : api.chipFor({ id: root, badges: props.badges ?? null }) ?? chipOf(requests);
  const oldest = requests.reduce((min, r) => (r.createdAt < min ? r.createdAt : min), requests[0]!.createdAt);
  const count = requests.length;

  const toggle = () => {
    setCollapsed((was) => {
      writeCollapsed(root, !was);
      return !was;
    });
  };

  const resolveAll = async () => {
    setBusy(true);
    try {
      const typed = note;
      stashNote(typed);
      setNote('');
      await api.resolve(root, typed.trim() || undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="att-block"
      data-testid="attention-block"
      data-collapsed={collapsed ? 'true' : undefined}
      aria-label="Attention requests"
    >
      <button
        type="button"
        className="att-block__head"
        aria-expanded={!collapsed}
        onClick={toggle}
        data-testid="attention-block-toggle"
      >
        <AttentionChipView chip={chip} />
        <span className="att-block__title">
          {count} {count === 1 ? 'request' : 'requests'} waiting
        </span>
        <span className="att-block__age">· oldest {attentionAge(oldest)}</span>
        <span className="att-block__caret" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
      </button>

      {collapsed ? null : (
        <>
          <ul className="att-block__list">
            {requests.map((request) => (
              <RequestRow
                key={request.id}
                request={request}
                root={root}
                props={props}
                onWithdraw={(id) => void api.withdraw(id)}
              />
            ))}
          </ul>
          {hidden > 0 ? (
            /* Resolve is root-scoped: it also settles what this session raised
               here, which the banner shows rather than the block. Say so. */
            <p className="att-block__scope" data-testid="attention-block-scope">
              Resolve all also settles {hidden} raised by this {props.noun ?? 'session'} (shown in its banner).
            </p>
          ) : null}
          <div className="att-block__foot">
            <label className="att-block__note">
              <span className="att-block__note-label">Note — {noteTarget(requests, props.noun ?? 'entity')}</span>
              <input
                type="text"
                value={note}
                placeholder="Optional"
                onChange={(event) => setNote(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !busy) void resolveAll();
                }}
                data-testid="attention-block-note"
              />
            </label>
            <button
              type="button"
              className="att-btn att-btn--primary"
              disabled={busy}
              onClick={() => void resolveAll()}
              data-testid="attention-block-resolve"
            >
              Resolve all
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function RequestRow({
  request,
  root,
  props,
  onWithdraw,
}: {
  request: AttentionRequest;
  root: EntityId;
  props: AttentionBlockProps;
  onWithdraw(id: string): void;
}) {
  const source = sourceLine(request);
  const rolled = isRolledUp(request, root);
  const isForm = isAnswerableForm(props.kindOf?.(request.entityId));
  const assignee = request.assigneeId ? props.nameOf?.(request.assigneeId) : null;
  const canWithdraw =
    !!props.viewerSessionId &&
    request.origin === 'agent' &&
    request.sourceWorkSessionId === props.viewerSessionId;
  const level = request.level ?? 'normal';
  return (
    <li className="att-block__row" data-testid="attention-block-row" data-level={level}>
      <div className="att-block__tags">
        <span className={`att-tag att-tag--${level}`}>{level}</span>
        <span className="att-tag att-tag--type">{request.actionType ?? 'decide'}</span>
        <span className="att-block__points">{request.points} pts</span>
      </div>
      <p className="att-block__reason">{request.reason}</p>
      <div className="att-block__meta">
        {source.id && props.onOpenEntity ? (
          <button
            type="button"
            className="att-link"
            onClick={() => props.onOpenEntity?.(source.id!)}
            data-testid="attention-block-source"
          >
            ↗ {source.text}
          </button>
        ) : (
          <span className="att-block__source">{source.text}</span>
        )}
        <span>{request.requestedBy.displayName}</span>
        {assignee ? <span>assigned to {assignee}</span> : null}
        <span>{attentionAge(request.createdAt)}</span>
        {rolled ? <span className="att-block__via">via {viaLabel(request, props.titleOf)}</span> : null}
      </div>
      {isForm || canWithdraw ? (
        <div className="att-block__actions">
          {isForm && props.onOpenEntity ? (
            <button type="button" className="att-btn" onClick={() => props.onOpenEntity?.(request.entityId)}>
              Answer form
            </button>
          ) : null}
          {canWithdraw ? (
            <button type="button" className="att-btn att-btn--quiet" onClick={() => onWithdraw(request.id)}>
              Withdraw
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Fallback chip when the store has no badge for the root yet (first paint). */
function chipOf(requests: readonly AttentionRequest[]) {
  const rank = { fyi: 0, normal: 1, high: 2, urgent: 3 } as const;
  const level = requests.reduce<keyof typeof rank>(
    (max, r) => (rank[r.level ?? 'normal'] > rank[max] ? (r.level ?? 'normal') : max),
    'fyi',
  );
  return {
    level,
    icon: level === 'fyi' ? ('i' as const) : ('!' as const),
    tone: level === 'fyi' ? ('fyi' as const) : level === 'urgent' ? ('block' as const) : ('wait' as const),
    totalPoints: requests.reduce((sum, r) => sum + r.points, 0),
    pendingCount: requests.length,
    oldestRequestedAt: requests.reduce((min, r) => (r.createdAt < min ? r.createdAt : min), requests[0]!.createdAt),
    latestReason: requests[0]!.reason,
  };
}
