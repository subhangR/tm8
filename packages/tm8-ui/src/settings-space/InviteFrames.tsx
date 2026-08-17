/**
 * T2-1c INVITES (oracle L91–L122) and T2-1d REDEEM LANDING (L124–L141).
 *
 * THE WHOLE FEATURE HAS NO SEAM. Searched on 2026-07-29 and stated plainly:
 * `data/seam.ts` has no invite read and no invite command; `@tm8/contract`
 * defines no invite DTO. That is a MISSING CAPABILITY, not a missing wire, and
 * it changes what honesty requires here.
 *
 * So the list does not render specimen rows in product. A screen showing
 * `i-7f3c · member · 0/5 used · expires in 5d` when nothing was ever read is
 * the worst artefact this surface could produce — every one of those fields
 * reads as measured. Product gets one quiet line saying no invite list exists
 * to read (D-law 9: an absence is stated, not shouted), and the specimen rows
 * live on the dev review board where they are labelled as the oracle's words.
 *
 * The CONTROLS still exist, because R7 says unavailable ≠ invisible: create,
 * copy, revoke and join all render disabled-with-reason. A user learns the
 * feature exists and learns why it cannot run.
 */
import { BrandMark } from '../kit';
import { DisabledAction, DisabledIconControl } from '../panels';
import { defaultInviteRole } from './port';
import type { RedeemState, SpecimenInvite } from './types';
import {
  INVITE_COPY_UNAVAILABLE,
  INVITE_CREATE_UNAVAILABLE,
  INVITE_REDEEM_UNAVAILABLE,
  INVITE_REVOKE_UNAVAILABLE,
  INVITES_UNREADABLE,
} from './reasons';

export interface InvitesPanelProps {
  /**
   * `null` in product — nothing can read invites. The dev board passes the
   * oracle's rows so the built list can be diffed against the canvas; the
   * prop is named for what it is so a future caller cannot mistake specimen
   * rows for data.
   */
  specimen?: readonly SpecimenInvite[] | null;
}

export function InvitesPanel({ specimen = null }: InvitesPanelProps) {
  const active = (specimen ?? []).filter((i) => !i.revoked);
  const revoked = (specimen ?? []).filter((i) => i.revoked);

  return (
    <>
      <div className="set-section__head">
        <span className="set-section__title">Invites</span>
        <div className="set-section__grow" />
      </div>

      {/* create — role + budget + expiry at creation (oracle L99–L104) */}
      <div className="set-invite-form">
        <div style={{ display: 'flex', gap: 6 }}>
          <DisabledIconControl label="invite role" reason={INVITE_CREATE_UNAVAILABLE}>
            <span className="set-field set-field--grow">role: {defaultInviteRole()} ▾</span>
          </DisabledIconControl>
          <DisabledIconControl label="invite use budget" reason={INVITE_CREATE_UNAVAILABLE}>
            <span className="set-field">5 uses ▾</span>
          </DisabledIconControl>
        </div>
        {/* The refusal skin IS the brass chip geometry (honesty.css L46–55:
            brand-2 / brand-soft / r6 / 3px 12px / 12px 600), so the control
            wears it directly rather than nesting a second brass box inside
            it. `set-refuse--block` only makes it full-width, which is the one
            thing the oracle adds here (L104 `padding:4px 0;text-align:center`). */}
        <span className="set-refuse--block">
          <DisabledAction reason={INVITE_CREATE_UNAVAILABLE} label="create invite link">
            Create invite link
          </DisabledAction>
        </span>
      </div>

      <div className="set-section__scroll">
        {specimen === null ? (
          <div className="set-absent" data-testid="invites-absent">
            <span className="set-absent__head">No invite list exists to read.</span>
            <span className="set-absent__why">
              {INVITES_UNREADABLE.cause} — {INVITES_UNREADABLE.remedy}
            </span>
          </div>
        ) : (
          <>
            <div className="set-invite__group set-eyebrow">Active · {active.length}</div>
            {active.map((i) => (
              <InviteRow invite={i} key={i.code} />
            ))}
            <div className="set-invite__group set-eyebrow">Revoked · {revoked.length}</div>
            {revoked.map((i) => (
              <InviteRow invite={i} key={i.code} />
            ))}
          </>
        )}
      </div>
    </>
  );
}

