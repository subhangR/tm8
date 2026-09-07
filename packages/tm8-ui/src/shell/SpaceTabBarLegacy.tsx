/**
 * SpaceTabBarLegacy — THE PREVIOUS TOP BAR, KEPT VERBATIM AS THE ROLLBACK.
 *
 * This file is a byte-for-byte snapshot of `SpaceTabBar.tsx` as it stood at
 * `origin/main` 4790333c, immediately before revision 21 rebuilt the row as a
 * grid. Nothing here is maintained: it exists so that a viewer who dislikes the
 * new bar gets back EXACTLY the bar they had, out of the same bundle, with the
 * same 21 commits of product work behind it.
 *
 * WHY THIS AND NOT THE UI-2.0 SWITCH. The obvious rollback looked like the door
 * to `/ui-2.0/` that already existed. It is not one: that path serves
 * `packages/tm8_ui_2.0`, which is 280 of 976 source files and ~35,600 lines
 * divergent from this package and missing roughly twenty commits of product
 * work. Sending someone there to "get the old bar back" would land them in a
 * different, staler product — a detour wearing a rollback's label. A rollback
 * has to return the thing that was there, and the only way to promise that is
 * to keep the thing that was there.
 *
 * ITS LIFETIME IS ONE RELEASE. Two bar implementations in one bundle is
 * duplication this package refuses everywhere else, and it is accepted here for
 * exactly as long as it takes to find out whether the new bar holds. Deleting
 * it is one commit: this file, `topbar-version.ts`, the fork in `GateApp`, and
 * the menu row that flips it.
 *
 * ── the original docblock follows, unchanged ─────────────────────────────
 *
 * SpaceTabBar — the top row: product mark, the server⋄space switcher slot,
 * the top-level TABS, palette hint, the inbox bell, copy-link
 * slot, account avatar.
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
 * THE BELL is Inbox's new door. Inbox left the menu rail because its rows
 * already feed the Home page's NEEDS YOU / MENTIONS sections — a rail row, a
 * home section AND a bar control would be three doors to one fact; the chrome
 * keeps the one that is visible from every screen. No count rides on it
 * deliberately: the bar has no honest per-viewer unseen read today, and a
 * fabricated zero would assert "nothing wants you" about a fact nobody
 * measured.
 *
 * D1 — THE ◐ THEME TOGGLE IS NOT BUILT. The T0-1 canvas still draws one
 * (the canvas is byte-unchanged), but the Round-2 amendment retires it: theme's
 * one home is the account menu (T3-3), with a command-palette fast path. The
 * amendment supersedes the pixels, so this component renders no toggle and the
 * test suite asserts its ABSENCE — a regression that "restores" it to match the
 * canvas would be restoring a retired control.
 */

import { BrandMark } from '../kit';
import type { SpaceTabBarProps } from './SpaceTabBar';

/* Props and `ShellTab` come from `SpaceTabBar` — one definition, so the two
   bars cannot drift apart in what a host may hand them. */

export function SpaceTabBarLegacy(props: SpaceTabBarProps) {
  return (
    <header className="shell-tabbar" data-testid="space-tab-bar">
      {props.onGoHome ? (
        <button
          type="button"
          className="shell-tabbar__mark shell-tabbar__mark--door"
          data-testid="go-home"
          aria-label="tm8 — back to conversations"
          title="Back to conversations"
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

      {/* The exit to the product UI, ahead of everything else on the right. */}
      {props.uiSwitchSlot ?? null}

      {props.onOpenPrompts ? (
        <button
          type="button"
          className="shell-tabbar__prompts"
          onClick={props.onOpenPrompts}
          data-testid="open-prompts"
          title="System prompts — everything tm8 says to an agent"
        >
          prompts
        </button>
      ) : null}

      <button type="button" className="shell-tabbar__palette" onClick={props.onOpenPalette}>
        / palette · ⌘K
      </button>

      {/* RETIRED 2026-08-20: Help now owns the final tab in the shipped menu.
          Keep no duplicate `?` door in chrome. The view, route and palette
          eligibility remain; only this dedicated control is gone. */}

      {/* The bell keeps the D28 posture when no host wired it: focusable,
          aria-disabled, with the reason on it — never hidden. */}
      <button
        type="button"
        className="shell-tabbar__bell"
        data-testid="open-inbox"
        aria-disabled={props.onOpenInbox ? undefined : 'true'}
        aria-label="Inbox"
        title={props.onOpenInbox ? 'Inbox — what wants you' : 'Inbox is unavailable without a host'}
        onClick={props.onOpenInbox ?? ((event) => event.preventDefault())}
      >
        <span aria-hidden="true">◹</span>
      </button>

      {props.shareSlot ?? null}

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
