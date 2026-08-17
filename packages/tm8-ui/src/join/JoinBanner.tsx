/**
 * The line the auth gate shows while a join code is parked.
 *
 * THE PROBLEM IT SOLVES. A stranger clicks an invite link and `AuthGate`
 * renders the sign-in card, because redeeming needs an identity. Without a
 * word here they meet a bare credential wall with no connection to the thing
 * they clicked — the same silence the missing route had, moved one screen
 * later. This says why they are being asked.
 *
 * IT MAKES NO CLAIM ABOUT THE INVITE. It deliberately does not name the space,
 * the inviter or the role, even though `previewInvite` could answer all three
 * without a session: the gate has no seam (App.tsx keeps seam construction in
 * `useGateData` so a second one cannot open a duplicate connection), and
 * inventing a client here to decorate a banner would trade a real
 * architectural rule for a nicety. Those facts are read on the other side of
 * the gate, on the join screen itself, where they are the whole page.
 */
export interface JoinBannerProps {
  /** Rendered only when a code is actually parked. */
  pending: boolean;
}

export function JoinBanner({ pending }: JoinBannerProps) {
  if (!pending) return null;
  return (
    <div className="join-banner" data-testid="join-banner">
      <span>You’ve been invited to a space — sign in to accept.</span>
      <span className="join-banner__sub">
        your invite is held until you do; a code cannot create an account by itself
      </span>
    </div>
  );
}
