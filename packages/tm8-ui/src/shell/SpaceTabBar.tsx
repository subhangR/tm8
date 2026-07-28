/**
 * SpaceTabBar — the 42px top bar: product mark, space switcher, palette hint,
 * account avatar. Transcribed from the T0-1 canvas.
 *
 * D1 — THE ◐ THEME TOGGLE IS NOT BUILT. The T0-1 canvas still draws one
 * (the canvas is byte-unchanged), but the Round-2 amendment retires it: theme's
 * one home is the account menu (T3-3), with a command-palette fast path. The
 * amendment supersedes the pixels, so this component renders no toggle and the
 * test suite asserts its ABSENCE — a regression that "restores" it to match the
 * canvas would be restoring a retired control.
 */
import type { SpaceId, SpaceSummary } from '@tm8/contract';

export interface SpaceTabBarProps {
  spaces: readonly SpaceSummary[];
  activeSpaceId: SpaceId | null;
  onSelectSpace(id: SpaceId): void;
  /** Account menu — theme's home per D1. */
  onOpenAccount?(): void;
  onOpenPalette?(): void;
  /** Monogram for the account avatar. */
  accountInitial?: string;
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

      <button type="button" className="shell-tabbar__palette" onClick={props.onOpenPalette}>
        / palette · ⌘K
      </button>

      {/* D1: no ◐ toggle here. Theme lives in the account menu. */}
      <button
        type="button"
        className="shell-tabbar__avatar"
        onClick={props.onOpenAccount}
        aria-label="Account menu"
      >
        {props.accountInitial ?? '·'}
      </button>
    </header>
  );
}
