/**
 * T3-3 — THE ACCOUNT MENU. The "who am I" surface off the top-bar avatar.
 *
 * Oracle: `T3-3 Account Menu Hi-Fi.dc.html`, frames "T3-3 — Account menu
 * anatomy" (light) and "T3-3 — Dark menu + 320 floor" (dark + the 320 floor).
 * The oracle's third frame, "T3-3 — Profile edit mode", is the MEMBER Z3 detail
 * panel with an edit mode — another lane's surface entirely; this menu's
 * "My profile" row is the handoff to it and nothing here implements it.
 *
 * THE BAR THIS FILE IS BUILT TO (user program order): link-level completeness.
 * Every control the canvas draws exists here and either performs through a real
 * handler or renders disabled-with-reason (R7/L6). There are no silent voids,
 * and `account.test.tsx` sweeps the rendered DOM to keep it that way.
 *
 * THEME LIVES HERE — D1. The tab-bar ◐ is retired; this segmented control is
 * theme's one home, with the palette's "toggle theme" as the fast path. The
 * control is a PROP (`AccountThemeControl`), not a `useTheme()` call, for two
 * reasons: the host already owns one theme control and a second hook instance
 * would be a second source of truth, and this runner's `localStorage` is a
 * broken stub (measured — `vite.config.ts`), so a component that reached for
 * storage would be untestable for reasons unrelated to the menu.
 *
 * WHAT THE MENU CANNOT DO, and says so: sign-out (the seam exposes no auth or
 * session command), acting-as (drawn disabled by the canvas itself), node
 * settings (T3-5 is designed, not built), and returning theme to the system
 * default (`useTheme` stores a choice and exposes no clear). Each renders
 * focusable with its reason wired through `aria-describedby` — D28: a natively
 * `disabled` control drops out of the tab order and takes its reason with it.
 *
 * FIDELITY IS DEFERRED, deliberately. Geometry follows the oracle where it was
 * cheap to follow (296px menu, 8px viewport inset, the 320 floor clamp), but a
 * later parity session owns the pixels; divergences I already know about are
 * listed in `HANDOVER.md` rather than smoothed over here.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { IdentityView } from '../data/seam';
import type { UnavailableReason } from '../panels/honesty/DisabledWithReason';
import { presentIdentity } from './identity';
import {
  ACT_AS_REASON,
  NODE_SETTINGS_REASON,
  PROFILE_NOT_WIRED_REASON,
  PROFILE_NO_MEMBER_REASON,
  SIGN_OUT_REASON,
  THEME_SYSTEM_REASON,
} from './reasons';
import { SignOutConfirm } from './SignOutConfirm';

export type AccountTheme = 'light' | 'dark';

/**
 * The host's theme control, narrowed to what this menu drives. `useTheme`
 * satisfies the required half as-is; `useSystem` is the OPTIONAL half it does
 * not have yet (see `HANDOVER.md` — the three-line addition is the coordinator's
 * to make, and until it exists the segment refuses honestly).
 */
export interface AccountThemeControl {
  theme: AccountTheme;
  /** True when the value came from the OS rather than an explicit choice. */
  isSystemDefault: boolean;
  setTheme(theme: AccountTheme): void;
  /** Clear the stored choice and follow the OS again. Absent ⇒ segment refuses. */
  useSystem?(): void;
}

export interface AccountMenuProps {
  /** `null` while the `seam.identity()` read is in flight, or when it failed. */
  identity: IdentityView | null;
  /** The failure, stated. Rendered verbatim — never swallowed into a spinner. */
  identityError?: string;
  /** Active space — decides the role chip and the "My profile" target. */
  spaceId?: string | null;
  theme: AccountThemeControl;
  /** Push your member entity onto the panel stack. Absent ⇒ row refuses. */
  onOpenProfile?(memberId: string): void;
  /** Absent ⇒ row refuses with the T3-5 reason (the honest default today). */
  onOpenNodeSettings?(): void;
  /** A REAL sign-out. Absent ⇒ row refuses and the confirm never opens. */
  onSignOut?(): void;
  onDismiss(): void;
  /** The trigger, for anchoring and for focus return. */
  anchorEl?: HTMLElement | null;
  /** Footer build label. */
  version?: string;
  /** Footer node label — omitted entirely when the host does not know it. */
  nodeLabel?: string;
  /** Names the agents in the sign-out confirm copy, when the host knows them. */
  runningLabel?: string;
}

