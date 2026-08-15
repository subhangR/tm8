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
    expect(rows[0]!.textContent).toContain('default · code · design · review · test');
    expect(rows[0]!.textContent).toContain('seeded');
    expect(rows[1]!.textContent).toContain('size');
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
