// @vitest-environment jsdom
/**
 * THE TASK PAGE (task 01a1163a, mockup r6): on the Workspace page a
 * `panel.layout: 'two-column'` kind draws its writing in a main column and its
 * properties in a rail, edits its title in place, and writes each checklist
 * gesture and the estimate as it happens — no Edit dialog, no staged Save.
 *
 * Through the panel, embedded, because every one of those is a decision the
 * PANEL makes from the registry and the host; the body only draws what it is
 * handed.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import type { AcceptanceCriterion, CommandResult, EntityDetail, EntityId, PatchTaskInput } from '@tm8/contract';
import { AUTOSAVE_DELAY_MS } from '../../doc-edit';
import { REASONS as DOMAIN_REASONS, type ActionContext } from '../../domain';
import { FIXTURE_SPACE_ID, fixtureDetails, presenceHollowReason, taskUuidTitle } from '../../fixtures';
import { EntityDetailPanel, type DetailReasons } from '../index';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const REASONS: DetailReasons = {
  presenceHollow: presenceHollowReason,
  versionHistory: DOMAIN_REASONS.versionHistoryDeferred,
  provenanceHollow: 'Session provenance is not recorded yet.',
  shareUnavailable: 'not in the stamped seam',
  withdrawUnavailable: 'not in the stamped seam',
};
const BASE = fixtureDetails[taskUuidTitle.id]!;
const CRITERIA: AcceptanceCriterion[] = [
  { id: 'ac_1', text: 'Title is editable in place', done: true },
  { id: 'ac_2', text: 'Rail carries every property', done: false },
];
const TASK: EntityDetail = {
  ...BASE,
  title: 'Redesign the task page',
  content: { ...(BASE.content as object), acceptanceCriteria: CRITERIA, pointsEstimate: 3 } as EntityDetail['content'],
};

function mount(detail: EntityDetail = TASK, opts: { embedded?: boolean } = {}) {
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  const patchTask = vi.fn((_id: EntityId, _input: PatchTaskInput) => Promise.resolve({} as CommandResult));
  const view = render(
    <div className="cv2-root">
      <EntityDetailPanel
        detail={detail}
        reasons={REASONS}
        ctx={ctx}
        commands={{ createEntity: vi.fn(), patchTask }}
        {...(opts.embedded === false
          ? {}
          : {
              embeddedChrome: {
                verbsSlot: null,
                kindSlot: null,
                commonVerbsSlot: null,
                statsSlot: null,
                menuSlot: null,
                dangerSlot: null,
                titleSlot: slot,
              },
            })}
      />
    </div>,
  );
  return { patchTask, view, slot };
}

function lastPatch(patchTask: ReturnType<typeof mount>['patchTask']): PatchTaskInput {
  return patchTask.mock.calls.at(-1)![1];
}

/* Focusing the rich editor scrolls its selection into view, which measures a
   Range; jsdom draws nothing, so the Range measures nothing. */
beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  document.body.innerHTML = '';
});

/* The description is the shared rich editor; TipTap hangs itself off its node. */
const editorOf = () => (screen.getByTestId('doc-rich') as unknown as { editor: Editor }).editor;
const typeDescription = (value: string) =>
  act(() => {
    editorOf().commands.setContent(value, { contentType: 'markdown', emitUpdate: true });
  });
const withDescription = (description: string): EntityDetail => ({
  ...TASK,
  content: { ...(TASK.content as object), description } as EntityDetail['content'],
});

