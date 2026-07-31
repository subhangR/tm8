/**
 * SpaceTabBar — the compact top bar: product mark, selected Server, space
 * switcher, palette hint, account avatar.
 *
 * D1 — THE ◐ THEME TOGGLE IS NOT BUILT. The T0-1 canvas still draws one
 * (the canvas is byte-unchanged), but the Round-2 amendment retires it: theme's
 * one home is the account menu (T3-3), with a command-palette fast path. The
 * amendment supersedes the pixels, so this component renders no toggle and the
 * test suite asserts its ABSENCE — a regression that "restores" it to match the
 * canvas would be restoring a retired control.
 */
import type { ReactNode } from 'react';
import type { SpaceId, SpaceSummary } from '@tm8/contract';

export interface SpaceTabBarProps {
  /** The Server whose spaces and menu currently own the workspace. */
  activeServer?: {
    label: string;
    reachability: 'checking' | 'online' | 'offline';
  };
  spaces: readonly SpaceSummary[];
  activeSpaceId: SpaceId | null;
  onSelectSpace(id: SpaceId): void;
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
   * Creating a space is not in the Phase-1 seam surface, so the affordance
   * renders disabled-with-reason rather than vanishing (L6).
   */
  addSpaceReason?: string;
}

export const ADD_SPACE_DISABLED_REASON = 'creating spaces arrives with the settings screens';

export function SpaceTabBar(props: SpaceTabBarProps) {
  const { spaces, activeSpaceId, onSelectSpace } = props;

  return (
    <header className="shell-tabbar" data-testid="space-tab-bar">
      <div className="shell-tabbar__mark" aria-label="tm8">
        <span aria-hidden="true">◈</span> tm8
      </div>
      {props.activeServer ? (
        <div
          className="shell-tabbar__server"
          aria-label={`Selected server: ${props.activeServer.label}, ${props.activeServer.reachability}`}
          title={`Selected server · ${props.activeServer.label} · ${props.activeServer.reachability}`}
        >
          <span
            className={`shell-tabbar__server-dot shell-tabbar__server-dot--${props.activeServer.reachability}`}
            aria-hidden="true"
          />
          <span className="shell-tabbar__server-label">{props.activeServer.label}</span>
        </div>
      ) : null}
      <div className="shell-tabbar__divider" role="presentation" />

      <div className="shell-tabbar__spaces" role="tablist" aria-label="Spaces">
        {spaces.map((space) => {
          const active = space.id === activeSpaceId;
          return (
            <button
              key={space.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`shell-tabbar__tab ${active ? 'shell-tabbar__tab--active' : ''}`}
              onClick={() => onSelectSpace(space.id)}
            >
              <span className="shell-tabbar__dot" aria-hidden="true" />
              {space.name}
            </button>
          );
        })}

        {/* D28: aria-disabled and FOCUSABLE, never natively `disabled`. A
            native disabled control drops out of the tab order, taking its
            reason with it — unreachable for exactly the users L6 protects. */}
        <button
          type="button"
          className="shell-tabbar__add"
          aria-disabled="true"
          onClick={(event) => event.preventDefault()}
          aria-label="Add space"
          title={props.addSpaceReason ?? ADD_SPACE_DISABLED_REASON}
        >
          +
        </button>
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

      {/* D1: no ◐ toggle here. Theme lives in the account menu. THAT MENU NOW
          EXISTS and arrives through `accountSlot` — which is the condition
          this comment named ("the label reverts to 'Account menu' the day the
          menu mounts"), so the fallback below is now only for a bar rendered
          WITHOUT one. While that is the case the label keeps saying the true
          thing: this button toggles the theme, and a screen-reader user is
          told that rather than being promised a menu that is not there. */}
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
