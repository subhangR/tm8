/**
 * THE PHONE'S ACCOUNT SURFACE — DEF-003.
 *
 * ── THE DEFECT, AND WHY NO INSTRUMENT WOULD EVER HAVE FOUND IT ────────────
 *
 * `MobileShell`'s header was back-chevron + titles + Copy link, and nothing
 * else. `AccountMenu` and `SpaceSwitcher` are mounted only on `GateApp`'s
 * DESKTOP branch. So a phone user could not sign out, could not switch space,
 * and could not change theme — on a device where signing out is the single most
 * likely thing a person needs to do to a shared or borrowed handset.
 *
 * The tap census scored those screens as PASSING, because a control that does
 * not exist has no bounding box to measure. Absence measures as health. This is
 * the one row in the whole gate that rests on a human looking, which is exactly
 * why it is the row that had never been assigned to anybody.
 *
 * ── WHY A SHEET AND NOT `AccountMenu` DROPPED INTO THE HEADER ─────────────
 *
 * `auth/AccountMenu` is an ANCHORED POPOVER: a trigger carrying the account
 * name, and an absolutely-positioned card hung off it. On a 390px header the
 * trigger alone is most of the row, and the card is desktop furniture — it
 * would arrive with the desktop's own geometry over a shell that has exactly
 * one surface. The shell contract's own rule (CONTRACT.md §4) is that a
 * temporary surface over the current place is a SHEET; this is the first thing
 * that rule was written for, so it uses the sheet primitive rather than
 * re-deciding for itself.
 *
 * WHAT IS REUSED IS THE SEAM, NOT THE CHROME. Sign-out is the same
 * `useAuthActions().signOut`, the theme pair writes the same host-owned theme
 * state, and space selection goes through the host's callback so the
 * privacy-lane invariant (leave the space context, THEN select) stays stated in
 * exactly one place. Two renderings of one set of verbs — the same rule the two
 * shells live under.
 *
 * ── WHAT IT DELIBERATELY DOES NOT CONTAIN ────────────────────────────────
 *
 * No Settings row. `settings` is a scheduled phase of its own and this sheet is
 * its natural future home — but a row that opens nothing is the enabled-inert
 * defect this codebase refuses everywhere else, and DEF-031 is in this very
 * ledger for exactly that shape. Room is left for it; a dead control is not.
 */
import { useAuthActions } from '../auth';
import { Avatar } from '../kit';
import type { ActorSummary, SpaceId } from '@tm8/contract';
import type { Theme } from '../theme/useTheme';
import { MobileSheet } from './MobileSheet';

export interface MobileAccountSheetSpace {
  readonly id: string;
  readonly name?: string | undefined;
}

export interface MobileAccountSheetProps {
  /** Display actor in the active space; distinct from the local login account. */
  readonly actor: ActorSummary | null;
  readonly spaces: readonly MobileAccountSheetSpace[];
  readonly activeSpaceId: string | null;
  /**
   * Switch space. The host supplies the WHOLE verb: the desktop mount pairs
   * every switch with `leaveSpaceContext()` FIRST — a privacy-lane invariant
   * about not carrying one space's open panels into another — and a phone that
   * called `selectSpace` directly would be a second, quieter path through that
   * invariant, which is how invariants stop holding.
   *
   * ABSENT ⇒ THE SWITCHER IS NOT DRAWN. Not "drawn and inert": this shell's own
   * switch docblock spends a paragraph on why passing `() => undefined` to a
   * screen that checks whether a handler EXISTS is worse than passing nothing —
   * it switches the honest state off and leaves a live-looking control that
   * swallows the press. Same rule, same file family, applied here.
   */
  readonly onSelectSpace?: (id: SpaceId) => void;
  /** Absent ⇒ the appearance control is not drawn, for the same reason. */
  readonly theme?: Theme;
  readonly onThemeChange?: (theme: Theme) => void;
  readonly onDismiss: () => void;
}

