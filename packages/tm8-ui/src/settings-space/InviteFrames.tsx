/**
 * T2-1c INVITES (oracle L91–L122) and T2-1d REDEEM LANDING (L124–L141).
 *
 * WHAT THIS FILE USED TO SAY, AND WHY IT WAS HALF WRONG. Its header opened
 * "THE WHOLE FEATURE HAS NO SEAM… That is a MISSING CAPABILITY, not a missing
 * wire." The first half was true — `data/seam.ts` carried no invite verb. The
 * second half was false: `create_invite`, `w2_revoke_invite` and
 * `redeem_invite` had been in `007_rpc_catalog.sql` since W1, with
 * `spaces.invites.*` in the contract catalog the whole time. The node could
 * always do this. **"The seam cannot" and "the node cannot" are different
 * facts, and only one of them is a missing capability** — a screen can only
 * observe the first, and this file reported the second.
 *
 * It is wired now (seam Amendment 11; migration 114 added the role an invite
 * confers). `InvitesPanel` reads, creates, copies and revokes for real, and
 * the specimen rows moved to their own component so the dev review board can
 * still diff the canvas without product ever reaching them.
 *
 * WHAT IS STILL REFUSED, and it is a refusal rather than a gap: the redeem
 * landing at the foot of this file. `auth.invite.resolve` and
 * `spaces.invites.redeem` both exist, but no `/join/<code>` route mounts this
 * card against them yet — so its primary action carries
 * `INVITE_REDEEM_LANDING_UNWIRED`, which names the two live operations and the
 * CLI verb that works today rather than claiming nothing can.
 *
 * R7 still governs throughout: unavailable ≠ invisible.
 */
import { useState } from 'react';
import type { CreateInviteInput, SpaceInviteView, SpaceMemberRole } from '@tm8/contract';
import { BrandMark } from '../kit';
import { DisabledAction, DisabledIconControl } from '../panels';
import { defaultInviteRole, inviteRoles } from './port';
import type { RedeemState, SpecimenInvite } from './types';
import {
  INVITE_CREATE_NOT_ADMIN,
  INVITE_REDEEM_LANDING_UNWIRED,
  INVITE_REVOKE_NOT_ADMIN,
} from './reasons';

/**
 * The join URL a code becomes.
 *
 * Built from the CURRENT ORIGIN, never from a configured base: the person
 * copying it reached this screen at some origin, and that is the one their
 * colleague can also reach. A configured base goes stale silently and produces
 * a link that fails for the recipient and works for the sender — the worst
 * failure shape for a thing whose entire job is to be sent to somebody else.
 *
 * The route it names is not mounted yet, which is stated next to the control.
 * The CODE is what actually carries the capability, and `tm8 space invite
 * redeem <code>` consumes it today.
 */
export function joinUrlFor(code: string, origin?: string): string {
  const base = origin ?? (typeof window === 'undefined' ? '' : window.location.origin);
  return `${base}/join/${code}`;
}

export interface InvitesPanelProps {
  /**
   * The live list, newest first. `null` means NOT LOADED — the panel says so
   * rather than drawing an empty list, because "no invites exist" and "the read
   * has not answered" are different facts and only one of them is actionable.
   */
  invites?: readonly SpaceInviteView[] | null;
  /** Absent ⇒ this viewer cannot mint one; the control renders locked. */
  onCreate?: (input: Omit<CreateInviteInput, 'clientMutationId' | 'actorId'>) => Promise<unknown>;
  /** Absent ⇒ revoke renders locked, for the same reason. */
  onRevoke?: (inviteId: string) => Promise<unknown>;
  /** Injected in tests; production reads `window.location.origin`. */
  origin?: string;
  /**
   * The dev review board's oracle rows. Kept so the canvas can still be
   * diffed, and still named for what it is so nobody mistakes it for data.
   * When supplied it REPLACES the live list.
   */
  specimen?: readonly SpecimenInvite[] | null;
}

/**
 * The roles an invite may confer, from REGISTRY DATA (114 R4: never `owner`).
 * See `port.inviteRoles` for why this is derived and not a written pair.
 */
type InviteRole = Exclude<SpaceMemberRole, 'owner'>;

/** Expiry choices, as offsets. `null` = never, which is the RPC's own default. */
const EXPIRY_CHOICES: ReadonlyArray<{ label: string; days: number | null }> = [
  { label: 'never expires', days: null },
  { label: 'expires in 7 days', days: 7 },
  { label: 'expires in 30 days', days: 30 },
];

