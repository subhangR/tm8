// @vitest-environment jsdom
/**
 * W2 — Settings > Task axes, at the component layer.
 *
 * What this file holds, in refusal order:
 *   1. the section renders REAL rows (the false AXES_UNREADABLE state is gone
 *      and cannot silently return as an empty pane);
 *   2. the seeded default axis's Delete is disabled-with-reason in 016's own
 *      words while its Edit stays live — the amended ruling, drawn honestly;
 *   3. an in-use refusal shows the server's message AND names the visible
 *      tasks, with "at least N" because the read is viewer-scoped and the
 *      refusal is space-wide; a failed lookup leaves the refusal standing;
 *   4. `null` (unread) and `[]` (measured none) render as different states.
 *
 * LAYOUT PASS 2026-08-16 added (5): the section is on `SectionFrame` with ONE
 * scroller, the refusal renders in the row that earned it, the value set is a
 * clamped set of chips, and the registry's one invariant is stated once rather
 * than re-typed under every row. Those four are the defects that were measured
 * in Chrome; each has an assertion below so it cannot come back silently.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TaskAxis } from '@tm8/contract';
import { AxesSection } from './AxesSection';

afterEach(cleanup);

const TYPE_AXIS: TaskAxis = {
  id: 'axis-type',
  spaceId: 'specimen-space' as never,
  name: 'type',
  axisValues: ['default', 'code', 'design', 'review', 'test'],
  kind: 'default',
  position: 0,
};

const SIZE_AXIS: TaskAxis = {
  id: 'axis-size',
  spaceId: 'specimen-space' as never,
  name: 'size',
  axisValues: ['s', 'm', 'l'],
  kind: 'manual',
  position: 1,
};

const noop = async () => undefined;

/** The value chips a row is drawing, in order. */
function values(row: Element): string[] {
  return [...row.querySelectorAll('[data-testid="axis-value"]')].map((n) => n.textContent ?? '');
}

function mount(over: Partial<React.ComponentProps<typeof AxesSection>> = {}) {
  return render(
    <div className="cv2-root">
      <AxesSection
        axes={[TYPE_AXIS, SIZE_AXIS]}
        onCreate={noop}
        onUpdate={noop}
        onDelete={noop}
        {...over}
      />
    </div>,
  );
}

