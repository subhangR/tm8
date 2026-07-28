// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { EntityContent, EntityDetail, EntitySummary, EntityState } from '@tm8/contract';
import {
  fixtureDetails,
  handoffDeliveredRecorded,
  handoffUnknownRecorded,
  sessionStale,
} from '../../fixtures';
import { SessionAnatomy, type SessionBlockRef } from './SessionAnatomy';

/**
 * SESSION ANATOMY — the session facts the oracle draws BEYOND the canvas.
 *
 * WHY THESE TESTS EXIST, defect by defect:
 *
 *  1. The exit facts the T0-2 exited frame draws ("exit code 0 · ran 41m ·
 *     ended 12m ago") were never assembled by anything — `ExitedFallback`
 *     accepts a `meta` string and its only caller passes none. The panel has
 *     shipped an exit state with no exit facts in it.
 *  2. `content.transcriptDoc` is read by NOTHING in the package, while the
 *     fallback draws a "View transcript ↗" button whose `onOpenTranscript` is
 *     never passed by `EntityDetailPanel` — an enabled-inert control, the
 *     exact R5 #9 class. A transcript affordance must be driven by the RECORD.
 *  3. The contract's work_session state carries no exit code at all. The
 *     oracle's `exit code 0` therefore cannot be rendered honestly, and the
 *     one thing that must never happen is a fabricated `0` — "zero means
 *     measured-zero; dash means not-measured" (T1-4, HollowValue).
 *
 * KIND LITERALS ARE LEGAL HERE and nowhere else in `panels/`: a test proving a
 * session renders correctly has to be able to name a session
 * (`no-branching.test.ts` excludes `*.test.tsx` deliberately). Every object
 * below is built against a CONTRACT TYPE with no cast, so a contract change
 * fails at `tsc` rather than silently passing a stale shape through an `as`.
 */

// ---------------------------------------------------------------------------
// Contract-typed local builders. No `as`, no optional chains — an assertion
// that has to reach through `?.` is an assertion that can silently not run.
// ---------------------------------------------------------------------------

/** 2026-07-27 17:49 → 18:30 is 41 MINUTES: the oracle's own "ran 41m". */
const STARTED = '2026-07-27T17:49:00.000Z';
const EXITED = '2026-07-27T18:30:00.000Z';

const transcript: EntitySummary = {
  id: 'doc-transcript-echo',
  kind: 'doc',
  title: 'echo — session transcript',
  state: { kind: 'doc', docFormat: 'markdown', childCount: 0 },
  badges: {},
  createdBy: { id: 'agent-echo', displayName: 'echo', isAgent: true },
  createdAt: STARTED,
  updatedAt: EXITED,
  activityAt: EXITED,
  version: 1,
  parentId: null,
  deletedAt: null,
};

function sessionContent(over: Partial<Extract<EntityContent, { kind: 'work_session' }>> = {}) {
  const content: EntityContent = {
    kind: 'work_session',
    nodeId: 'node-local',
    launchProjectId: 'proj-tm8ui',
    workingOn: [],
    transcriptDoc: null,
    ...over,
  };
  return content;
}

function sessionState(over: Partial<Extract<EntityState, { kind: 'work_session' }>> = {}) {
  const state: EntityState = {
    kind: 'work_session',
    status: 'exited',
    agentTool: 'claude-code',
    model: 'claude-fable-5',
    shareMode: 'none',
    startedAt: STARTED,
    exitedAt: EXITED,
    ...over,
  };
  return state;
}

/** The fixture detail the real panel path renders, used as the structural base. */
function baseDetail(): EntityDetail {
  const detail = fixtureDetails[sessionStale.id];
  if (!detail) throw new Error('fixtures must supply a work_session detail arm');
  return detail;
}

function detailWith(over: Partial<EntityDetail> = {}): EntityDetail {
  return { ...baseDetail(), ...over };
}

const PROVENANCE: readonly SessionBlockRef[] = [{ block: 'provenance-strip' }];
const EXIT: readonly SessionBlockRef[] = [{ block: 'exit-summary' }];
const TRANSCRIPT: readonly SessionBlockRef[] = [{ block: 'transcript' }];

// ---------------------------------------------------------------------------

