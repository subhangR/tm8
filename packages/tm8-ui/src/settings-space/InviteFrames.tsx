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
import { SectionFrame } from './SectionFrame';
import { SETTINGS_SECTIONS, type RedeemState, type SpecimenInvite } from './types';
import {
  INVITE_CREATE_NOT_ADMIN,
  INVITE_REDEEM_LANDING_UNWIRED,
  INVITE_REVOKE_NOT_ADMIN,
} from './reasons';
// Imported HERE and not from `index.ts` — SECTION-CONTRACT §5: the barrel is
// shared by twelve lanes and an import added to it is a conflict with eleven.
import './invites.css';

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

/**
 * THE THREE STATES OF ONE CODE, derived in one place.
 *
 * They were previously separated by an opacity and a run of words in the same
 * 9px grey: a used-up invite rendered identically to a live one but for the
 * trailing " · used up" at the end of its meta line, and a revoked one was the
 * same row at 0.7. Opacity says "less important", which is the wrong sentence
 * for "this code was deliberately killed". Each state now names itself.
 */
type InviteState = 'live' | 'spent' | 'revoked';

function stateOf(invite: SpaceInviteView): InviteState {
  if (invite.revoked) return 'revoked';
  return invite.uses >= invite.maxUses ? 'spent' : 'live';
}

const STATE_WORD: Record<InviteState, string> = {
  live: 'live',
  spent: 'used up',
  revoked: 'revoked',
};

/** What was last copied, and which of the two things it was. */
type Copied = { code: string; kind: 'code' | 'link' };

/**
 * The heading, READ FROM THE REGISTRY rather than re-typed (SECTION-CONTRACT
 * §2). The shell hands every other section `def.heading` and this one mounts
 * itself, so taking the same string from the same row is what keeps the two
 * from drifting the day somebody renames the tab.
 */