describe('the axis rows are real data', () => {
  it('renders every axis with its values, provenance, and position order', () => {
    mount();
    const rows = screen.getAllByTestId('axis-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('type');
    // CHANGED BY THE LAYOUT PASS (2026-08-16), and deliberately STRENGTHENED
    // rather than dropped. This used to read
    //   toContain('default · code · design · review · test')
    // which asserted the values were a `join(' · ')` SENTENCE — the exact
    // rendering the layout pass was asked to fix (one 850px mono run that
    // wrapped and dragged the axis name onto two lines with it). The values
    // are a SET and are drawn as one, so the assertion now pins the set and
    // its order exactly instead of pinning a substring of one presentation.
    expect(values(rows[0]!)).toEqual(['default', 'code', 'design', 'review', 'test']);
    expect(rows[0]!.textContent).toContain('seeded');
    expect(rows[1]!.textContent).toContain('size');
    expect(values(rows[1]!)).toEqual(['s', 'm', 'l']);
    expect(rows[1]!.textContent).toContain('manual');
  });

  it('a free-text axis says so instead of rendering a blank vocabulary', () => {
    mount({ axes: [{ ...SIZE_AXIS, axisValues: [] }] });
    expect(screen.getByTestId('axis-row').textContent).toContain('free text');
  });

  it('unread and measured-none are different states', () => {
    mount({ axes: null });
    expect(screen.getByTestId('axes-absent')).toBeDefined();
    cleanup();
    mount({ axes: [] });
    expect(screen.getByTestId('axes-none')).toBeDefined();
  });
});

describe('the layout contract (SECTION-CONTRACT.md)', () => {
  it('is a SectionFrame with exactly one scroller and no nested one', () => {
    const { container } = mount();
    // §2 — root / fixed head / one scrolling body. The section used to return
    // a FRAGMENT that hand-rolled the head and scroll divs; there was no
    // `.set-section` root at all (measured: sectionRoot === false).
    expect(container.querySelectorAll('.set-section')).toHaveLength(1);
    expect(container.querySelectorAll('.set-section__head')).toHaveLength(1);
    const scrollers = container.querySelectorAll('.set-section__scroll');
    expect(scrollers).toHaveLength(1);
    // §3 — the one scroller. jsdom has no layout, so this asserts the CAUSE:
    // no descendant declares itself a second scrolling pane.
    expect(scrollers[0]!.querySelectorAll('.set-section__scroll')).toHaveLength(0);
  });

  it('states the in-use invariant ONCE for the registry, not once per row', () => {
    // Four rows used to buy four copies of the same ~700px sentence, so the
    // section read as grey prose with the data hidden inside it.
    mount({ axes: [TYPE_AXIS, SIZE_AXIS, { ...SIZE_AXIS, id: 'a3', name: 'stage', position: 2 }] });
    expect(screen.getAllByTestId('axis-row')).toHaveLength(3);
    expect(screen.getAllByTestId('axes-rule')).toHaveLength(1);
  });

  it('the seeded row’s refusal caption is NOT inside the action column', () => {
    // THE 690px DEFECT, held at its cause. `DisabledAction` puts a
    // 96-character caption INSIDE the control; in a single flex row that
    // caption sized the flex item, so this row's `seeded / edit / delete`
    // landed at x=830 while every other row's landed at x=1520. The action
    // column must carry controls only — the prose lives in the row note.
    mount();
    const [seeded] = screen.getAllByTestId('axis-row');
    const acts = seeded!.querySelector('.set-axes__acts')!;
    expect(acts).not.toBeNull();
    expect(acts.querySelector('.hon-caption')).toBeNull();
    // The reason is still in the DOM, and reachable — just not in the track.
    expect(seeded!.textContent).toContain('the default task axis cannot be deleted');
    // Both rows put their controls in the same, single, actions track.
    for (const row of screen.getAllByTestId('axis-row')) {
      expect(row.querySelectorAll('.set-axes__acts')).toHaveLength(1);
    }
  });

  it('clamps a long value set and reveals the rest in place — no second scroller', () => {
    const many = Array.from({ length: 14 }, (_, i) => `v${i + 1}`);
    mount({ axes: [{ ...SIZE_AXIS, axisValues: many }] });
    const row = screen.getByTestId('axis-row');
    expect(values(row)).toHaveLength(8);
    expect(screen.getByTestId('axis-values-more').textContent).toBe('+6 more');

    fireEvent.click(screen.getByTestId('axis-values-more'));
    expect(values(screen.getByTestId('axis-row'))).toEqual(many);
    // Revealed in place, not into a pane of its own.
    expect(row.querySelectorAll('.set-section__scroll')).toHaveLength(0);

    fireEvent.click(screen.getByTestId('axis-values-fewer'));
    expect(values(screen.getByTestId('axis-row'))).toHaveLength(8);
  });

  it('a set at the clamp exactly is drawn whole, with no reveal offered', () => {
    mount({ axes: [{ ...SIZE_AXIS, axisValues: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }] });
    expect(values(screen.getByTestId('axis-row'))).toHaveLength(8);
    expect(screen.queryByTestId('axis-values-more')).toBeNull();
  });
});

describe('the default axis is fixed, its values are not (amended ruling)', () => {
  it('draws the seeded row\u2019s delete disabled-with-reason in 016\u2019s words, edit live', () => {
    const onDelete = vi.fn(noop);
    mount({ onDelete });
    const [seeded] = screen.getAllByTestId('axis-row');
    // Exactly ONE live delete on the screen: the manual axis's.
    expect(screen.getAllByTestId('axis-delete')).toHaveLength(1);
    // The seeded row's delete is the refusal form, reason in the DOM (the
    // caption is the refusal span's sibling inside the group).
    const refused = seeded!.querySelector('[data-testid="disabled-with-reason"]');
    expect(refused).not.toBeNull();
    expect(seeded!.textContent).toContain('the default task axis cannot be deleted');
    // Edit is a real button on BOTH rows — values stay curatable.
    expect(screen.getAllByTestId('axis-edit')).toHaveLength(2);
  });

  it('deleting a manual axis dispatches; the seeded one cannot dispatch at all', () => {
    const onDelete = vi.fn(noop);
    mount({ onDelete });
    fireEvent.click(screen.getByTestId('axis-delete'));
    expect(onDelete).toHaveBeenCalledWith(SIZE_AXIS.id);
    expect(onDelete).not.toHaveBeenCalledWith(TYPE_AXIS.id);
  });
});

describe('writes dispatch with the form\u2019s parse, and refusals surface', () => {
  it('creates with trimmed comma-separated values and the next free position', async () => {
    const onCreate = vi.fn(noop);
    mount({ onCreate });
    const form = screen.getAllByTestId('axis-form').find((f) => f.textContent?.includes('New axis'))!;
    fireEvent.change(form.querySelector('[data-testid="axis-name"]')!, { target: { value: ' stage ' } });
    fireEvent.change(form.querySelector('[data-testid="axis-values"]')!, { target: { value: 'triage, doing , done,' } });
    fireEvent.click(form.querySelector('[data-testid="axis-submit"]')!);
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        name: 'stage',
        axisValues: ['triage', 'doing', 'done'],
        kind: 'manual',
        position: 2,
      }),
    );
  });

  it('editing preserves kind — there is deliberately NO demote control', async () => {
    const onUpdate = vi.fn(noop);
    mount({ onUpdate });
    fireEvent.click(screen.getAllByTestId('axis-edit')[0]!);
    // TWO forms are on screen now (the edit form and the standing New-axis
    // form); scope to the one editing the seeded row.
    const editForm = screen.getAllByTestId('axis-form').find((f) => f.textContent?.includes('Edit type'))!;
    fireEvent.click(editForm.querySelector('[data-testid="axis-submit"]')!);
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(onUpdate.mock.calls[0]![1]).toMatchObject({ kind: 'default' });
  });

  it('an in-use refusal shows the server\u2019s words and names the VISIBLE tasks as "at least N"', async () => {
    const onDelete = vi.fn(async () => {
      throw new Error('task axis is still in use by tasks');
    });
    const tasksUsing = vi.fn(async () => [
      { id: 't1', title: 'Ship the importer' } as never,
      { id: 't2', title: 'Fix the board' } as never,
    ]);
    mount({ onDelete, tasksUsing });
    fireEvent.click(screen.getByTestId('axis-delete'));
    const alert = await screen.findByTestId('axes-error');
    expect(alert.textContent).toContain('task axis is still in use by tasks');
    expect(alert.textContent).toContain('at least 2 you can see: Ship the importer, Fix the board');
    expect(tasksUsing).toHaveBeenCalledWith(SIZE_AXIS);
  });

  it('a failed task lookup leaves the refusal standing alone — never swallowed with it', async () => {
    const onDelete = vi.fn(async () => {
      throw new Error('task axis is still in use by tasks');
    });
    const tasksUsing = vi.fn(async () => {
      throw new Error('boom');
    });
    mount({ onDelete, tasksUsing });
    fireEvent.click(screen.getByTestId('axis-delete'));
    const alert = await screen.findByTestId('axes-error');
    expect(alert.textContent).toBe('task axis is still in use by tasks');
  });

  it('the refusal renders INSIDE the row that earned it, not at the top of the section', async () => {
    // THE DEFECT THIS HOLDS (measured in Chrome, 2026-08-16, 900x600): the
    // failure was one span at the top of the scroller. Refusing a delete on
    // the third row put the server's words 362px ABOVE the button that was
    // clicked, and pushed every row down 88px to make space. A refusal that
    // lands somewhere else on the screen is not "beside the act".
    const onDelete = vi.fn(async () => {
      throw new Error('task axis is still in use by tasks');
    });
    mount({ onDelete });
    fireEvent.click(screen.getByTestId('axis-delete'));
    const alert = await screen.findByTestId('axes-error');

    const rows = screen.getAllByTestId('axis-row');
    // The nearest enclosing row IS the size row — the one whose delete was
    // clicked — so the refusal cannot be floating above the list.
    expect(alert.closest('[data-testid="axis-row"]')).toBe(rows[1]);
    expect(rows[0]!.contains(alert)).toBe(false);
    // It is not a child of the section body itself, which is where the old
    // single top-of-scroller span lived.
    expect(alert.parentElement).toBe(rows[1]);
  });

  it('a create refusal renders inside the create form, not in any row', async () => {
    const onCreate = vi.fn(async () => {
      throw new Error('forbidden: space admin required');
    });
    mount({ onCreate });
    const form = screen.getAllByTestId('axis-form').find((f) => f.textContent?.includes('New axis'))!;
    fireEvent.change(form.querySelector('[data-testid="axis-name"]')!, { target: { value: 'stage' } });
    fireEvent.click(form.querySelector('[data-testid="axis-submit"]')!);
    const alert = await screen.findByTestId('axes-error');
    expect(form.contains(alert)).toBe(true);
    for (const row of screen.getAllByTestId('axis-row')) expect(row.contains(alert)).toBe(false);
  });

  it('a non-in-use refusal (admin required) surfaces verbatim without a task lookup', async () => {
    const onCreate = vi.fn(async () => {
      throw new Error('forbidden: space admin required');
    });
    const tasksUsing = vi.fn(async () => []);
    mount({ onCreate, tasksUsing });
    const form = screen.getAllByTestId('axis-form').find((f) => f.textContent?.includes('New axis'))!;
    fireEvent.change(form.querySelector('[data-testid="axis-name"]')!, { target: { value: 'stage' } });
    fireEvent.click(form.querySelector('[data-testid="axis-submit"]')!);
    const alert = await screen.findByTestId('axes-error');
    expect(alert.textContent).toBe('forbidden: space admin required');
    expect(tasksUsing).not.toHaveBeenCalled();
  });
});
