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
  memoryTokens,
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
 *   3. ACCEPTANCE IS DRAWN, AND THE DEFERRAL IS REVERSED (D73, superseding
 *      D48.2's clause 2). This docblock used to read "ACCEPTANCE STAYS OUT
 *      (D30 / D48.2) … a body that quietly grew it would deliver the deferred
 *      half while the ledger still says deferred" — and that sentence was
 *      still here, 150 lines above a suite asserting the region renders, which
 *      is exactly the failure it warns about. It is corrected rather than
 *      deleted so the reversal is legible.
 *      WHY THE DEFERRAL FELL: D48.2 was survivable only because its mitigation
 *      was "the panel says so out loud" through a registry `notice` block. No
 *      such block was ever configured — `registry.ts`'s `task` row declares no
 *      `panel.blocks` at all — so the gap was INVISIBLE rather than disclosed,
 *      and a deferral nobody can see is indistinguishable from an omission.
 *      What the tests still pin is the STRUCTURAL law: an absent criteria
 *      member draws no region, so the archetype never asks "is this a task?".
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

  it('renders the id and the scalars the strip does not own', () => {
    const { getByTestId } = renderBody();
    const grid = getByTestId('subtree-grid');
    expect(grid.textContent).toContain(taskUuidTitle.id);
    // `dueDate` has no registry control, so the grid is still its only home.
    expect(grid.textContent).toMatch(/Due/);
  });

  /**
   * The grid must NOT restate a field the control strip now owns.
   *
   * This is the D67 amendment's rule, applied to the panel. The task tile once
   * carried static priority/assignee chips ABOVE a working control strip, and
   * the bug users reported was "the buttons are broken" — the things that
   * looked like controls were `<span>`s while the real control sat elsewhere.
   * The panel had the same shape: a read-only `URGENT` tag and an avatar row
   * here, with no way to change either. Now that `EntityControlStrip` is
   * mounted above this body, drawing them here again would rebuild exactly
   * that confusion, so suppression is asserted rather than assumed.
   *
   * Keyed on the REGISTRY declaring a control (task declares `valueControls`
   * for priority and an `assignControl`), never on the kind — a kind with no
   * assign control keeps its read-only assignee row, because there the row is
   * the only truth available.
   */
  it('does NOT restate priority or assignees — the control strip owns both', () => {
    const config = getKind('task');
    expect(config.list.valueControls?.some((c) => c.source === 'priority')).toBe(true);
    expect(config.list.assignControl?.source).toBe('assignees');

    const grid = renderBody().getByTestId('subtree-grid');
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

/**
 * THE DESCRIPTION IS READ BEFORE IT IS WRITTEN.
 *
 * It used to be a permanently-mounted textarea, so a task's markdown reached
 * every reader as its own source — `## Plan` printed, not drawn — in a field
 * that looked like an invitation to type even for a viewer who may not. These
 * pin the `ReaderSurface` stance: rendered by default, the SAME textarea on
 * request, and no stance carried from one task onto the next.
 */
describe('DESCRIPTION — a stance, not a permanent textarea', () => {
  it('DRAWS the markdown by default — no textarea until Edit is asked for', () => {
    const { queryByRole, getByTestId, getByText } = renderBody({
      detail: withDescription('## Plan\n\n- one\n- two'),
      onDescriptionChange: vi.fn(),
    });

    expect(queryByRole('textbox', { name: 'Description' })).toBeNull();
    const view = getByTestId('task-description-view');
    expect(view.querySelector('h2')?.textContent).toBe('Plan');
    expect(view.querySelectorAll('li')).toHaveLength(2);
    expect(view.textContent).not.toContain('## Plan');

    fireEvent.click(getByText('Edit'));
    const input = getByTestId('task-description-editor').querySelector('textarea')!;
    // EDITING IS UNCHANGED — the source, in the same growing field.
    expect((input as HTMLTextAreaElement).value).toBe('## Plan\n\n- one\n- two');
  });

  it('leaves edit for the preview again, and forgets the stance on the next task', () => {
    const { getByText, getByTestId, queryByRole, rerender } = render(
      <SubtreeBody detail={withDescription('Body one')} onDescriptionChange={vi.fn()} />,
    );
    fireEvent.click(getByText('Edit'));
    expect(queryByRole('textbox', { name: 'Description' })).not.toBeNull();
    fireEvent.click(getByText('Done'));
    expect(getByTestId('task-description-view').textContent).toContain('Body one');

    fireEvent.click(getByText('Edit'));
    rerender(
      <SubtreeBody
        detail={{ ...withDescription('Body two'), id: 'other-task' }}
        onDescriptionChange={vi.fn()}
      />,
    );
    // A different task is a different text: it opens READ, never mid-edit.
    expect(queryByRole('textbox', { name: 'Description' })).toBeNull();
    expect(getByTestId('task-description-view').textContent).toContain('Body two');
  });

  it('REFUSES OUT LOUD when the panel cannot save — never a live field that drops text', () => {
    const { getByTestId, queryByRole } = renderBody({
      detail: withDescription('Read-only body'),
      descriptionUnavailableReason: 'You have viewer access here — ask an owner to edit',
    });
    expect(queryByRole('textbox', { name: 'Description' })).toBeNull();
    const refusal = within(getByTestId('task-description-editor')).getByTestId(
      'disabled-with-reason',
    );
    expect(refusal.getAttribute('aria-disabled')).toBe('true');
    expect(refusal.textContent).toContain('viewer access');
  });

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

    // Through the field, as the panel drives it: typing latches the stance, so
    // the draft arriving back as a prop cannot close the editor mid-keystroke.
    fireEvent.change(input, { target: { value: 'First line\nSecond line\nThird line' } });
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
    // A SHAPE assertion, not a concurrency one. The comment that used to sit
    // here claimed the whole-array dispatch stopped one tick from dropping
    // another writer's; it does not. The array is rebuilt from `draft ??
    // persisted` — the rendered, possibly-stale list — so this only says WHERE
    // the rebuild happens. The lost-update defence is `expectedVersion`, and
    // it is asserted end-to-end in panels/detail/save-wiring.test.tsx.
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

  it('CLEARS doneBy/doneAt when a criterion is un-ticked', () => {
    // The stamp is provenance for a fact that is no longer true. `{...c, done}`
    // kept it verbatim, producing `{done:false, doneBy:'forge…', doneAt:'…'}`,
    // and the server normalizer passes both through untouched — so nothing
    // downstream would have corrected it. Setting it on a TICK is the server's
    // job (it has the actor and the clock); clearing it is this body's.
    const onCriteriaChange = vi.fn();
    const { getByTestId } = renderBody({ onCriteriaChange });
    const boxes = within(getByTestId('acceptance-section')).getAllByRole('checkbox');
    // Row 0 is the done one, and the fixture stamps it.
    expect(criteriaOf(taskDetail())[0]?.doneBy).toBeTruthy();
    fireEvent.click(boxes[0]!);

    const next = onCriteriaChange.mock.calls[0]?.[0] as AcceptanceCriterion[];
    expect(next[0]).toEqual({ id: 'ac-1', text: 'Crash reproduced under fixture data', done: false });
    // Every other row is handed back untouched, stamp included.
    expect(next[1]).toEqual(criteriaOf(taskDetail())[1]);
  });

  it('refuses every box with the HONESTY vocabulary when the entity cannot be saved (R7)', () => {
    // NOT a native `disabled` + `title`: DisabledWithReason rules that out
    // because a natively disabled control leaves the tab order, so the
    // keyboard-only user it refuses can never read the refusal.
    const { getByTestId } = renderBody({
      onCriteriaChange: vi.fn(),
      criteriaUnavailableReason: 'You cannot edit this — the server refuses edits here',
    });
    const section = getByTestId('acceptance-section');
    expect(within(section).queryAllByRole('checkbox')).toHaveLength(0);
    const refusals = within(section).getAllByTestId('disabled-with-reason');
    expect(refusals).toHaveLength(4);
    expect(refusals[0]?.getAttribute('tabindex')).toBe('0');
    expect(refusals[0]?.textContent).toMatch(/cannot edit this/i);
    expect(refusals[0]?.textContent).toMatch(/refuses edits here/i);
  });

  it('a REASON beats a handler — passing both refuses rather than half-refusing', () => {
    // The real arm of the contract, and the one `disabled={!onChange}` got
    // wrong: with both props the boxes stayed live and clickable while wearing
    // a refusal tooltip, so the control said one thing and did another.
    const onCriteriaChange = vi.fn();
    const { getByTestId } = renderBody({
      onCriteriaChange,
      criteriaUnavailableReason: 'You cannot edit this — the server refuses edits here',
    });
    const section = getByTestId('acceptance-section');
    fireEvent.click(within(section).getAllByTestId('disabled-with-reason')[0]!);
    expect(onCriteriaChange).not.toHaveBeenCalled();
  });

  it('names the NOT-WIRED reason when no dispatch was handed in at all', () => {
    // The other refusal cause, and the reason the R7 test above was half
    // tautological: `renderBody` supplies no `onCriteriaChange`, so a test that
    // only asserted "disabled" passed with no reason string present anywhere.
    const section = renderBody().getByTestId('acceptance-section');
    expect(within(section).getAllByTestId('disabled-with-reason')[0]?.textContent).toContain(
      'This action isn’t connected yet',
    );
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
   * content blocks — its regions come from the entity's own structure — so a
   * registry row declaring a block it does not draw would render NOTHING and
   * nobody would be red. This is that red.
   *
   * IT HAS WORKED TWICE. Adding `memory-set` to the task row turned this red
   * before the section existed; adding `peer-rows` for `triggered_by` did the
   * same. Both times the block was written because the test refused the
   * declaration, which is exactly the failure it exists for.
   *
   * The SET grows ONLY when the body genuinely grows a renderer. Widening it to
   * make a red go away would retire the guard while leaving it looking green —
   * the one edit this test must never receive.
   */
  const RENDERED_BLOCKS = new Set(['notice', 'memory-set', 'peer-rows']);

  it('every subtree-archetype registry row declares only blocks this body renders', () => {
    const rows = allSubtreeRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const block of row.panel.blocks ?? []) {
        expect(
          RENDERED_BLOCKS.has(block.block),
          `${row.kind} declares '${block.block}' but SubtreeBody draws nothing for it`,
        ).toBe(true);
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

// ---------------------------------------------------------------------------

/**
 * THE MEMORY WORKING SET ON A TASK.
 *
 * WHAT WENT WRONG BEFORE, and it was NOT a missing block guard — that guard
 * exists above and it did its job, going red the moment the task row declared
 * `memory-set` with no renderer behind it.
 *
 * The real defect was quieter. 085 widened `remembers.src_kinds` to the
 * wildcard and P2 began auto-injecting a spawn task's remembered memories,
 * while `peersOf` swept EVERY connection group with no type filter. So those
 * edges arrived in LINKED as anonymous chips — indistinguishable from a
 * `blocks` or `references` peer, while being the one link type on a task that
 * changes what an agent is TOLD. No block was declared, so no block guard
 * could fire; the leak was in a function that was correct until the substrate
 * moved underneath it.
 *
 * That is what the LINKED test below pins, and it is the one to keep.
 */
const REMEMBERS_MEMORY = {
  id: 'edge-task-remembers-1',
  type: 'remembers',
  props: {},
  createdBy: ada,
  createdAt: '2026-07-20T09:00:00.000Z',
  updatedAt: '2026-07-28T09:15:00.000Z',
};

function taskWithMemory(): EntityDetail {
  const base = taskDetail();
  return {
    ...base,
    connections: {
      ...base.connections,
      outgoing: [
        ...base.connections.outgoing,
        {
          type: 'remembers',
          direction: 'outgoing' as const,
          label: 'remembers',
          edges: [{ ...REMEMBERS_MEMORY, source: base as EntitySummary, target: memoryTokens }],
        },
      ],
    },
  };
}

describe('a task holds a memory working set, and a declared block must draw', () => {
  it('draws the declared section, with the label the registry row carries', () => {
    const { getByTestId } = renderBody({
      detail: taskWithMemory(),
      blocks: getKind('task').panel.blocks,
    });
    const section = getByTestId('memory-set-section');
    expect(section.textContent).toContain('MEMORIES');
    expect(section.textContent).toContain('tokens.css is verbatim');
  });

  it('keeps remembered memories OUT of LINKED — one fact, one place', () => {
    /*
     * The actual bug. `remembers` is excluded from `peersOf` by GROUP TYPE and
     * nothing broader: every other edge type still belongs in LINKED, which the
     * second half of this test holds.
     */
    const { getByTestId } = renderBody({
      detail: taskWithMemory(),
      blocks: getKind('task').panel.blocks,
    });
    const linked = getByTestId('linked-section').textContent ?? '';
    expect(linked).not.toContain('tokens.css is verbatim');
    // …and the ordinary link types are untouched by the filter.
    expect(linked).toContain(docLayoutSpec.title);
  });

  it('draws no section at all when the row declares none', () => {
    // Absent blocks must not conjure an empty MEMORIES heading on every task.
    const { queryByTestId } = renderBody({ detail: taskWithMemory() });
    expect(queryByTestId('memory-set-section')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/**
 * LOOP PROVENANCE — the second edge type to grow behavioural meaning under a
 * type-blind sweep, and the reason `OWN_SECTION_EDGES` is a set rather than the
 * single constant it started as.
 *
 * `triggered_by` (086, src task|work_session → dst loop) answers "why does this
 * task exist". Left to `peersOf` it would render as an anonymous LINKED chip —
 * identical to `references` — which is precisely the defect `remembers` had.
 * The failure class is a type-blind traversal meeting a widened edge registry,
 * and no declared-block guard can see it because nothing is declared. These
 * tests are what can see it.
 */
const TRIGGERED_BY_LOOP = {
  id: 'edge-task-triggered-1',
  type: 'triggered_by',
  props: {},
  createdBy: ada,
  createdAt: '2026-07-20T09:00:00.000Z',
  updatedAt: '2026-07-28T09:15:00.000Z',
};

const loopSummary: EntitySummary = {
  ...taskGuideLines,
  id: 'ent-loop-dreamer',
  kind: 'loop',
  title: 'Dreamer sweep',
  state: {
    kind: 'loop', schedule: 'every 1d', enabled: true, teamMemberId: null,
    subjectId: null, nextRunAt: null, lastRunAt: null, lastError: null,
  },
};

function taskFiredByLoop(): EntityDetail {
  const base = taskDetail();
  return {
    ...base,
    connections: {
      ...base.connections,
      outgoing: [
        ...base.connections.outgoing,
        {
          type: 'triggered_by',
          direction: 'outgoing' as const,
          label: 'triggered by',
          edges: [{ ...TRIGGERED_BY_LOOP, source: base as EntitySummary, target: loopSummary }],
        },
      ],
    },
  };
}

describe('a loop-fired task says which loop fired it', () => {
  it('draws the loop in its own section, named by kind', () => {
    const { getByTestId } = renderBody({
      detail: taskFiredByLoop(),
      blocks: getKind('task').panel.blocks,
    });
    const section = getByTestId('peer-rows-section');
    expect(section.textContent).toContain('TRIGGERED BY');
    expect(section.textContent).toContain('Dreamer sweep');
    // The KIND in words — a glyph alone cannot tell a loop from a task.
    expect(section.textContent).toContain('Loop');
  });

  it('keeps the loop OUT of LINKED, and leaves ordinary links alone', () => {
    const { getByTestId } = renderBody({
      detail: taskFiredByLoop(),
      blocks: getKind('task').panel.blocks,
    });
    const linked = getByTestId('linked-section').textContent ?? '';
    expect(linked).not.toContain('Dreamer sweep');
    // The filter is exactly two group types wide, not "anything unfamiliar".
    expect(linked).toContain(docLayoutSpec.title);
  });

  it('states the absence when no loop fired it, rather than drawing nothing', () => {
    // Most tasks are made by hand, and that is a fact worth rendering — an
    // empty region reads as a loading bug.
    const { getByTestId } = renderBody({
      detail: taskDetail(),
      blocks: getKind('task').panel.blocks,
    });
    expect(getByTestId('peer-rows-section').textContent)
      .toContain('this task was created directly');
  });
});
