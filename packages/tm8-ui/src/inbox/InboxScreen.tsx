/**
 * `src/inbox/InboxScreen.tsx` — T3-7, the screen behind the `inbox` rail row
 * and the `g i` chord.
 *
 * D65 shape: an activated menu view replaces the centre WHOLESALE (the
 * workspace is the only three-panel exception), so this is a full-width screen,
 * not a panel.
 *
 * R7 POSTURE, stated once for the whole file: **no control the oracle draws is
 * hidden, and no control is live-but-inert.** Every affordance below is either
 * dispatched through the real seam or rendered disabled-with-reason via
 * `panels/honesty` (`aria-disabled` + focusable + reason wired through
 * `aria-describedby` — D28: a natively `disabled` button leaves the tab order
 * and takes its own explanation with it). §3 of HANDOVER.md is the full table.
 *
 * FIDELITY IS DEFERRED. This lane's bar is link-level completeness; a later
 * parity seat owns pixels. Values here follow the oracle's structure and use
 * tokens throughout, and every divergence I know of is written down rather than
 * quietly absorbed.
 */
import { useId, useMemo, useState } from 'react';
import { Avatar, Eyebrow, Pill } from '../kit';
import { DisabledAction } from '../panels/honesty/DisabledWithReason';
import {
  CLICK_THROUGH_CAPTION,
  NO_FILTERS,
  ROW_NOT_WIRED_REASON,
  SEND_AGAIN_REASON,
  TEAMMATE_AUDIENCE_REASON,
  applyFilters,
  buildGroups,
  emptyGroupsNote,
  filtersActive,
  inboxEmptyNote,
  inboxRowOf,
  kindsPresent,
  unreadCount,
  type InboxFilters,
  type InboxRow,
} from './inbox-model';
import type { InboxData } from './useInboxData';

export interface InboxScreenProps {
  data: InboxData;
  /**
   * C1 — open the notification's entity. The oracle's CLICK-THROUGH card
   * specifies the whole behaviour (stacked panel · Discussion tab · message
   * highlighted · marks itself read · Esc pops back); the marks-itself-read
   * half is THIS screen's and always runs, the navigation half belongs to the
   * host. Absent ⇒ rows render disabled-with-reason rather than clickable and
   * silently inert.
   */
  onOpenNotification?: (row: InboxRow) => void;
  /** Injected for determinism; the recency column is a pure projection of it. */
  now?: Date;
}

