/**
 * THE JOIN SCREEN — the live landing an invite link finally reaches.
 *
 * `docs/identity/MEMBER-ROLES-AND-INVITES.md` §6 named this as the one thing
 * membership was still missing: *"`/join/<code>` — the landing that consumes
 * `auth.invite.resolve`. The card is built and carries
 * `INVITE_REDEEM_LANDING_UNWIRED`; no route mounts it."* Everything under it
 * has been finished for a while — `preview_invite` and `redeem_invite` (118),
 * both catalog ops, both seam members (Amendment 11), the CLI path. This is
 * the browser end.
 *
 * IT PREVIEWS BEFORE IT JOINS, and that is the whole difference between this
 * card and the specimen ones. `previewInvite` is the single read on the seam
 * that answers before the caller is anybody, so the space, the role and the
 * inviter shown here are READ, not supplied by a host as oracle values. The
 * two built-but-refused cards (`auth` frame 1h, `settings-space/RedeemLanding`)
 * take every fact as a prop and can never be honest; this one asks.
 *
 * THE DEAD STATES ARE THE SERVER'S OWN, and so is the disclosure rule.
 * `InvitePreview` is a discriminated union precisely so a dead code discloses
 * less than a live one: `unknown` carries NOTHING — no space name, not even a
 * hint that some other code would have worked — while revoked/expired/
 * exhausted carry the space name and nothing else. Verified against a live
 * node: a bogus code answers `{"status":"unknown"}` and a revoked one
 * `{"status":"revoked","spaceName":"tm8"}`. This component renders that shape
 * as given and never fills a gap it was handed on purpose.
 *
 * WHY REDEEMING STILL NEEDS AN ACCOUNT, stated on screen rather than
 * discovered: `redeem_invite` opens with `internal.require_identity()`, so a
 * code cannot make you somebody. `auth.invite.signup` — invite-bound account
 * creation — is named in the same doc's §6 and does not exist, and
 * `auth.signup` is node-admin gated. A stranger with no account on this node
 * genuinely cannot finish, and the honest thing is to name the missing step
 * rather than loop them through a sign-in that cannot work.
 */
import { useEffect, useState } from 'react';
import type { InvitePreview, InviteRedemption, SpaceId } from '@tm8/contract';
import { Timestamp } from '../kit';
import { maskCode } from './pendingJoin';

export interface JoinScreenProps {
  code: string;
  /** `seam.previewInvite` — the claim-free read. */
  onPreview: (code: string) => Promise<InvitePreview>;
  /** `seam.commands.redeemInvite`. Absent when nobody is signed in. */
  onRedeem?: (code: string) => Promise<InviteRedemption>;
  /** Where to go once membership exists. The host owns navigation. */
  onJoined: (spaceId: SpaceId, joined: boolean) => void;
  /** Abandon the code and continue into whatever this account already has. */
  onDismiss: () => void;
}

/** The word for each way a code can be dead. The server picks which; this names it. */
export const DEAD_WORD: Record<'revoked' | 'expired' | 'exhausted', string> = {
  revoked: 'This invite was revoked',
  expired: 'This invite has expired',
  exhausted: 'This invite is used up',
};

type ValidPreview = Extract<InvitePreview, { status: 'valid' }>;

type Phase =
  | { kind: 'reading' }
  | { kind: 'preview'; preview: InvitePreview }
  | { kind: 'unreadable'; why: string }
  | { kind: 'joining'; preview: ValidPreview }
  | { kind: 'refused'; preview: ValidPreview; why: string };

/**
 * How a redeem refusal reads.
 *
 * THE ONE LOSSY EDGE, stated rather than hidden: `redeem_invite` raises 42501
 * for BOTH "was revoked" and "has expired" and the HTTP layer maps that single
 * sqlstate to `forbidden`, so the code cannot separate them. Confirmed live —
 * a revoked code answers
 * `{"code":"forbidden","message":"invite was revoked","details":{"sqlstate":"42501"}}`.
 * The server's own sentence is the only place the distinction survives, so it
 * is passed through verbatim. Guessing "expired" for a revoked link would tell
 * somebody to wait for a thing that is never coming back.
 *
 * A refusal here is rarer than it looks — the preview above already caught the
 * dead states. Reaching this means the code died BETWEEN the preview and the
 * click, which is exactly the race a re-check exists for.
 */
export function refusalOf(code: string, message: string): string {
  switch (code) {
    case 'not_found':
      return 'That code is not recognised by this node any more.';
    case 'limit_exceeded':
      return 'Somebody used the last spot on this invite while you were reading it.';
    case 'unauthenticated':
      return 'Your session ended before the join went through — sign in and open the link again.';
    case 'forbidden':
      return message;
    default:
      return message;
  }
}

