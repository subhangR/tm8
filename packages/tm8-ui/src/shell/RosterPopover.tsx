import { useEffect, useRef } from 'react';
import type { SessionLiveness } from '../data/seam';
import {
  presentSession,
  presentationStyle,
  type SessionPresentation,
  type SessionRow,
} from '../terminal';

/**
 * THE ROSTER — "the same list, popover or teaching state" (T0-2).
 *
 * Three groups in fixed priority order: NEEDS YOU, LIVE, RECENTLY EXITED.
 * The order is the triage: what is blocked on you, then what is alive, then
 * what just ended. Recently-exited sits at 75% opacity — present, plainly
 * secondary, never dropped, because a session that just died is exactly what
 * a user goes looking for.
 *
 * Rows use a BARE word rather than a pill: at this density pill chrome fights
 * the list. Still word + colour, never colour alone.
 */

export interface RosterPopoverProps {
  liveIds: readonly string[];
  attentionIds?: readonly string[];
  recentlyExited?: readonly SessionRow[];
  resolve: (id: string) => SessionRow | undefined;
  livenessOf: (id: string) => SessionLiveness;
  activity?: Readonly<Record<string, boolean>>;
  onSelect?: (id: string) => void;
  onDismiss?: () => void;
}

export function RosterPopover({
  liveIds,
  attentionIds = [],
  recentlyExited = [],
  resolve,
  livenessOf,
  activity = {},
  onSelect,
  onDismiss,
}: RosterPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Esc closes only this surface (C6 layer 2) and is CONSUMED, so it never
  // also pops the panel stack underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onDismiss?.();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onDismiss]);

  const attentionSet = new Set(attentionIds);
  // A session that needs you appears ONCE, in NEEDS YOU — never twice.
  const attention = attentionIds.map(resolve).filter(isRow);
  const live = liveIds.filter((id) => !attentionSet.has(id)).map(resolve).filter(isRow);

  return (
    <div className="roster" role="menu" aria-label="Live sessions" ref={ref} data-testid="roster-popover">
      {attention.length > 0 ? (
        <>
          <div className="roster__group roster__group--attention">{`NEEDS YOU · ${attention.length}`}</div>
          {attention.map((row) => (
            <RosterRow
              key={row.id}
              row={row}
              presentation={presentSession({
                liveness: livenessOf(row.id),
                recordedStatus: row.recordedStatus,
                streaming: activity[row.id],
                needsAttention: true,
              })}
              onSelect={onSelect}
              tint
            />
          ))}
        </>
      ) : null}

      {live.length > 0 ? (
        <>
          <div className="roster__group">{`LIVE · ${live.length}`}</div>
          {live.map((row) => (
            <RosterRow
              key={row.id}
              row={row}
              presentation={presentSession({
                liveness: livenessOf(row.id),
                recordedStatus: row.recordedStatus,
                streaming: activity[row.id],
              })}
              onSelect={onSelect}
              /* One guide level only — the full coordinator tree lives in the
                 Sessions list panel, not in a 280px popover. */
              child={Boolean(row.parentSessionId && liveIds.includes(row.parentSessionId))}
            />
          ))}
        </>
      ) : null}

      {recentlyExited.length > 0 ? (
        <>
          <div className="roster__group roster__group--ended">{`RECENTLY EXITED · ${recentlyExited.length}`}</div>
          {recentlyExited.map((row) => (
            <RosterRow
              key={row.id}
              row={row}
              presentation={presentSession({
                liveness: livenessOf(row.id),
                recordedStatus: row.recordedStatus,
              })}
              onSelect={onSelect}
              dim
            />
          ))}
        </>
      ) : null}

      <div className="roster__footer">click focuses · p pins · esc closes</div>
    </div>
  );
}

function RosterRow({
  row,
  presentation,
  onSelect,
  tint = false,
  dim = false,
  child = false,
}: {
  row: SessionRow;
  presentation: SessionPresentation;
  onSelect?: (id: string) => void;
  tint?: boolean;
  dim?: boolean;
  child?: boolean;
}) {
  const s = presentationStyle(presentation);
  const cls = [
    'roster__row',
    tint ? 'roster__row--attention' : '',
    dim ? 'roster__row--ended' : '',
    child ? 'roster__row--child' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const dotCls = [
    'live-bar__dot',
    s.dot === 'hollow'
      ? 'term-dot--ended'
      : s.tone === 'run'
        ? 'term-dot--live'
        : 'term-dot--attention',
    s.pulse ? 'term-dot--pulse' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const avatarCls = [
    'roster__avatar',
    tint ? 'roster__avatar--attention' : '',
    s.isLive ? '' : 'roster__avatar--ended',
  ]
    .filter(Boolean)
    .join(' ');

  const wordCls = `roster__word roster__word--${wordVariant(presentation)}`;

  return (
    <button type="button" role="menuitem" className={cls} onClick={() => onSelect?.(row.id)}>
      <span className={dotCls} aria-hidden />
      <span className={avatarCls} aria-hidden>
        {(row.initial ?? row.name.charAt(0)).toUpperCase()}
      </span>
      <span className={s.isLive ? 'roster__name' : 'roster__name roster__name--ended'}>
        {row.name}
      </span>
      {row.meta ? <span className="roster__meta">{row.meta}</span> : null}
      <span className="roster__spacer" />
      {/* The short word here; the full sentence ("stale — node restarted")
          rides on title so the 280px row never has to truncate meaning. */}
      <span className={wordCls} title={s.full}>
        {s.word}
      </span>
    </button>
  );
}

function wordVariant(p: SessionPresentation): 'live' | 'attention' | 'stale' | 'ended' {
  const s = presentationStyle(p);
  if (s.tone === 'run') return 'live';
  if (p === 'stale') return 'stale';
  if (s.tone === 'wait') return 'attention';
  return 'ended';
}

function isRow(r: SessionRow | undefined): r is SessionRow {
  return r != null;
}
