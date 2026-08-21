// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { SessionLiveness } from '../data/seam';
import {
  ExitedFallback,
  StaleFallback,
  TerminalChromeStrip,
  TerminalHost,
  UnverifiedFallback,
  createScriptedActivitySource,
  presentSession,
  presentationStyle,
  type SessionPresentation,
} from './index';

const ALL_VERDICTS: SessionLiveness[] = ['live', 'stale', 'not-running', 'unknown'];

describe('session presentation — the two-source law', () => {
  it('activity may ONLY refine a live verdict; it never promotes a non-live one', () => {
    for (const liveness of ALL_VERDICTS) {
      const p = presentSession({ liveness, streaming: true });
      if (liveness === 'live') {
        expect(p).toBe('streaming');
      } else {
        // The gate: a pulse must never outrank the seam's verdict.
        expect(p).not.toBe('streaming');
        expect(presentationStyle(p).isLive).toBe(false);
      }
    }
  });

  it('NOTHING but a live verdict is ever styled as live', () => {
    for (const liveness of ALL_VERDICTS) {
      const style = presentationStyle(presentSession({ liveness }));
      expect(style.isLive, `${liveness} claimed live`).toBe(liveness === 'live');
    }
  });

  it('unknown renders neutral and never says plain "running" (D6)', () => {
    const style = presentationStyle(presentSession({ liveness: 'unknown' }));
    expect(style.tone).toBe('idle');
    expect(style.isLive).toBe(false);
    expect(style.pulse).toBe(false);
    expect(style.word).not.toBe('running');
    // The word withdraws the guarantee on its own. It must NOT also restate
    // the registry's long sentence — this assertion used to require /record/
    // here, which is precisely how the copy drift A1a found got locked in: a
    // test can pin a duplicate as firmly as it pins a requirement. The claim
    // "states what the record claims" belongs to liveTreatment('unknown'),
    // and the registry tests it there.
    expect(style.word).toBe('unverified');
  });

  it('stale is amber and never green — an unproven record cannot borrow proof', () => {
    const style = presentationStyle(presentSession({ liveness: 'stale' }));
    expect(style.tone).toBe('wait');
    expect(style.isLive).toBe(false);
    // The WORD is this layer's; the SENTENCE is the registry's. This used to
    // assert 'stale — node restarted' here, which pinned a duplicate exactly
    // as the `unknown` assertion did — same defect, adjacent case, found by
    // grepping the class instead of trusting that the reported instance was
    // the only one.
    expect(style.word).toBe('stale');
    expect(style.full).not.toContain('node restarted');
  });

  it('not-running splits by the RECORD status — exited, failed and spawning differ', () => {
    expect(presentSession({ liveness: 'not-running', recordedStatus: 'exited' })).toBe('exited');
    expect(presentSession({ liveness: 'not-running', recordedStatus: 'failed' })).toBe('failed');
    expect(presentSession({ liveness: 'not-running', recordedStatus: 'spawning' })).toBe('spawning');
    expect(presentationStyle('failed').tone).toBe('block');
  });

  it('attention outranks streaming while alive, and is ignored when not alive', () => {
    expect(presentSession({ liveness: 'live', streaming: true, needsAttention: true })).toBe('needs-you');
    expect(presentSession({ liveness: 'stale', needsAttention: true })).toBe('stale');
  });

  it('every presentation carries a WORD — status is never colour alone (L10)', () => {
    const all: SessionPresentation[] = [
      'streaming', 'running', 'needs-you', 'stale', 'exited', 'failed', 'spawning', 'unknown',
    ];
    for (const p of all) {
      expect(presentationStyle(p).word.length).toBeGreaterThan(0);
      expect(presentationStyle(p).full.length).toBeGreaterThan(0);
    }
  });
});