export function JoinScreen({ code, onPreview, onRedeem, onJoined, onDismiss }: JoinScreenProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'reading' });

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const preview = await onPreview(code);
        if (live) setPhase({ kind: 'preview', preview });
      } catch (error) {
        // A preview that could not be READ is not a dead invite — the node may
        // simply be unreachable. Saying "this invite is invalid" here would
        // burn a good code on a network blip.
        if (live) setPhase({ kind: 'unreadable', why: messageOf(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [code, onPreview]);

  async function join(preview: ValidPreview) {
    if (!onRedeem) return;
    setPhase({ kind: 'joining', preview });
    try {
      const result = await onRedeem(code);
      // `joined: false` means this account was already a member — a success
      // whose effect had already happened. Same destination either way, so the
      // screen does not stop to explain a distinction the person never
      // experienced as a failure.
      onJoined(result.spaceId, result.joined);
    } catch (error) {
      const raw = (error as { code?: unknown })?.code;
      setPhase({
        kind: 'refused',
        preview,
        why: refusalOf(typeof raw === 'string' ? raw : 'unknown', messageOf(error)),
      });
    }
  }

  if (phase.kind === 'reading') {
    return (
      <Shell testId="join-reading">
        <p className="join__why">Checking this invite…</p>
      </Shell>
    );
  }

  if (phase.kind === 'unreadable') {
    return (
      <Shell testId="join-unreadable">
        <h1 className="join__title">This invite could not be checked</h1>
        {/* Deliberately not "invalid": the node did not answer, which is a
            different fact from the code being dead, and only one of them means
            throwing the link away. */}
        <p className="join__why">
          The node did not answer, so nothing is known about this code yet — it may still be good.
        </p>
        <p className="join__detail">{phase.why}</p>
        <Foot code={code} onDismiss={onDismiss} dismissLabel="Continue without joining" />
      </Shell>
    );
  }

  const preview = phase.preview;

  if (preview.status === 'unknown') {
    return (
      <Shell testId="join-unknown">
        <h1 className="join__title">This invite link isn’t recognised</h1>
        {/* The server discloses NOTHING for an unknown code, by rule — not the
            space, not even whether some other code would have worked. This
            card must not soften that into a guess about what went wrong. */}
        <p className="join__why">
          No space on this node is behind that code. It may have been mistyped, or truncated by
          whatever you copied it from.
        </p>
        <Foot code={code} onDismiss={onDismiss} dismissLabel="Continue without joining" />
      </Shell>
    );
  }

  if (preview.status !== 'valid') {
    return (
      <Shell testId={`join-${preview.status}`}>
        <h1 className="join__title">{DEAD_WORD[preview.status]}</h1>
        <p className="join__why">
          {preview.spaceName} is still there — this particular link just doesn’t open it any more.
          Ask whoever sent it for a new one.
        </p>
        <Foot code={code} onDismiss={onDismiss} dismissLabel="Continue without joining" />
      </Shell>
    );
  }

  return (
    <Shell testId="join-valid">
      <h1 className="join__title">
        You’re invited to
        <br />
        {preview.spaceName}
      </h1>
      <p className="join__facts">
        {preview.invitedBy === null ? null : `invited by ${preview.invitedBy} · `}
        {`joining as ${preview.role}`}
        {/* `kit/time` is the app's ONE date formatter and `Timestamp` its one
            surface (`kit/timestamp.test.tsx` enforces exactly that). Relative
            is also the right read: "expires in 6 days" answers the question a
            person holding a link actually has. */}
        {preview.expiresAt === null ? null : (
          <>
            {' · '}
            <Timestamp at={preview.expiresAt} prefix="expires" />
          </>
        )}
      </p>

      {onRedeem ? (
        <>
          <button
            type="button"
            className="join__primary"
            data-testid="join-accept"
            disabled={phase.kind === 'joining'}
            onClick={() => void join(preview)}
          >
            {phase.kind === 'joining' ? 'Joining…' : `Join ${preview.spaceName}`}
          </button>
          {phase.kind === 'refused' ? (
            <p className="join__problem" role="alert" data-testid="join-refused">
              {phase.why}
            </p>
          ) : null}
        </>
      ) : (
        /* SIGNED OUT. `redeem_invite` requires an identity, so there is nothing
           to click yet — and this names the missing step instead of offering a
           button that would fail. The code stays parked, so signing in comes
           straight back here. */
        <p className="join__why" data-testid="join-needs-account">
          Sign in on this node to accept — a code cannot create an account by itself, so joining
          adds an existing account to the space.
        </p>
      )}

      <Foot code={code} onDismiss={onDismiss} dismissLabel="Not now" />
    </Shell>
  );
}

function messageOf(error: unknown): string {
  return String((error as { message?: string })?.message ?? error);
}

function Shell({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <div className="join" data-testid={testId}>
      <span className="join__mark">◈ tm8</span>
      {children}
    </div>
  );
}

function Foot({
  code,
  onDismiss,
  dismissLabel,
}: {
  code: string;
  onDismiss: () => void;
  dismissLabel: string;
}) {
  return (
    <>
      <button type="button" className="join__ghost" data-testid="join-dismiss" onClick={onDismiss}>
        {dismissLabel}
      </button>
      {/* Masked: enough to tell somebody WHICH link they are holding when they
          ask for help, without printing the credential itself. */}
      <p className="join__foot">invite {maskCode(code)}</p>
    </>
  );
}
