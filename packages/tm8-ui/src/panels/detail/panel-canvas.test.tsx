// @vitest-environment jsdom
/**
 * THE CANVAS PANEL — `composition: 'canvas'` (task 01a101c5, the story view).
 *
 * jsdom has no layout, so nothing here proves the graph reaches the top edge
 * or fills the panel — that was checked in pixels (PR body). What this file
 * pins is the structure a screenshot cannot separate from a lucky render:
 * the title row, the tab row and the attach strip are ABSENT for a canvas
 * kind and PRESENT for an ordinary one (both directions, so a removal that
 * leaked to every kind fails here); the verbs survive, floating; the
 * messages ride the body as a section; and no tab can be selected past it.
 */
import { describe, expect, it } from 'vitest';
import { render, within } from '@testing-library/react';
import type { EntityDetail } from '@tm8/contract';
import { REASONS as DOMAIN_REASONS, getKind, type ActionContext } from '../../domain';
import { FIXTURE_SPACE_ID, fixtureDetails, presenceHollowReason, storyAsAnEntity, taskUuidTitle } from '../../fixtures';
import { EntityDetailPanel, type DetailReasons } from '../index';
import { panelMenuItems } from './chrome';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const REASONS: DetailReasons = {
  presenceHollow: presenceHollowReason,
  versionHistory: DOMAIN_REASONS.versionHistoryDeferred,
  provenanceHollow: 'Session provenance is not recorded yet.',
  shareUnavailable: 'not in the stamped seam',
  withdrawUnavailable: 'not in the stamped seam',
};
const STORY: EntityDetail = fixtureDetails[storyAsAnEntity.id]!;
const TASK: EntityDetail = fixtureDetails[taskUuidTitle.id]!;

function panel(detail: EntityDetail, over: Partial<Parameters<typeof EntityDetailPanel>[0]> = {}) {
  return render(
    <EntityDetailPanel
      detail={detail}
      reasons={REASONS}
      ctx={ctx}
      onAction={() => {}}
      onClose={() => {}}
      discussionSurface={<p data-testid="thread">the thread</p>}
      attachments={{ startUpload: () => Promise.reject(new Error('unused')) } as never}
      {...over}
    />,
  );
}

describe('a canvas panel starts at its body', () => {
  it('the story is declared a canvas in the registry', () => {
    expect(getKind('story').panel.composition).toBe('canvas');
  });

  it('draws no title row, no tab row and no attach strip — the verbs float instead', () => {
    const { container, queryByTestId, getByTestId } = panel(STORY);
    expect(queryByTestId('panel-header')).toBeNull();
    expect(queryByTestId('panel-tabs')).toBeNull();
    expect(queryByTestId('attachment-strip')).toBeNull();
    expect(queryByTestId('panel-footer')).toBeNull();
    expect(container.querySelector('.pn-panel--canvas')).toBeTruthy();
    const bar = getByTestId('panel-canvas-bar');
    expect(within(bar).getByRole('button', { name: /close/i })).toBeTruthy();
    expect(within(bar).getByTestId('panel-action-bar')).toBeTruthy();
  });

  it('floats the story header over the graph and mounts the messages as a section', () => {
    const { getByTestId } = panel(STORY);
    const float = getByTestId('story-graph-float');
    expect(within(float).getByTestId('story-header')).toBeTruthy();
    expect(within(getByTestId('story-messages')).getByTestId('thread')).toBeTruthy();
  });

  it('a host still holding another tab gets the story, not that tab', () => {
    // As the Messages tab body the thread would REPLACE the story page; as the
    // section it sits inside it, exactly once.
    const { getByTestId, getAllByTestId } = panel(STORY, { activeTab: 'discussion' });
    expect(getByTestId('story-page')).toBeTruthy();
    expect(getAllByTestId('thread')).toHaveLength(1);
    expect(getByTestId('story-messages').contains(getByTestId('thread'))).toBe(true);
  });

  it('an ordinary kind keeps its title row, tabs and attach strip, and no messages section', () => {
    const { getByTestId, queryByTestId } = panel(TASK);
    expect(getByTestId('panel-header')).toBeTruthy();
    expect(getByTestId('panel-tabs')).toBeTruthy();
    expect(getByTestId('attachment-strip')).toBeTruthy();
    expect(queryByTestId('panel-canvas-bar')).toBeNull();
    expect(queryByTestId('story-messages')).toBeNull();
  });

  it("the phone's action menu offers no tab rows for a canvas kind", () => {
    const rows = (kind: string) =>
      panelMenuItems({ config: getKind(kind), ctx, onSelectTab: () => {}, onAction: () => {} }).map((r) => r.id);
    expect(rows('story')).not.toContain('connections');
    expect(rows('story')).not.toContain('discussion');
    expect(rows('task')).toContain('connections');
    expect(rows('task')).toContain('discussion');
  });
});