describe('activity source (the §9.2 port)', () => {
  it('fans out only on CHANGE, and reports current state to late subscribers', () => {
    const src = createScriptedActivitySource();
    const seen: Array<[string, boolean]> = [];
    src.onActivity((id, active) => seen.push([id, active]));

    src.setActive('ws-1', true);
    src.setActive('ws-1', true); // idempotent — no redundant fanout
    src.setActive('ws-1', false);

    expect(seen).toEqual([['ws-1', true], ['ws-1', false]]);
    expect(src.isActive('ws-1')).toBe(false);
  });

  it('unsubscribes cleanly', () => {
    const src = createScriptedActivitySource();
    const cb = vi.fn();
    const off = src.onActivity(cb);
    off();
    src.setActive('ws-1', true);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('chrome strip — the focus-capture contract', () => {
  const liveStates: SessionPresentation[] = ['streaming', 'running', 'needs-you'];

  it('renders the exit chip WITH its keystroke in every live state', () => {
    for (const presentation of liveStates) {
      const { getByTestId, unmount } = render(
        <TerminalChromeStrip persona="forge" provider="claude-fable-5" presentation={presentation} />,
      );
      const chip = getByTestId('exit-terminal-chip');
      expect(chip.textContent).toContain('⌃`');
      expect(chip.getAttribute('aria-label')).toMatch(/backtick/i);
      unmount();
    }
  });

  it('compact drops the WORD but never the keystroke (320px floor)', () => {
    const { getByTestId } = render(
      <TerminalChromeStrip persona="forge" presentation="running" compact />,
    );
    const chip = getByTestId('exit-terminal-chip');
    expect(chip.textContent).toContain('⌃`');
    expect(chip.textContent).not.toContain('terminal');
  });

  it('swaps the same slot to a transcript link once the session is over', () => {
    const { getByTestId, queryByTestId } = render(
      <TerminalChromeStrip persona="forge" presentation="exited" />,
    );
    expect(getByTestId('transcript-chip').textContent).toContain('transcript');
    // No escape hatch is advertised when there is nothing to escape from.
    expect(queryByTestId('exit-terminal-chip')).toBeNull();
  });

  it('carries the status WORD and the full sentence for every state', () => {
    /**
     * A SYNTHETIC sentinel, deliberately not the registry's real sentence.
     * Passing the real one would make this test unable to tell THREADING from
     * HARDCODING: if the component ignored the prop and printed the canonical
     * string, an assertion against that same string would still pass. The
     * sentinel can only appear here by having travelled through the prop.
     * (Found by A1a's cross-module sweep; the copies were the symptom, this
     * was the defect under them.)
     */
    const SENTINEL = 'SENTINEL-verdict-sentence-from-registry';
    const { getByTestId } = render(
      <TerminalChromeStrip persona="probe" presentation="stale" statusDetail={SENTINEL} />,
    );
    const pill = getByTestId('session-status-pill');
    expect(pill.textContent).toContain('stale');
    expect(pill.getAttribute('title')).toBe(SENTINEL);
  });

  it('opens a nested always-dark token scope rather than restating dark hexes', () => {
    const { container } = render(<TerminalChromeStrip persona="forge" presentation="running" />);
    const scope = container.querySelector('[data-always-dark="true"]');
    expect(scope).not.toBeNull();
    expect(scope?.getAttribute('data-theme')).toBe('dark');
    expect(scope?.classList.contains('cv2-root')).toBe(true);
  });
});

describe('terminal host', () => {
  it('tells the user how to escape BEFORE trapping their keyboard', () => {
    const { getByTestId } = render(<TerminalHost placeholder="x" />);
    const host = getByTestId('terminal-host');
    const describedBy = host.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    // getElementById, not querySelector: React's useId emits colons, which are
    // not valid bare CSS identifiers, and jsdom has no CSS.escape.
    const hint = document.getElementById(describedBy!);
    expect(hint?.textContent).toMatch(/Control and backtick/);
  });

  it('forwards a pointer press so an interactive xterm can reclaim keyboard focus', () => {
    const onPointerDown = vi.fn();
    const { getByTestId } = render(
      <TerminalHost placeholder="x" onPointerDown={onPointerDown} />,
    );

    fireEvent.pointerDown(getByTestId('terminal-host'));
    expect(onPointerDown).toHaveBeenCalledOnce();
  });
});

describe('fallbacks — each verdict states what is actually known', () => {
  it('exited points at the surviving record and offers resume', () => {
    const { getByTestId } = render(<ExitedFallback />);
    const el = getByTestId('session-exited-fallback');
    expect(el.textContent).toContain('Session exited');
    // The record survives — that half of the old copy is unchanged.
    expect(el.textContent).toContain('session record, discussion and connections stay');
    // "Read-only" is GONE on purpose: a resumable session is not read-only,
    // and the word next to a Resume button would be a false claim.
    expect(el.textContent).not.toMatch(/read-only/i);
  });

  /**
   * D3 — the failed session that called itself exited.
   *
   * `TerminalBody` has always mapped `failed` and `exited` onto this one
   * canvas, and the canvas has always said "Session exited" while the
   * presentation layer correctly said `failed`. Two claims about one session,
   * on one screen.
   */
  it('gives a failed session its own word, and still no exit code', () => {
    const { getByTestId } = render(<ExitedFallback outcome="failed" />);
    const el = getByTestId('session-exited-fallback');
    expect(el.dataset.outcome).toBe('failed');
    expect(el.textContent).toContain('Session failed');
    expect(el.textContent).not.toContain('Session exited');
    // NOT a red number. The contract projects no exit code on any node, so
    // there is nothing here to colour — the oracle's "non-zero exit codes
    // render the code in block red" stays unbuildable and unbuilt.
    expect(el.textContent).not.toMatch(/exit code/i);
  });

  /**
   * D1 — the exit facts, which had never rendered on any screen. `meta` was a
   * string prop for exactly this line and its only caller passed none; it is
   * superseded by the record itself rather than finally fed.
   */
  it('assembles the exit facts from the record, and refuses to invent an ending', () => {
    const withEnd = render(
      <ExitedFallback
        startedAt="2026-01-02T10:00:00.000Z"
        exitedAt="2026-01-02T10:41:00.000Z"
      />,
    );
    expect(withEnd.getByTestId('session-exit-facts').textContent).toMatch(/ran 41m/);
    withEnd.unmount();

    // A row whose node died before it could close out. No duration is
    // manufactured from `now`, and the absence is stated.
    const openEnded = render(<ExitedFallback startedAt="2026-01-02T10:00:00.000Z" />);
    const facts = openEnded.getByTestId('session-exit-facts').textContent ?? '';
    expect(facts).toMatch(/duration not recorded/);
    expect(facts).toMatch(/no end recorded/);
    openEnded.unmount();

    // A record with neither timestamp draws no line at all rather than a line
    // made entirely of refusals.
    const bare = render(<ExitedFallback />);
    expect(bare.queryByTestId('session-exit-facts')).toBeNull();
  });

  /**
   * D2 — the enabled-inert transcript button, which was a live control with
   * `onClick={undefined}` on every host that did not wire the handler. Same L6
   * rule as Resume, which sits beside it and has always obeyed it.
   */
  it('refuses the transcript button out loud when no host wired it', () => {
    const unwired = render(<ExitedFallback />);
    const inert = unwired.getByTestId('session-open-transcript') as HTMLButtonElement;
    expect(inert.disabled).toBe(true);
    expect(inert.title).toMatch(/not wired/i);
    unwired.unmount();

    const calls: number[] = [];
    const wired = render(<ExitedFallback onOpenTranscript={() => calls.push(1)} />);
    const live = wired.getByTestId('session-open-transcript') as HTMLButtonElement;
    expect(live.disabled).toBe(false);
    fireEvent.click(live);
    expect(calls).toHaveLength(1);
  });

  it('mounts a host-supplied post-mortem without displacing resume', () => {
    const { getByTestId } = render(
      <ExitedFallback onResume={() => {}} stats={<p data-testid="stats-probe">stats</p>} />,
    );
    expect(getByTestId('stats-probe')).toBeTruthy();
    // The highest-value control on this screen must not regress behind a wall
    // of figures: it is still present and still live.
    expect((getByTestId('session-resume') as HTMLButtonElement).disabled).toBe(false);
    expect(getByTestId('session-exited-fallback').className).toContain('term-fallback--stats');
  });

  it('resume is DISABLED with a reason when the host has not wired it — never hidden', () => {
    const { getByTestId } = render(<ExitedFallback />);
    const btn = getByTestId('session-resume') as HTMLButtonElement;
    // Present, refused, and it says why. A missing button would claim the
    // session cannot be resumed, which is a different statement entirely.
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/not wired/i);
  });

  it('resume fires the host handler, and reports its own in-flight state', () => {
    const calls: number[] = [];
    const { getByTestId, rerender } = render(
      <ExitedFallback onResume={() => calls.push(1)} />,
    );
    const btn = getByTestId('session-resume') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(calls).toHaveLength(1);

    // In flight: disabled, so a double-click cannot race two spawns onto one
    // session id.
    rerender(<ExitedFallback onResume={() => calls.push(1)} resuming />);
    const busy = getByTestId('session-resume') as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.textContent).toMatch(/resuming/i);
    fireEvent.click(busy);
    expect(calls).toHaveLength(1);
  });

  it('a server refusal becomes the caption, verbatim', () => {
    const REASON = 'no recorded native session id (spawned before resume support)';
    const { getByTestId } = render(
      <ExitedFallback onResume={() => {}} resumeDisabledReason={REASON} />,
    );
    const el = getByTestId('session-exited-fallback');
    expect(el.textContent).toContain(REASON);
    expect((getByTestId('session-resume') as HTMLButtonElement).disabled).toBe(true);
  });

  it('stale contradicts our own record out loud, and offers the only real remedy', () => {
    const SENTINEL = 'SENTINEL-stale-label';
    const { getByTestId } = render(<StaleFallback label={SENTINEL} />);
    const el = getByTestId('session-stale-fallback');
    // The label arrived through the prop — it cannot have been hardcoded.
    expect(el.textContent).toContain(SENTINEL);
    expect(el.textContent).toContain('Liveness never lies');
    // "reconnect" cannot work — the process is gone. Correcting the record can.
    expect(el.textContent).toContain('mark exited');
    expect(el.textContent).not.toMatch(/reconnect/i);
  });

  it('unverified claims neither life nor death', () => {
    const { getByTestId } = render(<UnverifiedFallback />);
    const text = (getByTestId('session-unverified-fallback').textContent ?? '').toLowerCase();
    expect(text).toContain('unverified');
    expect(text).not.toMatch(/\bexited\b/);
  });
});

describe('copy has ONE home — no second authored sentence', () => {
  it('the fallbacks render NO explanatory sentence when the registry reason is absent', () => {
    // Found by A1a in review: a `??` default that reads like copy is a second
    // authored version of an honesty statement, and two near-identical
    // sentences for one state is exactly the drift the registry prevents.
    // Absent copy is honest; a near-duplicate is not.
    const { getByTestId } = render(<UnverifiedFallback />);
    const el = getByTestId('session-unverified-fallback');
    expect(el.querySelector('.term-fallback__caption')).toBeNull();
    // Still fully identified — by the state's own name, not by a restatement
    // of the registry's sentence.
    expect(el.textContent?.toLowerCase()).toContain('unverified');
    expect(el.textContent).not.toContain('per record');
  });

  it('the registry sentence is what renders when it IS passed', () => {
    const SENTINEL = 'SENTINEL-registry-reason-sentence';
    const { getByTestId } = render(<UnverifiedFallback reason={SENTINEL} />);
    expect(getByTestId('session-unverified-fallback').textContent).toContain(SENTINEL);
  });

  it('the strip pill prefers the registry sentence over its own minimal expansion', () => {
    const authored = 'The record claims running, and that claim is unverified.';
    const { getByTestId } = render(
      <TerminalChromeStrip persona="scout" presentation="unknown" statusDetail={authored} />,
    );
    expect(getByTestId('session-status-pill').getAttribute('title')).toBe(authored);
  });

  it('NO presentation style restates a registry verdict sentence', () => {
    // Swept as a CLASS, not case by case: the first fix caught `unknown` only
    // because that was the instance under review, and `stale` sat untouched
    // with the identical defect. Both verdict sentences belong to the
    // registry; this layer carries only its own record-status vocabulary.
    expect(presentationStyle('unknown').full).not.toContain('per record');
    expect(presentationStyle('stale').full).not.toContain('node restarted');
  });

  it('no COMPONENT in this layer hardcodes a registry verdict sentence either', () => {
    // The styles table was only one of three homes. Rendering with NO props is
    // the check that catches the other two: a sentence that appears without
    // being passed in is one this layer authored.
    const unverified = render(<UnverifiedFallback />);
    expect(unverified.getByTestId('session-unverified-fallback').textContent).not.toContain(
      'per record',
    );
    unverified.unmount();
    const stale = render(<StaleFallback />);
    expect(stale.getByTestId('session-stale-fallback').textContent).not.toContain('node restarted');
  });

  it('the stale fallback renders no long sentence it did not receive', () => {
    const { getByTestId } = render(<StaleFallback />);
    const el = getByTestId('session-stale-fallback');
    expect(el.textContent).toContain('stale');
    expect(el.textContent).not.toContain('node restarted');
  });

  /*
   * "mark exited" is the ONE remedy this screen offers, and it is drawn on the
   * one screen a user reaches after a node restart killed their sessions. It
   * shipped ENABLED with `onClick={undefined}` — the enabled-inert control this
   * package bans by law — so the chip absorbed every press and the record kept
   * claiming the dead session was running. Measured on a live node 2026-08-21:
   * 23 sessions stale, and clearing them needed the CLI.
   *
   * These pin L6 on this chip the way it is already pinned on Resume.
   */
  it('the stale chip is disabled WITH A REASON when no host wired it', () => {
    const { getByTestId } = render(<StaleFallback />);
    const chip = getByTestId('session-mark-exited') as HTMLButtonElement;

    // Never hidden — a missing chip would claim the session cannot be cleared.
    expect(chip).toBeTruthy();
    expect(chip.disabled).toBe(true);
    expect(getByTestId('session-stale-fallback').textContent).toContain('not wired');
  });

  it('the stale chip fires exactly once when a host DID wire it', () => {
    const onMarkExited = vi.fn();
    const { getByTestId } = render(<StaleFallback onMarkExited={onMarkExited} />);
    const chip = getByTestId('session-mark-exited') as HTMLButtonElement;

    expect(chip.disabled).toBe(false);
    // The unwired reason must not survive alongside a live handler.
    expect(getByTestId('session-stale-fallback').textContent).not.toContain('not wired');

    fireEvent.click(chip);
    expect(onMarkExited).toHaveBeenCalledTimes(1);
  });
});