const INVITES_HEADING = SETTINGS_SECTIONS.find((s) => s.id === 'invites')!.heading;

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
  const [copied, setCopied] = useState<Copied | null>(null);

  const rows = invites ?? [];
  const live = rows.filter((i) => stateOf(i) === 'live');
  const spent = rows.filter((i) => stateOf(i) === 'spent');
  const revoked = rows.filter((i) => stateOf(i) === 'revoked');

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

  /**
   * TWO THINGS ARE COPYABLE, and they are not the same thing.
   *
   * The LINK is what you send to a colleague. The CODE is what
   * `tm8 space invite redeem <code>` consumes, and it was previously a `<span>`
   * you could only take away by dragging across an 11px monospace string — the
   * one artefact on this screen whose entire purpose is to leave it.
   */
  async function copy(code: string, kind: Copied['kind']) {
    const text = kind === 'link' ? joinUrlFor(code, origin) : code;
    try {
      await navigator.clipboard.writeText(text);
      setCopied({ code, kind });
    } catch {
      // Clipboard access is refusable (permissions, insecure origin, jsdom).
      // Selecting the link so it can be copied by hand is the honest fallback;
      // reporting success we did not have is not.
      setCopied(null);
      setFailure(`could not reach the clipboard — copy this by hand: ${text}`);
    }
  }

  function group(label: string, list: readonly SpaceInviteView[]) {
    if (list.length === 0) return null;
    return (
      <>
        <div className="set-invites__group">
          <span className="set-eyebrow">{label}</span>
          <span className="set-invites__count">{list.length}</span>
        </div>
        {list.map((i) => (
          <LiveInviteRow
            invite={i}
            key={i.id}
            origin={origin}
            copied={copied?.code === i.code ? copied.kind : null}
            onCopy={(kind) => void copy(i.code, kind)}
            {...(onRevoke && !i.revoked ? { onRevoke: () => void onRevoke(i.id) } : {})}
          />
        ))}
      </>
    );
  }

  /* `measure={false} pad={false}`: the rows are the full-bleed case
     `SectionFrame` names in its own doc comment, so their hairlines reach the
     card edge and read as table rules. Each block below carries the 18px
     gutter itself and caps its CONTENT at the measure — left-aligned, not
     centred, so it starts on the same gutter as the section title above it. */
  return (
    <SectionFrame
      title={INVITES_HEADING}
      measure={false}
      pad={false}
      bodyTestId="invites-body"
      action={
        invites === null ? null : (
          <span className="set-invites__count" data-testid="invite-tally">
            {live.length} live · {spent.length} used up · {revoked.length} revoked
          </span>
        )
      }
    >
      {/* create — role + budget + expiry at creation (oracle L99–L104).
          It lives INSIDE the one scroller rather than fixed above it: at
          900×600 the fixed form took 128px of a 407px pane permanently, and
          the contract's one-scroller rule (§3) is what makes the rest
          reachable. */}
      <div className="set-invites__form">
        <div className="set-invites__formInner">
          <span className="set-eyebrow">New invitation</span>
          <div className="set-invites__fields">
            {/* Labelled, not merely aria-labelled: before this the three
                selects were a bare row and the only way to know the middle one
                meant "how many people may use it" was to open it. */}
            <label className="set-invites__field set-invites__field--role">
              <span className="set-invites__label">Role</span>
              <select
                className="set-field"
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
            </label>
            <label className="set-invites__field">
              <span className="set-invites__label">Uses</span>
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
            </label>
            <label className="set-invites__field">
              <span className="set-invites__label">Expiry</span>
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
            </label>
          </div>

          {/* The submit line. The affordance is a CHIP, at its own width, and
              the consequence sits on the same baseline beside it. It was a
              100%-wide `.set-refuse--block` before — a class that sets only
              `display:block; width:100%`, so the LIVE button rendered as raw
              browser chrome while the refused one inherited honesty.css's
              brass. The working state looked worse than the refused one. */}
          <div className="set-invites__submit">
            <span className="set-invites__caution">
              anyone holding the link can join as {role} until it is used up or revoked — send it the
              way you would send a password
            </span>
            <span className="set-invites__go">
              {onCreate ? (
                <button
                  type="button"
                  className="set-chip"
                  data-testid="invite-create"
                  disabled={busy}
                  onClick={() => void create()}
                >
                  {busy ? 'Creating…' : 'Create invite link'}
                </button>
              ) : (
                <DisabledAction reason={INVITE_CREATE_NOT_ADMIN} label="create invite link">
                  Create invite link
                </DisabledAction>
              )}
            </span>
          </div>

          {failure ? (
            <span className="set-invites__error" role="alert" data-testid="invite-error">
              {failure}
            </span>
          ) : null}
        </div>
      </div>

      {invites === null ? (
        /* THE COMMON CASE. Most viewers are not admins here, so this is the
           state this section is usually IN — and a single grey line under a
           form nobody can use is indistinguishable from a screen that failed
           to load. It is framed, and it names the remedy. `null` still means
           NOT READ and never "there are none": that distinction is the whole
           point of the block and both sentences are load-bearing. */
        <div className="set-invites__locked" data-testid="invites-absent">
          <span className="set-invites__lockedEyebrow">Not read</span>
          <span className="set-invites__lockedHead">The invite list has not been read.</span>
          <span className="set-invites__lockedWhy">
            this is an unread, not a measured empty — listing invites needs admin in this space. Ask
            an admin or the owner to list them, or run <code>tm8 space invite list</code> with an
            account that has it.
          </span>
        </div>
      ) : (
        <>
          {rows.length === 0 ? (
            <div className="set-invites__empty" data-testid="invites-none-active">
              <span className="set-absent__head">No live invitations.</span>
              <span className="set-absent__why">
                the list was read and carries none — create one above to invite somebody
              </span>
            </div>
          ) : live.length === 0 ? (
            /* Read, non-empty, and yet nothing here can be redeemed. A
               different fact from "carries none", so it gets its own words. */
            <div className="set-invites__empty" data-testid="invites-none-live">
              <span className="set-absent__head">No live invitations.</span>
              <span className="set-absent__why">
                every invitation this space has minted is used up or revoked — create one above
              </span>
            </div>
          ) : (
            group('Live', live)
          )}
          {group('Used up', spent)}
          {group('Revoked', revoked)}
        </>
      )}
    </SectionFrame>
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
  /** Which of the row's two copyables was last taken, if either. */
  copied: 'code' | 'link' | null;
  onCopy?: (kind: 'code' | 'link') => void;
  onRevoke?: () => void;
}) {
  const state = stateOf(invite);
  const dead = state === 'revoked';
  return (
    <div className={`set-invites__row set-invites__row--${state}`} data-testid="invite-row">
      <div className="set-invites__rowInner">
        <div className="set-invites__rowTop">
          {/* The state, first and named. A reader should not have to parse
              "1/1 used" against a maxUses they have to find to learn that this
              code no longer works. */}
          <span
            className={`set-invites__state set-invites__state--${state}`}
            data-testid={`invite-state-${state}`}
          >
            {STATE_WORD[state]}
          </span>

          {/* The code is a control on a live row and plain text on a dead one:
              copying a code that `redeem_invite` refuses with 42501 would hand
              somebody a string that only looks like a capability. */}
          {dead || !onCopy ? (
            <span className="set-invites__code set-invites__code--dead">{invite.code}</span>
          ) : (
            <button
              type="button"
              className={`set-invites__code${copied === 'code' ? ' set-invites__act--copied' : ''}`}
              data-testid="invite-copy-code"
              aria-label={`copy the invite code ${invite.code}`}
              onClick={() => onCopy('code')}
            >
              {copied === 'code' ? '✓ copied' : invite.code}
            </button>
          )}

          <span className="set-invites__meta">
            joins as {invite.role} · {invite.uses}/{invite.maxUses} used
          </span>
          <div className="set-invites__grow" />

          {dead ? null : (
            <>
              {onCopy ? (
                <button
                  type="button"
                  className={`set-invites__act${copied === 'link' ? ' set-invites__act--copied' : ''}`}
                  data-testid="invite-copy"
                  aria-label={`copy the join link for ${invite.code}`}
                  onClick={() => onCopy('link')}
                >
                  {copied === 'link' ? '✓ copied' : '⧉ copy link'}
                </button>
              ) : null}
              {onRevoke ? (
                <button
                  type="button"
                  className="set-invites__act set-invites__act--danger"
                  data-testid="invite-revoke"
                  aria-label={`revoke ${invite.code}`}
                  onClick={onRevoke}
                >
                  revoke
                </button>
              ) : (
                <DisabledIconControl label={`revoke ${invite.code}`} reason={INVITE_REVOKE_NOT_ADMIN}>
                  <span className="set-invites__meta">revoke</span>
                </DisabledIconControl>
              )}
            </>
          )}
        </div>
        {/* An expiry is a fact about a code that could still be redeemed. A
            used-up one cannot be, so printing "expires 2026-09-14" beside it
            states a deadline that stopped mattering the moment the budget ran
            out — the row said the same sentence as a live row. */}
        <span className="set-invites__stamp">
          {dead
            ? 'revoked — the code no longer joins anyone, and it is kept so a stale link can still be identified'
            : state === 'spent'
              ? `${joinUrlFor(invite.code, origin)} · its ${invite.maxUses} ${
                  invite.maxUses === 1 ? 'use is' : 'uses are'
                } spent, so it joins nobody else`
              : `${joinUrlFor(invite.code, origin)} · ${
                  invite.expiresAt === null ? 'never expires' : `expires ${invite.expiresAt}`
                }`}
        </span>
      </div>
    </div>
  );
}

