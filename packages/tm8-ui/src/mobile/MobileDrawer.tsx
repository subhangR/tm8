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
 * ── TOP TO BOTTOM (drawer mockup v3, task 01a14ccc, 2026-10-18) ──────────
 *
 *   ＋ New chat  the one verb. A conversation is what a reader opens this
 *                drawer to start.
 *   Trees        Chats, Sessions, Docs, Tasks (`drawerTreeKinds()`), each a
 *                collapsible section, COLLAPSED BY DEFAULT. Expanding one shows
 *                its most recent items; an item with children (launched
 *                sessions under their root, sub-docs, subtasks) has a ▸ and
 *                expands in place. "See all" opens the phone list route.
 *   Pinned       the desktop rail's pins (`railStore`), as the same trees,
 *                skipping kinds already drawn above.
 *   All kinds    a disclosure, closed by default, holding every other kind and
 *                the view destinations the drawer is still the only door to.
 *                Home, Work and Inbox are NOT here: chat is home, and the
 *                mockup gives them no row.
 *   Foot         Help, Settings and the account
 *
 * ── THIS REPLACES OWNER RULING 7 ("no list inside the drawer") ─────────────
 *
 * Ruling 7 refused a list beside the drawer because the old drawer had no
 * bound: the inline thread list pushed every kind below a population that
 * grows without limit (task 01a0a5f2). The trees keep that bound — each
 * section is closed until asked, and an open one draws a handful of recent
 * items and a See all, never the population. Tapping an item still navigates
 * and dismisses through the one `go()`/`open()` pair below.
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

import {
  KIND_ART,
  KindIcon,
  collectionKinds,
  drawerTreeKinds,
  getKind,
  homeRailGroups,
  isDrawerChatKind,
  type KindArt,
  type KindConfig,
} from '../domain';
import { loadWorkspaceRailPins, workspacePinnedKinds } from '../tab-workspace/runtime/railStore';
import { VectorIcon } from '../kit';
import { VIEW_PRESENTATION, type MenuTarget } from '../shell';
import type { EntityId, EntitySummary, MenuViewRef } from '@tm8/contract';
import type { SessionLiveness } from '../data/seam';
import { homeRowOf } from '../home/home-model';
import { relativeTime } from '../messages/messages-model';
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
 * THE DESTINATIONS THE DRAWER IS STILL THE ONLY DOOR TO, in the desktop rail's
 * order. Home (`dashboard`, the chat screen), Work (`workspace`) and Inbox
 * left the drawer with mockup v3: chat is home, Work is desktop-only (Spec A
 * §2), and the ☰'s attention dot carries unread. What remains sits inside All
 * kinds so nothing that had a door lost it.
 */
const DESTINATION_REFS: readonly MenuViewRef[] = ['board', 'craft', 'graph', 'files'];

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

/** The account row's mark: the `member` kind's person — you ARE a member. */
const PERSON_ART: KindArt = KIND_ART.member;

/** How many recent roots an open section draws before its See all. */
export const DRAWER_RECENT_LIMIT = 5;
/** How many children an open item draws before its own See all. */
export const DRAWER_CHILD_LIMIT = 6;
/** Trees nest, but a phone drawer is 322px wide: three levels and stop. */
const MAX_DEPTH = 3;

/*
 * WHAT IS OPEN, REMEMBERED FOR THE LIFE OF THE PAGE. The drawer unmounts every
 * time it closes, so state held in it would re-collapse every section on every
 * open — a reader who opened Sessions to watch a run would open it again each
 * time. Collapsed is still the default: nothing is in here until a tap puts it
 * here, and nothing is persisted across a reload.
 */
const openKeys = new Set<string>();

function useOpen(key: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => openKeys.has(key));
  const toggle = useCallback(() => {
    setOpen((was) => {
      if (was) openKeys.delete(key);
      else openKeys.add(key);
      return !was;
    });
  }, [key]);
  return [open, toggle];
}

/** Test seam: forget every remembered section. */
export function resetDrawerOpenState(): void {
  openKeys.clear();
}

