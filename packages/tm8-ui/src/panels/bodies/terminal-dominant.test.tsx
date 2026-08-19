// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { fixtureDetails, sessionExited, sessionFailed, sessionStale } from '../../fixtures';
import { TerminalBody } from './TerminalBody';

/**
 * R5 #10 — TERMINAL-DOMINANT, taken to its end.
 *
 * The law, verbatim (2026-07-29): "an empty state that costs the primary
 * surface half its height inverts the honesty economy."
 *
 * The ruling has moved three times, each time in the same direction, and this
 * file is the record of where it landed:
 *
 *   2026-07-29  all session metadata into ONE collapsed drawer below the canvas
 *   2026-07-31  and collapsed costs NOTHING — the drawer unmounts, its toggle
 *               and the exit chip float on the canvas at zero layout height
 *   2026-08-19  "remove the bottom panel which opens up, the associated
 *               projects, shared context and all that shit, the session
 *               details chip at the bottom, exit terminal button at the
 *               bottom" — all of it, floating or not
 *
 * These tests exist because the regression is INVISIBLE to the suite that
 * preceded them: nothing asserted the old always-open anatomy, so collapsing
 * it broke no test, and nothing would have caught it silently reverting. The
 * behaviour a ruling establishes has to be pinned by a test or it is only a
 * comment. That argument now cuts the other way — a re-added strip must fail
 * something — so the assertions are absences.
 */

function sessionDetail() {
  // EntityDetail spreads the summary FLAT — there is no `.summary` arm — and
  // `fixtureDetails` is keyed by id, not a list.
  // The RECORD is the stale session (the only work_session with a detail arm);
  // the VERDICT is a separate prop, so this still exercises the live canvas.
  const detail = fixtureDetails[sessionStale.id];
  if (!detail) throw new Error('fixtures must supply a work_session detail');
  return detail;
}

function renderBody(over: Partial<React.ComponentProps<typeof TerminalBody>> = {}) {
  return render(<TerminalBody detail={sessionDetail()} liveness="live" {...over} />);
}

describe('the canvas, and nothing else', () => {
  it('draws no drawer, no toggle and no exit chip — nothing below the terminal', () => {
    const { getByTestId, queryByTestId } = renderBody();
    expect(queryByTestId('terminal-bottom-drawer')).toBeNull();
    expect(queryByTestId('terminal-details-toggle')).toBeNull();
    expect(queryByTestId('exit-terminal-chip')).toBeNull();
    expect(queryByTestId('terminal-chrome-strip')).toBeNull();
    expect(queryByTestId('session-context-header')).toBeNull();
    // The one thing that IS there.
    expect(getByTestId('terminal-host-placeholder')).toBeTruthy();
  });

  it('draws none of the drawer’s content either — projects, provenance, shares', () => {
    const detail = sessionDetail();
    const projectId = (detail.content as unknown as Record<string, unknown>).launchProjectId;
    expect(typeof projectId).toBe('string');
    const { queryByTestId, queryByText } = renderBody();
    expect(queryByTestId('associated-projects-section')).toBeNull();
    expect(queryByTestId('shared-context-section')).toBeNull();
    expect(queryByTestId('share-drop-target')).toBeNull();
    // By its words too, not only by testid: the project id was rendered as a
    // chip AND as the "launched from … immutable" caption.
    expect(queryByText(projectId as string)).toBeNull();
    expect(queryByText(/launched from/)).toBeNull();
  });

  /**
   * THE COST, PINNED SO IT CANNOT BE FORGOTTEN.
   *
   * The exit chip was the only VISIBLE instruction for getting the keyboard
   * back out of a focused terminal (C6 layer 3), and the previous version of
   * this file guarded it as a contract: mounted always, opacity-hidden never
   * `display: none`. The user removed it knowingly.
   *
   * `⌃\`` still works — it is a keyboard-layer reservation, not a property of
   * that button — so what was lost is discoverability, not the escape. This
   * test asserts the removal so nobody re-adds the chip believing they are
   * fixing a bug, and states the cost so the next person weighing it has the
   * argument rather than an empty space.
   */
  it('has removed the exit-focus instruction, keystroke untouched', () => {
    const { queryByTestId, queryByText } = renderBody();
    expect(queryByTestId('exit-terminal-chip')).toBeNull();
    expect(queryByText(/exit terminal/)).toBeNull();
  });

  it('the stage stops listening for drags — there is nothing left to drop onto', () => {
    /* Drag-share opened the drawer on dragover so a drop never required
       expanding first. With the drawer gone the target is gone with it, and
       the handlers that surfaced it are removed rather than left firing into
       a component that no longer renders. `SharedContextSection` and
       `ShareDropTarget` still exist, unmounted, for whoever re-homes them. */
    const { getByTestId, queryByTestId } = renderBody();
    const stage = getByTestId('terminal-stage');

    fireEvent.dragEnter(stage);
    fireEvent.dragOver(stage);

    expect(queryByTestId('share-drop-target')).toBeNull();
    expect(queryByTestId('terminal-bottom-drawer')).toBeNull();
    expect(queryByTestId('session-context-header')).toBeNull();
  });

  it('an EXITED session is bare too — the transcript chip went with the overlay', () => {
    // It duplicated the TRANSCRIPT tab in the surface switcher, which is
    // wired and visible; this is the one removal here that costs nothing.
    const { queryByTestId } = renderBody({ liveness: 'exited' });
    expect(queryByTestId('transcript-chip')).toBeNull();
    expect(queryByTestId('terminal-details-toggle')).toBeNull();
  });
});

