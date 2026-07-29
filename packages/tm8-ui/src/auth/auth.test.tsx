// @vitest-environment jsdom
/**
 * T3 AUTH & ONBOARDING — the suite, and what each half of it is for.
 *
 * The oracle draws 17 frames of sign-in, claim, redeem and token surfaces. The
 * seam behind them exposes ONE identity capability — `identity()`, a read — and
 * no auth command of any kind. So the single most important property this file
 * asserts is NOT that the screens render: it is that NOTHING ON THEM PRETENDS
 * TO AUTHENTICATE. A login form that accepts a password and silently does
 * nothing is the worst lie this app could tell, and it is exactly the lie a
 * "every frame renders" suite would pass over in green.
 *
 * The storage stub below is the `views/realSeamFlag.test.ts` pattern, copied
 * because that file's docblock says it is LOAD-BEARING under this runner
 * (globalThis.localStorage arrives without setItem/removeItem). It is copied,
 * not imported, because importing it would make one file's retirement silently
 * break another's environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { IdentityView } from '../data/seam';
import {
  AUTH_FRAMES,
  AuthBoard,
  AuthFlow,
  ORIENTATION_STORAGE_KEY,
  type AuthFrameId,
  type AuthOutcome,
} from './index';

function installStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

/**
 * A REAL IdentityView, not a hand-shaped duck. This is the "one test lives in
 * the gap" link (brief §4.3): the flow's identity prop is typed off the seam's
 * own export, so a field rename on the bridge side turns THIS red instead of
 * rendering an undefined name in production.
 */
const IDENTITY: IdentityView = {
  identityId: 'id_1',
  accountId: 'acct_1',
  username: 'amber',
  displayName: 'Amber',
  avatar: null,
  email: null,
  isNodeAdmin: true,
  isOwner: true,
  status: 'active',
  actingAs: null,
  memberships: [{ spaceId: 'sp_1', memberId: 'mem_1', role: 'owner' }],
};

const ALL_IDS = (): AuthFrameId[] => AUTH_FRAMES.map((f) => f.id);

beforeEach(installStorage);
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('the frame set matches the oracle', () => {
  it('carries all 17 data-screen-labels, in the oracle DOM order', () => {
    // Oracle order is 1h → 1j → 1i and 1l → 1o → 1m: the file's DOM order, not
    // the alphabet. Asserting the ORDER (not just the set) is what makes this
    // a transcription check rather than a spelling check.
    expect(ALL_IDS()).toEqual([
      '1a', '1b', '1c',
      '1d', '1e', '1f', '1g',
      '1h', '1j', '1i',
      '1k', '1l', '1o', '1m', '1n',
      '1p', '1q',
    ]);
  });

  it('labels every frame with its oracle data-screen-label text', () => {
    for (const frame of AUTH_FRAMES) {
      expect(frame.label.startsWith(frame.id), `${frame.id} label`).toBe(true);
    }
  });
});

describe('every frame renders, in both themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`renders all 17 frames under data-theme="${theme}"`, () => {
      for (const id of ALL_IDS()) {
        const { unmount } = render(<AuthFlow frame={id} theme={theme} onDone={() => {}} />);
        const root = document.querySelector('.cv2-root');
        expect(root, `${id} must mount a themed scope`).not.toBeNull();
        expect(root!.getAttribute('data-theme')).toBe(theme);
        unmount();
      }
    });
  }

  it('does NOT nest a second .cv2-root when told to inherit the host scope', () => {
    // D60 puts `zoom: 1.1` on .cv2-root. zoom COMPOUNDS: a nested scope would
    // render this flow at 1.21× inside the gated app while every screenshot of
    // it standalone looked right. The prop exists for that reason alone.
    render(
      <div className="cv2-root">
        <AuthFlow frame="1d" rootScope="inherit" onDone={() => {}} />
      </div>,
    );
    expect(document.querySelectorAll('.cv2-root')).toHaveLength(1);
  });
});

