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
 *   ＋ New chat  the primary button, above every section (drawer mockup v3).
 *   Chats        ＋ New {kind} and ONE row that opens the conversation list. FIRST, because it is
 *                what a reader returns to. It is also where the ☰ used to lead
 *                on the chat screen, so nothing was taken away to make room
 *                for it.
 *
 *                THE SECOND VERB IS THERE because opening this drawer to
 *                START something was only ever answered one way. Making a
 *                task meant a kind row, a list screen and its header's ＋ —
 *                three taps for the thing a reader reaches for as often as a
 *                conversation. It runs the SHELL'S create (`useNewTask`, the
 *                desktop's own flow) and takes its word from the registry, so
 *                the drawer still names no kind.
 *
 *                IT USED TO BE THE LIST ITSELF, inline, and that was the one
 *                thing ruling 7 below says this drawer never does. It held
 *                while a space had three conversations; at eight it put every
 *                entity kind in the app below a population that grows without
 *                bound, and reaching Tasks meant scrolling past every
 *                conversation anyone had started (owner report 2026-09-15,
 *                task 01a0a5f2). The list moved to `MobileThreadsSheet`, whose
 *                head carries the rest of the reasoning — including why a chat
 *                thread cannot simply become a kind row in the Entities band.
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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { KIND_ART, KindIcon, collectionKinds, getKind, homeRailGroups, type KindArt, type KindConfig } from '../domain';
import { isNavigatorEnabled } from '../tab-workspace/view/navigatorFlag';
import { loadWorkspaceRailPins, workspacePinnedKinds } from '../tab-workspace/runtime/railStore';
import { VectorIcon } from '../kit';
import { VIEW_PRESENTATION, type MenuTarget } from '../shell';
import type { EntityKind, MenuViewRef } from '@tm8/contract';
import { useMobileSurface } from './surface';
import './mobile-drawer.css';
import { useCustomKindsVersion } from '../data/custom-kinds';

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

/** The foot's destinations. Beside the account, per ruling 3. */
const SETTINGS_REF: MenuViewRef = 'settings';
/**
 * The phone has no top-tab row, so its Help destination remains in the foot
 * with Settings and account. This is the mobile expression of desktop's final
 * Help tab, not a second Help door in the desktop chrome.
 */
const HELP_REF: MenuViewRef = 'help';

/** ＋, on `VectorIcon`'s 16x16 grid — drawn, so it inherits the stroke weight. */
const PLUS_ART: KindArt = ['M8 3.25v9.5', 'M3.25 8h9.5'];

/**
 * The Chats row's mark: THE chat mark, read from the shared table so the phone
 * draws chat the way every other surface does (`kind-art.test.ts` fails on a
 * private copy).
 *
 * NOT `KindIcon('channel')`, and the distinction is the whole reason this row
 * is not in the Entities band — a channel is an entity with a slug and a
 * collection route, a conversation is an anchored message subtree. Wearing the
 * channel's # would say they were the same population, and the Channels row
 * three sections down would then be an unexplained duplicate.
 */
const CHAT_ART: KindArt = KIND_ART.chat;

/**
 * The second verb's word, off the registry.
 *
 * `palette.createLabel` is the SAME string `EntityCreateControl` renders for
 * this kind, which is the point — the drawer is not allowed a second opinion
 * about what creating a task is called. The fallback covers a kind whose row
 * carries no palette; it is built from the registry's label, still not from a
 * word written here.
 */
function newEntityLabel(kind: EntityKind): string {
  const config = getKind(kind);
  return config.palette?.createLabel ?? `New ${config.label.toLowerCase()}`;
}