/** One invite row. Revoked rows keep their audit trail struck through, never deleted (oracle L137). */
function InviteRow({ invite }: { invite: SpecimenInvite }) {
  const dead = invite.revoked;
  return (
    <div className={dead ? 'set-invite set-invite--revoked' : 'set-invite'} data-testid="invite-row">
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span className="set-invite__code">{invite.code}</span>
        <span className="set-invite__meta">
          {invite.role} · {invite.used}/{invite.uses} used
        </span>
        <div className="set-section__grow" />
        {dead ? (
          <span className="set-invite__revoked-word">revoked</span>
        ) : (
          <>
            <DisabledIconControl label={`copy ${invite.code}`} reason={INVITE_COPY_UNAVAILABLE}>
              <span className="set-invite__meta" style={{ color: 'var(--pn-brand-2)' }}>
                ⧉ copy
              </span>
            </DisabledIconControl>
            <DisabledIconControl label={`revoke ${invite.code}`} reason={INVITE_REVOKE_UNAVAILABLE}>
              <span className="set-invite__meta">revoke</span>
            </DisabledIconControl>
          </>
        )}
      </div>
      <span className="set-invite__stamp">
        {dead
          ? `revoked ${invite.revoked!.when} by ${invite.revoked!.by} — ${invite.revoked!.effect}`
          : `created ${invite.createdWhen} by ${invite.createdBy} · ${invite.expiry}`}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// T2-1d — the redeem landing
// ---------------------------------------------------------------------------

/**
 * Oracle L141 names four states of one card: valid (drawn) plus expired /
 * revoked / used-up, "same card, wait/block word + 'ask @ada for a new link'".
 * All four are built. NO SPACE CONTENT LEAKS before joining (T4's
 * permission-lost rule) — the dead states carry the inviter's handle and
 * nothing else about the space.
 */
export const REDEEM_DEAD_WORD: Record<Exclude<RedeemState, 'valid'>, string> = {
  expired: 'This invite has expired',
  revoked: 'This invite was revoked',
  'used-up': 'This invite is used up',
};

export interface RedeemLandingProps {
  state?: RedeemState;
  /** Oracle's own copy, supplied by the host — this page has no reads of its own. */
  spaceName: string;
  invitedBy: string;
  /** Rendered only when supplied; never guessed. */
  memberCount?: number | null;
  nodeName?: string | null;
  role?: string;
  inviteCode?: string;
  expiry?: string;
  /** The typed name; live, because typing is not an act the seam performs. */
  name?: string;
  onNameChange?: (next: string) => void;
}

export function RedeemLanding({
  state = 'valid',
  spaceName,
  invitedBy,
  memberCount = null,
  nodeName = null,
  role = defaultInviteRole(),
  inviteCode,
  expiry,
  name = '',
  onNameChange,
}: RedeemLandingProps) {
  if (state !== 'valid') {
    return (
      <div className="set-redeem" data-testid={`redeem-${state}`}>
        <span className="set-redeem__mark">
          <BrandMark /> tm8
        </span>
        <span className="set-redeem__title">{REDEEM_DEAD_WORD[state]}</span>
        <span className="set-redeem__sub">ask {invitedBy} for a new link</span>
        {/* Deliberately no member count, no node, no space description: a
            stranger holding a dead link learns nothing about the space. */}
        <span className="set-redeem__foot">
          {inviteCode ? `invite ${inviteCode} · ` : ''}no space content is shown before joining
        </span>
      </div>
    );
  }

  const facts = [
    `${invitedBy} invited you`,
    memberCount === null ? null : `${memberCount} members`,
    nodeName === null ? null : `node “${nodeName}”`,
  ].filter(Boolean);

  return (
    <div className="set-redeem" data-testid="redeem-valid">
      <span className="set-redeem__mark">
        <BrandMark /> tm8
      </span>
      <span className="set-redeem__title">
        You’re invited to
        <br />
        {spaceName}
      </span>
      <span className="set-redeem__sub">{facts.join(' · ')}</span>

      <label className="set-redeem__field">
        <span className="set-redeem__label">Your name</span>
        <input
          className="set-redeem__input"
          value={name}
          placeholder="Sam Rivera"
          onChange={(e) => onNameChange?.(e.target.value)}
        />
      </label>

      {/* SAME TREATMENT, DIFFERENT SKIN — the auth lane's ruling reused. The
          oracle's primary here is an INK button (L133 #23201B/#F4F2EC), and
          wearing the brass refusal skin would make the one page a stranger
          ever sees diverge from the canvas at its most prominent element.
          Mechanics are honesty.css's verbatim (aria-disabled, focusable,
          reason in the DOM, .45); only the fill changes. */}
      <span className="set-refuse--ink">
        <DisabledAction reason={INVITE_REDEEM_UNAVAILABLE} label={`join as ${role}`}>
          Join as {role}
        </DisabledAction>
      </span>

      <span className="set-redeem__foot">
        {[inviteCode ? `invite ${inviteCode}` : null, expiry, 'joining creates your account on this node']
          .filter(Boolean)
          .join(' · ')}
      </span>
    </div>
  );
}
