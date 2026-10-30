/**
 * Invite to space — the People tab's guest-row action (B3, BRIDGE-ENTITY-DESIGN
 * §2.4 "Invite", D60). Drawn in `<BridgePeopleTab renderInvite>` (lane P, D51),
 * which shows it only on guest rows and only to a space admin.
 *
 * It mints ONE join link with `spaces.invites.create`, one use, pinned to this
 * participant. The bridge never messages anyone (D28): the admin copies the
 * link and shares it themselves. Whoever joins with it has this number linked
 * to their account, identity-scoped, as a code would (D5).
 */
import { useState } from 'react';
import type { CreateInviteInput, EntityId, SpaceId, SpaceInviteView } from '@tm8/contract';
import './invite-to-space.css';

/**
 * The fields of P's `BridgeParticipant` this action reads. Structural, so the
 * full row passes as is.
 */
export interface InviteParticipant {
  externalId: string;
  displayName: string | null;
}

export interface InviteToSpaceProps {
  spaceId: SpaceId;
  bridgeId: EntityId;
  participant: InviteParticipant;
  /** `seam.commands.createInvite`. */
  createInvite: (spaceId: SpaceId, input: CreateInviteInput) => Promise<SpaceInviteView>;
  /** Builds the join link from a code; defaults to this origin's `/join/<code>`. */
  joinUrl?: (code: string) => string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const defaultJoinUrl = (code: string): string =>
  `${typeof window === 'undefined' ? '' : window.location.origin}/join/${code}`;

/** '···· 0002': the last four digits, which is all a row shows anyone. */
export function maskedNumber(externalId: string): string {
  const bare = externalId.replace(/@.*$/, '');
  return bare.length <= 4 ? '····' : `···· ${bare.slice(-4)}`;
}

export function InviteToSpace({ spaceId, bridgeId, participant, createInvite, joinUrl = defaultJoinUrl }: InviteToSpaceProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const who = participant.displayName || maskedNumber(participant.externalId);

  const mint = async () => {
    setBusy(true);
    setError(null);
    try {
      const invite = await createInvite(spaceId, {
        clientMutationId: `bridge-invite-${bridgeId}-${Date.now()}`,
        maxUses: 1,
        bridgeParticipant: { bridgeId, externalId: participant.externalId },
      });
      setLink(joinUrl(invite.code));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setCopied(false); }
  };

  if (!open) {
    return (
      <button type="button" className="bri-invite__open" data-testid={`bridge-invite-${participant.externalId}`}
        onClick={() => setOpen(true)}>
        Invite to space
      </button>
    );
  }

  return (
    <div className="bri-invite" role="dialog" aria-label={`Invite ${who} to this space`} data-testid="bridge-invite-panel">
      {link ? (
        <>
          <span className="bri-invite__head">Join link for {who}</span>
          <div className="bri-invite__row">
            <code className="bri-invite__link" data-testid="bridge-invite-link">{link}</code>
            <button type="button" className="bri-invite__act" onClick={() => void copy()}>{copied ? 'copied' : 'copy'}</button>
          </div>
          <span className="bri-invite__note">
            Send it to them yourself; tm8 does not message them. It works once. When they join with it, their messages
            from {maskedNumber(participant.externalId)} count as them.
          </span>
          <div className="bri-invite__row">
            <button type="button" className="bri-invite__act bri-invite__act--quiet" onClick={() => { setOpen(false); setLink(null); }}>
              done
            </button>
          </div>
        </>
      ) : (
        <>
          <span className="bri-invite__head">Invite {who} to this space?</span>
          <span className="bri-invite__note">
            You get a one-use join link to share with them yourself. tm8 never messages them. When they join with it,
            {` ${maskedNumber(participant.externalId)}`} is linked to their account.
          </span>
          {error ? <span className="bri-invite__error" role="alert" data-testid="bridge-invite-error">{error}</span> : null}
          <div className="bri-invite__row">
            <button type="button" className="bri-invite__act bri-invite__act--quiet" onClick={() => setOpen(false)}>cancel</button>
            <button type="button" className="bri-invite__act bri-invite__act--go" disabled={busy}
              data-testid="bridge-invite-mint" onClick={() => void mint()}>
              make join link
            </button>
          </div>
        </>
      )}
    </div>
  );
}
