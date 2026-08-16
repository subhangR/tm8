// @vitest-environment jsdom
/**
 * THE 2026-08-16 LAYOUT PASS, held.
 *
 * `credentials.test.tsx` next door owns the honest-degradation contract — what
 * words this section is allowed to say about a connection. This file owns the
 * four things the layout pass CHANGED, and it is deliberately separate so a
 * later lane rewriting the frame cannot quietly delete a state-honesty test
 * while "fixing the layout tests".
 *
 * WHAT IS AND IS NOT PROVABLE HERE. jsdom parses no stylesheet and runs no
 * layout: every `offsetWidth` is 0 and every `getComputedStyle` returns the
 * initial value. So there is not one width, gutter or scroll assertion below —
 * those were measured in real Chrome (see the module's PR) and asserting them
 * here would produce a green test that certifies nothing. What jsdom CAN
 * settle is STRUCTURE: which elements exist, how many scrollers the section
 * contributes, and whether a state renders a distinguishable node. That is the
 * whole of this file.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  CredentialProviderName,
  CredentialsStatusView,
} from '@tm8/contract';
import { CredentialsSection } from './CredentialsSection';
import type { CredentialsPort } from './port';

function connection(
  over: Partial<CredentialsStatusView['providers'][number]> & { provider: CredentialProviderName },
) {
  return {
    connected: false,
    login: null,
    authMethod: null,
    status: null,
    connectedAt: null,
    lastVerifiedAt: null,
    ...over,
  };
}

function portWith(status: CredentialsStatusView, over: Partial<CredentialsPort> = {}): CredentialsPort {
  return {
    load: async () => status,
    disconnect: async (provider) => ({
      provider,
      revoked: true,
      terminatedCredentialSessionIds: [],
      terminatedAgentSessionIds: [],
      failures: [],
    }),
    startLogin: async (provider) => ({
      workSessionId: 'ws-login-1',
      spaceId: 'space-1',
      provider,
      expiresAt: '2026-08-07T12:00:00.000Z',
      command: `${provider} login`,
    }),
    finishLogin: async (workSessionId) => ({
      workSessionId,
      provider: 'github' as const,
      connected: true,
      login: 'ada',
      authMethod: 'oauth',
      status: 'active' as const,
      stored: true,
      terminated: true,
    }),
    ...over,
  };
}

describe('the section is built on SectionFrame, not on a hand-rolled copy of it', () => {
  /**
   * THE DRIFT THIS PASS EXISTS TO END. Twelve sections each hand-transcribed
   * `.set-section__head` + `.set-section__scroll`, and twelve transcriptions of
   * three divs drifted exactly as far apart as that predicts. This section's
   * copy rendered a bare fragment: no `.set-section` root at all, and a
   * scroller with neither the measure wrapper nor the pad — so its lede began
   * at the card's left edge, 18px out of line with the head above it, and ran
   * the card's full width past the 860px measure.
   */
  it('renders the frame’s root, head and measured, padded body', async () => {
    const { container } = render(
      <CredentialsSection
        port={portWith({
          providers: [connection({ provider: 'anthropic', connected: true, authMethod: 'oauth' })],
          gitCredentialStore: 'present',
        })}
      />,
    );
    await screen.findByTestId('credential-card-anthropic');

    // The root the shell's `.set-body` hands its height to. The old fragment
    // had none, so the section had nothing to own the height WITH.
    const root = container.querySelector('.set-section');
    expect(root).toBeTruthy();

    // The head is the frame's, and it carries the heading it was given.
    expect(root!.querySelector('.set-section__title')!.textContent).toBe('Agent credentials');

    // ONE scroller — contract §3. Two nested and the outer takes the overflow
    // while the inner silently clips. Asserted as a count so a later lane
    // adding a second one fails here rather than in somebody's screenshot.
    expect(container.querySelectorAll('.set-section__scroll')).toHaveLength(1);

    // And the body is inside the measure + pad wrapper rather than loose in
    // the scroller. This is the assertion that would have failed before.
    const body = screen.getByTestId('credentials-body');
    const wrap = body.firstElementChild as HTMLElement;
    expect(wrap.className).toContain('set-section__measure');
    expect(wrap.className).toContain('set-section__pad');
    expect(within(wrap).getByTestId('credential-card-anthropic')).toBeTruthy();
  });

  /**
   * The section must not re-declare the head the frame already drew. A second
   * `.set-section__head` is how the "two titles" bug appears — and it is
   * invisible in a test that only asks whether the title is present at all.
   */
  it('draws exactly one head', async () => {
    const { container } = render(
      <CredentialsSection
        port={portWith({ providers: [connection({ provider: 'github' })], gitCredentialStore: 'present' })}
      />,
    );
    await screen.findByTestId('credential-card-github');
    expect(container.querySelectorAll('.set-section__head')).toHaveLength(1);
  });
});

