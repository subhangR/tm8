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

/**
 * THE LAYOUT PASS (settings frame wave, 2026-08-16). Each of these holds one
 * defect that was MEASURED in real Chrome against the real stylesheets before
 * it was fixed — see the component header for the numbers. They are written
 * against structure and copy rather than pixels on purpose: jsdom loads no
 * stylesheets, so a vitest can pin WHAT is rendered and WHETHER it is
 * reachable, and nothing about how it looks. The looking was done separately,
 * per SECTION-CONTRACT.md §8.
 */
describe('W4 — Settings > Workflows, the layout contract', () => {
  it('is one SectionFrame: one section root, one scroller, and the measure wrapper', () => {
    const { container } = render(
      <WorkflowsSection axes={[TYPE_AXIS]} workflows={[CODE_RULE]} onUpsert={noop} onDelete={noop} />,
    );
    // Before this pass the component returned a bare fragment and there was NO
    // `.set-section` at all — `querySelector('.set-section')` was null in every
    // state, so the head and scroller were adopted by `.set-body` directly.
    expect(container.querySelectorAll('.set-section')).toHaveLength(1);
    expect(container.querySelectorAll('.set-section__head')).toHaveLength(1);
    // §3: ONE scroller. Two nested and the inner one is silently clipped.
    expect(container.querySelectorAll('.set-section__scroll')).toHaveLength(1);
    // §2: the measure wrapper, which was likewise absent — the intro prose ran
    // the full card width.
    expect(container.querySelectorAll('.set-section__measure')).toHaveLength(1);
    // The heading comes from SETTINGS_SECTIONS, not a re-typed copy.
    expect(container.querySelector('.set-section__title')?.textContent).toBe('Workflows');
  });

  /**
   * The defect this section had and no sibling could: it reads TWO registries,
   * and answered a partial read with a sentence that was false about the one
   * that HAD arrived — then rendered nothing, so a stored rule could be neither
   * seen nor removed.
   */
  it('an unread AXIS registry names the axis, keeps the rules that DID arrive, and keeps them deletable', async () => {
    const deleted: string[] = [];
    render(
      <WorkflowsSection
        axes={null}
        workflows={[CODE_RULE]}
        onUpsert={noop}
        onDelete={async (id) => {
          deleted.push(id);
        }}
      />,
    );
    // NOT "the workflow registry has not been read" — it had been.
    expect(screen.queryByTestId('workflows-absent')).toBeNull();
    const absent = screen.getByTestId('workflows-axes-absent');
    expect(absent.textContent).toMatch(/type axis has not been read/);
    expect(absent.textContent).toMatch(/rules themselves DID arrive/);

    const row = screen.getByTestId('workflow-row');
    expect(row.getAttribute('data-standing')).toBe('unverifiable');
    // It does not claim the rule is inert — with the axis unread, whether it is
    // in force is not knowable, and saying "inert" would state a fact this
    // render does not have.
    expect(row.textContent).toMatch(/not knowable here/);
    expect(row.textContent).not.toMatch(/not a declared type value/);

    fireEvent.click(within(row).getByTestId('workflow-delete'));
    await screen.findByTestId('workflow-row');
    expect(deleted).toEqual(['wf-code']);
  });

  it('a space whose type axis is gone still shows its stranded rules instead of hiding them', () => {
    render(<WorkflowsSection axes={[]} workflows={[CODE_RULE]} onUpsert={noop} onDelete={noop} />);
    expect(screen.getByTestId('workflows-no-axis')).toBeTruthy();
    const row = screen.getByTestId('workflow-row');
    expect(row.getAttribute('data-standing')).toBe('inert');
    expect(within(row).getByTestId('workflow-delete')).toBeTruthy();
  });

  it('an axis that declares no values gets a real empty state, not a blank pane', () => {
    render(
      <WorkflowsSection
        axes={[{ ...TYPE_AXIS, axisValues: [] }]}
        workflows={[]}
        onUpsert={noop}
        onDelete={noop}
      />,
    );
    // It used to render the intro prose and then nothing at all — measured as a
    // 541px-tall empty body at 900x600.
    const absent = screen.getByTestId('workflows-no-values');
    expect(absent.textContent).toMatch(/declares no values/);
    expect(absent.textContent).toMatch(/free text/);
    expect(screen.queryAllByTestId('workflow-row')).toHaveLength(0);
  });

  /**
   * The order, shown. A workflow is a SET — 132's `statuses <@ array[...]` and
   * the trigger's `work_status <> all (vocab)` — so what is ordered is the
   * seven-status LIFECYCLE it draws from, and the ordinal a status carries is
   * its position in THAT, held true across both groups rather than renumbered
   * per group.
   */
  it('groups the locked three away from the narrowable four, each keeping its true lifecycle ordinal', () => {
    const { container } = render(
      <WorkflowsSection axes={[TYPE_AXIS]} workflows={[CODE_RULE]} onUpsert={noop} onDelete={noop} />,
    );
    const row = screen.getAllByTestId('workflow-row')[1]!;
    const groups = row.querySelectorAll('.set-workflows__group');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.textContent).toMatch(/Always allowed/);
    expect(groups[1]!.textContent).toMatch(/may also be moved to/);

    // Every structural box lives in the first group, every narrowable in the
    // second — the flat wrap this replaces put all seven in one row where the
    // only difference was a greyed tick.
    for (const id of ['open', 'working', 'done']) {
      expect(within(groups[0] as HTMLElement).getByLabelText(new RegExp(`^${id} is structural`))).toBeTruthy();
    }
    for (const label of ['pulled', 'in review', 'blocked', 'cancelled']) {
      expect(within(groups[1] as HTMLElement).getByLabelText(`code allows ${label}`)).toBeTruthy();
    }

    const ords = [...container.querySelectorAll('.set-workflows__ord')].map((n) => n.textContent);
    // open=1 working=3 done=6 | pulled=2 in_review=4 blocked=5 cancelled=7 —
    // NOT 1,2,3 | 1,2,3,4.
    expect(ords.slice(0, 7)).toEqual(['1', '3', '6', '2', '4', '5', '7']);

    // The resulting vocabulary, written out in lifecycle order.
    expect(within(row).getByTestId('workflow-path').textContent).toBe('open·working·in review·done');
  });

  it('the vocabulary line follows the draft as boxes are toggled', () => {
    render(<WorkflowsSection axes={[TYPE_AXIS]} workflows={[CODE_RULE]} onUpsert={noop} onDelete={noop} />);
    const row = screen.getAllByTestId('workflow-row')[1]!;
    fireEvent.click(within(row).getByLabelText('code allows blocked'));
    // `blocked` is 5th in the lifecycle, so it lands between in_review and done
    // rather than on the end — the write is normalised the same way.
    expect(within(row).getByTestId('workflow-path').textContent).toBe(
      'open·working·in review·blocked·done',
    );
  });

  /**
   * A live primary over a no-op write teaches a user to distrust the button.
   * With NO rule it stays live, because creating a rule that allows all seven
   * is a different stored state from having no rule at all, and this is the
   * only door to it.
   */
  it('Save is quiet when a stored rule already matches its draft, and live again once it does not', () => {
    render(<WorkflowsSection axes={[TYPE_AXIS]} workflows={[CODE_RULE]} onUpsert={noop} onDelete={noop} />);
    const [unruled, ruled] = screen.getAllByTestId('workflow-row') as [HTMLElement, HTMLElement];

    const ruledSave = within(ruled).getByTestId('workflow-save') as HTMLButtonElement;
    expect(ruledSave.disabled).toBe(true);
    expect(ruledSave.getAttribute('title')).toMatch(/already allows exactly these statuses/);

    // No rule at all: always live.
    expect((within(unruled).getByTestId('workflow-save') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(within(ruled).getByLabelText('code allows blocked'));
    expect((within(ruled).getByTestId('workflow-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('the head counts how many declared values are actually narrowed', () => {
    render(<WorkflowsSection axes={[TYPE_AXIS]} workflows={[CODE_RULE]} onUpsert={noop} onDelete={noop} />);
    expect(screen.getByTestId('workflows-count').textContent).toBe('1 of 2 narrowed');
  });
});