describe('THE HONESTY LAW — nothing here pretends to authenticate', () => {
  /**
   * The load-bearing assertion. Every frame that draws a terminal auth act
   * must render it disabled-with-reason (R7 / D28), and the refusal must be
   * FOCUSABLE — a keyboard user who cannot reach the control can never learn
   * why it is dead, which defeats the whole treatment.
   */
  const FRAMES_WITH_A_DEAD_VERB: AuthFrameId[] = [
    '1a', '1b', '1c', '1d', '1e', '1f', '1g', '1h', '1k', '1l', '1m', '1n', '1p', '1q',
  ];

  for (const id of FRAMES_WITH_A_DEAD_VERB) {
    it(`${id} refuses its terminal act, visibly and reachably`, () => {
      render(<AuthFlow frame={id} onDone={() => {}} />);
      const refusals = screen.getAllByTestId('disabled-with-reason');
      expect(refusals.length, `${id} must refuse at least one verb`).toBeGreaterThan(0);
      for (const el of refusals) {
        expect(el.getAttribute('aria-disabled')).toBe('true');
        expect(el.getAttribute('tabindex')).toBe('0'); // D28: reachable
        expect(el.hasAttribute('disabled')).toBe(false); // never natively disabled
        const described = el.getAttribute('aria-describedby');
        expect(described, `${id} refusal must name its reason`).toBeTruthy();
        const reason = document.getElementById(described!);
        expect(reason?.textContent?.trim().length ?? 0).toBeGreaterThan(10);
      }
    });
  }

  it('renders NO enabled control that reads like a sign-in verb', () => {
    // The class check, not the instance check. Five dead verbs were once found
    // as five separate bugs; the finding was that they were a CLASS. This
    // sweeps every frame for any ENABLED element whose label promises an act
    // the seam cannot perform.
    const FORBIDDEN =
      /^(sign in|sign in with token|sign in & resume|sign back in|create owner account|create space & enter|join atelier|try again|connect|add forge|continue to forge|new token|revoke|copy|retry|sign out of forge)$/i;
    const offenders: string[] = [];
    for (const id of ALL_IDS()) {
      const { unmount } = render(<AuthFlow frame={id} onDone={() => {}} />);
      for (const el of document.querySelectorAll('[role="button"], button')) {
        const text = (el.textContent ?? '').trim();
        const refused = el.getAttribute('aria-disabled') === 'true';
        // `data-nav` is the one legitimate exemption, and it is STRUCTURAL:
        // 1h's footer link is labelled "sign in" and takes you to the login
        // screen, which is exactly what it says. This assertion caught it on
        // its first run — the label alone genuinely cannot distinguish a
        // navigation from a lie, so the control has to declare which it is.
        const navOnly = el.hasAttribute('data-nav');
        if (!refused && !navOnly && FORBIDDEN.test(text)) offenders.push(`${id}: "${text}"`);
      }
      unmount();
    }
    expect(offenders, `enabled controls promising an unwired act:\n${offenders.join('\n')}`).toEqual(
      [],
    );
  });

  it('every refusal reason names the gap in the SEAM, not a vague "coming soon"', () => {
    // Copy is the product here. "Coming soon" is the apology voice T1-4 bans;
    // the reason must be a fact the reader could check.
    const seen = new Set<string>();
    for (const id of ALL_IDS()) {
      const { unmount } = render(<AuthFlow frame={id} onDone={() => {}} />);
      for (const el of screen.queryAllByTestId('disabled-with-reason')) {
        const reason = document.getElementById(el.getAttribute('aria-describedby')!);
        if (reason) seen.add(reason.textContent!.trim());
      }
      unmount();
    }
    expect(seen.size).toBeGreaterThan(5);
    for (const text of seen) {
      expect(text, `vague refusal: "${text}"`).not.toMatch(/coming soon|stay tuned|not yet available/i);
      // `auth\.` earns its place here: naming the exact missing operation
      // ("auth.login does not exist on this node") is a STRONGER citation than
      // the generic words, and the first version of this guard rejected the
      // better copy for saying it more precisely. A guard that punishes
      // precision is a guard pointed the wrong way.
      expect(text, `refusal must cite what is missing: "${text}"`).toMatch(
        /seam|contract|operation|op\b|auth\.|spaces\.|Phase 2|executor|build/i,
      );
    }
  });
});

describe('what IS real, is real', () => {
  it('1p renders the LIVE identity, not a specimen name', () => {
    render(<AuthFlow frame="1p" identity={IDENTITY} onDone={() => {}} />);
    const menu = screen.getByTestId('auth-account-menu');
    expect(within(menu).getByText('Amber')).toBeTruthy();
    expect(within(menu).getByText(/@amber/)).toBeTruthy();
    expect(within(menu).getByText(/owner/i)).toBeTruthy();
  });

  it('1p falls back to the username when displayName is null — never to a fixture', () => {
    render(
      <AuthFlow frame="1p" identity={{ ...IDENTITY, displayName: null }} onDone={() => {}} />,
    );
    const menu = screen.getByTestId('auth-account-menu');
    expect(within(menu).getByText('amber')).toBeTruthy();
  });

  it('1p says so honestly when there is no identity at all', () => {
    render(<AuthFlow frame="1p" identity={null} onDone={() => {}} />);
    expect(screen.getByTestId('auth-account-menu').textContent).toMatch(/identity has not loaded/i);
  });

  it('1p theme control actually switches the theme', () => {
    const setTheme = vi.fn();
    render(<AuthFlow frame="1p" identity={IDENTITY} theme="light" onThemeChange={setTheme} onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /dark/i }));
    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('1p access-tokens row navigates to 1q — client nav is real nav', () => {
    const onFrameChange = vi.fn();
    render(
      <AuthFlow frame="1p" identity={IDENTITY} onFrameChange={onFrameChange} onDone={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /access tokens/i }));
    expect(onFrameChange).toHaveBeenCalledWith('1q');
  });

  it('1p does NOT show a token count it cannot read', () => {
    // The oracle draws a "2" pill. There is no token operation in the catalog,
    // so a 2 here would be invented. Dash-not-zero (T1-4 hollow value).
    render(<AuthFlow frame="1p" identity={IDENTITY} onDone={() => {}} />);
    const row = screen.getByRole('button', { name: /access tokens/i });
    expect(row.textContent).not.toMatch(/\b\d+\b/);
  });

  it('1d switches between the password and token halves — both are drawn', () => {
    render(<AuthFlow frame="1d" onDone={() => {}} />);
    expect(screen.getByText('PASSWORD')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /use an access token instead/i }));
    expect(screen.getByText('ACCESS TOKEN')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /use a password instead/i }));
    expect(screen.getByText('PASSWORD')).toBeTruthy();
  });

  it('1b derives the rail tile glyph from the typed name, live', () => {
    // The oracle's own caption promises "glyph from the name" (L62). A caption
    // that promises behaviour is a behaviour under test — and `tsc` caught
    // that specimen.ts's `as const` had narrowed this field's state to the
    // literal "forge", which no assertion here had exercised.
    render(<AuthFlow frame="1b" onDone={() => {}} />);
    const input = screen.getByLabelText('SERVER NAME') as HTMLInputElement;
    expect(screen.getByTestId('auth-frame').textContent).toMatch(/forge/);
    fireEvent.change(input, { target: { value: 'lumen' } });
    expect(input.value).toBe('lumen');
    expect(screen.getAllByText('L').length).toBeGreaterThan(0);
  });

  it('1g omits the live-session sentence when no count was supplied', () => {
    // Signed out, the liveness read is space-scoped and unreachable. Rendering
    // "0 live sessions" would be a lie of precision; rendering "2" would be
    // fiction. The sentence is absent, and present when a host supplies one.
    render(<AuthFlow frame="1g" onDone={() => {}} />);
    expect(screen.queryByTestId('auth-live-count')).toBeNull();
    cleanup();
    render(<AuthFlow frame="1g" liveSessionCount={2} onDone={() => {}} />);
    expect(screen.getByTestId('auth-live-count').textContent).toMatch(/2 live sessions/);
  });
});