describe('the block list drives the body — nothing knows a kind', () => {
  it('renders no block the registry did not ask for', () => {
    const { queryByTestId } = render(<SessionAnatomy detail={detailWith()} blocks={[]} />);
    expect(queryByTestId('block-provenance-strip')).toBeNull();
    expect(queryByTestId('block-exit-summary')).toBeNull();
    expect(queryByTestId('block-transcript')).toBeNull();
  });

  it('renders the blocks in the order the registry lists them', () => {
    const { getByTestId, container } = render(
      <SessionAnatomy
        detail={detailWith()}
        blocks={[{ block: 'exit-summary' }, { block: 'provenance-strip' }]}
      />,
    );
    const rendered = [...container.querySelectorAll('[data-testid^="block-"]')];
    expect(rendered.map((el) => el.getAttribute('data-testid'))).toEqual([
      'block-exit-summary',
      'block-provenance-strip',
    ]);
    expect(getByTestId('block-exit-summary')).toBeTruthy();
  });
});

describe('provenance strip — T0-4 Z4 terminal, the two-column strip under the title', () => {
  it('names the launch project and states that it is immutable', () => {
    const { getByTestId } = render(<SessionAnatomy detail={detailWith()} blocks={PROVENANCE} />);
    const block = getByTestId('block-provenance-strip');
    expect(block.textContent).toContain('proj-tm8ui');
    // The oracle's own caption: "launched from · immutable". Provenance can
    // never be edited, so it must not read like something editable.
    expect(block.textContent).toContain('immutable');
  });

  it('states the ABSENCE of a launch project rather than drawing an empty chip', () => {
    const detail = detailWith({ content: sessionContent({ launchProjectId: null }) });
    const { getByTestId } = render(<SessionAnatomy detail={detail} blocks={PROVENANCE} />);
    expect(getByTestId('block-provenance-strip').textContent).toContain('no project recorded');
  });

  it('carries the share count in the eyebrow, as the oracle does', () => {
    const { getByTestId } = render(
      <SessionAnatomy
        detail={detailWith()}
        blocks={PROVENANCE}
        handoffs={[handoffDeliveredRecorded, handoffUnknownRecorded]}
      />,
    );
    expect(getByTestId('block-provenance-strip').textContent).toContain('SHARED CONTEXT · 2');
  });

  it('renders BOTH facets on every share row and never merges them (L7)', () => {
    const { getAllByTestId } = render(
      <SessionAnatomy
        detail={detailWith()}
        blocks={PROVENANCE}
        handoffs={[handoffUnknownRecorded]}
      />,
    );
    const rows = getAllByTestId('anatomy-share-row');
    expect(rows).toHaveLength(1);
    const firstRow = rows[0];
    if (!firstRow) throw new Error('a share row must render for a handoff');
    // `unknown` is a WARNING and wears the wait tone — never the green of proof.
    expect(firstRow.textContent).toContain('delivery unknown ⚠');
    expect(firstRow.textContent).toContain('recorded');
    expect(firstRow.querySelectorAll('.pn-facet')).toHaveLength(2);
  });

  it('says nothing is shared rather than rendering an empty list', () => {
    const { getByTestId } = render(
      <SessionAnatomy detail={detailWith()} blocks={PROVENANCE} handoffs={[]} />,
    );
    expect(getByTestId('block-provenance-strip').textContent).toContain('nothing shared');
  });
});

