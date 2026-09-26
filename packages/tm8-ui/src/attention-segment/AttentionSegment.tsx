/**
 * AttentionSegment — the status strip's LEAD segment: how many attention
 * requests are pending in this space, and the door to them.
 *
 * Mounted through `StatusStrip`'s `leadSlot` and owning nothing of the strip:
 * it reads its own data (`useAttentionPending`), so the strip carries no
 * attention props and neither lane edits the other's files.
 *
 * THE COUNT IS REQUESTS, THE LIST IS ENTITIES. The number answers "how many
 * requests are waiting"; the popover groups them one row per entity
 * (`groupAttentionByEntity`, the same arithmetic as the server badge) because
 * an entity is the unit of work — it is where the requests get settled.
 *
 * OPENING GOES THROUGH `openEntityAndMarkRead`, the rule every other door into
 * an entity follows: navigate first, then record a read mark. THE COUNT DOES
 * NOT DROP HERE, and that is the change (Attention v2, G4/G5): picking a row
 * used to bulk-resolve that entity's whole queue on the way through, so this
 * popover emptied itself by being used and nobody could see what had been
 * escalated. Now it navigates, and the entity's attention dock is where a
 * request is resolved or declined — explicitly, one row at a time, undoably.
 * The count clears when the dock settles the rows, not when you look at them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { KindIcon } from '../domain/KindIcon';
import { getKind } from '../domain/registry';
import { groupAttentionByEntity, type AttentionEntityGroup } from '../attention/attention-model';
import { useDismissable } from '../panels/useDismissable';
import { openEntityAndMarkRead } from '../views/open-entity';
import { useAttentionPending, type AttentionPendingSeam } from './useAttentionPending';
import './attention-segment.css';

/** Rows drawn in the popover; the rest are summarised, never silently dropped. */
export const POPOVER_ROWS = 12;

type EntityName = { title: string; kind: string };

export interface AttentionSegmentProps {
  seam: AttentionPendingSeam & Pick<Seam, 'entity'> & {
    commands: Pick<Seam['commands'], 'upsertReadMark'>;
  };
  spaceId: SpaceId | null | undefined;
  /** Navigate to the entity. The read mark is done here. */
  onOpenEntity(id: EntityId): void;
  /** Names the host already holds — consulted before any network read. */
  nameOf?(id: EntityId): EntityName | undefined;
  /** Test seam: the event-triggered refresh delay. */
  refreshDelayMs?: number;
}

export function AttentionSegment(props: AttentionSegmentProps) {
  const { seam, spaceId, onOpenEntity, nameOf } = props;
  const { state } = useAttentionPending(
    seam,
    spaceId,
    props.refreshDelayMs != null ? { delayMs: props.refreshDelayMs } : {},
  );
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissable(open, boxRef, close);
  const marking = useRef<Set<EntityId>>(new Set());

  const rows = state.phase === 'ready' ? state.rows : [];
  const groups = groupAttentionByEntity(rows);
  const shown = groups.slice(0, POPOVER_ROWS);
  const names = useEntityNames(seam, open ? shown : [], nameOf);

  if (!spaceId) return null;

  const count = rows.length;
  const truncated = state.phase === 'ready' && state.truncated;
  const value = state.phase === 'loading'
    ? '…'
    : state.phase === 'error'
      ? '—'
      : truncated ? `${count}+` : String(count);
  const hot = state.phase === 'ready' && count > 0;
  // A full page makes BOTH numbers floors: the entities are grouped from the
  // same truncated rows, so an unmarked entity count would read as a total.
  const entities = `${groups.length}${truncated ? '+' : ''} ${groups.length === 1 && !truncated ? 'entity' : 'entities'}`;
  const summary = state.phase === 'error'
    ? `Attention could not be loaded: ${state.message}`
    : state.phase === 'loading'
      ? 'Loading attention requests'
      : count === 0
        ? 'Nothing needs your attention'
        : `${value} attention ${count === 1 ? 'request' : 'requests'} pending on ${entities}`;

  const openRow = (id: EntityId) => {
    setOpen(false);
    // NO `refresh()` AFTERWARDS, deliberately. Navigating changes nothing about
    // what is pending, so re-reading here would spend a request to redraw the
    // same number. The hook already refreshes on the event that a settlement
    // emits, which is the only thing that can actually move this count.
    openEntityAndMarkRead({
      entityId: id,
      open: onOpenEntity,
      commands: seam.commands,
      marking: marking.current,
    });
  };

  return (
    <span className="att-seg" ref={boxRef}>
      <button
        type="button"
        className={hot ? 'status-strip__segment att-seg__btn att-seg__btn--hot' : 'status-strip__segment att-seg__btn'}
        data-testid="attention-segment"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={summary}
        title={summary}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="att-seg__label">Attention</span>
        <span className="att-seg__value" data-testid="attention-segment-count">{value}</span>
      </button>

      {open ? (
        <div
          className="att-seg__pop"
          role="group"
          aria-label="Pending attention"
          data-testid="attention-segment-popover"
        >
          {state.phase === 'error' ? (
            <p className="att-seg__note">{summary}</p>
          ) : state.phase === 'loading' ? (
            <p className="att-seg__note">Loading…</p>
          ) : groups.length === 0 ? (
            <p className="att-seg__note">Nothing needs your attention.</p>
          ) : (
            <>
              <div className="att-seg__eyebrow">
                {`Needs attention · ${entities}`}
              </div>
              <ul className="att-seg__list">
                {shown.map((group) => (
                  <SegmentRow
                    key={group.entityId}
                    group={group}
                    name={nameOf?.(group.entityId) ?? names[group.entityId]}
                    onOpen={() => openRow(group.entityId)}
                  />
                ))}
              </ul>
              {groups.length > shown.length || truncated ? (
                <p className="att-seg__note">
                  {truncated
                    ? 'More are pending than one page shows.'
                    : `${groups.length - shown.length} more waiting.`}
                </p>
              ) : null}
              <p className="att-seg__hint">Opening an entity clears its attention.</p>
            </>
          )}
        </div>
      ) : null}
    </span>
  );
}

