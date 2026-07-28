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

describe('the context header costs one line, not half the panel', () => {
  it('starts collapsed', () => {
    const { getByTestId } = renderBody();
    expect(getByTestId('session-context-header').getAttribute('data-expanded')).toBe('false');
  });

  it('does not render the sections while collapsed — that is the height being reclaimed', () => {
    const { queryByTestId } = renderBody();
    expect(queryByTestId('associated-projects-section')).toBeNull();
    expect(queryByTestId('shared-context-section')).toBeNull();
  });

  it('names the project on the collapsed line when there IS one', () => {
    // A summary that hid the facts would trade one dishonesty for another, so
    // the collapsed line must carry the project itself, not just its presence.
    const detail = sessionDetail();
    const projectId = (detail.content as unknown as Record<string, unknown>).launchProjectId;
    expect(typeof projectId).toBe('string');
    const { getByTestId } = renderBody({ handoffs: [] });
    const text = getByTestId('session-context-header').textContent ?? '';
    expect(text).toContain(projectId as string);
    expect(text).toMatch(/nothing shared/);
  });

  it('states the ABSENCE of a project when there is none — the empty half of the same line', () => {
    const detail = sessionDetail();
    const withoutProject = { ...detail, content: { ...detail.content, launchProjectId: undefined } };
    const { getByTestId } = renderBody({ detail: withoutProject as typeof detail, handoffs: [] });
    expect(getByTestId('session-context-header').textContent).toMatch(/no project recorded/);
  });

  it('states a real share count when there is one', () => {
    const detail = sessionDetail();
    const handoffs = [
      { handoffId: 'h1', sourceEntityId: 'e1', sourceTitle: 'a', targetSessionId: detail.id },
      { handoffId: 'h2', sourceEntityId: 'e2', sourceTitle: 'b', targetSessionId: detail.id },
    ] as never;
    const { getByTestId } = renderBody({ handoffs });
    expect(getByTestId('session-context-header').textContent).toMatch(/2 shared/);
  });

  it('renders the terminal canvas WITHOUT anyone expanding anything', () => {
    // The point of the whole ruling: the primary surface is present and
    // dominant on arrival, not after an interaction.
    const { getByTestId } = renderBody();
    expect(getByTestId('terminal-host-placeholder')).toBeTruthy();
  });

  it('reveals the sections on demand', () => {
    const { getByTestId, queryByTestId } = renderBody();
    fireEvent.click(within(getByTestId('session-context-header')).getByRole('button'));
    expect(getByTestId('session-context-header').getAttribute('data-expanded')).toBe('true');
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
  it('surfaces the drop target on dragover while still collapsed', () => {
    const { getByTestId, queryByTestId } = renderBody();
    const header = getByTestId('session-context-header');
    expect(queryByTestId('share-drop-target')).toBeNull();

    fireEvent.dragEnter(header);
    fireEvent.dragOver(header);
    expect(queryByTestId('share-drop-target')).not.toBeNull();
  });

  it('returns to the viewer’s own choice when the drag leaves, rather than staying open behind them', () => {
    const { getByTestId, queryByTestId } = renderBody();
    const header = getByTestId('session-context-header');

    fireEvent.dragEnter(header);
    expect(queryByTestId('share-drop-target')).not.toBeNull();

    // relatedTarget outside the region — a child-boundary crossing must NOT
    // close it, which is what the contains() check in the handler is for.
    fireEvent.dragLeave(header, { relatedTarget: document.body });
    expect(header.getAttribute('data-expanded')).toBe('false');
  });

  it('leaves an explicitly expanded header open after a drag passes through', () => {
    // Drag state and viewer state are separate; a drag must not silently undo
    // a choice the viewer made.
    const { getByTestId } = renderBody();
    const header = getByTestId('session-context-header');
    fireEvent.click(within(header).getAllByRole('button')[0]);
    expect(header.getAttribute('data-expanded')).toBe('true');

    fireEvent.dragEnter(header);
    fireEvent.dragLeave(header, { relatedTarget: document.body });
    expect(header.getAttribute('data-expanded')).toBe('true');
  });
});