export function AccountMenu(props: AccountMenuProps) {
  const { identity, theme, onDismiss, anchorEl } = props;
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);
  const person = useMemo(
    () => (identity ? presentIdentity(identity, props.spaceId) : null),
    [identity, props.spaceId],
  );

  // Focus return (C8): whatever had focus when the menu opened gets it back on
  // Esc — with the avatar as the trigger, that is the avatar, which is exactly
  // what the annotation asks for.
  const restoreRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    restoreRef.current = anchorEl ?? (document.activeElement as HTMLElement | null);
    menuRef.current?.querySelector<HTMLElement>('[data-acct-row]')?.focus();
  }, [anchorEl]);

  const dismiss = useCallback(() => {
    restoreRef.current?.focus?.();
    onDismiss();
  }, [onDismiss]);

  // Esc is CONSUMED — layer 2 of the keyboard chain (C6/C8): closing the menu
  // must never also pop the panel stack underneath it. With the confirm open,
  // Esc belongs to the confirm and stops there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (confirming) setConfirming(false);
      else dismiss();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [confirming, dismiss]);

  // Pointer outside closes. The anchor is excluded so a second click on the
  // avatar toggles once rather than closing and reopening in the same gesture.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onDismiss();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [anchorEl, onDismiss]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[data-acct-row]') ?? []);
    if (rows.length === 0) return;
    const here = rows.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? here + 1 : here - 1;
    // Disabled rows are INCLUDED in the ring: they are focusable precisely so
    // their reason gets announced, and skipping them would undo that.
    rows[(next + rows.length) % rows.length]?.focus();
    e.preventDefault();
  };

  const profile = profileTarget(person, props.onOpenProfile);

  return (
    <div
      className="acct-menu"
      role="menu"
      aria-label="Account menu"
      data-testid="account-menu"
      ref={menuRef}
      style={anchorStyle(anchorEl)}
      onKeyDown={onMenuKeyDown}
    >
      <IdentityBlock person={person} error={props.identityError} />

      <div className="acct-menu__group">
        <AccountRow
          id="profile"
          glyph="◯"
          title="My profile"
          sub="opens your member panel"
          chevron
          reason={profile.reason}
          onActivate={profile.activate}
        />
      </div>

      <ThemeSection theme={theme} />

      <div className="acct-menu__group">
        <AccountRow
          id="act-as"
          glyph="⇄"
          title={person?.actingAs ? `Acting as ${person.actingAs}` : 'Act as teammate…'}
          reason={ACT_AS_REASON}
        />
        <AccountRow
          id="node-settings"
          glyph="⚙"
          title="Node settings"
          sub="trust · slots · project registry"
          chevron
          reason={props.onOpenNodeSettings ? undefined : NODE_SETTINGS_REASON}
          onActivate={props.onOpenNodeSettings}
        />
      </div>

      <div className="acct-menu__group">
        <AccountRow
          id="sign-out"
          glyph="↦"
          title="Sign out"
          sub="ends this browser session only — the local node and live agents keep running"
          reason={props.onSignOut ? undefined : SIGN_OUT_REASON}
          onActivate={props.onSignOut ? () => setConfirming(true) : undefined}
        />
      </div>

      <div className="acct-menu__footer">
        <span>{`tm8 ${props.version ?? 'v1'}${props.nodeLabel ? ` · node ${props.nodeLabel}` : ''}`}</span>
        <span className="acct-menu__spacer" />
        <span>esc closes</span>
      </div>

      {confirming && props.onSignOut ? (
        <SignOutConfirm
          runningLabel={props.runningLabel}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            props.onSignOut?.();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Which refusal (if any) the profile row carries. Two DIFFERENT causes with
 * two different remedies — "this space has no member record for you" and "this
 * mount passed no handler" are not the same fact, and collapsing them would
 * send a reader to the wrong place.
 */
function profileTarget(
  person: ReturnType<typeof presentIdentity> | null,
  onOpenProfile?: (memberId: string) => void,
): { reason?: UnavailableReason; activate?: () => void } {
  if (!onOpenProfile) return { reason: PROFILE_NOT_WIRED_REASON };
  if (!person) return { reason: IDENTITY_PENDING_REASON };
  if (!person.memberId) return { reason: PROFILE_NO_MEMBER_REASON };
  const memberId = person.memberId;
  return { activate: () => onOpenProfile(memberId) };
}

const IDENTITY_PENDING_REASON: UnavailableReason = {
  cause: 'Your member record hasn’t loaded',
  remedy: 'the identity read has not returned yet',
};

function IdentityBlock({
  person,
  error,
}: {
  person: ReturnType<typeof presentIdentity> | null;
  error?: string;
}) {
  if (!person) {
    return (
      <div className="acct-menu__identity" data-testid="account-identity">
        <div className="acct-menu__pending">
          {error ? `Identity unavailable — ${error}` : 'loading your identity…'}
        </div>
      </div>
    );
  }
  return (
    <div className="acct-menu__identity" data-testid="account-identity">
      {/* Round = human, always (T3-3 annotation 1 / the provenance rule). The
          viewer of an account menu is a person by construction. */}
      <span className="acct-menu__avatar" aria-hidden="true">
        {person.initials}
      </span>
      <div className="acct-menu__who">
        <div className="acct-menu__nameline">
          <span className="acct-menu__name" title={person.name}>
            {person.name}
          </span>
          {person.role ? <span className="acct-menu__role">{person.role}</span> : null}
        </div>
        <span className="acct-menu__account" title={person.accountLine}>
          {person.accountLine}
        </span>
        {/* NOT presence — the account status word, verbatim. See identity.ts. */}
        <span className="acct-menu__status" title="account status">
          <span aria-hidden="true">●</span> {person.status}
        </span>
      </div>
    </div>
  );
}

const SEGMENTS: readonly { value: 'light' | 'dark' | 'system'; glyph: string; word: string }[] = [
  { value: 'light', glyph: '☼', word: 'light' },
  { value: 'dark', glyph: '◐', word: 'dark' },
  { value: 'system', glyph: '◑', word: 'system' },
];

function ThemeSection({ theme }: { theme: AccountThemeControl }) {
  const reasonId = useId();
  const groupRef = useRef<HTMLDivElement>(null);
  const active = theme.isSystemDefault ? 'system' : theme.theme;
  const systemRefused = !theme.isSystemDefault && !theme.useSystem;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const segs = Array.from(groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);
    const here = segs.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowRight' ? here + 1 : here - 1;
    segs[(next + segs.length) % segs.length]?.focus();
    e.preventDefault();
  };

  return (
    <div className="acct-menu__theme">
      <span className="acct-menu__eyebrow">THEME</span>
      <div
        className="acct-seg"
        role="radiogroup"
        aria-label="Theme"
        ref={groupRef}
        onKeyDown={onKeyDown}
      >
        {SEGMENTS.map((seg) => {
          const checked = seg.value === active;
          const refused = seg.value === 'system' && systemRefused;
          const activate = () => {
            if (seg.value === 'system') theme.useSystem?.();
            else theme.setTheme(seg.value);
          };
          const cls = `acct-seg__btn${checked ? ' acct-seg__btn--on' : ''}${refused ? ' acct-seg__btn--off' : ''}`;
          // Refused segments keep role=radio and stay focusable (D28) so the
          // reason is announced rather than silently unreachable.
          return refused ? (
            <span
              key={seg.value}
              className={cls}
              role="radio"
              aria-checked={false}
              aria-label={seg.word}
              aria-disabled="true"
              aria-describedby={reasonId}
              tabIndex={0}
            >
              <span aria-hidden="true">{seg.glyph}</span>
              <span className="acct-seg__word">{seg.word}</span>
            </span>
          ) : (
            <button
              key={seg.value}
              type="button"
              className={cls}
              role="radio"
              aria-checked={checked}
              aria-label={seg.word}
              data-acct-wired="true"
              onClick={activate}
            >
              <span aria-hidden="true">{seg.glyph}</span>
              <span className="acct-seg__word">{seg.word}</span>
              {checked ? <span aria-hidden="true">✓</span> : null}
            </button>
          );
        })}
      </div>
      {/* The canvas's "system is honest" note: the caption states the RESOLVED
          value, so "system" never leaves you guessing which theme you are in. */}
      <span className="acct-menu__caption" data-testid="account-theme-caption">
        {theme.isSystemDefault
          ? `following your system setting — currently ${theme.theme}`
          : `your choice — ${theme.theme}`}
      </span>
      {systemRefused ? (
        <span className="acct-menu__caption acct-menu__caption--reason" id={reasonId}>
          {`${THEME_SYSTEM_REASON.cause} — ${THEME_SYSTEM_REASON.remedy ?? ''}`}
        </span>
      ) : null}
    </div>
  );
}

/**
 * ONE row shape for every row. Enabled rows are real buttons carrying
 * `data-acct-wired`; refused rows are focusable `aria-disabled` elements whose
 * reason is in the DOM and pointed at by `aria-describedby`. The two shapes
 * are what the void sweep in the suite distinguishes — which is why the marker
 * is structural rather than a prop anyone could forget to pass.
 */
function AccountRow({
  id,
  glyph,
  title,
  sub,
  chevron,
  reason,
  onActivate,
}: {
  id: string;
  glyph: string;
  title: ReactNode;
  sub?: string;
  chevron?: boolean;
  reason?: UnavailableReason;
  onActivate?: () => void;
}) {
  const captionId = useId();
  const refused = reason !== undefined || onActivate === undefined;
  const shownReason = reason ?? NOT_WIRED_HERE;
  const body = (
    <>
      <span className="acct-row__glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="acct-row__body">
        <span className="acct-row__title">{title}</span>
        {sub && !refused ? <span className="acct-row__sub">{sub}</span> : null}
        {refused ? (
          <span className="acct-row__sub acct-row__sub--reason" id={captionId}>
            {`${shownReason.cause}${shownReason.remedy ? ` — ${shownReason.remedy}` : ''}`}
          </span>
        ) : null}
      </span>
      {chevron ? (
        <span className="acct-row__chevron" aria-hidden="true">
          ›
        </span>
      ) : null}
    </>
  );

  if (refused) {
    return (
      <span
        className="acct-row acct-row--refused"
        role="menuitem"
        aria-disabled="true"
        aria-describedby={captionId}
        tabIndex={0}
        data-acct-row="true"
        data-testid={`account-row-${id}`}
      >
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="acct-row"
      role="menuitem"
      data-acct-row="true"
      data-acct-wired="true"
      data-testid={`account-row-${id}`}
      onClick={onActivate}
    >
      {body}
    </button>
  );
}

/** The R5 enabled-inert class, refused structurally: no handler ⇒ no live row. */
const NOT_WIRED_HERE: UnavailableReason = {
  cause: 'This action isn’t connected yet',
  remedy: 'this mount passed no handler for it',
};

/**
 * Anchored below the trigger, right-aligned, 8px viewport inset (the oracle's
 * own geometry line). `position: fixed` is what lets the menu anchor itself
 * without its trigger having to become a positioned container — the trigger
 * lives in `SpaceTabBar`, a file this lane does not own.
 */
function anchorStyle(anchorEl?: HTMLElement | null): React.CSSProperties {
  const rect = anchorEl?.getBoundingClientRect?.();
  const top = rect && rect.bottom > 0 ? rect.bottom + 6 : undefined;
  return top === undefined ? {} : { top };
}
