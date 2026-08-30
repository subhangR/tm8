// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, within } from '@testing-library/react';
import type { ActionContext } from '../domain';
import { FIXTURE_SPACE_ID, fixtureDetails, taskUuidTitle } from '../fixtures';
import {
  EntityDetailPanel,
  type ControlHost,
  type DetailReasons,
} from './index';

const REASONS: DetailReasons = {
  presenceHollow: 'Presence is not measured yet.',
  versionHistory: 'Version history is deferred.',
  provenanceHollow: 'Session provenance is not recorded yet.',
  shareUnavailable: 'Sharing is not available in this fixture.',
  withdrawUnavailable: 'Withdrawing is not available in this fixture.',
};

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

function detail() {
  const task = fixtureDetails[taskUuidTitle.id];
  if (!task) throw new Error('task fixture must include a detail');
  return task;
}

function controls(): ControlHost {
  const task = detail();
  return {
    kind: task.kind,
    ctx,
    capabilitiesOf: () => task.capabilities,
    onSetState: vi.fn(),
    onSetValue: vi.fn(),
    onAssign: vi.fn(),
    onArchive: vi.fn(),
    assignableActors: [],
  };
}

describe('premium task detail — one coherent surface', () => {
  it('composes identity, tabs, live metadata, brief, progress, and run state in task order', () => {
    const view = render(
      <div className="cv2-root">
        <EntityDetailPanel
          detail={detail()}
          reasons={REASONS}
          ctx={ctx}
          controls={controls()}
          livenessOf={() => 'live'}
          onAction={vi.fn()}
          wiredActions={['add-child']}
        />
      </div>,
    );

    const panel = view.getByTestId('entity-detail-panel');
    expect(panel.getAttribute('data-archetype')).toBe('subtree');
    expect(panel.getAttribute('data-panel-tab')).toBe('content');
    expect(within(panel).getByTestId('panel-header').textContent).toContain(detail().title);
    expect(within(within(panel).getByTestId('panel-tabs')).getAllByRole('tab')).toHaveLength(3);
    expect(within(panel).getByTestId('panel-toolbar').contains(within(panel).getByTestId('panel-action-bar'))).toBe(true);
    expect(panel.querySelector('.pn-controls__measure .lp__rowdetail--chips')).not.toBeNull();
    const controlGroup = within(panel).getByRole('group', { name: 'Controls' });
    expect(controlGroup.firstElementChild?.classList.contains('lp__rowdetail--chips')).toBe(true);
    const points = within(controlGroup).getByTestId('row-number-input');
    expect(points.getAttribute('placeholder')).toBe('points');
    expect(within(controlGroup).getAllByTestId('row-date-input')).toHaveLength(2);
    expect(controlGroup.querySelector('[data-source="priority"]')).not.toBeNull();

    const unavailableSave = within(panel).getByRole('button', { name: 'Save' });
    expect(unavailableSave.getAttribute('aria-disabled')).toBe('true');
    const reasonId = unavailableSave.getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    expect(reasonId ? view.container.ownerDocument.getElementById(reasonId)?.textContent : '').toMatch(
      /saving is not wired/i,
    );

    /*
     * THE DESCRIPTION CARD MUST NOT CLIP ITSELF. This pinned `k-hero` and
     * `k-accent-top`; both were removed 2026-08-29 on the owner's ruling, and
     * `k-accent-top` turned out to be a layout defect rather than decoration.
     * It CARRIED `overflow: hidden` (retired in #554, so this half is now
     * archaeology), which costs a flex item its content-based automatic
     * minimum size (Flexbox §4.5), and this card is a flex item in
     * `.sb-body` — a fixed-height scrolling column. Measured against prod
     * `6423d07d`: the card rendered 32px tall around 282px of description and
     * clipped every pixel of it with no way to scroll.
     *
     * jsdom cannot measure that, so the guard is on the mechanism: no clipping
     * utility on this card. The shared panels.css card rule supplies the
     * `flex-shrink: 0` half.
     */
    const description = within(panel).getByTestId('task-description-editor');
    expect(description.className).not.toContain('k-accent-top');
    expect(description.className).not.toContain('k-hero');

    const progress = within(panel).getByTestId('acceptance-progress');
    expect(progress.getAttribute('data-state')).toBe('in-progress');
    expect(within(progress).getByRole('progressbar')).toBeTruthy();

    const acceptance = within(panel).getByTestId('acceptance-section');
    const runs = within(panel).getByTestId('runs-section');
    expect(
      acceptance.compareDocumentPosition(runs) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(runs).getByTestId('live-session-section').textContent).toContain('Live now');
  });

  it('frames the shared feed as an accessible discussion timeline without replacing it', () => {
    const surface = (
      <section className="chs-root" data-testid="shared-discussion-surface">
        <div className="chs-row chs-row--activity">Priority changed to high</div>
        <div className="chs-composer">Composer</div>
      </section>
    );
    const view = render(
      <div className="cv2-root">
        <EntityDetailPanel
          detail={detail()}
          reasons={REASONS}
          ctx={ctx}
          activeTab="discussion"
          discussionSurface={surface}
        />
      </div>,
    );

    const panel = view.getByTestId('entity-detail-panel');
    expect(panel.getAttribute('data-panel-tab')).toBe('discussion');
    const tabpanel = view.getByRole('tabpanel', { name: /Discussion/i });
    expect(tabpanel).toBe(view.getByTestId('task-discussion'));
    expect(tabpanel.textContent).toContain('Decisions, updates, and activity');
    expect(tabpanel.textContent).toContain('Shared timeline');
    expect(within(tabpanel).getByTestId('shared-discussion-surface')).toBeTruthy();
    expect(tabpanel.querySelector('.chs-row--activity')).not.toBeNull();
    expect(tabpanel.querySelector('.chs-composer')).not.toBeNull();
  });

  it('keeps task chrome and archetype scope around loading and error states', () => {
    const loading = render(
      <div className="cv2-root">
        <EntityDetailPanel detail={detail()} reasons={REASONS} ctx={ctx} loading />
      </div>,
    );
    const loadingPanel = loading.getByTestId('entity-detail-panel');
    expect(loadingPanel.getAttribute('data-archetype')).toBe('subtree');
    expect(within(loadingPanel).getByTestId('panel-loading').getAttribute('aria-busy')).toBe('true');
    expect(within(loadingPanel).getByTestId('panel-header')).toBeTruthy();
    loading.unmount();

    const failed = render(
      <div className="cv2-root">
        <EntityDetailPanel
          detail={detail()}
          reasons={REASONS}
          ctx={ctx}
          error="fixture read failed"
        />
      </div>,
    );
    const failedPanel = failed.getByTestId('entity-detail-panel');
    expect(within(failedPanel).getByTestId('panel-error').textContent).toContain('fixture read failed');
    expect(within(failedPanel).getByTestId('panel-tabs')).toBeTruthy();
  });

  it('ships task-local container, theme, motion, contrast, focus, and overflow laws', () => {
    const css = readFileSync(join(process.cwd(), 'src/panels/task-detail.css'), 'utf8');

    expect(css).toContain(".pn-panel[data-archetype='subtree']");
    expect(css).toContain('container: task-detail / inline-size');
    expect(css).toContain('@container task-detail (max-width: 840px)');
    expect(css).toContain('@container task-detail (max-width: 640px)');
    expect(css).toContain('@container task-detail (max-width: 420px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('flex-wrap: nowrap');
    expect(css).toContain('overflow-x: auto');
    expect(css).toContain('min-inline-size: 92px');
    expect(css).toContain('font-family: var(--pn-ui)');
    expect(css).toContain('padding-inline: 0');
    expect(css).not.toMatch(/\b(?:d?vh|d?vw)\b/);
    expect(css).not.toMatch(/#[\da-f]{3,8}/i);
  });
});