function SegmentRow(props: {
  group: AttentionEntityGroup;
  name: EntityName | undefined;
  onOpen(): void;
}) {
  const { group, name } = props;
  const config = name ? getKind(name.kind) : undefined;
  // An unhydrated row shows its id, styled as an id — never a guessed title.
  const title = name?.title ?? group.entityId;
  return (
    <li>
      <button
        type="button"
        className="att-seg__row"
        onClick={props.onOpen}
        data-testid={`attention-segment-row-${group.entityId}`}
        aria-label={[
          title,
          `${group.totalPoints} points`,
          group.pendingCount > 1 ? `${group.pendingCount} requests` : '1 request',
          group.latestReason,
        ].join(', ')}
      >
        <span className="att-seg__points" aria-hidden="true">{group.totalPoints}</span>
        <span className="att-seg__body">
          <span className="att-seg__title">
            {config ? (
              <span className="att-seg__glyph" aria-hidden="true"><KindIcon kind={config.kind} /></span>
            ) : null}
            <span className={name ? 'att-seg__name' : 'att-seg__name att-seg__name--raw'}>{title}</span>
            {group.pendingCount > 1 ? (
              <span className="att-seg__count">{`×${group.pendingCount}`}</span>
            ) : null}
          </span>
          <span className="att-seg__reason">{group.latestReason}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * Titles are not on the attention wire, so the rows the popover is about to
 * draw are hydrated one read each — only while it is open, only for the rows
 * shown, and at most once per id. A failed read leaves the row on its id.
 */
function useEntityNames(
  seam: Pick<Seam, 'entity'>,
  groups: readonly AttentionEntityGroup[],
  nameOf: ((id: EntityId) => EntityName | undefined) | undefined,
): Record<string, EntityName> {
  const [fetched, setFetched] = useState<Record<string, EntityName>>({});
  const requested = useRef<Set<string>>(new Set());
  const key = groups.map((g) => g.entityId).join(',');
  // No `live` guard: the segment outlives the popover, so a name that lands
  // after the popover closed is still wanted — dropping it would pin the id
  // in `requested` with nothing to show for it.
  useEffect(() => {
    for (const group of groups) {
      if (nameOf?.(group.entityId) || requested.current.has(group.entityId)) continue;
      requested.current.add(group.entityId);
      void seam.entity(group.entityId).then(
        (detail) => {
          setFetched((current) => ({
            ...current,
            [group.entityId]: { title: detail.title, kind: detail.state.kind },
          }));
        },
        () => {
          // Allow a later open to try again rather than pinning the id forever.
          requested.current.delete(group.entityId);
        },
      );
    }
    // `key` is the identity of `groups`; the array itself is rebuilt per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, seam, nameOf]);
  return fetched;
}
