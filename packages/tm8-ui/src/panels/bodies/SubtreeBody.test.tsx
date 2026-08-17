// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { AcceptanceCriterion, EntityDetail, EntitySummary } from '@tm8/contract';
import type { SessionLiveness } from '../../data/seam';
import { allKinds, getKind } from '../../domain';
import {
  ada,
  docLayoutSpec,
  fixtureDetails,
  sessionStale,
  taskBlocked,
  taskGuideLines,
  taskTombstone,
  taskUuidTitle,
} from '../../fixtures';
import { SubtreeBody } from './SubtreeBody';

/**
 * THE SUBTREE ARCHETYPE — T0-4 frame 2, the `task` region.
 *
 * These tests pin the four things this body can get WRONG in ways a render
 * cannot show you:
 *
 *   1. THE TWO-SOURCE LAW (brief §2.7, D6). A run row's word comes from the
 *      VERDICT handed in, never from the record it sits beside. The fixture is
 *      built for exactly this: `sessionStale.state.status` is 'running' while
 *      the seam's verdict is 'stale'. A body that reads the record renders
 *      "running" over a dead session — the defect preserved in gate-evidence.
 *   2. NO VERDICT IS NOT A ZERO. With no `livenessOf`, the eyebrow may not say
 *      "0 LIVE" — that claims a measurement nobody took (the HollowValue law).
 *   3. ACCEPTANCE STAYS OUT (D30 / D48.2). It is A2 depth, ruled-not-missed;
 *      a body that quietly grew it would deliver the deferred half while the
 *      ledger still says deferred.
 *   4. DONE-NESS IS REGISTRY DATA. A struck row means the child's status is in
 *      its own kind's `done` lifecycle tier — not a literal this file knows.
 *
 * Contract types are IMPORTED, never re-authored, and nothing here casts: a
 * cast would hide the very shape mismatch these assertions exist to catch.
 */

// ---------------------------------------------------------------------------
// Fixture composition — real contract-typed values, assembled locally.
// ---------------------------------------------------------------------------

function taskDetail(): EntityDetail {
  const detail = fixtureDetails[taskUuidTitle.id];
  if (!detail) throw new Error('fixtures must supply a task detail');
  return detail;
}

/**
 * SUBTREE children.
 *
 * `taskTombstone` is the ONLY task summary in the fixtures carrying a CLOSED
 * workStatus, so it is doing double duty as the done-row specimen. That is a
 * fixture gap, not a design choice — reported to the coordinator rather than
 * papered over here.
 */
function withChildren(children: readonly EntitySummary[]): EntityDetail {
  const base = taskDetail();
  return {
    ...base,
    hierarchy: {
      ...base.hierarchy,
      children: { items: [...children], nextCursor: null, total: children.length },
    },
  };
}

function withDescription(description: string): EntityDetail {
  const base = taskDetail();
  if (base.content.kind !== 'task') throw new Error('this fixture must carry task content');
  return {
    ...base,
    content: { ...base.content, description },
  };
}

function criteriaOf(detail: EntityDetail): AcceptanceCriterion[] {
  if (detail.content.kind !== 'task') throw new Error('this fixture must carry task content');
  return detail.content.acceptanceCriteria;
}

function withCriteria(acceptanceCriteria: AcceptanceCriterion[]): EntityDetail {
  const base = taskDetail();
  if (base.content.kind !== 'task') throw new Error('this fixture must carry task content');
  return {
    ...base,
    content: { ...base.content, acceptanceCriteria },
  };
}

const staleVerdict = (id: string): SessionLiveness | undefined =>
  id === sessionStale.id ? 'stale' : undefined;

function renderBody(over: Partial<React.ComponentProps<typeof SubtreeBody>> = {}) {
  return render(<SubtreeBody detail={taskDetail()} {...over} />);
}

// ---------------------------------------------------------------------------

