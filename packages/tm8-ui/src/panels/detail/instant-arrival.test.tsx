// @vitest-environment jsdom
/**
 * A RECORD NEW JUST MADE LANDS WITH ITS TITLE SELECTED (Kalai, 2026-10-07:
 * "the new task detail screen, with the title selected"). Through the panel,
 * in the Workspace's title band, for a `createInstant: 'title'` kind.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CommandResult, EntityDetail, EntityId, PatchTaskInput } from '@tm8/contract';
import { REASONS as DOMAIN_REASONS, type ActionContext } from '../../domain';
import { FIXTURE_SPACE_ID, fixtureDetails, presenceHollowReason, taskUuidTitle } from '../../fixtures';
import { emptyFreshDocs, forgetFreshDoc, markFreshDoc, useLiveTitle } from '../../doc-edit';
import { EntityDetailPanel, type DetailReasons } from '../index';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const REASONS: DetailReasons = {
  presenceHollow: presenceHollowReason,
  versionHistory: DOMAIN_REASONS.versionHistoryDeferred,
  provenanceHollow: 'Session provenance is not recorded yet.',
  shareUnavailable: 'not in the stamped seam',
  withdrawUnavailable: 'not in the stamped seam',
};
const PLACEHOLDER = 'Untitled task';
const TASK: EntityDetail = { ...fixtureDetails[taskUuidTitle.id]!, title: PLACEHOLDER };

function TabLabel() {
  return <span data-testid="tab-label">{useLiveTitle(TASK.id) ?? TASK.title}</span>;
}

function mount() {
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  const patchTask = vi.fn((_id: EntityId, _input: PatchTaskInput) => Promise.resolve({} as CommandResult));
  const view = render(
    <div className="cv2-root">
      <TabLabel />
      <EntityDetailPanel
        detail={TASK}
        reasons={REASONS}
        ctx={ctx}
        commands={{ createEntity: vi.fn(), patchTask }}
        embeddedChrome={{
          verbsSlot: null,
          kindSlot: null,
          commonVerbsSlot: null,
          statsSlot: null,
          menuSlot: null,
          dangerSlot: null,
          titleSlot: slot,
        }}
      />
    </div>,
  );
  return { patchTask, view, slot };
}

afterEach(() => {
  cleanup();
  forgetFreshDoc(TASK.id);
  document.body.innerHTML = '';
});

describe('a record New just made', () => {
  it('lands with its placeholder title selected, and records the version it arrived at', () => {
    markFreshDoc(TASK.id, PLACEHOLDER);
    mount();
    const field = screen.getByTestId('panel-embedded-title-input') as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe(PLACEHOLDER);
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, PLACEHOLDER.length]);
    expect(emptyFreshDocs()).toEqual([{ id: TASK.id, version: TASK.version }]);
  });

  it('typing names it: the tab follows, it stops being empty, and Enter saves the title', async () => {
    markFreshDoc(TASK.id, PLACEHOLDER);
    const { patchTask } = mount();
    const field = screen.getByTestId('panel-embedded-title-input');
    fireEvent.change(field, { target: { value: 'Fix the login redirect' } });
    expect(screen.getByTestId('tab-label').textContent).toBe('Fix the login redirect');
    expect(emptyFreshDocs()).toEqual([]);
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(patchTask).toHaveBeenCalledTimes(1);
    expect(patchTask.mock.calls[0]![1]).toMatchObject({ title: 'Fix the login redirect', expectedVersion: TASK.version });
  });

  it('a name typed but never entered is saved when the tab closes under it', () => {
    markFreshDoc(TASK.id, PLACEHOLDER);
    const { patchTask, view } = mount();
    fireEvent.change(screen.getByTestId('panel-embedded-title-input'), { target: { value: 'Half a thought' } });
    view.unmount();
    expect(patchTask).toHaveBeenCalledTimes(1);
    expect(patchTask.mock.calls[0]![1]).toMatchObject({ title: 'Half a thought' });
  });

  it('any other record opens with its title as text, as before', () => {
    mount();
    expect(screen.queryByTestId('panel-embedded-title-input')).toBeNull();
    expect(screen.getByTestId('panel-embedded-title').textContent).toBe(PLACEHOLDER);
  });
});