describe('exit summary — the facts the built exited state never had', () => {
  it('computes the run duration from the record, matching the oracle "ran 41m"', () => {
    const detail = detailWith({ state: sessionState() });
    const { getByTestId } = render(<SessionAnatomy detail={detail} blocks={EXIT} />);
    expect(getByTestId('block-exit-summary').textContent).toContain('ran 41m');
  });

  it('renders the exit code HOLLOW — the contract records none, and 0 would be a lie', () => {
    const detail = detailWith({ state: sessionState() });
    const { getByTestId } = render(<SessionAnatomy detail={detail} blocks={EXIT} />);
    const block = getByTestId('block-exit-summary');
    expect(block.textContent).toContain('exit code —');
    // The specific fabrication this test exists to forbid.
    expect(block.textContent).not.toContain('exit code 0');
    expect(getByTestId('hollow-inline')).toBeTruthy();
  });

  it('states an unrecorded duration instead of computing one from a missing end', () => {
    const detail = detailWith({ state: sessionState({ exitedAt: null }) });
    const { getByTestId } = render(<SessionAnatomy detail={detail} blocks={EXIT} />);
    const text = getByTestId('block-exit-summary').textContent ?? '';
    expect(text).toContain('duration not recorded');
    expect(text).not.toContain('ran ');
  });

  it('does NOT restate the fallback’s read-only caption — one home per sentence', () => {
    // SessionFallback.tsx already renders "Read-only — the session record,
    // discussion and connections stay." Rendering it again here would be the
    // third instance of the duplication UnverifiedFallback's docblock records.
    const detail = detailWith({ state: sessionState() });
    const { getByTestId } = render(<SessionAnatomy detail={detail} blocks={EXIT} />);
    expect(getByTestId('block-exit-summary').textContent).not.toContain('Read-only');
  });
});

describe('transcript — driven by the record, never an enabled-inert button', () => {
  it('opens the recorded transcript document by id', () => {
    const onOpenEntity = vi.fn();
    const detail = detailWith({ content: sessionContent({ transcriptDoc: transcript }) });
    const { getByRole } = render(
      <SessionAnatomy detail={detail} blocks={TRANSCRIPT} onOpenEntity={onOpenEntity} />,
    );
    getByRole('button', { name: /transcript/i }).click();
    expect(onOpenEntity).toHaveBeenCalledWith(transcript.id);
  });

  it('renders disabled-with-reason when the record has no transcript', () => {
    const detail = detailWith({ content: sessionContent({ transcriptDoc: null }) });
    const { getByTestId } = render(
      <SessionAnatomy detail={detail} blocks={TRANSCRIPT} onOpenEntity={() => {}} />,
    );
    const control = getByTestId('disabled-with-reason');
    expect(control.getAttribute('aria-disabled')).toBe('true');
    // The reason states the RECORD's fact, not a deferred-feature excuse.
    expect(control.parentElement?.textContent ?? '').toContain('no transcript');
  });

  it('renders disabled-with-reason when the OPEN handler is not wired (R5 #9)', () => {
    // The defect this mirrors is live at HEAD: EntityDetailPanel renders
    // TerminalBody without `onOpenTranscript`, so the fallback's "View
    // transcript ↗" is a live button that does nothing when clicked. A
    // structural check cannot drift away from what is actually wired.
    const detail = detailWith({ content: sessionContent({ transcriptDoc: transcript }) });
    const { getByTestId, container } = render(<SessionAnatomy detail={detail} blocks={TRANSCRIPT} />);
    expect(getByTestId('disabled-with-reason').getAttribute('aria-disabled')).toBe('true');
    // Asserted on the ELEMENT, not the role: the disabled treatment is
    // deliberately `role="button"` and focusable (so a keyboard user can reach
    // the reason), which means a role query would match it. The defect being
    // forbidden is a real, clickable <button>.
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('the gap between the data and this body (§4.3 — a test lives in the seam)', () => {
  /**
   * FOUR LINKS CAN EACH BE GREEN WHILE THE FEATURE IS DEAD. These blocks read
   * `content.launchProjectId` and `content.transcriptDoc` off the SAME detail
   * arm the real panel path renders. Asserting the members exist on the real
   * fixture — not on a hand-built object — is what catches the case where the
   * component is perfect and its input never carries the field.
   */
  it('the detail the panel actually renders carries the members these blocks read', () => {
    const content = baseDetail().content;
    if (content.kind !== 'work_session') throw new Error('the session detail arm must be session content');
    expect(typeof content.launchProjectId).toBe('string');
    // `null` is the honest recorded value here — the ASSERTION is that the
    // member EXISTS, because an absent member and a null one render the same
    // and only one of them is a contract change.
    expect('transcriptDoc' in content).toBe(true);
    expect(content.transcriptDoc).toBeNull();
  });

  it('the record the exit block reads carries its timestamps', () => {
    const state = baseDetail().state;
    if (state.kind !== 'work_session') throw new Error('the session detail arm must carry session state');
    expect('startedAt' in state).toBe(true);
    expect('exitedAt' in state).toBe(true);
  });
});