describe('the two-column page', () => {
  it('draws a main column and a properties rail, and no band above the body', () => {
    mount();
    const body = screen.getByTestId('subtree-body');
    expect(body.getAttribute('data-layout')).toBe('two-column');
    const main = screen.getByTestId('subtree-main');
    const rail = screen.getByTestId('subtree-rail');
    expect(within(main).getByTestId('task-description-editor')).toBeTruthy();
    expect(within(main).getByTestId('acceptance-section')).toBeTruthy();
    // The grid's facts moved into the rail; nothing is drawn above the writing.
    expect(within(rail).getByTestId('subtree-grid').className).toContain('sb-grid--rail');
    expect(within(main).queryByTestId('subtree-grid')).toBeNull();
    expect(screen.queryByTestId('panel-embedded-head')).toBeNull();
  });

  it('is a page layout only: a pinned panel keeps the stacked body', () => {
    mount(TASK, { embedded: false });
    expect(screen.getByTestId('subtree-body').getAttribute('data-layout')).toBeNull();
    expect(screen.queryByTestId('subtree-rail')).toBeNull();
  });

  it('edits the title in place, and Enter saves it', async () => {
    const { patchTask } = mount();
    const field = screen.getByTestId('panel-embedded-title-input') as HTMLInputElement;
    expect(field.value).toBe('Redesign the task page');
    fireEvent.change(field, { target: { value: 'Redesign the task detail page' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(patchTask).toHaveBeenCalledTimes(1);
    expect(lastPatch(patchTask)).toMatchObject({ title: 'Redesign the task detail page', expectedVersion: TASK.version });
  });

  it('writes the estimate on commit, and an emptied one as a clear', async () => {
    const { patchTask } = mount();
    const points = screen.getByTestId('subtree-points') as HTMLInputElement;
    expect(points.value).toBe('3');
    fireEvent.change(points, { target: { value: '5' } });
    await act(async () => {
      fireEvent.blur(points);
    });
    expect(lastPatch(patchTask)).toMatchObject({ pointsEstimate: 5 });
  });

  it('clears the estimate with an explicit null', async () => {
    const { patchTask } = mount();
    const points = screen.getByTestId('subtree-points') as HTMLInputElement;
    fireEvent.change(points, { target: { value: '' } });
    await act(async () => {
      fireEvent.blur(points);
    });
    expect(lastPatch(patchTask).pointsEstimate).toBeNull();
  });
});

describe('the checklist writes each gesture', () => {
  it('a tick is one write, with nothing staged behind a Save', async () => {
    const { patchTask } = mount();
    const rows = screen.getAllByTestId('acceptance-row');
    await act(async () => {
      fireEvent.click(within(rows[1]!).getByRole('checkbox'));
    });
    expect(patchTask).toHaveBeenCalledTimes(1);
    expect(lastPatch(patchTask).acceptanceCriteria?.map((c) => c.done)).toEqual([true, true]);
  });

  it('adds a criterion with a minted id the server will keep', async () => {
    const { patchTask } = mount();
    const add = screen.getByTestId('acceptance-add');
    fireEvent.change(add, { target: { value: 'Phone stacks the columns' } });
    await act(async () => {
      fireEvent.keyDown(add, { key: 'Enter' });
    });
    const next = lastPatch(patchTask).acceptanceCriteria!;
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({ id: 'ac_3', text: 'Phone stacks the columns', done: false });
    expect((add as HTMLInputElement).value).toBe('');
  });

  it('renames on blur, and an unchanged blur writes nothing', async () => {
    const { patchTask } = mount();
    const texts = screen.getAllByTestId('acceptance-text');
    await act(async () => {
      fireEvent.blur(texts[0]!);
    });
    expect(patchTask).not.toHaveBeenCalled();
    fireEvent.change(texts[1]!, { target: { value: 'The rail carries every property' } });
    await act(async () => {
      fireEvent.blur(texts[1]!);
    });
    expect(lastPatch(patchTask).acceptanceCriteria?.[1]).toMatchObject({
      id: 'ac_2',
      text: 'The rail carries every property',
    });
  });

  it('reorders with Alt+↓, keeping each id with its text', async () => {
    const { patchTask } = mount();
    await act(async () => {
      fireEvent.keyDown(screen.getAllByTestId('acceptance-text')[0]!, { key: 'ArrowDown', altKey: true });
    });
    expect(lastPatch(patchTask).acceptanceCriteria?.map((c) => c.id)).toEqual(['ac_2', 'ac_1']);
  });

  it('removes a criterion', async () => {
    const { patchTask } = mount();
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('acceptance-remove')[0]!);
    });
    expect(lastPatch(patchTask).acceptanceCriteria?.map((c) => c.id)).toEqual(['ac_2']);
  });
});

describe('the description is written in place', () => {
  it('is the rich editor, mounted with no Edit to cross and no chrome while reading', () => {
    mount(withDescription('## Plan\n\n- step one'));
    const block = screen.getByTestId('task-description-editor');
    expect(within(block).getByTestId('doc-rich')).toBeTruthy();
    expect(editorOf().getMarkdown()).toContain('- step one');
    expect(block.getAttribute('data-stance')).toBe('reading');
    expect(screen.queryByTestId('task-description-stance')).toBeNull();
    expect(within(block).queryByTestId('doc-save-word')).toBeNull();
  });

  it('saves a pause after typing, through patchTask, with the description alone', async () => {
    vi.useFakeTimers();
    const { patchTask } = mount(withDescription('old words'));
    typeDescription('new words');
    expect(screen.getByTestId('task-description-editor').getAttribute('data-stance')).toBe('writing');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    });
    expect(patchTask).toHaveBeenCalledTimes(1);
    expect(patchTask.mock.calls[0]![0]).toBe(TASK.id);
    expect(lastPatch(patchTask)).toEqual({ description: 'new words', expectedVersion: TASK.version });
  });

  it('opens a body the editor would not keep as markdown source, saying why', () => {
    mount(withDescription('<div align="center">kept as written</div>'));
    expect(screen.queryByTestId('doc-rich')).toBeNull();
    expect(screen.getByTestId('task-description-source-reason')).toBeTruthy();
  });

  it('keeps the stacked stance editor on a pinned panel', () => {
    mount(withDescription('words'), { embedded: false });
    expect(screen.queryByTestId('doc-rich')).toBeNull();
    expect(screen.getByTestId('task-description-stance')).toBeTruthy();
  });

  it('Enter in the title puts the caret in the description', async () => {
    mount();
    const field = screen.getByTestId('panel-embedded-title-input') as HTMLInputElement;
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(document.activeElement).toBe(screen.getByTestId('doc-rich'));
  });
});
