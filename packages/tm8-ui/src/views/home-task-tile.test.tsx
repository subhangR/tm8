// @vitest-environment jsdom
/**
 * HomeTaskTile — the workspace task tile reused on Home's Tasks tab (user
 * ruling 2026-08-16). What these cases pin:
 *
 *  - it IS the workspace anatomy (`pn-tt`, `data-anatomy="control-card"`)
 *    with the registry-projected status word, not a re-drawn copy;
 *  - the expand mounts the D67 `EntityControlStrip`, so the STATUS IS
 *    CHANGEABLE from Home exactly as it is from the workspace list;
 *  - Run rides the action cluster (hover-revealed by the tile's own CSS)
 *    and goes straight to the host's launch sheet.
 */
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HomeTaskTile } from './HomeTaskTile';
import { getKind } from '../domain';
import type { ControlHost } from '../panels/controls/EntityControls';
import { taskUuidTitle } from '../fixtures/entities';

const TASK_KIND = getKind('task');

const CAN_EVERYTHING = {
  canEdit: true,
  canDelete: true,
  canAddChild: true,
  canLink: true,
  canPull: true,
  canReact: true,
  canGrantPoints: true,
  canComplete: true,
};

function makeControls(over: Partial<ControlHost> = {}): ControlHost {
  return {
    kind: TASK_KIND.kind,
    ctx: { spaceId: 'sp-atelier' },
    capabilitiesOf: () => CAN_EVERYTHING,
    ...over,
  };
}

function renderTile(over: Partial<Parameters<typeof HomeTaskTile>[0]> = {}) {
  return render(
    <HomeTaskTile
      row={taskUuidTitle}
      config={TASK_KIND}
      controls={makeControls()}
      selected={false}
      streaming={false}
      onSelect={() => {}}
      {...over}
    />,
  );
}

describe('HomeTaskTile — the workspace tile on Home', () => {
  it('mounts the REAL workspace anatomy with the registry-projected status', () => {
    const view = renderTile();
    const tile = view.getByTestId('list-tile');
    expect(tile.getAttribute('data-anatomy')).toBe('control-card');
    // taskUuidTitle's workStatus is in_review — the projection's word, not
    // a Home-local copy of the vocabulary.
    expect(tile.textContent).toContain('in review');
  });

  it('the expand mounts the D67 control strip — the status is changeable here', () => {
    const view = renderTile();
    // Collapsed: no strip.
    expect(view.container.querySelector('.lp__rowdetail')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: /Expand details/ }));
    // Expanded: the ONE state/priority/assign/archive strip, chips layout.
    expect(view.container.querySelector('.lp__rowdetail--chips')).not.toBeNull();
  });

  it('Run lives in the action cluster and opens the host launch sheet directly', () => {
    const onOpenLaunch = vi.fn();
    const view = renderTile({ onOpenLaunch });
    const run = view.getByRole('button', { name: /run/i });
    fireEvent.click(run);
    expect(onOpenLaunch).toHaveBeenCalledWith(taskUuidTitle.id);
  });

  it('selecting the tile is the row gesture, not the expand', () => {
    const onSelect = vi.fn();
    const view = renderTile({ onSelect });
    fireEvent.click(view.getByRole('button', { name: taskUuidTitle.title }));
    expect(onSelect).toHaveBeenCalled();
  });
});