function sameTarget(a: MenuTarget | null, b: MenuTarget): boolean {
  if (!a || a.type !== b.type) return false;
  if (a.type === 'view' && b.type === 'view') return a.ref === b.ref;
  if (a.type === 'kind' && b.type === 'kind') return a.ref === b.ref;
  return false;
}

const byActivity = (a: EntitySummary, b: EntitySummary) =>
  a.activityAt < b.activityAt ? 1 : a.activityAt > b.activityAt ? -1 : 0;

/**
 * ONE KIND'S LOADED ROWS AS A FOREST.
 *
 * A root is a row whose parent is not another loaded row of the same kind — a
 * launched session whose root session is loaded hangs under it; one whose root
 * is not on this page stands as a root of its own rather than vanishing.
 * Children come from the same rows, so expanding an item costs no read.
 */
export function drawerForest(rows: readonly EntitySummary[]): {
  roots: EntitySummary[];
  childrenOf: (id: EntityId) => EntitySummary[];
} {
  const live = rows.filter((row) => !row.deletedAt);
  const ids = new Set(live.map((row) => row.id));
  const children = new Map<string, EntitySummary[]>();
  const roots: EntitySummary[] = [];
  for (const row of live) {
    if (row.parentId && ids.has(row.parentId) && row.parentId !== row.id) {
      const list = children.get(row.parentId) ?? [];
      list.push(row);
      children.set(row.parentId, list);
    } else {
      roots.push(row);
    }
  }
  roots.sort(byActivity);
  for (const list of children.values()) list.sort(byActivity);
  return { roots, childrenOf: (id) => children.get(id) ?? [] };
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
   * One kind's loaded rows — `GateData.rowsFor(kind)(undefined)`, the same
   * unfiltered read the phone list draws. Read only for an OPEN section.
   */
  readonly rowsOf: (kind: string) => readonly EntitySummary[];
  /** Hydrate a kind when its section opens. Idempotent (`GateData.ensureKind`). */
  readonly ensureKind: (kind: string) => void;
  /** The seam's liveness verdict, so a session row says running/waiting. */
  readonly livenessOf?: ((id: string) => SessionLiveness) | undefined;
  /** Open one entity on the phone (`openEntityOnPhone`). */
  readonly onOpenEntity: (id: EntityId, kind: string) => void;
  /** Open one conversation in the chat screen. */
  readonly onOpenChat: (id: EntityId) => void;

  /**
   * How many attention requests are waiting — the SAME number the attention
   * button and sheet title use (mine when any are mine, else all). The
   * "Needs you" row draws only when this is above zero; absent ⇒ no row.
   */
  readonly needsYouCount?: number | undefined;
  /** Opens the `AttentionSheet`. The chat screen has no header to carry it. */
  readonly onOpenAttention?: (() => void) | undefined;

  /** Opens the conversation list — the Chats section's See all. */
  readonly onOpenChats: () => void;
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

  /**
   * The Space, for the pins (§8: the SAME `railStore` order as the desktop
   * column — the two shells read one preference, as they read one kind
   * table). Absent ⇒ no pins.
   */
  readonly spaceId?: string | undefined;

  readonly onDismiss: () => void;
}

/** What every tree in one drawer shares, threaded down once. */
interface TreeContext {
  readonly rowsOf: MobileDrawerProps['rowsOf'];
  readonly ensureKind: MobileDrawerProps['ensureKind'];
  readonly livenessOf: MobileDrawerProps['livenessOf'];
  readonly countsFor: CountsFor;
  readonly activeTarget: MenuTarget | null;
  readonly now: Date;
  readonly openItem: (row: EntitySummary) => void;
  readonly seeAll: (config: KindConfig) => void;
}