/** The account row's mark: the `member` kind's person — you ARE a member. */
const PERSON_ART: KindArt = KIND_ART.member;

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

  /**
   * How many conversations the space has, for the Chats row's counter.
   *
   * ABSENT IS NOT ZERO here too: the shell only learns the count once the chat
   * screen has published its threads back, so before that there is no fact and
   * the row draws no number rather than claiming none exist.
   */
  readonly chatCount?: number | undefined;
  /** Opens the conversation list. The drawer renders no list of its own. */
  readonly onOpenChats: () => void;
  readonly onNewThread: () => void;

  /**
   * THE SECOND VERB, and the kind it makes.
   *
   * A reader who opens this drawer to start something is as likely to be
   * starting a piece of WORK as a conversation, and until now the only verb
   * here made a conversation — so the other half of the answer was three taps
   * away through a kind row and a list header. Two verbs, side by side.
   *
   * THE KIND TRAVELS, THE WORD DOES NOT. `onNewEntity` is the shell's create
   * — `useNewTask`'s, the same flow the desktop's ＋ runs, not a second one —
   * and the label is read off the registry's own `palette.createLabel` here,
   * exactly as the kind rows below read their names. This file names no kind,
   * and the head says why that matters.
   */
  readonly newEntityKind: EntityKind;
  readonly onNewEntity: () => void;
  /**
   * Why that create cannot run right now, or null/absent when it can.
   *
   * REFUSED, NEVER HIDDEN, and never a live button that does nothing (R7).
   * The row stays in place, states the cause, and does not fire — a verb that
   * vanishes when the seam is missing teaches the reader the feature does not
   * exist.
   */
  readonly newEntityUnavailable?: { cause: string; remedy: string } | null | undefined;

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

  /**
   * The Space, for the navigator drawer's pins (§8: the SAME `railStore` order
   * as the desktop column — the two shells read one preference, as they read
   * one kind table). Absent ⇒ the default pins.
   */
  readonly spaceId?: string | undefined;

  readonly onDismiss: () => void;
}

