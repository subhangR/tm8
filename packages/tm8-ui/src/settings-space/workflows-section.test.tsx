// @vitest-environment jsdom
/**
 * W4 — Settings > Workflows, asserted at the AxesSection bar: real rows per
 * `type` value, the structural three locked with the schema's reason, save
 * writes the WHOLE vocabulary, delete is widen-back with honest copy, and
 * every server refusal is surfaced verbatim — never predicted, never
 * rewritten.
 */
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach } from 'vitest';
import type { TaskAxis, TaskWorkflow } from '@tm8/contract';
import { WorkflowsSection } from './WorkflowsSection';

afterEach(cleanup);

const TYPE_AXIS: TaskAxis = {
  id: 'axis-type',
  spaceId: 'specimen-space' as never,
  name: 'type',
  axisValues: ['default', 'code'],
  kind: 'default',
  position: 0,
};

const CODE_RULE: TaskWorkflow = {
  id: 'wf-code',
  spaceId: 'specimen-space' as never,
  typeValue: 'code',
  statuses: ['open', 'working', 'in_review', 'done'] as never,
};

const noop = async () => undefined;

describe('W4 — Settings > Workflows', () => {
  it('draws one editor per declared type value, naming ruled and unruled honestly', () => {
    render(
      <WorkflowsSection axes={[TYPE_AXIS]} workflows={[CODE_RULE]} onUpsert={noop} onDelete={noop} />,
    );
    const rows = screen.getAllByTestId('workflow-row');
    expect(rows).toHaveLength(2);
    // `default` has no rule and says so — a measured absence, not a fabricated rule.
    expect(within(rows[0]!).getByTestId('workflow-summary').textContent).toMatch(/no rule — all statuses allowed/);
    expect(within(rows[1]!).getByTestId('workflow-summary').textContent).toBe('allows 4 of 7');
  });

  it('the structural three are locked checkboxes carrying the schema reason; the narrowable four are live', () => {
    render(<WorkflowsSection axes={[TYPE_AXIS]} workflows={[]} onUpsert={noop} onDelete={noop} />);
    const row = screen.getAllByTestId('workflow-row')[1]!;
    for (const structural of ['open', 'working', 'done']) {
      const box = within(row).getByLabelText(new RegExp(`^${structural} is structural`)) as HTMLInputElement;
      expect(box.disabled).toBe(true);
      expect(box.checked).toBe(true);
      expect(box.getAttribute('title')).toMatch(/structural — every workflow must keep open, working and done/);
    }
    for (const narrowable of ['pulled', 'in review', 'blocked', 'cancelled']) {
      const box = within(row).getByLabelText(`code allows ${narrowable}`) as HTMLInputElement;
      expect(box.disabled).toBe(false);
    }
  });

  it('save writes the WHOLE vocabulary — structural three plus the checked narrowables', async () => {
    const writes: unknown[] = [];
    render(
      <WorkflowsSection
        axes={[TYPE_AXIS]}
        workflows={[]}
        onUpsert={async (input) => {
          writes.push(input);
        }}
        onDelete={noop}
      />,
    );
    const row = screen.getAllByTestId('workflow-row')[1]!;
    // Uncheck three of the narrowable four; keep in_review.
    for (const drop of ['pulled', 'blocked', 'cancelled']) {
      fireEvent.click(within(row).getByLabelText(`code allows ${drop}`));
    }
    fireEvent.click(within(row).getByTestId('workflow-save'));
    await screen.findAllByTestId('workflow-save');

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      typeValue: 'code',
      statuses: ['open', 'working', 'in_review', 'done'],
    });
  });

  it('delete exists only where a rule exists, and its copy says widen-back, never data loss', async () => {
    const deleted: string[] = [];
    render(
      <WorkflowsSection
        axes={[TYPE_AXIS]}
        workflows={[CODE_RULE]}
        onUpsert={noop}
        onDelete={async (id) => {
          deleted.push(id);
        }}
      />,
    );
    const rows = screen.getAllByTestId('workflow-row');
    expect(within(rows[0]!).queryByTestId('workflow-delete')).toBeNull();
    const del = within(rows[1]!).getByTestId('workflow-delete');
    expect(rows[1]!.textContent).toMatch(/widens code back to every status — never data loss/);
    fireEvent.click(del);
    await screen.findAllByTestId('workflow-row');
    expect(deleted).toEqual(['wf-code']);
  });

  it('a server refusal is surfaced VERBATIM as an alert', async () => {
    render(
      <WorkflowsSection
        axes={[TYPE_AXIS]}
        workflows={[]}
        onUpsert={async () => {
          throw new Error('space admin required');
        }}
        onDelete={noop}
      />,
    );
    fireEvent.click(screen.getAllByTestId('workflow-save')[0]!);
    const alert = await screen.findByTestId('workflows-error');
    expect(alert.textContent).toBe('space admin required');
  });

  it('a rule for a value the axis no longer declares is shown INERT, still deletable', () => {
    const stray: TaskWorkflow = { ...CODE_RULE, id: 'wf-stray', typeValue: 'retired' };
    render(
      <WorkflowsSection axes={[TYPE_AXIS]} workflows={[stray]} onUpsert={noop} onDelete={noop} />,
    );
    const rows = screen.getAllByTestId('workflow-row');
    const strayRow = rows.find((r) => r.textContent?.includes('retired'))!;
    expect(strayRow.textContent).toMatch(/not a declared type value — this rule is inert/);
    expect(within(strayRow).getByTestId('workflow-delete')).toBeTruthy();
  });

  it('unread is unread, and a space with no type axis says what is missing', () => {
    render(<WorkflowsSection axes={[TYPE_AXIS]} workflows={null} onUpsert={noop} onDelete={noop} />);
    expect(screen.getByTestId('workflows-absent').textContent).toMatch(/has not been read/);
    cleanup();
    render(<WorkflowsSection axes={[]} workflows={[]} onUpsert={noop} onDelete={noop} />);
    expect(screen.getByTestId('workflows-no-axis').textContent).toMatch(/no type axis/);
  });
});
