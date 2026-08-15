/**
 * SpaceTabBar — the compact top bar: product mark, inbox bell, palette hint,
 * copy-link slot, account avatar.
 *
 * REVISION 11 (single-home ruling, 2026-08-14): the server chip and the space
 * tablist LEFT THIS BAR. A (server, space) pair is one fact — the context you
 * stand in — and it now has one home: the rail's identity block
 * (`SpaceSwitcher`), which also absorbed the add-space affordance. The name
 * `SpaceTabBar` survives for continuity of tests and imports; what remains is
 * the product bar.
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
import type { ReactNode } from 'react';
import { BrandMark } from '../kit';

export interface SpaceTabBarProps {
  /** Opens the Inbox screen — the bell. Absent, the bell renders disabled. */
  onOpenInbox?(): void;
  /** Account menu — theme's home per D1. */
  onOpenAccount?(): void;
  onOpenPalette?(): void;
  /**
   * Opens the prompt catalog — every system prompt tm8 sends an agent.
   * Optional like the rest of the bar's callbacks, so a bar rendered without a
   * host (every existing shell test) simply does not show the control.
   */
  onOpenPrompts?(): void;
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
  /**
   * COPY LINK for whatever is currently on screen.
   *
   * A slot, not a rendered control: the bar has no business knowing how a link
   * is built or what a clipboard refusal looks like. Left undefined the bar is
   * unchanged, so every existing shell test and a bar rendered with no host
   * keep working.
   */
  shareSlot?: ReactNode;
}

export function SpaceTabBar(props: SpaceTabBarProps) {
  return (
    <header className="shell-tabbar" data-testid="space-tab-bar">
      <div className="shell-tabbar__mark" aria-label="tm8">
        <BrandMark /> tm8
      </div>

      <div className="shell-tabbar__spacer" />

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
