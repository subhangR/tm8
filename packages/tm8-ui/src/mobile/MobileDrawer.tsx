/**
 * THE NAVIGATION DRAWER — what the phone got when the five-destination tab bar
 * was removed.
 *
 * ── WHY THE BAR HAD TO GO, MEASURED RATHER THAN ASSERTED ───────────────────
 *
 * A tab bar is a PROMISE that the destinations it names are the places you go.
 * This space registers 19 collection kinds (`strategy: 'collection'`) and 12
 * view refs — 31 destinations. The bar named five. Docs, Projects, PRs,
 * Worktrees, Commits, Files, Artifacts, Memories, Collections, Spells, Skills,
 * Loops, Teammates, Members, Graphs, Board, Craft, Code and Settings were
 * unreachable on a phone except by pasting a URL, and the bar spent ~49px plus
 * the home-indicator inset on every screen to advertise 16% of the app. That is
 * not a curation; it is a cap.
 *
 * ── THIS IS THE DESKTOP RAIL, NOT A PHONE MENU (owner ruling 2, 2026-08-19) ─
 *
 * Same `VIEW_PRESENTATION` labels, same `KIND_ART` marks, same order — the
 * destinations come from `SHIPPED_DEFAULT_MENU`'s group spine and the entity
 * rows from `homeRailGroups()`, which is the very table the desktop Home rail
 * renders from. Nothing here names a kind or invents a word; if it did, the two
 * shells would drift and the product would start reading as two products. That
 * is also why this file imports from `domain/` rather than listing kinds: §15.2
 * makes a kind literal outside `domain/` a build failure, and the rule is doing
 * real work here.
 *
 * ── FOUR SECTIONS, IN ONE ORDER (owner ruling 3) ───────────────────────────
 *
 *   Chats        the conversation list — FIRST, because it is what a reader
 *                returns to. It is also where the ☰ used to lead on the chat
 *                screen, so nothing was taken away to make room for it.
 *   Destinations the view refs (Home, Inbox, Work, Board, Craft, Graph, Files)
 *   Entities     every collection kind, grouped as the desktop rail groups them
 *   Foot         Settings and the account
 *
 * ── A KIND ROW OPENS A FULL-SCREEN LIST (owner ruling 7) ───────────────────
 *
 * It navigates and dismisses. NO list is rendered inside the drawer: a panel
 * that expanded a kind into rows beside itself is a two-pane phone UI, which is
 * the arrangement the whole mobile shell exists to refuse. One surface.
 *
 * ── UNSEEN HAD TO SURVIVE THE BAR (owner ruling 5) ─────────────────────────
 *
 * Inbox left the always-visible row, so the unread fact has to be carried
 * somewhere or the drawer is a strictly worse Inbox and the change is a
 * regression. Two carriers: the ☰ itself takes an indicator when anything is
 * unread (`anyUnseen` below, read by `MobileShell`), and each kind row draws its
 * own count.
 *
 * ABSENT IS NOT ZERO, and it is load-bearing. `GateData.countsFor` answers
 * `undefined` for a kind the node could not count — `useGateData` swallows a
 * failed `spaces.counts` on purpose so the counters can never cost the boot. A
 * row that rendered `0` there would state a fact nobody established. So an
 * absent count draws NOTHING, and `anyUnseen` returns `null` rather than
 * `false` when it could not count at all, which is how the ☰ tells "everything
 * is read" apart from "nobody could say".
 */
