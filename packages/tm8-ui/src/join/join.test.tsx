// @vitest-environment jsdom
/**
 * THE JOIN JOURNEY, asserted end to end.
 *
 * The defect this suite exists to prevent is the one the feature actually
 * had: EVERY LAYER BUILT, NOTHING CONNECTED. `preview_invite` and
 * `redeem_invite` shipped in migration 118, both got catalog ops, both got
 * seam verbs, the CLI got `tm8 space invite redeem`, and the admin screen even
 * generated `${origin}/join/{code}` links — while nothing on the receiving end
 * read one, so every link a user sent landed silently on somebody's home
 * screen. Typechecks passed the whole time.
 *
 * So these assert BEHAVIOUR ACROSS the seam: what the link parses to, what
 * survives the sign-in, what is asked of the seam, and what a person then
 * sees. A test that only proved `previewInvite` exists would have passed on
 * the broken build too.
 *
 * The shapes below are not invented — they were read off a live node
 * (`POST /v2/auth/invite/resolve`), which answered `{"status":"unknown"}` for a
 * bogus code, `{"status":"revoked","spaceName":"tm8"}` after a revoke, and the
 * full `valid` union for a live one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CollabError, type InvitePreview, type InviteRedemption } from '@tm8/contract';
import {
  PENDING_JOIN_KEY,
  capturePendingJoin,
  clearPendingJoin,
  maskCode,
  newJoinMutationId,
  peekPendingJoin,
  readJoinCode,
} from './pendingJoin';
import { JoinScreen, refusalOf } from './JoinScreen';
import { JoinBanner } from './JoinBanner';

afterEach(cleanup);

const CODE = 'inv_abcdefabcdefabcdefabcdefabcdef01';

const VALID: InvitePreview = {
  status: 'valid',
  spaceId: 'space-7' as never,
  spaceName: 'atelier',
  role: 'member',
  invitedBy: 'Ada Osei',
  expiresAt: null,
};

const REDEEMED: InviteRedemption = {
  spaceId: 'space-7' as never,
  memberId: 'member-9' as never,
  joined: true,
};

beforeEach(() => {
  sessionStorage.clear();
  history.replaceState(null, '', '/');
});

describe('the link the admin actually copies', () => {
  it('parses the PATH form, which is what joinUrlFor emits', () => {
    // `settings-space/InviteFrames.tsx:joinUrlFor` produces
    // `${origin}/join/{code}`, and the node's static handler serves index.html
    // for extension-less paths — so this spelling is the one that reaches the
    // app in production.
    expect(readJoinCode(`/join/${CODE}`, '')).toBe(CODE);
    expect(readJoinCode(`/join/${CODE}/`, '')).toBe(CODE);
  });

  it('parses the HASH form too, for a host with no SPA rewrite', () => {
    expect(readJoinCode('/', `#/join/${CODE}`)).toBe(CODE);
  });

  it('survives the percent-encoding chat clients apply without asking', () => {
    expect(readJoinCode('/join/a%2Fb', '')).toBe('a/b');
  });

  it('is not confused by any other address in the app', () => {
    for (const [path, hash] of [
      ['/', '#/s/space-1/home'],
      ['/', ''],
      ['/joinery/x', ''],
      ['/join/', ''],
      ['/s/space-1/join', ''],
    ] as const) {
      expect(readJoinCode(path, hash), `${path} ${hash}`).toBeNull();
    }
  });

  it('refuses a malformed escape rather than parking garbage', () => {
    expect(readJoinCode('/join/%E0%A4%A', '')).toBeNull();
  });
});

describe('parking the code across the sign-in', () => {
  it('captures it and STRIPS it from the address bar', () => {
    history.replaceState(null, '', `/join/${CODE}`);
    expect(capturePendingJoin()).toBe(CODE);
    // A credential must not sit in the URL for the rest of the session.
    expect(location.pathname).toBe('/');
    expect(peekPendingJoin()).toBe(CODE);
  });

  it('SURVIVES the account ceremony the gate forces in between', () => {
    history.replaceState(null, '', `/join/${CODE}`);
    capturePendingJoin();
    // The URL no longer carries it, and AuthGate has thrown away and rebuilt
    // the tree — which is exactly what signing in does.
    expect(capturePendingJoin()).toBe(CODE);
  });

  it('a bare boot parks nothing and invents nothing', () => {
    expect(capturePendingJoin()).toBeNull();
    expect(sessionStorage.getItem(PENDING_JOIN_KEY)).toBeNull();
  });

  it('clearing means the next boot is not ambushed by an abandoned code', () => {
    history.replaceState(null, '', `/join/${CODE}`);
    capturePendingJoin();
    clearPendingJoin();
    expect(capturePendingJoin()).toBeNull();
  });

  it('masks a real code and leaves a short one legible', () => {
    expect(maskCode(CODE)).toMatch(/…/);
    expect(maskCode(CODE)).not.toContain(CODE.slice(10, 24));
    expect(maskCode('short')).toBe('short');
  });

  it('mints a FRESH idempotency key per attempt', () => {
    // A stable key would make a retry replay the first attempt out of the
    // node's ledger instead of touching the invite.
    expect(newJoinMutationId()).not.toBe(newJoinMutationId());
  });
});

describe('the banner on the sign-in wall', () => {
  it('says why a stranger is being asked for credentials', () => {
    render(<JoinBanner pending />);
    expect(screen.getByTestId('join-banner').textContent).toMatch(/invited/i);
  });

  it('renders nothing at all when no code is held', () => {
    const { container } = render(<JoinBanner pending={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('discloses NOTHING about the invite — the gate has no seam to read one with', () => {
    render(<JoinBanner pending />);
    const text = screen.getByTestId('join-banner').textContent ?? '';
    expect(text).not.toMatch(/atelier/);
    expect(text).not.toContain(CODE);
  });
});

describe('the join screen', () => {
  function mount(over: Partial<React.ComponentProps<typeof JoinScreen>> = {}) {
    const asked: string[] = [];
    const redeemed: string[] = [];
    const joined: Array<{ spaceId: string; joined: boolean }> = [];
    let dismissed = 0;
    render(
      <JoinScreen
        code={CODE}
        onPreview={async (c) => { asked.push(c); return VALID; }}
        onRedeem={async (c) => { redeemed.push(c); return REDEEMED; }}
        onJoined={(spaceId, didJoin) => { joined.push({ spaceId, joined: didJoin }); }}
        onDismiss={() => { dismissed += 1; }}
        {...over}
      />,
    );
    return { asked, redeemed, joined, dismissed: () => dismissed };
  }

  it('READS the invite before offering to join — the facts are not props', async () => {
    const h = mount();
    await screen.findByTestId('join-valid');
    expect(h.asked).toEqual([CODE]);
    const text = screen.getByTestId('join-valid').textContent ?? '';
    // Space, inviter and role all come off `previewInvite`. The two older
    // cards (auth 1h, settings RedeemLanding) take these as oracle props and
    // can never be honest about them.
    expect(text).toMatch(/atelier/);
    expect(text).toMatch(/Ada Osei/);
    expect(text).toMatch(/joining as member/);
  });

  it('joining reaches the seam and reports where it landed', async () => {
    const h = mount();
    fireEvent.click(await screen.findByTestId('join-accept'));
    await waitFor(() => expect(h.redeemed).toEqual([CODE]));
    expect(h.joined).toEqual([{ spaceId: 'space-7', joined: true }]);
  });

  it('already-a-member is a SUCCESS, not a refusal', async () => {
    const h = mount({ onRedeem: async () => ({ ...REDEEMED, joined: false }) });
    fireEvent.click(await screen.findByTestId('join-accept'));
    // `joined:false` still routes them in — the effect had already happened,
    // which is not the same as it having failed.
    await waitFor(() => expect(h.joined).toEqual([{ spaceId: 'space-7', joined: false }]));
    expect(screen.queryByTestId('join-refused')).toBeNull();
  });

  it('signed out: no join button, and it names the missing step', async () => {
    mount({ onRedeem: undefined });
    await screen.findByTestId('join-valid');
    expect(screen.queryByTestId('join-accept')).toBeNull();
    // `redeem_invite` opens with require_identity(), so a code cannot make you
    // somebody — the screen must say so rather than offer a dead button.
    expect(screen.getByTestId('join-needs-account').textContent).toMatch(/sign in/i);
  });

  it('renders each dead state the server distinguishes, in its own words', async () => {
    for (const [status, pattern] of [
      ['revoked', /was revoked/i],
      ['expired', /has expired/i],
      ['exhausted', /used up/i],
    ] as const) {
      cleanup();
      render(
        <JoinScreen
          code={CODE}
          onPreview={async () => ({ status, spaceName: 'atelier' })}
          onJoined={() => {}}
          onDismiss={() => {}}
        />,
      );
      const card = await screen.findByTestId(`join-${status}`);
      expect(card.textContent, status).toMatch(pattern);
    }
  });

  it('an UNKNOWN code discloses nothing — not even that a space exists', async () => {
    render(
      <JoinScreen
        code={CODE}
        onPreview={async () => ({ status: 'unknown' })}
        onJoined={() => {}}
        onDismiss={() => {}}
      />,
    );
    const card = await screen.findByTestId('join-unknown');
    const text = card.textContent ?? '';
    // The union carries no spaceName for `unknown` BY RULE. The card must not
    // soften that into a guess, and must not print the code itself.
    expect(text).not.toMatch(/atelier/);
    expect(text).not.toContain(CODE);
  });

  it('an unreachable node is NOT reported as a dead invite', async () => {
    render(
      <JoinScreen
        code={CODE}
        onPreview={async () => { throw new CollabError('upstream_unavailable', 'cannot reach the tm8 node'); }}
        onJoined={() => {}}
        onDismiss={() => {}}
      />,
    );
    const card = await screen.findByTestId('join-unreadable');
    // Burning a good code on a network blip is the failure this branch exists
    // to prevent, so it must say the opposite of "invalid".
    expect(card.textContent).toMatch(/may still be good/i);
  });

  it('a refusal BETWEEN preview and click is shown, not swallowed', async () => {
    // The preview said valid; somebody took the last spot while this person
    // was reading. That race is the only way a live preview reaches a refusal.
    mount({ onRedeem: async () => { throw new CollabError('limit_exceeded', 'invite is exhausted'); } });
    fireEvent.click(await screen.findByTestId('join-accept'));
    expect((await screen.findByTestId('join-refused')).textContent).toMatch(/last spot/i);
  });

  it('keeps the server’s words for forbidden, the one rung the code cannot split', () => {
    // revoked and expired BOTH raise 42501 -> `forbidden`, so the message is
    // the only place the distinction survives. Confirmed live.
    expect(refusalOf('forbidden', 'invite was revoked')).toBe('invite was revoked');
    expect(refusalOf('forbidden', 'invite has expired')).toBe('invite has expired');
  });

  it('dismissing lets somebody walk away from a link they did not want', async () => {
    const h = mount();
    fireEvent.click(await screen.findByTestId('join-dismiss'));
    expect(h.dismissed()).toBe(1);
  });
});