export function MobileAccountSheet(props: MobileAccountSheetProps) {
  const { actor, spaces, activeSpaceId, theme, onThemeChange, onDismiss } = props;
  const actions = useAuthActions();
  const account = actions?.account ?? null;
  const name = actor?.displayName ?? account?.handle ?? 'You';

  return (
    <MobileSheet title="Account" onDismiss={onDismiss} testId="mobile-account-sheet">
      <div className="macct">
        {/* WHO YOU ARE. The face and display name are the active space's actor;
            the handle and the sign-out verb are the LOCAL login account. The
            desktop menu keeps those two identities explicit rather than
            collapsing them, because collapsing them borrows server authority
            for a browser-local credential — same reasoning, same split. */}
        <div className="macct__id">
          {actor ? (
            <Avatar
              actorId={actor.id}
              provenance={actor.isAgent ? 'agent' : 'human'}
              label={name}
              size={32}
              src={actor.avatar ?? null}
            />
          ) : null}
          <span className="macct__idtext">
            <span className="macct__name">{name}</span>
            {account ? (
              <span className="macct__handle">
                @{account.handle} · {account.isOwner ? 'owner of this server' : 'server account'}
              </span>
            ) : null}
          </span>
        </div>

        {/* APPEARANCE — theme's one product home (D1), reachable on a phone for
            the first time. Drawn only where the host actually owns a theme
            control to write to. */}
        {theme && onThemeChange ? (
        <section className="macct__group" aria-labelledby="macct-appearance">
          <h3 className="macct__grouphead" id="macct-appearance">
            Appearance
          </h3>
          <div className="macct__seg" role="group" aria-label="appearance">
            {(['light', 'dark'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={`macct__segopt${theme === t ? ' macct__segopt--on' : ''}`}
                aria-pressed={theme === t}
                onClick={() => onThemeChange(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </section>
        ) : null}

        {/* SPACES. Rendered only when there is a real switch verb AND more than
            one space to move between — a switcher offering the space you are
            already in is chrome that teaches nothing and can only disappoint a
            press. */}
        {props.onSelectSpace && spaces.length > 1 ? (
          <section className="macct__group" aria-labelledby="macct-spaces">
            <h3 className="macct__grouphead" id="macct-spaces">
              Space
            </h3>
            <ul className="macct__spaces">
              {spaces.map((space) => (
                <li key={space.id}>
                  <button
                    type="button"
                    className="macct__row"
                    aria-current={space.id === activeSpaceId ? 'true' : undefined}
                    onClick={() => {
                      /* Dismissing FIRST, then switching: the switch replaces
                         the screen underneath this sheet, and a sheet left open
                         over a screen it no longer belongs to is the stale-sheet
                         failure `MobileSheet` was built as a portal to avoid. */
                      onDismiss();
                      props.onSelectSpace?.(space.id as SpaceId);
                    }}
                  >
                    <span className="macct__rowlabel">{space.name ?? space.id}</span>
                    {space.id === activeSpaceId ? (
                      <span className="macct__rowmark" aria-hidden="true">
                        ✓
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* SIGN OUT. Rendered only where there is a gate to sign out OF — with
            no account there is no verb, and a button that cannot perform is the
            shape this codebase refuses everywhere else. */}
        {actions?.account ? (
          <section className="macct__group macct__group--last">
            <button
              type="button"
              className="macct__row macct__row--signout"
              data-testid="mobile-sign-out"
              onClick={() => {
                onDismiss();
                actions.signOut();
              }}
            >
              <span className="macct__rowlabel">Sign out</span>
              {/* The honest scope line, carried over verbatim from the desktop
                  menu: `auth.logout` revokes THIS session on the server, and
                  nothing else — not the account, not the entities, not the
                  running agents. */}
              <span className="macct__rownote">
                revokes this session on the server — agents keep running
              </span>
            </button>
          </section>
        ) : null}
      </div>
    </MobileSheet>
  );
}
