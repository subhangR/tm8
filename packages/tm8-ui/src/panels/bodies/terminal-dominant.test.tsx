// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import { fixtureDetails, sessionStale } from '../../fixtures';
import { TerminalBody } from './TerminalBody';

/**
 * R5 #10 — TERMINAL-DOMINANT, user-ratified default.
 *
 * The law, verbatim: "an empty state that costs the primary surface half its
 * height inverts the honesty economy."
 *
 * These tests exist because the regression is INVISIBLE to the suite that
 * preceded them. Nothing asserted the old always-open anatomy, so collapsing
 * it broke no test — which means nothing would catch it silently reverting
 * either. The behaviour a ruling establishes has to be pinned by a test or it
 * is only a comment.
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
  return render(
    <TerminalBody
      detail={sessionDetail()}
      liveness="live"
      shareUnavailableReason="Sharing is deferred — the seam has no handoff command in this build"
      withdrawUnavailableReason="Withdraw is deferred — the seam has no withdraw command in this build"
      {...over}
    />,
  );
}

describe('everything below the canvas starts in one collapsed drawer', () => {
  /**
   * USER RULING 2026-07-31 — "remove the bottom strip … terminal all the way,
   * till the component bottom." Collapsed is now ZERO height: the drawer is
   * unmounted, not merely closed, and its toggle floats on the canvas. These
   * assertions moved from "the bar reads X" to "nothing below the canvas has
   * a box, and X is still stated" — which is the same honesty claim measured
   * where the facts now live.
   */
  it('renders no strip below the canvas at all by default', () => {
    const { getByTestId, queryByTestId } = renderBody();
    expect(queryByTestId('terminal-bottom-drawer')).toBeNull();
    expect(queryByTestId('terminal-chrome-strip')).toBeNull();
    expect(queryByTestId('session-context-header')).toBeNull();
    expect(getByTestId('terminal-details-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(getByTestId('terminal-host-placeholder')).toBeTruthy();
  });

  it('keeps project and share facts on the collapsed toggle', () => {
    const detail = sessionDetail();
    const projectId = (detail.content as unknown as Record<string, unknown>).launchProjectId;
    expect(typeof projectId).toBe('string');
    const handoffs = [
      { handoffId: 'h1', sourceEntityId: 'e1', sourceTitle: 'a', targetSessionId: detail.id },
      { handoffId: 'h2', sourceEntityId: 'e2', sourceTitle: 'b', targetSessionId: detail.id },
    ] as never;
    const { getByTestId } = renderBody({ handoffs });
    // The facts have no pixels of their own any more, so they are asserted
    // where a viewer and a screen reader can still reach them.
    const summary = getByTestId('terminal-details-toggle').getAttribute('aria-label') ?? '';
    expect(summary).toContain(projectId as string);
    expect(summary).toMatch(/2 shared/);
    expect(getByTestId('terminal-details-toggle').getAttribute('title')).toContain(
      projectId as string,
    );
  });

  it('states the absence of a project on that same collapsed toggle', () => {
    const detail = sessionDetail();
    const withoutProject = { ...detail, content: { ...detail.content, launchProjectId: undefined } };
    const { getByTestId } = renderBody({ detail: withoutProject as typeof detail });
    expect(getByTestId('terminal-details-toggle').getAttribute('aria-label')).toMatch(/no project/);
  });

  /**
   * The exit chip is the ONE visible instruction for getting the keyboard back
   * out of a focused terminal (C6 layer 3). Moving it onto a hover-revealed
   * overlay is only legitimate while it stays MOUNTED and focusable — CSS
   * opacity, never `display: none` and never a conditional render. jsdom
   * cannot see the opacity; it can see the element, which is the half that
   * would actually break the contract if it regressed.
   */
  it('keeps the exit-focus instruction mounted with the strip gone', () => {
    const { getByTestId } = renderBody();
    const chip = getByTestId('exit-terminal-chip');
    expect(chip.getAttribute('aria-label')).toMatch(/Control and backtick/);
  });

  it('reveals the session strip and context controls on demand', () => {
    const { getByTestId, queryByTestId } = renderBody();
    fireEvent.click(getByTestId('terminal-details-toggle'));
    expect(getByTestId('terminal-bottom-drawer').getAttribute('data-expanded')).toBe('true');
    expect(queryByTestId('terminal-chrome-strip')).not.toBeNull();
    expect(queryByTestId('session-context-header')).not.toBeNull();

    fireEvent.click(within(getByTestId('session-context-header')).getByRole('button'));
    expect(queryByTestId('associated-projects-section')).not.toBeNull();
    expect(queryByTestId('shared-context-section')).not.toBeNull();
  });
});

describe('dropping must not require expanding first', () => {
  /**
   * The ruling's explicit carve-out. Sessions are collapsed by default, so a
   * drop target reachable only after expanding would make drag-share dead on
   * arrival for every session — a feature removed by a layout decision.
   */
  /**
   * With the drawer unmounted while collapsed there is no bar left to drag
   * onto, so the STAGE — the canvas and its overlay — is the region that
   * listens. If it stopped listening, drag-share would be dead on arrival for
   * every session again, which is the exact failure this carve-out exists to
   * prevent.
   */
  it('surfaces the drop target on dragover the canvas while still collapsed', () => {
    const { getByTestId, queryByTestId } = renderBody();
    const stage = getByTestId('terminal-stage');
    expect(queryByTestId('share-drop-target')).toBeNull();

    fireEvent.dragEnter(stage);
    fireEvent.dragOver(stage);
    expect(queryByTestId('share-drop-target')).not.toBeNull();
  });

  it('returns to the viewer’s own choice when the drag leaves, rather than staying open behind them', () => {
    const { getByTestId, queryByTestId } = renderBody();
    const stage = getByTestId('terminal-stage');

    fireEvent.dragEnter(stage);
    expect(queryByTestId('share-drop-target')).not.toBeNull();

    // relatedTarget outside the region — a child-boundary crossing must NOT
    // close it, which is what the contains() check in the handler is for.
    fireEvent.dragLeave(stage, { relatedTarget: document.body });
    expect(queryByTestId('terminal-bottom-drawer')).toBeNull();
    expect(queryByTestId('session-context-header')).toBeNull();
  });

  it('leaves an explicitly expanded header open after a drag passes through', () => {
    // Drag state and viewer state are separate; a drag must not silently undo
    // a choice the viewer made.
    const { getByTestId, queryByTestId } = renderBody();
    fireEvent.click(getByTestId('terminal-details-toggle'));
    expect(getByTestId('terminal-bottom-drawer').getAttribute('data-expanded')).toBe('true');

    const stage = getByTestId('terminal-stage');
    fireEvent.dragEnter(stage);
    fireEvent.dragLeave(stage, { relatedTarget: document.body });
    expect(queryByTestId('terminal-bottom-drawer')).not.toBeNull();
  });
});