describe('the composed metadata grid', () => {
  it('names the parent by its own registry LABEL, not a hard-coded word', () => {
    const { getByTestId } = renderBody();
    const parent = taskDetail().hierarchy.parent;
    if (!parent) throw new Error('this fixture must have a parent to exercise the row');
    const grid = getByTestId('subtree-grid');
    expect(grid.textContent).toContain(getKind(parent.kind).label);
    expect(grid.textContent).toContain(parent.title);
  });

  it('renders the id', () => {
    const { getByTestId } = renderBody();
    expect(getByTestId('subtree-grid').textContent).toContain(taskUuidTitle.id);
  });

  it('does NOT repeat facts the controls strip now EDITS', () => {
    // Priority and assignees moved into the row-controls strip above the body,
    // where they are editable. A read-only second rendering of an editable
    // fact is the drift this grid already refuses for status.
    const { getByTestId } = renderBody();
    const grid = getByTestId('subtree-grid');
    expect(grid.textContent).not.toContain(`@${ada.displayName}`);
    expect(grid.textContent).not.toMatch(/URGENT/);
  });

  it('renders the points estimate, which lives in CONTENT rather than state', () => {
    // The grid read only `state` and so was silent about a field the create
    // and patch inputs have always carried. The fixture estimates 8.
    expect(renderBody().getByTestId('subtree-grid').textContent).toMatch(/Points\s*8/);
  });

  it('does NOT repeat the status the header pill already carries', () => {
    // Two renderings of one fact drift the moment one of them is edited.
    const { getByTestId } = renderBody();
    expect(getByTestId('subtree-grid').textContent).not.toMatch(/in.review/i);
  });
});