describe('1j orientation — the one fully-buildable frame', () => {
  it('shows three points and dismisses forever', () => {
    const onDismiss = vi.fn();
    render(<AuthFlow frame="1j" onOrientationDismissed={onDismiss} onDone={() => {}} />);
    expect(screen.getAllByTestId('auth-coachmark')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: /got it/i }));
    expect(localStorage.getItem(ORIENTATION_STORAGE_KEY)).toBe('1');
    expect(onDismiss).toHaveBeenCalled();
  });

  it('survives blocked storage without taking the screen down', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem() {
          throw new Error('blocked');
        },
        setItem() {
          throw new Error('blocked');
        },
        // Not part of the assertion — the shared afterEach calls clear(), and
        // a teardown that throws would report as a failure of the NEXT test.
        clear() {},
      },
    });
    render(<AuthFlow frame="1j" onDone={() => {}} />);
    expect(() => fireEvent.click(screen.getByRole('button', { name: /got it/i }))).not.toThrow();
  });
});

describe('the mount contract the coordinator wires against', () => {
  it('the only way out is an explicitly-labelled dev bypass that says what it is', () => {
    const onDone = vi.fn<(o: AuthOutcome) => void>();
    render(<AuthFlow frame="1d" devBypass onDone={onDone} />);
    const control = screen.getByTestId('auth-dev-bypass');
    // Its own copy must disclaim: no account, no session, no auth executor.
    expect(control.textContent).toMatch(/no account/i);
    fireEvent.click(within(control).getByRole('button'));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0]![0]).toEqual({
      kind: 'dev-bypass',
      note: expect.stringMatching(/no account was created/i),
    });
  });

  it('hides the dev bypass unless the host asks for it', () => {
    render(<AuthFlow frame="1d" onDone={() => {}} />);
    expect(screen.queryByTestId('auth-dev-bypass')).toBeNull();
  });

  it('drives its own frame state when the host does not pin one', () => {
    render(<AuthFlow initialFrame="1a" onDone={() => {}} />);
    expect(screen.getByTestId('auth-frame').getAttribute('data-frame')).toBe('1a');
  });
});

describe('the review board', () => {
  it('renders every frame twice — once per theme', () => {
    render(<AuthBoard />);
    const frames = screen.getAllByTestId('auth-frame');
    expect(frames).toHaveLength(AUTH_FRAMES.length * 2);
    // Both themes present for every frame, not seventeen of one and none of
    // the other: "renders in both themes" is the claim, so count the scopes.
    const scopes = [...document.querySelectorAll('.authboard__viewport > .cv2-root')];
    expect(scopes.filter((s) => s.getAttribute('data-theme') === 'light')).toHaveLength(17);
    expect(scopes.filter((s) => s.getAttribute('data-theme') === 'dark')).toHaveLength(17);
  });

  it('gives the overlay frames a backdrop and the full-stage frames none', () => {
    // A dialog drawn over nothing reads as a floating card, which is not the
    // frame the oracle drew — the dimmed work behind it IS the content.
    render(<AuthBoard />);
    for (const def of AUTH_FRAMES) {
      const shown = document.querySelectorAll(
        `[data-frame="${def.id}"] .authboard-skel`,
      ).length;
      expect(shown > 0, `${def.id} backdrop`).toBe(def.overlay);
    }
  });
});