/**
 * THE ENDED CANVAS — the one place where "the canvas and nothing else" means
 * something other than an empty box.
 *
 * The ruling above stripped the terminal's chrome because it was charging the
 * LIVE surface height it could not spare. A session that has ended has no live
 * surface to protect: the canvas is a fallback either way, and the choice is
 * between the fallback saying two words and the fallback saying what happened.
 * These pin the second.
 */
describe('what an ended session says about itself', () => {
  /**
   * `liveness` is the VERDICT ('not-running'), not the status. Which kind of
   * not-running this is — exited or failed — is read off the DETAIL's own
   * `state.status`, so the two cases need two fixtures rather than two props.
   */
  function endedDetail(summary: { id: string }) {
    const detail = fixtureDetails[summary.id];
    if (!detail) throw new Error('fixtures must supply an ended work_session detail');
    return detail;
  }

  it('threads the RECORD’s own exit facts into the canvas', () => {
    // D1: the prop for this line existed from the beginning and its only
    // caller passed none, so this had never rendered anywhere.
    const { getByTestId } = render(<TerminalBody detail={endedDetail(sessionExited)} liveness="not-running" />);
    expect(getByTestId('session-exit-facts').textContent).toMatch(/ran .+ · ended /);
  });

  it('tells the canvas WHICH ending it is drawing', () => {
    // D3: `failed` and `exited` share this canvas — that is fine — but they
    // must not share the word. The verdict comes from `presentSession`, the
    // same authority every other arm of the canvas switch reads.
    const failed = render(<TerminalBody detail={endedDetail(sessionFailed)} liveness="not-running" />);
    expect(failed.getByTestId('session-exited-fallback').dataset.outcome).toBe('failed');
    expect(failed.getByTestId('session-exited-fallback').textContent).toContain('Session failed');
    failed.unmount();

    const exited = render(<TerminalBody detail={endedDetail(sessionExited)} liveness="not-running" />);
    expect(exited.getByTestId('session-exited-fallback').dataset.outcome).toBe('exited');
  });

  it('mounts the host-wired post-mortem in the ended slot and NOWHERE else', () => {
    const probe = <p data-testid="stats-probe">post-mortem</p>;

    const ended = render(
      <TerminalBody detail={endedDetail(sessionExited)} liveness="not-running" statsSurface={probe} />,
    );
    expect(ended.getByTestId('stats-probe')).toBeTruthy();
    ended.unmount();

    // A LIVE session must not mount it. The surface reads the transcript, and
    // a read polling beside a running PTY re-reads a file the terminal is
    // already showing you — the canvas is the live answer, not this.
    const live = render(
      <TerminalBody detail={endedDetail(sessionExited)} liveness="live" statsSurface={probe} />,
    );
    expect(live.queryByTestId('stats-probe')).toBeNull();
  });

  it('keeps Resume live and refuses the transcript button rather than faking it', () => {
    const { getByTestId } = render(
      <TerminalBody detail={endedDetail(sessionExited)} liveness="not-running" onResume={() => {}} />,
    );
    expect((getByTestId('session-resume') as HTMLButtonElement).disabled).toBe(false);
    // No `onOpenTranscript` from this host ⇒ refused with its reason, never a
    // live control that silently does nothing (D2).
    expect((getByTestId('session-open-transcript') as HTMLButtonElement).disabled).toBe(true);
  });
});
