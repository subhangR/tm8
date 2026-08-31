/**
 * SpaceTabBar — the top row: product mark, the server⋄space switcher slot,
 * the top-level TABS, palette hint, account menu slot.
 *
 * REVISION 21 (user-ordered, 2026-08-31: "palatte inbox copy link and Tarakesh
 * profile section can you move inbox copy link to profile"): the bar's right
 * side is now EXACTLY `/ palette · ⌘K` and the account menu. The inbox bell
 * and the copy-link slot moved into that menu's utility group; see the note
 * where they used to render, and `auth/AccountMenu` for where they went.
 *
 * REVISION 20 (Help/top-tab ruling, 2026-08-20): the shipped row is exactly
 * Home | Work | Board | Craft | Graph | Settings | Help. Board is the client-
 * owned Board v2 route tab; legacy Board and Files remain valid views without
 * shipping in the default spine. Help is the final tab, so the old dedicated
 * `?` control is retired below.
 *
 * REVISION 12 (top-tab ruling R1/R2, 2026-08-15): the identity block moved
 * HERE from the rail head, and the menu's GROUPS render as top-level tabs —
 * the exact group set has evolved since. The single-home rule
 * survives with a new address: identity is still ONE control (`switcherSlot`,
 * occupied by `SpaceSwitcher`), never a server chip beside a space list — the
 * old read-only server label is NOT restored. The rail below stops listing
 * groups and renders only the active tab's contents.
 *
 * The tabs are DATA-DRIVEN from the resolved MenuConfig's groups (the host
 * maps them); this component hardcodes no tab names. `tabs` absent renders no
 * tablist, so a bar without a host keeps the r11 product-bar shape.
 *
 * THE MARK IS A DOOR to the conversation surface: with `onGoHome` wired the
 * product mark becomes a button back to it. Left unwired it stays inert text,
 * so every bar rendered without a host is unchanged.
 *
 * It arrived in revision 13, when the `home` group was retired and the mark
 * was the ONLY way back. Revision 14 restored that tab (as Chats), so the mark
 * is now a SECOND door — kept deliberately, because a clickable product mark
 * is a convention people already try, and the objection 13 raised was never to
 * this button. What holds is that it is not a TAB: it never reads current, so
 * it cannot disagree with the tab row about where you are.
 *
 * REVISION 11 (single-home ruling, 2026-08-14): the server chip and the space
 * tablist left this bar for the rail's identity block. R1 moves that block
 * into the bar — the ruling's ONE-home invariant holds; only the address
 * changed. The name `SpaceTabBar` survives for continuity of tests and
 * imports.
 *
 * THE BELL WAS Inbox's door, and it is not in this file any more (r21). Inbox
 * left the menu rail because its rows already feed the Home page's NEEDS YOU /
 * MENTIONS sections — a rail row, a home section AND a bar control would be
 * three doors to one fact. That ruling is unchanged; only the surviving door's
 * address moved, from this bar to the account menu. What travelled with it: the
 * `VIEW_ART.inbox` mark, the D28 refused-with-a-reason posture, and the
 * deliberate ABSENCE OF A COUNT — the chrome still has no honest per-viewer
 * unseen read, and a fabricated zero would assert "nothing wants you" about a
 * fact nobody measured.
 *
 * D1 — THE ◐ THEME TOGGLE IS NOT BUILT. The T0-1 canvas still draws one
 * (the canvas is byte-unchanged), but the Round-2 amendment retires it: theme's
 * one home is the account menu (T3-3), with a command-palette fast path. The
 * amendment supersedes the pixels, so this component renders no toggle and the
 * test suite asserts its ABSENCE — a regression that "restores" it to match the
 * canvas would be restoring a retired control.
 */
import type { ReactNode } from 'react';
import { BrandMark } from '../kit';

/** One top-level tab — a menu GROUP, mapped by the host. */
export interface ShellTab {
  id: string;
  label: string;
}

export interface SpaceTabBarProps {
  /**
   * The identity block — `SpaceSwitcher`, mounted by the host (R1). A slot
   * for the same reason `accountSlot` is one: the bar has no business knowing
   * how servers are listed or what a space switch resets. Left undefined the
   * bar simply has no identity control, which is every pre-R1 test.
   */
  switcherSlot?: ReactNode;
  /**
   * The top-level tabs, derived from the resolved menu config's groups (R2).
   * Data, not chrome: the bar never invents a tab. Absent → no tablist.
   */
  tabs?: readonly ShellTab[];
  /** Which tab reads as current — the group owning the active target. */
  activeTabId?: string | null;
  onSelectTab?(id: string): void;
  /**
   * Back to the conversation surface — the mark's verb (revision 13). Absent
   * ⇒ the mark is inert text, exactly as it was before Home became the
   * container.
   */
  onGoHome?(): void;
  /** Account menu — theme's home per D1. */
  onOpenAccount?(): void;
  onOpenPalette?(): void;
  /** Monogram for the account avatar. */
  accountInitial?: string;
  /**
   * Replaces the avatar button when supplied (T3-3, user-ordered 2026-07-29):
   * the host mounts the real account menu here, which carries the signed-in
   * name, the theme control and sign-out. Left undefined the bar keeps the
   * avatar fallback below, so a bar rendered without an auth gate — every
   * existing shell test, and the app before anyone signs in — is unchanged.
   */
  accountSlot?: ReactNode;
  /* REMOVED 2026-08-31: `shareSlot` and `onOpenInbox`. Copy link and Inbox now
     hang inside the account menu (see the retirement note in the body). The
     props went with the controls rather than being left behind unused — a prop
     nothing passes is a control that cannot appear, and a bar that still
     accepted `shareSlot` would advertise a seat it never renders. */
}