import { useCallback, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { KindIcon, collectionKinds, homeRailGroups, type KindArt } from '../domain';
import { VectorIcon } from '../kit';
import { VIEW_PRESENTATION, type MenuTarget } from '../shell';
import type { ChatThreadSummary } from '../chat-home/types';
import type { EntityId, MenuViewRef } from '@tm8/contract';
import { useMobileSurface } from './surface';
import './mobile-drawer.css';

/** What the shell hands each row so it can say whether it is unread. */
export type CountsFor = (kind: string) => { total: number; unseen: number } | undefined;

/**
 * Is anything in this space unread?
 *
 * THREE ANSWERS, NOT TWO. `true` — something is unread. `false` — every kind
 * the node could count came back at zero. `null` — NOTHING could be counted, so
 * there is no fact here and the ☰ must draw no indicator rather than an
 * all-clear it has not earned. Collapsing `null` into `false` is the exact
 * shape of the absent-is-not-zero defect ruling 5 forbids, one level up.
 */
export function anyUnseen(countsFor: CountsFor): boolean | null {
  let counted = false;
  for (const config of collectionKinds()) {
    const counts = countsFor(config.kind);
    if (!counts) continue;
    counted = true;
    if (counts.unseen > 0) return true;
  }
  return counted ? false : null;
}

/**
 * THE DESTINATION SPINE — the view refs, in the desktop rail's own order.
 *
 * Taken from `SHIPPED_DEFAULT_MENU`'s groups rather than retyped, with two
 * deliberate departures that are both ruling 3:
 *
 *   `inbox` is INSERTED second. It is a `VIEW_PRESENTATION` ref with a finished
 *   screen and no menu group of its own (the desktop reaches it through Home);
 *   on a phone it was one of the five tabs, so leaving it out of the drawer
 *   would be the one destination this change actually removed.
 *
 *   `settings` is REMOVED from this list and drawn at the foot, where the
 *   ruling puts it beside the account.
 */
const DESTINATION_REFS: readonly MenuViewRef[] = [
  'dashboard',
  'inbox',
  'workspace',
  'board',
  'craft',
  'graph',
  'files',
];

/** The foot's one destination. Beside the account, per ruling 3. */
const SETTINGS_REF: MenuViewRef = 'settings';

/** ＋, on `VectorIcon`'s 16x16 grid — drawn, so it inherits the stroke weight. */
const PLUS_ART: KindArt = ['M8 3.25v9.5', 'M3.25 8h9.5'];

/** The account row's mark: a head over shoulders, same grid. */
const PERSON_ART: KindArt = ['M8 8.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8', 'M3.4 13.2a4.6 4.6 0 0 1 9.2 0'];

function sameTarget(a: MenuTarget | null, b: MenuTarget): boolean {
  if (!a || a.type !== b.type) return false;
  if (a.type === 'view' && b.type === 'view') return a.ref === b.ref;
  if (a.type === 'kind' && b.type === 'kind') return a.ref === b.ref;
  return false;
}

export interface MobileDrawerProps {
  /** The Space's name, for the drawer's own head. */
  readonly spaceLabel: string;
  /** What the shell is showing, so exactly one row reads as current. */
  readonly activeTarget: MenuTarget | null;
  /** The ONE shared navigation seam. This drawer builds no `Route`. */
  readonly navigateTo: (target: MenuTarget) => void;
  /** Per-kind counters. `undefined` for a kind the node could not count. */
  readonly countsFor: CountsFor;

  /** The conversation list — the first section. */
  readonly threads: readonly ChatThreadSummary[];
  readonly selectedThreadId: EntityId | null;
  readonly onSelectThread: (id: EntityId) => void;
  readonly onNewThread: () => void;

  /**
   * The header's Copy link, re-hosted in the foot beside Settings.
   *
   * AN ELEMENT, NOT A TARGET. The address is built from shell state the drawer
   * has no business re-deriving; handing over the finished control keeps the
   * one routing opinion in the one place that already holds it. `null` is a
   * real answer — the chat screen has nothing page-shaped to share.
   */
  readonly share?: ReactNode;
  /** The foot's account row. Absent ⇒ not drawn (there is nothing behind it). */
  readonly onOpenAccount?: (() => void) | undefined;
  /** The name to put on that row. */
  readonly accountName?: string | undefined;

  readonly onDismiss: () => void;
}

export function MobileDrawer(props: MobileDrawerProps) {
  const { sheetHost } = useMobileSurface();
  const { activeTarget, navigateTo, onDismiss } = props;

  /* Escape closes it, bound at the document exactly as `MobileSheet` binds its
     own — a phone has no Escape, but the shell is driven by a keyboard in every
     test and on every tablet that falls the phone side of the fork. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onDismiss();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onDismiss]);

  /* ONE PLACE THE DRAWER CLOSES ON NAVIGATION (ruling 7). Every row goes
     through this, so a row that forgot to dismiss is not a shape this file
     has. */
  const go = useCallback(
    (target: MenuTarget) => {
      navigateTo(target);
      onDismiss();
    },
    [navigateTo, onDismiss],
  );

  /* Inert off the phone, like every other portalled surface here: with no host
     there is nowhere for a modal layer to live, and rendering in place would
     put the drawer inside whatever screen happened to mount it. */
  if (!sheetHost) return null;

  return createPortal(
    <div
      className="mdrawer"
      data-testid="mobile-drawer"
      onClick={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <nav className="mdrawer__panel" role="dialog" aria-modal="true" aria-label="Navigation">
        <div className="mdrawer__head">
          <span className="mdrawer__space">{props.spaceLabel}</span>
          <button
            type="button"
            className="mdrawer__close"
            aria-label="Close navigation"
            onClick={onDismiss}
          >
            <span aria-hidden>✕</span>
          </button>
        </div>

        <div className="mdrawer__scroll">
          {/* ── CHATS ─────────────────────────────────────────────────────
              First, because it is what a reader returns to (ruling 3). The
              rows are the SAME summaries the chat screen publishes back
              through `onThreadsChange`, so this is one list with one source
              rather than a second read of the same thing. */}
          <Section label="Chats">
            <li>
              <button type="button" className="mdrawer__row mdrawer__row--verb" onClick={props.onNewThread}>
                <span className="mdrawer__mark" aria-hidden>
                  <VectorIcon paths={PLUS_ART} size={16} strokeWidth={1.6} />
                </span>
                <span className="mdrawer__name">New conversation</span>
              </button>
            </li>
            {props.threads.map((thread) => (
              <li key={thread.rootId}>
                <button
                  type="button"
                  className="mdrawer__row"
                  aria-current={thread.rootId === props.selectedThreadId ? 'true' : undefined}
                  onClick={() => props.onSelectThread(thread.rootId)}
                >
                  <span className="mdrawer__name mdrawer__name--stacked">
                    <span className="mdrawer__title">{thread.title}</span>
                    <span className="mdrawer__preview">{thread.preview}</span>
                  </span>
                </button>
              </li>
            ))}
            {props.threads.length === 0 ? (
              <li className="mdrawer__empty">No conversations on this space yet.</li>
            ) : null}
          </Section>

          {/* ── DESTINATIONS ──────────────────────────────────────────────
              The view refs, in the desktop rail's order and wearing the
              desktop rail's words and marks. */}
          <Section label="Destinations">
            {DESTINATION_REFS.map((ref) => (
              <ViewRow key={ref} viewRef={ref} activeTarget={activeTarget} onGo={go} />
            ))}
          </Section>

          {/* ── ENTITIES ──────────────────────────────────────────────────
              `homeRailGroups()` IS the desktop Home rail: same groups, same
              order, same membership, resolved against the live registry. A
              kind added to the registry appears here for free and in the same
              place it appears on a desktop — which is the whole of ruling 2
              expressed as a function call rather than as a list somebody has
              to remember to update. */}
          {homeRailGroups().map((group) => (
            <Section key={group.id} label={group.label}>
              {group.kinds.map((config) => {
                const target: MenuTarget = { type: 'kind', ref: config.kind };
                const counts = props.countsFor(config.kind);
                return (
                  <li key={config.kind}>
                    <button
                      type="button"
                      className="mdrawer__row"
                      aria-current={sameTarget(activeTarget, target) ? 'page' : undefined}
                      onClick={() => go(target)}
                    >
                      <span className="mdrawer__mark" aria-hidden>
                        <KindIcon kind={config.kind} size={16} />
                      </span>
                      <span className="mdrawer__name">{config.labelPlural}</span>
                      {/*
                        ABSENT IS NOT ZERO. `counts` is undefined for a kind the
                        node could not count, and there the row draws no number
                        at all rather than a `0` nobody established. A zero that
                        WAS counted is also not drawn — it is the resting state
                        of every row, and 19 zeroes is noise, not information.
                      */}
                      {counts && counts.unseen > 0 ? (
                        <span
                          className="mdrawer__count"
                          aria-label={`${counts.unseen} unread`}
                        >
                          {counts.unseen}
                        </span>
                      ) : null}
                      {/*
                        THE KIND TOTAL, WHICH USED TO BE `662` IN THE LIST'S OWN
                        BAR. It came off that bar with the chrome collapse, and
                        this is where it lands rather than nowhere: here it is
                        one of a column of totals against nineteen kinds, which
                        is the only reading that makes a total useful. Wedged in
                        the corner of a 390px band it was a number with nothing
                        to compare it to.

                        Same absent-is-not-zero rule as the unread count above,
                        and the same reason — the node may not have counted this
                        kind at all. A counted zero DOES draw here, unlike
                        unread: "0 tasks" is a fact about the space, where "0
                        unread" is the resting state of everything.
                      */}
                      {counts ? (
                        <span
                          className="mdrawer__total"
                          aria-label={`${counts.total} ${config.labelPlural.toLowerCase()}`}
                        >
                          {counts.total}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </Section>
          ))}
        </div>

        {/* ── THE FOOT ───────────────────────────────────────────────────
            Settings and the account, pinned below the scroll so they do not
            travel to the bottom of a 19-row list to be found (ruling 3). */}
        <div className="mdrawer__foot">
          {/* COPY LINK, off the 53px header. It is a verb about the screen the
              viewer is on, and it sits above Settings because Settings leaves
              that screen while this one is about it. Dismissing on activation
              would race the copy, so it does not — the control says "Copied"
              in place, and the viewer closes the drawer having seen it. */}
          {props.share ? <div className="mdrawer__share">{props.share}</div> : null}
          <ul className="mdrawer__rows">
            <ViewRow viewRef={SETTINGS_REF} activeTarget={activeTarget} onGo={go} />
            {/* Rendered only when the shell handed down something to open —
                the same honest-absence rule the header's avatar follows. */}
            {props.onOpenAccount ? (
              <li>
                <button
                  type="button"
                  className="mdrawer__row"
                  data-testid="mobile-drawer-account"
                  aria-haspopup="dialog"
                  onClick={() => {
                    props.onOpenAccount?.();
                    onDismiss();
                  }}
                >
                  <span className="mdrawer__mark" aria-hidden>
                    <VectorIcon paths={PERSON_ART} size={16} strokeWidth={1.4} />
                  </span>
                  <span className="mdrawer__name">{props.accountName ?? 'Account'}</span>
                </button>
              </li>
            ) : null}
          </ul>
        </div>
      </nav>
    </div>,
    sheetHost,
  );
}

/** One labelled band of rows. The label is a real heading for the a11y tree. */
function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mdrawer__section">
      <h2 className="mdrawer__label">{label}</h2>
      <ul className="mdrawer__rows">{children}</ul>
    </div>
  );
}

/**
 * One view destination, named and marked by `VIEW_PRESENTATION` — the desktop
 * rail's own table, so "File browser" reads "File browser" on both shells and
 * neither can be renamed without the other following.
 */
function ViewRow({
  viewRef,
  activeTarget,
  onGo,
}: {
  viewRef: MenuViewRef;
  activeTarget: MenuTarget | null;
  onGo: (target: MenuTarget) => void;
}) {
  const presentation = VIEW_PRESENTATION[viewRef];
  const target: MenuTarget = { type: 'view', ref: viewRef };
  return (
    <li>
      <button
        type="button"
        className="mdrawer__row"
        aria-current={sameTarget(activeTarget, target) ? 'page' : undefined}
        onClick={() => onGo(target)}
      >
        <span className="mdrawer__mark" aria-hidden>
          <VectorIcon paths={presentation.art} size={16} />
        </span>
        <span className="mdrawer__name">{presentation.label}</span>
      </button>
    </li>
  );
}