/** The oracle's rows, unchanged — dev review board only, never product. */
function SpecimenInvitesPanel({ specimen }: { specimen: readonly SpecimenInvite[] }) {
  const active = specimen.filter((i) => !i.revoked);
  const revoked = specimen.filter((i) => i.revoked);
  /* The specimen rows keep the older `.set-invite*` rules from `settings.css`
     verbatim — they are the canvas the dev review board diffs against, and
     restyling them would be changing the oracle to match the product. Only the
     FRAME around them moves onto `SectionFrame`. */
  return (
    <SectionFrame
      title={INVITES_HEADING}
      measure={false}
      pad={false}
      bodyTestId="invites-specimen-body"
      action={<span className="set-invite__meta">oracle specimen — not data</span>}
    >
      <div className="set-invite__group set-eyebrow">Active · {active.length}</div>
      {active.map((i) => (
        <InviteRow invite={i} key={i.code} />
      ))}
      <div className="set-invite__group set-eyebrow">Revoked · {revoked.length}</div>
      {revoked.map((i) => (
        <InviteRow invite={i} key={i.code} />
      ))}
    </SectionFrame>
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
  /* NOT a settings section — it is the entire page a stranger holding a link
     sees, and forcing it into `SectionFrame` would put a settings head on the
     one screen that has no settings behind it. What it DID lack was a width
     bound of its own: it inherited whatever the host gave it, so on a wide
     host the 22px serif title ran the full window. It is centred, on paper,
     and capped at 380px here. */
  if (state !== 'valid') {
    return (
      <div className="set-invites__redeemPage">
        <div className="set-redeem set-invites__redeemCard" data-testid={`redeem-${state}`}>
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
      </div>
    );
  }

  const facts = [
    `${invitedBy} invited you`,
    memberCount === null ? null : `${memberCount} members`,
    nodeName === null ? null : `node “${nodeName}”`,
  ].filter(Boolean);

  return (
    <div className="set-invites__redeemPage">
      <div className="set-redeem set-invites__redeemCard" data-testid="redeem-valid">
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
          {[
            inviteCode ? `invite ${inviteCode}` : null,
            expiry,
            'joining creates your account on this node',
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
    </div>
  );
}