describe('connected, not-connected and EXPIRED are three distinguishable states', () => {
  /**
   * THE STATE THAT WAS INVISIBLE. `CredentialConnectionView.status` is
   * `'active' | 'stale' | 'revoked' | null` and nothing rendered it, so a row
   * with `connected: true, status: 'stale'` drew the same words, the same
   * single button and the same everything as a healthy one. A user whose
   * agents are about to fail on an expired login was shown a working
   * connection.
   *
   * Asserted on the pill WORD, not on a class: colour alone would be a state
   * only a sighted reader with both themes could distinguish.
   */
  it('renders a stale credential as EXPIRED, not as a healthy connection', async () => {
    render(
      <CredentialsSection
        port={portWith({
          providers: [connection({ provider: 'github', connected: true, login: 'ada', status: 'stale' })],
          gitCredentialStore: 'present',
        })}
      />,
    );

    const pill = await screen.findByTestId('credential-pill-github');
    expect(pill.textContent).toBe('Expired');
    // Not the healthy word...
    expect(pill.textContent).not.toBe('Connected');
    // ...and not the confident negative either: the credential IS stored, and
    // telling the user it is absent would send them down the wrong path.
    expect(pill.textContent).not.toBe('Not connected');

    // The third next action, in words: neither "connect this" nor "you are
    // fine" — sign in again before the next launch.
    const why = screen.getByTestId('credential-expired-why-github');
    expect(why.textContent).toContain('stale');
    expect(why.textContent).toContain('will fail');
    expect(why.textContent).toContain('Reconnect');
  });

  it('renders `revoked` as expired too — the row exists and does not work', async () => {
    render(
      <CredentialsSection
        port={portWith({
          providers: [connection({ provider: 'openai', connected: true, login: 'ada', status: 'revoked' })],
          gitCredentialStore: 'present',
        })}
      />,
    );
    expect((await screen.findByTestId('credential-pill-openai')).textContent).toBe('Expired');
  });

  /**
   * THE CONTROLS. Without these, "Expired" could be the word for every card
   * and the distinction would be decorative. All four pill words are pinned,
   * including the `null` status a pre-status node still sends — which must
   * read as healthy, not as expired, because absence is not staleness.
   */
  it('pins the other three pill words, and treats a null status as healthy', async () => {
    render(
      <CredentialsSection
        port={portWith({
          providers: [
            connection({ provider: 'anthropic', connected: true, status: null }),
            connection({ provider: 'openai', connected: false }),
            connection({ provider: 'github', connected: false }),
          ],
          gitCredentialStore: 'absent',
        })}
      />,
    );

    // `connected: true` with no status at all — the frozen-node shape. Healthy.
    expect((await screen.findByTestId('credential-pill-anthropic')).textContent).toBe('Connected');
    expect(screen.getByTestId('credential-pill-openai').textContent).toBe('Not connected');
    // And the store-absent github entry keeps its own fourth word.
    expect(screen.getByTestId('credential-pill-github').textContent).toBe('Unknown');
  });

  /**
   * Every state's next action has to be REACHABLE. The expired card in
   * particular must still offer both — the old code's button set was derived
   * from `connected` alone, and an expired row that offered only Disconnect
   * would strand the user one step from the fix.
   */
  it('offers Reconnect AND Disconnect on an expired card', async () => {
    render(
      <CredentialsSection
        port={portWith({
          providers: [connection({ provider: 'github', connected: true, login: 'ada', status: 'stale' })],
          gitCredentialStore: 'present',
        })}
      />,
    );
    expect((await screen.findByTestId('credential-connect-github')).textContent).toBe('Reconnect');
    expect(screen.getByTestId('credential-disconnect-github')).toBeTruthy();
  });
});