export function InvitesPanel({
  invites = null,
  onCreate,
  onRevoke,
  origin,
  specimen = null,
}: InvitesPanelProps) {
  if (specimen !== null) return <SpecimenInvitesPanel specimen={specimen} />;

  const roles = inviteRoles();
  // The least-privileged role is the default: an invitation should grant the
  // smallest thing that works, and the person minting it can widen it in one
  // click on the control right there.
  const [role, setRole] = useState<string>(defaultInviteRole());
  const [maxUses, setMaxUses] = useState(1);
  const [expiryDays, setExpiryDays] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** Which code was last copied, so the control can confirm it happened. */
  const [copied, setCopied] = useState<string | null>(null);

  const rows = invites ?? [];
  const active = rows.filter((i) => !i.revoked);
  const revoked = rows.filter((i) => i.revoked);

  async function create() {
    if (!onCreate) return;
    setBusy(true);
    setFailure(null);
    try {
      await onCreate({
        // The vocabulary came from the registry, so the cast asserts what the
        // derivation already guarantees: `inviteRoles()` is every role except
        // the owner word, which is exactly `InviteRole`.
        role: role as InviteRole,
        maxUses,
        // An offset resolved HERE, at click time, from the browser's clock.
        // The alternative — sending "7 days" and letting the server resolve it
        // — would make the expiry depend on which clock answered, and the two
        // disagree often enough to matter for a thing measured in days.
        expiresAt:
          expiryDays === null
            ? null
            : new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString(),
      });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function copy(code: string) {
    const url = joinUrlFor(code, origin);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(code);
    } catch {
      // Clipboard access is refusable (permissions, insecure origin, jsdom).
      // Selecting the link so it can be copied by hand is the honest fallback;
      // reporting success we did not have is not.
      setCopied(null);
      setFailure(`could not reach the clipboard — copy this by hand: ${url}`);
    }
  }

  return (
    <>
      <div className="set-section__head">
        <span className="set-section__title">Invites</span>
        <div className="set-section__grow" />
      </div>

      {/* create — role + budget + expiry at creation (oracle L99–L104) */}
      <div className="set-invite-form">
        <div style={{ display: 'flex', gap: 6 }}>
          <select
            className="set-field set-field--grow"
            aria-label="invite role"
            data-testid="invite-role"
            value={role}
            disabled={!onCreate || busy}
            onChange={(e) => setRole(e.target.value)}
          >
            {roles.map((r) => (
              <option key={r} value={r}>
                joins as {r}
              </option>
            ))}
          </select>
          <select
            className="set-field"
            aria-label="invite use budget"
            data-testid="invite-uses"
            value={maxUses}
            disabled={!onCreate || busy}
            onChange={(e) => setMaxUses(Number(e.target.value))}
          >
            {[1, 5, 25].map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? 'use' : 'uses'}
              </option>
            ))}
          </select>
          <select
            className="set-field"
            aria-label="invite expiry"
            data-testid="invite-expiry"
            value={expiryDays === null ? '' : String(expiryDays)}
            disabled={!onCreate || busy}
            onChange={(e) => setExpiryDays(e.target.value === '' ? null : Number(e.target.value))}
          >
            {EXPIRY_CHOICES.map((c) => (
              <option key={c.label} value={c.days === null ? '' : String(c.days)}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        {onCreate ? (
          <button
            type="button"
            className="set-refuse--block"
            data-testid="invite-create"
            disabled={busy}
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : 'Create invite link'}
          </button>
        ) : (
          <span className="set-refuse--block">
            <DisabledAction reason={INVITE_CREATE_NOT_ADMIN} label="create invite link">
              Create invite link
            </DisabledAction>
          </span>
        )}

        {/* Stated once, next to the control that mints them, rather than in a
            tooltip nobody opens: an invite is a bearer capability. */}
        <span className="set-absent__why">
          anyone holding the link can join as {role} until it is used up or revoked — send it the way
          you would send a password
        </span>

        {failure ? (
          <span className="set-absent__why" role="alert" data-testid="invite-error">
            {failure}
          </span>
        ) : null}
      </div>

      <div className="set-section__scroll">
        {invites === null ? (
          <div className="set-absent" data-testid="invites-absent">
            <span className="set-absent__head">The invite list has not been read.</span>
            <span className="set-absent__why">
              this is an unread, not a measured empty — listing invites needs admin in this space
            </span>
          </div>
        ) : (
          <>
            <div className="set-invite__group set-eyebrow">Active · {active.length}</div>
            {active.length === 0 ? (
              <div className="set-absent" data-testid="invites-none-active">
                <span className="set-absent__head">No live invitations.</span>
                <span className="set-absent__why">
                  the list was read and carries none — create one above to invite somebody
                </span>
              </div>
            ) : null}
            {active.map((i) => (
              <LiveInviteRow
                invite={i}
                key={i.id}
                origin={origin}
                copied={copied === i.code}
                onCopy={() => void copy(i.code)}
                {...(onRevoke ? { onRevoke: () => void onRevoke(i.id) } : {})}
              />
            ))}
            <div className="set-invite__group set-eyebrow">Revoked · {revoked.length}</div>
            {revoked.map((i) => (
              <LiveInviteRow invite={i} key={i.id} origin={origin} copied={false} />
            ))}
          </>
        )}
      </div>
    </>
  );
}

