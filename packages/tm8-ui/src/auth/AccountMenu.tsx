/**
 * THE WORKSPACE ACCOUNT MENU — "who am I, and how do I leave".
 *
 * User-ordered (2026-07-29): "add logout option, and show the user name on the
 * workspace. the owner name." So the TRIGGER carries the name, not just an
 * initial in a circle — the request was for the name to be visible on the
 * workspace, and a lone avatar satisfies the letter of that and not the point.
 *
 * This is the T3-3 surface (oracle 1p) as an anchored popover, sharing the
 * frame's markup and grammar. The differences from the standalone 1p frame are
 * only the ones the situation forces: it is anchored rather than staged. The
 * face and display name are the active space actor; the handle and sign-out
 * verb remain the LOCAL login account. Keeping those two identities explicit
 * avoids borrowing server authority for a browser-local credential.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActorSummary } from '@tm8/contract';
import { Avatar } from '../kit';
import { useTheme, type Theme } from '../theme/useTheme';
import { useAuthActions } from './gate-context';
import { ACCOUNT_MENU } from './specimen';

export interface AccountMenuProps {
  /** Display actor in the active space; distinct from the local login account. */
  actor: ActorSummary;
  /** Open the full T3-3 screen. Omitted ⇒ the row is not offered. */
  onOpenAccountScreen?: () => void;
  /** Controlled by the workspace so changing Appearance updates the same
      state that stamps the root theme immediately. */
  theme?: Theme;
  onThemeChange?: (theme: Theme) => void;
}

export function AccountMenu({
  actor,
  onOpenAccountScreen,
  theme: controlledTheme,
  onThemeChange,
}: AccountMenuProps) {
  const actions = useAuthActions();
  const localTheme = useTheme();
  const theme = controlledTheme ?? localTheme.theme;
  const setTheme = onThemeChange ?? localTheme.setTheme;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  // Click-away and Escape. Both, because a popover that only closes on one of
  // them is a popover people get stuck in — and Escape is the path a keyboard
  // user has.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // Outside a gate there is no account and no sign-out verb. Rendering a
  // trigger that opened an empty menu would be the enabled-inert defect, so
  // the component renders nothing at all — the host decides whether to show
  // an account affordance by whether it mounted a gate.
  if (!actions?.account) return null;

  const account = actions.account;
  const name = actor.displayName;

  return (
    <div className="auth-accountmenu" ref={wrapRef}>
      <button
        type="button"
        className="auth-accountmenu__trigger"
        data-testid="account-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar
          actorId={actor.id}
          provenance={actor.isAgent ? 'agent' : 'human'}
          label={name}
          size={20}
          src={actor.avatar ?? null}
          className="auth-avatar auth-avatar--sm"
        />
        <span className="auth-accountmenu__name">{name}</span>
        <span className="auth-accountmenu__caret" aria-hidden>
          ▾
        </span>
      </button>

      {open ? (
        <div className="auth-menu auth-menu--anchored" role="menu" data-testid="auth-account-menu">
          <div className="auth-menu__head">
            <Avatar
              actorId={actor.id}
              provenance={actor.isAgent ? 'agent' : 'human'}
              label={name}
              size={32}
              src={actor.avatar ?? null}
              className="auth-avatar auth-avatar--lg"
            />
            <div className="auth-server__text">
              <span className="auth-menu__name">{name}</span>
              {/* NOT "owner of forge". The oracle's line borrows the node's
                  authority, and no node vouched for this account. */}
              <span className="auth-menu__handle">@{account.handle} · local account</span>
            </div>
          </div>

          <div className="auth-menu__group">
            {/* D1: the account menu is theme's ONE product home. */}
            <div className="auth-menu__row">
              <span className="auth-menu__glyph" aria-hidden>
                ◐
              </span>
              {ACCOUNT_MENU.appearance}
              <span className="auth-spacer" />
              <span className="auth-toggle" role="group" aria-label="appearance">
                {(['light', 'dark'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`auth-toggle__opt${theme === t ? ' auth-toggle__opt--on' : ''}`}
                    aria-pressed={theme === t}
                    onClick={() => setTheme(t)}
                  >
                    {t}
                  </button>
                ))}
              </span>
            </div>

            {onOpenAccountScreen ? (
              <button
                type="button"
                className="auth-menu__row auth-menu__row--live"
                onClick={() => {
                  close();
                  onOpenAccountScreen();
                }}
              >
                <span className="auth-menu__glyph" aria-hidden>
                  ⌗
                </span>
                Account &amp; access tokens
              </button>
            ) : null}
          </div>

          <div className="auth-menu__group auth-menu__group--last">
            <button
              type="button"
              className="auth-menu__row auth-menu__row--live auth-menu__row--stacked"
              onClick={() => {
                close();
                actions.signOut();
              }}
            >
              <span className="auth-menu__signout">
                <span className="auth-menu__glyph" aria-hidden>
                  ↩
                </span>
                Sign out
              </span>
              {/* The honest scope line. The oracle's "agents keep running" is
                  true of a SERVER sign-out; this one only clears a local
                  record, and says the thing it actually does. */}
              <span className="auth-menu__signout-note">
                clears the local session — your account stays on this browser
              </span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