export function MobileDrawer(props: MobileDrawerProps) {
  useCustomKindsVersion();
  const { sheetHost } = useMobileSurface();
  const { activeTarget, navigateTo, onDismiss } = props;
  const navigator = useMemo(() => isNavigatorEnabled(), []);
  const [allKindsOpen, setAllKindsOpen] = useState(false);
  /* Read, not subscribed: the drawer is mounted for the moment it is open, and
     pinning happens on the desktop column. */
  const pinnedKinds = useMemo(
    () => (props.spaceId ? workspacePinnedKinds(loadWorkspaceRailPins(props.spaceId)) : []),
    [props.spaceId],
  );

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
              First, because it is what a reader returns to (ruling 3). TWO
              ROWS, not the list: the verb, and a door to the list. The list
              itself is `MobileThreadsSheet`, which still renders the SAME
              summaries the chat screen publishes back through
              `onThreadsChange` — one list with one source, now on a surface
              that can hold it. */}
          {/* ── ＋ NEW CHAT ────────────────────────────────────────────────
              THE drawer's primary action (drawer mockup v3), so it is drawn
              as one: a filled button above every section rather than a row
              inside Chats. It opens a fresh, empty chat and closes the drawer
              — never a picker and never the conversation list, which is what
              the Conversations row below is for. The shell's `onNewThread`
              does the clearing, the navigating and the dismissing. */}
          <div className="mdrawer__primary">
            <button
              type="button"
              className="mdrawer__new"
              data-testid="mobile-drawer-new-chat"
              onClick={props.onNewThread}
            >
              <VectorIcon paths={PLUS_ART} size={16} strokeWidth={1.8} />
              <span>New chat</span>
            </button>
          </div>
          <Section label="Chats">
            <li>
              {/* THE WORK VERB, beside the chat one. Its word comes
                  from the registry so the drawer and the desktop's ＋ cannot
                  come to say different things about the same create.

                  DISABLED-WITH-REASON RATHER THAN ABSENT when the seam cannot
                  create: `aria-disabled` keeps the row in the tab order (a
                  `disabled` attribute would take it out, D28) while the guard
                  below is what actually stops the press. */}
              <button
                type="button"
                className="mdrawer__row mdrawer__row--verb"
                data-testid="mobile-drawer-new-entity"
                {...(props.newEntityUnavailable
                  ? { 'aria-disabled': true as const, title: props.newEntityUnavailable.cause }
                  : {})}
                onClick={() => {
                  if (props.newEntityUnavailable) return;
                  props.onNewEntity();
                }}
              >
                <span className="mdrawer__mark" aria-hidden>
                  <VectorIcon paths={PLUS_ART} size={16} strokeWidth={1.6} />
                </span>
                <span className="mdrawer__name">{newEntityLabel(props.newEntityKind)}</span>
              </button>
            </li>
            <li>
              {/* ONE ROW, SHAPED LIKE A KIND ROW — mark, name, total — so the
                  conversations read as one more population of the space rather
                  than as a band of the menu. It opens a full-screen list and
                  dismisses, which is what every other row in this drawer does.

                  It does NOT go through `go()`: the sheet is not a `MenuTarget`
                  and this drawer builds no routes. Dismissing here is the same
                  dismissal for the same reason, written out because the shared
                  helper cannot carry it. */}
              <button
                type="button"
                className="mdrawer__row"
                data-testid="mobile-drawer-chats"
                aria-haspopup="dialog"
                onClick={() => {
                  props.onOpenChats();
                  onDismiss();
                }}
              >
                <span className="mdrawer__mark" aria-hidden>
                  <VectorIcon paths={CHAT_ART} size={16} strokeWidth={1.4} />
                </span>
                <span className="mdrawer__name">Conversations</span>
                {/* Absent is not zero — see `chatCount`. A counted zero DOES
                    draw, exactly as a kind total does: "0 conversations" is a
                    fact about the space and the reason the row still exists. */}
                {props.chatCount !== undefined ? (
                  <span className="mdrawer__total" aria-label={`${props.chatCount} conversations`}>
                    {props.chatCount}
                  </span>
                ) : null}
              </button>
            </li>
          </Section>

          {/* ── NEW · PINS · ALL KINDS, or the four bands ────────────────
              THE MERGED NAVIGATOR'S DRAWER (design doc 01a1465d-a2b7 §8).
              With `tm8.ui.navigator` on the drawer carries the navigator's TOP
              HALF and nothing else: the New verbs above, the same pins in the
              same `railStore` order, and All kinds.

              THE LIST IS STILL NOT IN HERE (ruling 7, Sep 15). A pin NAVIGATES
              to that kind's full-screen list and dismisses, which is what every
              row in this drawer has always done — §8 says so in the same words
              the ruling does.

              ALL KINDS IS A DISCLOSURE, NOT A REPLACEMENT. The desktop's All
              kinds is a popover over a column that still has a footer; a phone
              drawer is the ONLY door to Inbox, Board, Craft, Graph and Files,
              so folding them away for good would remove five destinations to
              tidy up one. They move inside the disclosure, closed by default:
              the resting drawer is New + pins + All kinds, and nothing became
              unreachable. */}
          {navigator ? (
            <>
              <Section label="Pinned">
                {pinnedKinds.map((config) => (
                  <KindRow
                    key={config.kind}
                    config={config}
                    counts={props.countsFor(config.kind)}
                    activeTarget={activeTarget}
                    unseenAs="dot"
                    onGo={go}
                  />
                ))}
              </Section>
              <div className="mdrawer__section">
                <button
                  type="button"
                  className="mdrawer__row mdrawer__row--verb"
                  aria-expanded={allKindsOpen}
                  data-testid="mobile-drawer-all-kinds"
                  onClick={() => setAllKindsOpen((open) => !open)}
                >
                  <span className="mdrawer__mark" aria-hidden>
                    {allKindsOpen ? '▾' : '▸'}
                  </span>
                  <span className="mdrawer__name">All kinds</span>
                </button>
              </div>
              {allKindsOpen ? (
                <>
                  <Section label="Destinations">
                    {DESTINATION_REFS.map((ref) => (
                      <ViewRow key={ref} viewRef={ref} activeTarget={activeTarget} onGo={go} />
                    ))}
                  </Section>
                  {homeRailGroups().map((group) => (
                    <Section key={group.id} label={group.label}>
                      {group.kinds.map((config) => (
                        <KindRow
                          key={config.kind}
                          config={config}
                          counts={props.countsFor(config.kind)}
                          activeTarget={activeTarget}
                          unseenAs="dot"
                          onGo={go}
                        />
                      ))}
                    </Section>
                  ))}
                </>
              ) : null}
            </>
          ) : (
            <>
              {/* ── DESTINATIONS ──────────────────────────────────────────
                  The view refs, in the desktop rail's order and wearing the
                  desktop rail's words and marks. */}
              <Section label="Destinations">
                {DESTINATION_REFS.map((ref) => (
                  <ViewRow key={ref} viewRef={ref} activeTarget={activeTarget} onGo={go} />
                ))}
              </Section>

              {/* ── ENTITIES ──────────────────────────────────────────────
                  `homeRailGroups()` IS the desktop Home rail: same groups, same
                  order, same membership, resolved against the live registry. A
                  kind added to the registry appears here for free and in the
                  same place it appears on a desktop. */}
              {homeRailGroups().map((group) => (
                <Section key={group.id} label={group.label}>
                  {group.kinds.map((config) => (
                    <KindRow
                      key={config.kind}
                      config={config}
                      counts={props.countsFor(config.kind)}
                      activeTarget={activeTarget}
                      /* FLAG OFF IS UNCHANGED: today's drawer keeps the numeric
                         pill it shipped with. */
                      unseenAs="count"
                      onGo={go}
                    />
                  ))}
                </Section>
              ))}
            </>
          )}
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
            <ViewRow viewRef={HELP_REF} activeTarget={activeTarget} onGo={go} />
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