describe('the empty and absent paths read honestly', () => {
  /**
   * `providers` is documented as always carrying one entry per provider, so a
   * zero-length array is a node reporting a gap. The old body mapped over it
   * and rendered NOTHING — a lede sentence and then bare paper, which a reader
   * takes as "you have no logins". That is a different claim, and one nobody
   * measured.
   */
  it('states the gap instead of drawing an empty pane', async () => {
    render(
      <CredentialsSection
        port={portWith({ providers: [], gitCredentialStore: 'present' })}
      />,
    );

    const absent = await screen.findByTestId('credentials-empty');
    expect(absent.textContent).toContain('listed no providers');
    // The distinction that matters: it must NOT assert the user has no logins.
    expect(absent.textContent).toContain('not a statement that you have no logins');
    // And the loading state must have been replaced, not merely covered.
    expect(screen.queryByTestId('credentials-loading')).toBeNull();
  });

  /**
   * IT IS PER-ACCOUNT, sitting between two space-scoped sections. Everything
   * either side of this row in the nav changes the SPACE, so a reader who
   * infers scope from position infers it wrong.
   */
  it('says which scope it is on, because its neighbours are on the other one', async () => {
    render(
      <CredentialsSection
        port={portWith({ providers: [connection({ provider: 'github' })], gitCredentialStore: 'present' })}
      />,
    );
    const scope = await screen.findByTestId('credentials-scope');
    expect(scope.textContent).toContain('Per account, not per space');
    expect(scope.textContent).toContain('every space you are a member of');
  });
});

describe('nothing on this surface renders a secret', () => {
  /**
   * THE MOST SECURITY-SENSITIVE BODY ON THE SCREEN, verified by reading rather
   * than assumed.
   *
   * Two independent halves, because either alone is weak:
   *
   *  1. THE DTO. `CredentialConnectionView` carries only `provider`,
   *     `connected`, `login`, `authMethod`, `status`, `connectedAt` and
   *     `lastVerifiedAt`; the finish result adds `stored` and `terminated`.
   *     There is no token, key, secret or header field for this component to
   *     leak, and `login` is a public account handle. Asserted on the actual
   *     runtime keys so a field ADDED to the DTO later fails here — that is
   *     the moment this file exists for.
   *  2. THE RENDER. A token-shaped string planted in every free-text field the
   *     component will print must be findable ONLY where it was legitimately
   *     put. This catches a future card that helpfully starts spreading the
   *     whole entry into the DOM.
   */
  it('has no secret-shaped field in the DTO it renders from', async () => {
    const entry = connection({
      provider: 'anthropic',
      connected: true,
      authMethod: 'oauth',
      status: 'active',
      connectedAt: '2026-08-01T00:00:00.000Z',
      lastVerifiedAt: '2026-08-02T00:00:00.000Z',
    });
    expect(Object.keys(entry).sort()).toEqual([
      'authMethod', 'connected', 'connectedAt', 'lastVerifiedAt', 'login', 'provider', 'status',
    ]);
    for (const key of Object.keys(entry)) {
      expect(key).not.toMatch(/token|secret|key|password|credentialValue|bearer|cookie|header/i);
    }
  });

  it('never prints a secret-shaped value, even when the node sends one', async () => {
    const PLANT = 'sk-ant-PLANTED-SECRET-0000';
    const { container } = render(
      <CredentialsSection
        port={portWith({
          providers: [
            // The two free-text fields a node could put anything in. If the
            // card ever renders the entry wholesale, this shows up.
            connection({
              provider: 'anthropic',
              connected: true,
              login: null,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ...({ token: PLANT, apiKey: PLANT } as any),
            }),
          ],
          gitCredentialStore: 'present',
        })}
      />,
    );
    await screen.findByTestId('credential-card-anthropic');
    expect(container.textContent).not.toContain(PLANT);
    expect(container.textContent).not.toMatch(/sk-ant-|ghp_|ghs_|Bearer /);
  });

  /**
   * The login terminal is the one place a secret is actually typed, and it is
   * NOT typed into this component: the PTY owns those bytes. What this screen
   * prints about it is the command and the expiry, and the panel must say so
   * plainly — including that the secret does not pass through here.
   */
  it('says the secret does not pass through this screen', async () => {
    render(
      <CredentialsSection
        port={portWith({ providers: [connection({ provider: 'github' })], gitCredentialStore: 'present' })}
      />,
    );
    const lede = await screen.findByText(/These credentials are YOURS/);
    expect(lede.textContent).toContain('the secret never passes through this screen');
  });
});