export function MobileDrawer(props: MobileDrawerProps) {
  useCustomKindsVersion();
  const { sheetHost } = useMobileSurface();
  const { activeTarget, navigateTo, onDismiss, onOpenEntity, onOpenChat, onOpenChats } = props;
  const [allKindsOpen, toggleAllKinds] = useOpen('all-kinds');

  const treeKinds = useMemo(() => drawerTreeKinds(), []);
  /* Read, not subscribed: the drawer is mounted for the moment it is open, and
     pinning happens on the desktop column. Kinds already drawn as trees above
     are skipped, so no kind is drawn twice. */
  const pinnedKinds = useMemo(() => {
    const shown = new Set(treeKinds.map((config) => config.kind));
    return props.spaceId
      ? workspacePinnedKinds(loadWorkspaceRailPins(props.spaceId)).filter((config) => !shown.has(config.kind))
      : [];
  }, [props.spaceId, treeKinds]);
  const otherGroups = useMemo(() => {
    const shown = new Set([...treeKinds, ...pinnedKinds].map((config) => config.kind));
    return homeRailGroups()
      .map((group) => ({ ...group, kinds: group.kinds.filter((config) => !shown.has(config.kind)) }))
      .filter((group) => group.kinds.length > 0);
  }, [treeKinds, pinnedKinds]);

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

  /* ONE PLACE THE DRAWER CLOSES ON NAVIGATION. Every row goes through `go` or
     `openItem`, so a row that forgot to dismiss is not a shape this file has.
     Expanding a section or an item is the only press that keeps it open. */
  const go = useCallback(
    (target: MenuTarget) => {
      navigateTo(target);
      onDismiss();
    },
    [navigateTo, onDismiss],
  );
  const openItem = useCallback(
    (row: EntitySummary) => {
      if (isDrawerChatKind(row.kind)) onOpenChat(row.id);
      else onOpenEntity(row.id, row.kind);
      onDismiss();
    },
    [onOpenChat, onOpenEntity, onDismiss],
  );
  const seeAll = useCallback(
    (config: KindConfig) => {
      /* The Chats section's See all is the conversation list, the surface a
         thread is picked from; every other kind's is its phone list route. */
      if (isDrawerChatKind(config.kind)) {
        onOpenChats();
        onDismiss();
      } else {
        go({ type: 'kind', ref: config.kind });
      }
    },
    [go, onOpenChats, onDismiss],
  );

  const ctx: TreeContext = {
    rowsOf: props.rowsOf,
    ensureKind: props.ensureKind,
    livenessOf: props.livenessOf,
    countsFor: props.countsFor,
    activeTarget,
    now: new Date(),
    openItem,
    seeAll,
  };

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
          {/* ── ＋ NEW CHAT ────────────────────────────────────────────────
              The one verb, first, and the only filled control in the drawer. */}
          <button
            type="button"
            className="mdrawer__new"
            data-testid="mobile-drawer-new-chat"
            onClick={props.onNewThread}
          >
            <VectorIcon paths={PLUS_ART} size={16} strokeWidth={1.8} />
            <span>New chat</span>
          </button>

          {/* ── NEEDS YOU ─────────────────────────────────────────────────
              The chat screen lost its header, and with it the attention
              button; the floating ☰ carries the dot, so the drawer it opens
              carries the door. Drawn only when something is waiting. */}
          {props.onOpenAttention && (props.needsYouCount ?? 0) > 0 ? (
            <button
              type="button"
              className="mdrawer__row mdrawer__needs"
              data-testid="mobile-drawer-needs-you"
              aria-haspopup="dialog"
              aria-label={`Needs you: ${props.needsYouCount} waiting`}
              onClick={() => {
                props.onOpenAttention?.();
                onDismiss();
              }}
            >
              <span className="mdrawer__needs-dot" aria-hidden />
              <span className="mdrawer__name">Needs you</span>
              <span className="mdrawer__needs-count" aria-hidden>
                {props.needsYouCount}
              </span>
            </button>
          ) : null}

          {/* ── THE TREES ─────────────────────────────────────────────────
              Chats, Sessions, Docs, Tasks — collapsed until tapped. */}
          <ul className="mdrawer__trees" data-testid="mobile-drawer-trees">
            {treeKinds.map((config) => (
              <KindTree key={config.kind} config={config} ctx={ctx} />
            ))}
          </ul>

          {pinnedKinds.length > 0 ? (
            <div className="mdrawer__section">
              <h2 className="mdrawer__label">Pinned</h2>
              <ul className="mdrawer__trees">
                {pinnedKinds.map((config) => (
                  <KindTree key={config.kind} config={config} ctx={ctx} />
                ))}
              </ul>
            </div>
          ) : null}

          {/* ── ALL KINDS ─────────────────────────────────────────────────
              A DISCLOSURE, NOT A REMOVAL. The drawer is the only door a phone
              has to Board, Craft, Graph, Files and the long tail of kinds, so
              they fold away here, closed by default, rather than going. */}
          <div className="mdrawer__section">
            <button
              type="button"
              className="mdrawer__kindhead mdrawer__kindhead--quiet"
              aria-expanded={allKindsOpen}
              data-testid="mobile-drawer-all-kinds"
              onClick={toggleAllKinds}
            >
              <span className="mdrawer__twisty" aria-hidden>
                ▸
              </span>
              <span className="mdrawer__name">All kinds</span>
            </button>
            {allKindsOpen ? (
              <>
                {otherGroups.map((group) => (
                  <div key={group.id} className="mdrawer__group">
                    <h2 className="mdrawer__label">{group.label}</h2>
                    <ul className="mdrawer__trees">
                      {group.kinds.map((config) => (
                        <KindTree key={config.kind} config={config} ctx={ctx} />
                      ))}
                    </ul>
                  </div>
                ))}
                <div className="mdrawer__group">
                  <h2 className="mdrawer__label">Views</h2>
                  <ul className="mdrawer__rows">
                    {DESTINATION_REFS.map((ref) => (
                      <ViewRow key={ref} viewRef={ref} activeTarget={activeTarget} onGo={go} />
                    ))}
                  </ul>
                </div>
              </>
            ) : null}
          </div>
        </div>

        {/* ── THE FOOT ───────────────────────────────────────────────────
            Settings and the account, pinned below the scroll so they do not
            travel to the bottom of a long list to be found (ruling 3). */}
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
 * ONE KIND AS A COLLAPSIBLE TREE — the header (mark, name, unread, total) and,
 * once opened, its most recent roots and a See all.
 */
function KindTree({ config, ctx }: { config: KindConfig; ctx: TreeContext }) {
  const [open, toggle] = useOpen(`kind:${config.kind}`);
  const { ensureKind } = ctx;
  /* Hydrated when OPENED, not when the drawer mounts: a closed section costs
     no read, which is what lets every kind sit here collapsed. */
  useEffect(() => {
    if (open) ensureKind(config.kind);
  }, [open, ensureKind, config.kind]);

  const counts = ctx.countsFor(config.kind);
  const target: MenuTarget = { type: 'kind', ref: config.kind };
  const bodyId = `mdrawer-tree-${config.kind}`;
  const rows = open ? ctx.rowsOf(config.kind) : null;
  const forest = useMemo(() => (rows ? drawerForest(rows) : null), [rows]);
  const label = config.labelPlural;

  return (
    <li className="mdrawer__tree" data-kind={config.kind} data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className="mdrawer__kindhead"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-current={sameTarget(ctx.activeTarget, target) ? 'page' : undefined}
        data-testid={`mobile-drawer-kind-${config.kind}`}
        onClick={toggle}
      >
        <span className="mdrawer__twisty" aria-hidden>
          ▸
        </span>
        <span className="mdrawer__mark" aria-hidden>
          <KindIcon kind={config.kind} size={16} />
        </span>
        <span className="mdrawer__name">{label}</span>
        {/*
          ABSENT IS NOT ZERO. `counts` is undefined for a kind the node could
          not count, and there the header draws nothing rather than a `0`
          nobody established. Unread draws as a DOT, never a second numeral:
          in a fresh space unread and total coincide and "Tasks 9 9" reads as
          one number printed twice. `aria-label` still says the figure.
        */}
        {counts && counts.unseen > 0 ? (
          <span className="mdrawer__unseen-dot" aria-label={`${counts.unseen} unread`} />
        ) : null}
        {/* A counted zero DOES draw: "0 tasks" is a fact about the space. */}
        {counts ? (
          <span className="mdrawer__total" aria-label={`${counts.total} ${label.toLowerCase()}`}>
            {counts.total}
          </span>
        ) : null}
      </button>
      {open && forest ? (
        <ul className="mdrawer__branch" id={bodyId}>
          {forest.roots.length === 0 ? (
            <li className="mdrawer__empty">
              {/* Nothing loaded yet is not "none": only a counted zero says so. */}
              {counts?.total === 0 ? `No ${label.toLowerCase()} yet` : 'Loading…'}
            </li>
          ) : (
            forest.roots
              .slice(0, DRAWER_RECENT_LIMIT)
              .map((row) => <ItemNode key={row.id} row={row} forest={forest} depth={1} ctx={ctx} />)
          )}
          <li>
            <button
              type="button"
              className="mdrawer__seeall"
              data-testid={`mobile-drawer-see-all-${config.kind}`}
              onClick={() => ctx.seeAll(config)}
            >
              See all {label.toLowerCase()} ›
            </button>
          </li>
        </ul>
      ) : null}
    </li>
  );
}

/** The subtitle under an item: how many children, and how recent. */
function itemDetail(row: EntitySummary, childTotal: number, now: Date): string {
  const parts: string[] = [];
  if (childTotal > 0) {
    const config = getKind(row.kind);
    const noun = (childTotal === 1 ? config.label : config.labelPlural).toLowerCase();
    parts.push(`${childTotal} sub-${noun}`);
  }
  const when = relativeTime(row.activityAt, now);
  if (when) parts.push(when);
  return parts.join(' · ');
}

/**
 * ONE ITEM, and its children in place. The row body OPENS the item; the ▸ is
 * its own control and EXPANDS it — two verbs, two targets, so opening a
 * session that has workers never needs a second tap through its children.
 */
function ItemNode({
  row,
  forest,
  depth,
  ctx,
}: {
  row: EntitySummary;
  forest: ReturnType<typeof drawerForest>;
  depth: number;
  ctx: TreeContext;
}) {
  const [open, toggle] = useOpen(`item:${row.id}`);
  const children = forest.childrenOf(row.id);
  /* The server's live child count is the TRUE number; the loaded children may
     be one page of them. Absent ⇒ never counted, fall back to what is loaded. */
  const childTotal = Math.max(row.childCount ?? 0, children.length);
  const expandable = children.length > 0 && depth < MAX_DEPTH;
  const status = homeRowOf(row, {
    ...(ctx.livenessOf ? { liveness: ctx.livenessOf(row.id) } : {}),
    compact: true,
  });
  const branchId = `mdrawer-item-${row.id}`;

  return (
    <li className="mdrawer__item" data-open={open ? 'true' : undefined}>
      <div className="mdrawer__itemrow">
        {expandable ? (
          <button
            type="button"
            className="mdrawer__expand"
            aria-expanded={open}
            aria-controls={branchId}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${row.title}`}
            onClick={toggle}
          >
            <span className="mdrawer__twisty" aria-hidden>
              ▸
            </span>
          </button>
        ) : (
          <span className="mdrawer__expand-spacer" aria-hidden />
        )}
        <button
          type="button"
          className="mdrawer__row mdrawer__row--item"
          data-testid="mobile-drawer-item"
          onClick={() => ctx.openItem(row)}
        >
          <span className="mdrawer__name mdrawer__name--stacked">
            <span className="mdrawer__title">{row.title}</span>
            <span className="mdrawer__preview">{itemDetail(row, childTotal, ctx.now)}</span>
          </span>
          {status.word ? (
            <span className="mdrawer__status" data-tone={status.tone} title={status.detail}>
              {status.word}
            </span>
          ) : null}
        </button>
      </div>
      {expandable && open ? (
        <ul className="mdrawer__branch" id={branchId}>
          {children.slice(0, DRAWER_CHILD_LIMIT).map((child) => (
            <ItemNode key={child.id} row={child} forest={forest} depth={depth + 1} ctx={ctx} />
          ))}
          {childTotal > Math.min(children.length, DRAWER_CHILD_LIMIT) ? (
            <li>
              {/* The rest live on the parent's own page, which lists them all. */}
              <button type="button" className="mdrawer__seeall" onClick={() => ctx.openItem(row)}>
                See all {childTotal} ›
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}