describe('DESCRIPTION — always present and growing in document flow', () => {
  it('renders an editable empty widget when the task has no description', () => {
    const onDescriptionChange = vi.fn();
    const { getByRole } = renderBody({
      detail: withDescription(''),
      onDescriptionChange,
    });

    const input = getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('Add a description…');

    fireEvent.change(input, { target: { value: 'The task now has a description.' } });
    expect(onDescriptionChange).toHaveBeenCalledWith('The task now has a description.');
  });

  it('shows an existing description in the same editor', () => {
    const { getByRole } = renderBody({ detail: withDescription('Persisted task context') });
    const input = getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement;
    expect(input.value).toBe('Persisted task context');
  });

  it('grows to its content and keeps the lower regions after it', () => {
    const onDescriptionChange = vi.fn();
    const { getByRole, getByTestId, rerender } = render(
      <SubtreeBody
        detail={withDescription('')}
        descriptionDraft=""
        onDescriptionChange={onDescriptionChange}
      />,
    );
    const input = getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement;
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 180 });

    rerender(
      <SubtreeBody
        detail={withDescription('')}
        descriptionDraft={'First line\nSecond line\nThird line'}
        onDescriptionChange={onDescriptionChange}
      />,
    );

    expect(input.style.height).toBe('180px');
    expect(
      input.compareDocumentPosition(getByTestId('subtree-section')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('ACCEPTANCE — the conditions that decide whether the work is done', () => {
  it('lists every criterion and counts the completed ones', () => {
    const { getByTestId } = renderBody();
    const section = getByTestId('acceptance-section');
    // The fixture carries four criteria, two of them done.
    expect(section.textContent).toMatch(/ACCEPTANCE · 2\/4/);
    expect(section.textContent).toContain('Crash reproduced under fixture data');
    expect(section.textContent).toContain('Reviewed by a human');
    expect(within(section).getAllByTestId('acceptance-row')).toHaveLength(4);
  });

  it('marks a done criterion done and an open one open', () => {
    const rows = within(renderBody().getByTestId('acceptance-section')).getAllByTestId('acceptance-row');
    expect(rows[0]?.getAttribute('data-done')).toBe('true');
    expect(rows[2]?.getAttribute('data-done')).toBe('false');
  });

  it('hands back the WHOLE array on a tick, with only that criterion flipped', () => {
    // A caller given one flip would rebuild the array from a copy, and a
    // rebuild from a stale copy is how one tick silently drops another's.
    const onCriteriaChange = vi.fn();
    const { getByTestId } = renderBody({ onCriteriaChange });
    const boxes = within(getByTestId('acceptance-section')).getAllByRole('checkbox');
    fireEvent.click(boxes[2]!);

    const next = onCriteriaChange.mock.calls[0]?.[0] as AcceptanceCriterion[];
    expect(next).toHaveLength(4);
    expect(next.map((c) => c.done)).toEqual([true, true, true, false]);
    expect(next[2]?.text).toBe('Fix behind a test');
  });

  it('renders the staged draft, not the persisted criteria, while one is open', () => {
    const persisted = criteriaOf(taskDetail());
    const draft = persisted.map((c) => ({ ...c, done: true }));
    const section = renderBody({ criteriaDraft: draft }).getByTestId('acceptance-section');
    expect(section.textContent).toMatch(/ACCEPTANCE · 4\/4/);
  });

  it('disables every box with its reason when the entity cannot be saved (R7)', () => {
    const { getByTestId } = renderBody({ criteriaUnavailableReason: 'You cannot edit this — the server refuses edits here' });
    const boxes = within(getByTestId('acceptance-section')).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.every((b) => b.disabled)).toBe(true);
    expect(boxes[0]?.title).toMatch(/cannot edit this/i);
  });

  it('states an empty criteria list rather than drawing an empty region', () => {
    const { getByTestId } = renderBody({ detail: withCriteria([]) });
    expect(getByTestId('acceptance-section').textContent).toMatch(/no acceptance criteria/i);
  });

  it('draws NO region for a content shape that carries no criteria member', () => {
    // The archetype law: a structural read, never "is this a task?". A doc
    // detail through this body must not grow an acceptance concept.
    const doc = fixtureDetails[docLayoutSpec.id];
    if (!doc) throw new Error('fixtures must supply a doc detail');
    expect(renderBody({ detail: doc }).queryByTestId('acceptance-section')).toBeNull();
  });
});

describe('SUBTREE — child work, counted and struck from registry data', () => {
  it('lists the children and counts them in the eyebrow', () => {
    const { getByTestId } = renderBody({ detail: withChildren([taskTombstone, taskBlocked]) });
    const section = getByTestId('subtree-section');
    expect(section.textContent).toMatch(/SUBTREE · 2/);
    expect(within(section).getAllByTestId('subtree-row')).toHaveLength(2);
  });

  it('strikes a child whose status is in its kind’s DONE lifecycle tier', () => {
    const { getByTestId } = renderBody({ detail: withChildren([taskTombstone, taskBlocked]) });
    const rows = within(getByTestId('subtree-section')).getAllByTestId('subtree-row');
    // taskTombstone: workStatus 'cancelled' — a member of the task row's done
    // tier filter. taskBlocked: 'blocked' — an open status.
    expect(rows[0]?.getAttribute('data-done')).toBe('true');
    expect(rows[1]?.getAttribute('data-done')).toBe('false');
  });

  it('takes the status WORD from the registry, including its authored label', () => {
    const { getByTestId } = renderBody({ detail: withChildren([taskUuidTitle]) });
    // The task row authors `labels: { in_review: 'in review' }` — the humanized
    // fallback would also produce 'in review', so this asserts the registry is
    // consulted at all by checking the raw value is NOT what is shown.
    const row = within(getByTestId('subtree-section')).getAllByTestId('subtree-row')[0];
    expect(row?.textContent).toContain('in review');
    expect(row?.textContent).not.toContain('in_review');
  });

  it('opens a child on click', () => {
    const onOpenEntity = vi.fn();
    const { getByTestId } = renderBody({ detail: withChildren([taskBlocked]), onOpenEntity });
    fireEvent.click(within(getByTestId('subtree-section')).getAllByTestId('subtree-row')[0]!);
    expect(onOpenEntity).toHaveBeenCalledWith(taskBlocked.id);
  });

  it('states an empty subtree in one quiet line rather than an empty region', () => {
    const { getByTestId } = renderBody({ detail: withChildren([]) });
    expect(getByTestId('subtree-section').textContent).toMatch(/no child work/i);
  });

  it('renders `add child` DISABLED-WITH-REASON while no dispatch is wired (R7)', () => {
    const { getByTestId } = renderBody({ detail: withChildren([]) });
    const control = within(getByTestId('subtree-section')).getByTestId('disabled-with-reason');
    expect(control.textContent).toMatch(/add child/i);
  });
});

describe('RUNS — the verdict is handed in, never derived (D6, brief §2.7)', () => {
  it('separates sessions out of SUBTREE and into RUNS', () => {
    // The fixture task has ONE child and it is a session. Partitioning by
    // "does this kind's registry row present a liveness verdict" is what keeps
    // this file free of a kind literal.
    const { getByTestId } = renderBody({ livenessOf: staleVerdict });
    expect(getByTestId('subtree-section').textContent).toMatch(/no child work/i);
    expect(within(getByTestId('runs-section')).getAllByTestId('run-row')).toHaveLength(1);
  });

  it('shows the VERDICT word over a record that claims otherwise', () => {
    expect(sessionStale.state).toMatchObject({ status: 'running' });
    const { getByTestId } = renderBody({ livenessOf: staleVerdict });
    const row = within(getByTestId('runs-section')).getAllByTestId('run-row')[0];
    const treatment = getKind(sessionStale.kind).list.liveTreatment;
    if (!treatment) throw new Error('the session registry row must carry a liveTreatment');
    expect(row?.textContent).toContain(treatment('stale').shortLabel ?? treatment('stale').label);
    expect(row?.textContent).not.toMatch(/\brunning\b/);
  });

  it('counts LIVE from the verdicts, and says UNVERIFIED rather than 0 when none were supplied', () => {
    const { getByTestId, rerender } = render(<SubtreeBody detail={taskDetail()} />);
    // No `livenessOf`: "0 LIVE" would claim a measurement nobody took.
    expect(getByTestId('runs-section').textContent).toMatch(/UNVERIFIED/i);
    expect(getByTestId('runs-section').textContent).not.toMatch(/0 LIVE/);

    rerender(<SubtreeBody detail={taskDetail()} livenessOf={() => 'live'} />);
    expect(getByTestId('runs-section').textContent).toMatch(/1 LIVE/);
  });

  it('leaves the row verdict HOLLOW when no verdict reached it', () => {
    const { getByTestId } = renderBody();
    const row = within(getByTestId('runs-section')).getAllByTestId('run-row')[0];
    expect(within(row!).getByTestId('hollow-inline')).toBeTruthy();
  });

  it('states an empty runs region in one quiet line', () => {
    const base = taskDetail();
    const detail: EntityDetail = {
      ...base,
      hierarchy: { ...base.hierarchy, children: { items: [], nextCursor: null, total: 0 } },
    };
    const { getByTestId } = renderBody({ detail });
    expect(getByTestId('runs-section').textContent).toMatch(/no runs recorded/i);
  });
});

describe('LINKED — connection peers as chips', () => {
  it('chips every non-session peer, counted', () => {
    const { getByTestId } = renderBody();
    const section = getByTestId('linked-section');
    expect(section.textContent).toMatch(/LINKED · 2/);
    expect(section.textContent).toContain(taskBlocked.title);
    expect(section.textContent).toContain(docLayoutSpec.title);
  });

  it('opens a peer on click', () => {
    const onOpenEntity = vi.fn();
    const { getByTestId } = renderBody({ onOpenEntity });
    fireEvent.click(within(getByTestId('linked-section')).getByText(taskBlocked.title));
    expect(onOpenEntity).toHaveBeenCalledWith(taskBlocked.id);
  });
});

describe('the registry seam this body reads through', () => {
  /**
   * ONE TEST IN THE GAP (brief §4.3). This body does NOT compose itself from
   * content blocks — its regions come from the entity's own structure — and it
   * renders exactly one block kind, `notice`. A registry row that declared any
   * other block for a subtree kind would render NOTHING and nobody would be
   * red. This is that red.
   */
  it('every subtree-archetype registry row declares only blocks this body renders', () => {
    const rows = allSubtreeRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const block of row.panel.blocks ?? []) {
        expect(block.block, `${row.kind} declares a block SubtreeBody does not draw`).toBe('notice');
      }
    }
  });

  it('renders a notice block verbatim', () => {
    const { getByTestId } = renderBody({
      blocks: [{ block: 'notice', params: { text: 'This kind is governed by the space policy.' } }],
    });
    expect(getByTestId('subtree-notices').textContent).toContain(
      'This kind is governed by the space policy.',
    );
  });
});

function allSubtreeRows() {
  return allKinds().filter((k) => k.panel.archetype === 'subtree');
}