/**
 * ONE KIND ROW — mark, name, unread, total. Lifted out of the Entities bands
 * unchanged when the merged navigator's drawer (§8) needed the SAME row under
 * Pinned: two copies would be two answers to absent-is-not-zero, which the
 * head spends four paragraphs establishing.
 */
function KindRow({
  config,
  counts,
  activeTarget,
  unseenAs,
  onGo,
}: {
  config: KindConfig;
  counts: { total: number; unseen: number } | undefined;
  activeTarget: MenuTarget | null;
  /**
   * HOW UNREAD IS DRAWN: `'count'` is the filled numeric pill this row has
   * always had, `'dot'` the unnumbered mark the navigator's drawer uses (§8;
   * QA finding 4, ruled 2026-10-17). The navigator's drawer passes `'dot'` on
   * EVERY row it draws — Pinned and the All-kinds groups alike — so one
   * drawer never gives two answers to "what does unread look like", which is
   * the whole reason this component was lifted out rather than copied.
   */
  unseenAs: 'count' | 'dot';
  onGo: (target: MenuTarget) => void;
}) {
  const target: MenuTarget = { type: 'kind', ref: config.kind };
  return (
    <li>
      <button
        type="button"
        className="mdrawer__row"
        aria-current={sameTarget(activeTarget, target) ? 'page' : undefined}
        onClick={() => onGo(target)}
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
          /*
            A DOT, NOT A SECOND NUMBER, in the navigator's drawer. Unread and
            the kind total are different facts that COINCIDE in a fresh space —
            nine tasks, none of them seen — and drawn as two numerals they read
            as one number printed twice ("Tasks 9 9"). The dot keeps the call to
            act and drops the arithmetic: there is something new here, and there
            are nine of these. The exact figure is not lost, it is undrawn —
            `aria-label` still says "9 unread" either way.
          */
          <span
            className={unseenAs === 'dot' ? 'mdrawer__unseen-dot' : 'mdrawer__count'}
            aria-label={`${counts.unseen} unread`}
          >
            {unseenAs === 'dot' ? null : counts.unseen}
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
}