/**
 * One live invite row.
 *
 * A revoked row KEEPS ITS CODE VISIBLE and struck through rather than being
 * deleted (oracle L137). The code is dead — `redeem_invite` refuses it with
 * 42501 — so showing it discloses nothing, and it is the only way somebody
 * holding a link that stopped working can confirm which link it was.
 */
function LiveInviteRow({
  invite,
  origin,
  copied,
  onCopy,
  onRevoke,
}: {
  invite: SpaceInviteView;
  origin?: string;
  copied: boolean;
  onCopy?: () => void;
  onRevoke?: () => void;
}) {
  const dead = invite.revoked;
  const exhausted = !dead && invite.uses >= invite.maxUses;
  return (
    <div className={dead ? 'set-invite set-invite--revoked' : 'set-invite'} data-testid="invite-row">
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span className="set-invite__code">{invite.code}</span>
        <span className="set-invite__meta">
          joins as {invite.role} · {invite.uses}/{invite.maxUses} used
          {exhausted ? ' · used up' : ''}
        </span>
        <div className="set-section__grow" />
        {dead ? (
          <span className="set-invite__revoked-word">revoked</span>
        ) : (
          <>
            {onCopy ? (
              <button
                type="button"
                className="set-invite__meta"
                style={{ color: 'var(--pn-brand-2)' }}
                data-testid="invite-copy"
                aria-label={`copy the join link for ${invite.code}`}
                onClick={onCopy}
              >
                {copied ? '✓ copied' : '⧉ copy link'}
              </button>
            ) : null}
            {onRevoke ? (
              <button
                type="button"
                className="set-invite__meta"
                data-testid="invite-revoke"
                aria-label={`revoke ${invite.code}`}
                onClick={onRevoke}
              >
                revoke
              </button>
            ) : (
              <DisabledIconControl label={`revoke ${invite.code}`} reason={INVITE_REVOKE_NOT_ADMIN}>
                <span className="set-invite__meta">revoke</span>
              </DisabledIconControl>
            )}
          </>
        )}
      </div>
      <span className="set-invite__stamp">
        {dead
          ? 'revoked — the code no longer joins anyone, and it is kept so a stale link can still be identified'
          : `${joinUrlFor(invite.code, origin)} · ${
              invite.expiresAt === null ? 'never expires' : `expires ${invite.expiresAt}`
            }`}
      </span>
    </div>
  );
}

/** The oracle's rows, unchanged — dev review board only, never product. */
function SpecimenInvitesPanel({ specimen }: { specimen: readonly SpecimenInvite[] }) {
  const active = specimen.filter((i) => !i.revoked);
  const revoked = specimen.filter((i) => i.revoked);
  return (
    <>
      <div className="set-section__head">
        <span className="set-section__title">Invites</span>
        <div className="set-section__grow" />
        <span className="set-invite__meta">oracle specimen — not data</span>
      </div>
      <div className="set-section__scroll">
        <div className="set-invite__group set-eyebrow">Active · {active.length}</div>
        {active.map((i) => (
          <InviteRow invite={i} key={i.code} />
        ))}
        <div className="set-invite__group set-eyebrow">Revoked · {revoked.length}</div>
        {revoked.map((i) => (
          <InviteRow invite={i} key={i.code} />
        ))}
      </div>
    </>
  );
}

/** One specimen row. Revoked rows keep their audit trail struck through (oracle L137). */
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
        {dead ? <span className="set-invite__revoked-word">revoked</span> : null}
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
        <DisabledAction reason={INVITE_REDEEM_LANDING_UNWIRED} label={`join as ${role}`}>
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