export function InboxScreen({ data, onOpenNotification, now }: InboxScreenProps) {
  const [filters, setFilters] = useState<InboxFilters>(NO_FILTERS);
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const rowsCaptionId = useId();

  const clock = now ?? new Date();
  const allRows = useMemo(
    () => (data.items ?? []).map((item) => inboxRowOf(item, clock)),
    // `clock` is intentionally excluded: re-projecting every row on each render
    // because the wall clock moved would make the list identity-unstable for no
    // visible gain (recency is minute-grained).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.items],
  );
  const visible = useMemo(() => applyFilters(allRows, filters), [allRows, filters]);
  const groups = useMemo(() => buildGroups(visible), [visible]);
  const unread = unreadCount(allRows);
  const types = useMemo(() => kindsPresent(allRows), [allRows]);
  const absence = emptyGroupsNote(visible);

  const rowsWired = onOpenNotification != null;

  const openRow = (row: InboxRow) => {
    // Read-marking is this screen's own half of the click-through and runs
    // regardless of what the host does with the navigation.
    void data.markRead(row.id);
    onOpenNotification?.(row);
  };

  return (
    <div className="ibx-root" data-testid="inbox-screen">
      <div className="ibx-card" role="region" aria-label="Inbox">
        {/* ---- header: title · unread count · mark all read ---- */}
        <div className="ibx-head">
          <div className="ibx-head__line">
            <span className="ibx-title">Inbox</span>
            {unread > 0 ? (
              <Pill tone="brand">{`${unread} unread`}</Pill>
            ) : (
              <span className="ibx-muted" data-testid="inbox-allread">
                all read
              </span>
            )}
            <div className="ibx-spacer" />
            <MarkAllControl data={data} unread={unread} />
          </div>

          {/* ---- audience split ---- */}
          <div className="ibx-head__line">
            <span className="ibx-seg" role="group" aria-label="Inbox audience">
              <span className="ibx-seg__on" aria-current="true">
                you
              </span>
              {/* GAP 1: no seam read exists for another actor's notifications.
                  The count the oracle draws ("· 2") is deliberately NOT
                  rendered — nobody counted it. */}
              <span className="ibx-seg__off">
                <DisabledAction reason={TEAMMATE_AUDIENCE_REASON} label="your teammates">
                  your teammates
                </DisabledAction>
              </span>
            </span>
            <div className="ibx-spacer" />

            {/* ---- filters: both real, both over the loaded page ---- */}
            <button
              type="button"
              className={filters.unreadOnly ? 'ibx-chip ibx-chip--on' : 'ibx-chip'}
              aria-pressed={filters.unreadOnly}
              onClick={() => setFilters((f) => ({ ...f, unreadOnly: !f.unreadOnly }))}
              data-testid="inbox-filter-unread"
            >
              {filters.unreadOnly ? 'unread ✕' : 'unread'}
            </button>

            {types.length === 0 ? (
              <DisabledAction
                reason={{
                  cause: 'No notifications to filter',
                  remedy: 'the type filter offers the kinds actually present in the list',
                }}
                label="type"
              >
                type ▾
              </DisabledAction>
            ) : (
              <div className="ibx-menu-host">
                <button
                  type="button"
                  className={filters.kinds?.length ? 'ibx-chip ibx-chip--on' : 'ibx-chip'}
                  aria-expanded={typeMenuOpen}
                  onClick={() => setTypeMenuOpen((o) => !o)}
                  data-testid="inbox-filter-type"
                >
                  {filters.kinds?.length ? `type · ${filters.kinds.length} ✕` : 'type ▾'}
                </button>
                {typeMenuOpen ? (
                  <div className="ibx-menu" role="menu" data-testid="inbox-type-menu">
                    <button
                      type="button"
                      role="menuitem"
                      className="ibx-menu__item"
                      onClick={() => {
                        setFilters((f) => ({ ...f, kinds: null }));
                        setTypeMenuOpen(false);
                      }}
                    >
                      all types
                    </button>
                    {types.map((kind) => {
                      const on = filters.kinds?.includes(kind) ?? false;
                      return (
                        <button
                          key={kind}
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={on}
                          className="ibx-menu__item"
                          onClick={() =>
                            setFilters((f) => {
                              const current = f.kinds ?? [];
                              const next = on
                                ? current.filter((k) => k !== kind)
                                : [...current, kind];
                              return { ...f, kinds: next.length === 0 ? null : next };
                            })
                          }
                        >
                          <span aria-hidden>{on ? '✓' : '　'}</span> {kind.replace(/[_-]+/g, ' ')}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>

        {/* ---- the list ---- */}
        <div className="ibx-list">
          {groups.length === 0 ? (
            <p className="ibx-empty" data-testid="inbox-empty">
              {inboxEmptyNote(data.items, data.error, filters)}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.key} data-testid={`inbox-group-${group.key}`}>
                <div className={group.alarm ? 'ibx-gh ibx-gh--alarm' : 'ibx-gh'}>
                  <Eyebrow faint={!group.alarm}>{`${group.label} · ${group.countLabel}`}</Eyebrow>
                </div>
                {group.rows.map((row) => (
                  <Row
                    key={row.id}
                    row={row}
                    wired={rowsWired}
                    captionId={rowsCaptionId}
                    onOpen={() => openRow(row)}
                  />
                ))}
              </div>
            ))
          )}
        </div>

        {/* ---- the honest footer: absences, gaps, scope ---- */}
        <div className="ibx-foot">
          {absence && groups.length > 0 ? (
            <span className="ibx-note" data-testid="inbox-absence">
              {absence}
            </span>
          ) : null}
          {data.nextCursor ? (
            <span className="ibx-note" data-testid="inbox-more">
              {`showing the first ${allRows.length} — the node has more, and the filters above narrow only what is loaded`}
            </span>
          ) : null}
          {data.markError ? (
            <span className="ibx-note ibx-note--block" role="alert" data-testid="inbox-mark-error">
              {data.markError}
            </span>
          ) : null}
          {!rowsWired ? (
            <span className="ibx-note" id={rowsCaptionId} data-testid="inbox-rows-unwired">
              {`${ROW_NOT_WIRED_REASON.cause} — ${ROW_NOT_WIRED_REASON.remedy}`}
            </span>
          ) : (
            <span className="ibx-note">{CLICK_THROUGH_CAPTION}</span>
          )}
          {/* GAP 1 again, at the place the oracle draws a whole second card.
              Design law 9: a collapsed line carrying the fact beats an
              expanded empty section that steals height to say nothing. */}
          <span className="ibx-note" data-testid="inbox-teammate-absence">
            {`your teammates’ inbox — ${TEAMMATE_AUDIENCE_REASON.cause.toLowerCase()}; ${TEAMMATE_AUDIENCE_REASON.remedy}`}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * "mark all read" — the oracle's only bulk verb. There is NO bulk command on
 * the seam, so this is a real fan-out of `commands.markRead` over the unread
 * ids (a genuine dispatch, not a stub), and it is refused with the TRUE reason
 * whenever there is nothing to dispatch.
 */
function MarkAllControl({ data, unread }: { data: InboxData; unread: number }) {
  if (data.error) {
    return (
      <DisabledAction
        reason={{ cause: 'The inbox read failed', remedy: 'there are no rows to mark read' }}
        label="mark all read"
      >
        mark all read
      </DisabledAction>
    );
  }
  if (unread === 0) {
    return (
      <DisabledAction
        reason={{
          cause: 'Nothing is unread',
          remedy: 'the verb applies to unread rows and there are none',
        }}
        label="mark all read"
      >
        mark all read
      </DisabledAction>
    );
  }
  return (
    <button
      type="button"
      className="ibx-link"
      disabled={data.marking}
      onClick={() => void data.markAllRead()}
      data-testid="inbox-mark-all"
    >
      {data.marking ? 'marking…' : 'mark all read'}
    </button>
  );
}

function Row({
  row,
  wired,
  captionId,
  onOpen,
}: {
  row: InboxRow;
  wired: boolean;
  captionId: string;
  onOpen: () => void;
}) {
  const cls = [
    'ibx-row',
    row.unread ? 'ibx-row--unread' : 'ibx-row--read',
    row.group === 'delivery-failures' ? 'ibx-row--alarm' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const body = (
    <>
      {/* Unread marker. A read row keeps the SPACE (never reflows) but not the
          dot — "read rows fade, they never vanish". */}
      <span className={row.unread ? 'ibx-dot' : 'ibx-dot ibx-dot--off'} aria-hidden />
      {row.actor ? (
        <Avatar
          actorId={row.actor.id}
          provenance={row.actor.isAgent ? 'agent' : 'human'}
          label={row.actor.label}
          size={20}
          src={row.actor.avatar ?? null}
        />
      ) : (
        <span className="ibx-glyph" aria-hidden>
          ◬
        </span>
      )}
      <span className="ibx-row__body">
        <span className="ibx-row__head">
          <span className="ibx-row__title">{row.headline}</span>
          <span className="ibx-row__meta">
            {row.target ? (
              <>
                <span aria-hidden>{row.target.glyph}</span> {row.target.title} ·{' '}
              </>
            ) : null}
            {row.recency}
          </span>
        </span>
        {row.preview ? <span className="ibx-row__preview">{row.preview}</span> : null}
      </span>
    </>
  );

  return (
    <div className={cls} data-testid="inbox-row" data-unread={row.unread}>
      {wired ? (
        <button type="button" className="ibx-row__hit" onClick={onOpen}>
          {body}
        </button>
      ) : (
        /* Not hidden, not silently inert: aria-disabled + focusable, with the
           reason living once in the footer and referenced by every row rather
           than repeated forty times. */
        <span
          className="ibx-row__hit ibx-row__hit--off"
          role="button"
          aria-disabled="true"
          aria-describedby={captionId}
          tabIndex={0}
          data-testid="disabled-with-reason"
        >
          {body}
        </span>
      )}
      {row.group === 'delivery-failures' ? (
        <div className="ibx-row__action">
          {/* GAP 2. The oracle is explicit that the copy is "Send again",
              never "Retry" — a new send with a new record. */}
          <DisabledAction reason={SEND_AGAIN_REASON} label="Send again">
            Send again
          </DisabledAction>
        </div>
      ) : null}
    </div>
  );
}