export function SpaceTabBar(props: SpaceTabBarProps) {
  return (
    <header className="shell-tabbar" data-testid="space-tab-bar">
      {props.onGoHome ? (
        <button
          type="button"
          className="shell-tabbar__mark shell-tabbar__mark--door"
          data-testid="go-home"
          /* The tooltip names the DESTINATION by the tab row's own word for it
             ("Home"), so the mark and the tab cannot describe one place two
             ways. */
          aria-label="tm8 — Home"
          title="Home"
          onClick={props.onGoHome}
        >
          <BrandMark />
        </button>
      ) : (
        <div className="shell-tabbar__mark" aria-label="tm8">
          <BrandMark />
        </div>
      )}

      {props.switcherSlot ?? null}

      {props.tabs && props.tabs.length > 0 ? (
        <nav className="shell-tabbar__tabs" role="tablist" aria-label="Screens">
          {props.tabs.map((tab) => {
            const active = tab.id === props.activeTabId;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`shell-tabbar__tab ${active ? 'shell-tabbar__tab--active' : ''}`}
                onClick={() => props.onSelectTab?.(tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      ) : null}

      <div className="shell-tabbar__spacer" />

      {/* RETIRED 2026-08-29: Prompts now lives inside Help — keep no duplicate
          door in chrome. The catalog, its `/help/prompts` address and its tests
          remain; only this dedicated chip is gone. */}

      {/* A SEARCH FIELD, NOT A CHIP THAT SAYS "palette" (owner, 2026-08-31:
          "for palette you can put search bar write inside in light colors
          search entities whatever job it does as a search").
          The control opens the same command palette it always did — what
          changed is that it now looks like the thing it does. `/ palette · ⌘K`
          named the MECHANISM and left the reader to infer the job; a magnifier
          and the words in the field say the job and leave the mechanism to the
          shortcut. It stays a button rather than becoming an `<input>`: typing
          happens in the palette's own field once it opens, and a decorative
          input that steals focus and then hands it somewhere else is worse
          than an honest button. */}
      <button
        type="button"
        className="shell-tabbar__palette"
        aria-label="Search this space"
        title="Search entities, docs and people (⌘K)"
        onClick={props.onOpenPalette}
      >
        <svg
          className="shell-tabbar__palette-mark"
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="4.2" />
          <path d="M10.2 10.2 14 14" strokeLinecap="round" />
        </svg>
        <span className="shell-tabbar__palette-hint">Search entities, docs, people…</span>
        <kbd className="shell-tabbar__palette-kbd">⌘K</kbd>
      </button>

      {/* RETIRED 2026-08-20: Help now owns the final tab in the shipped menu.
          Keep no duplicate `?` door in chrome. The view, route and palette
          eligibility remain; only this dedicated control is gone. */}

      {/* RETIRED 2026-08-31 (user-ordered: "can you move inbox copy link to
          profile"): the INBOX BELL and the COPY-LINK slot both left this bar
          for the account menu's utility group — `auth/AccountMenu`'s
          `onOpenInbox` row and its `utilityRows`. The verbs, the inbox art
          (`VIEW_ART.inbox`) and the bell's D28 refused-with-a-reason posture
          all travelled with them; only these two chrome seats are gone, along
          with the `onOpenInbox` and `shareSlot` props that fed them. The bar's
          right side is now exactly the palette hint and the account menu. */}

      {/* D1: no ◐ toggle here. Theme lives in the account menu. THAT MENU NOW
          EXISTS and arrives through `accountSlot` — the fallback below is only
          for a bar rendered WITHOUT one, and while that is the case the label
          keeps saying the true thing: this button toggles the theme. */}
      {props.accountSlot ?? (
        <button
          type="button"
          className="shell-tabbar__avatar"
          onClick={props.onOpenAccount}
          aria-label="Toggle theme"
          title="Toggle theme"
        >
          {props.accountInitial ?? '·'}
        </button>
      )}
    </header>
  );
}
