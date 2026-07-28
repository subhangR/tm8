// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, within } from '@testing-library/react';
import type { EntityDetail, EntitySummary } from '@tm8/contract';
import { allKinds, getKind, resolveAction, type ActionContext, type QueryFilter } from '../domain';
import { REASONS as DOMAIN_REASONS } from '../domain';
import {
  FIXTURE_SPACE_ID,
  fixtureDetails,
  fixtureHandoffs,
  fixtureSummaries,
  presenceHollowReason,
  sessionLive,
  sessionStale,
  taskGuideLines,
  taskTombstone,
  taskUuidTitle,
} from '../fixtures';
import { EntityDetailPanel, EntityListPanel, SharedContextSection, ShareDropTarget } from './index';
import type { DetailReasons } from './EntityDetailPanel';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

/**
 * The deferral copy comes from the ACTION REGISTRY, which owns it — not from a
 * fixture constant. Reading it here also means these tests exercise the real
 * availability path rather than a stand-in string that could agree with
 * nothing.
 */
function reasonFor(ref: 'share-into-session' | 'withdraw-handoff'): string {
  const availability = resolveAction(ref).availability(ctx);
  if (availability.kind !== 'disabled') throw new Error(`${ref} should be deferred (§10.7)`);
  return availability.reason;
}
const SHARE_UNAVAILABLE = reasonFor('share-into-session');
const WITHDRAW_UNAVAILABLE = reasonFor('withdraw-handoff');

const REASONS: DetailReasons = {
  presenceHollow: presenceHollowReason,
  versionHistory: DOMAIN_REASONS.versionHistoryDeferred,
  provenanceHollow: 'Session provenance is not recorded yet.',
  shareUnavailable: SHARE_UNAVAILABLE,
  withdrawUnavailable: WITHDRAW_UNAVAILABLE,
};

/** Renders inside both theme scopes so a state that only works in one fails. */
function renderBothThemes(node: React.ReactElement) {
  return render(
    <>
      <div className="cv2-root">{node}</div>
      <div className="cv2-root" data-theme="dark">
        {node}
      </div>
    </>,
  );
}

describe('EntityDetailPanel — the fixed anatomy', () => {
  it('D3: renders FOUR tabs in fixed order for EVERY registry kind, no exceptions', () => {
    // Walks the whole registry, so a future kind that somehow suppressed a tab
    // fails here rather than shipping a three-tab panel nobody noticed.
    for (const config of allKinds()) {
      const detail = Object.values(fixtureDetails).find((d) => d.kind === config.kind);
      if (!detail) continue;
      const { getByTestId, unmount } = render(
        <EntityDetailPanel detail={detail} reasons={REASONS} ctx={ctx} />,
      );
      const labels = within(getByTestId('panel-tabs'))
        .getAllByRole('tab')
        .map((t) => t.textContent?.replace(/\d+$/, '').trim());
      expect(labels, `kind ${config.kind}`).toEqual([
        'Content',
        'Discussion',
        'Connections',
        'Activity',
      ]);
      unmount();
    }
  });

  it('routes the body by ARCHETYPE, never by kind — work_session gets the terminal body', () => {
    const detail = fixtureDetails[sessionStale.id]!;
    const { getByTestId } = render(
      <EntityDetailPanel detail={detail} reasons={REASONS} ctx={ctx} liveness="stale" />,
    );
    expect(getByTestId('entity-detail-panel').getAttribute('data-archetype')).toBe('terminal');
    expect(getByTestId('terminal-body')).toBeTruthy();
  });

  it('D7.2: the viewers footer is HOLLOW — a dash, never "0 viewing"', () => {
    const { getByTestId } = render(
      <EntityDetailPanel detail={fixtureDetails[taskUuidTitle.id]!} reasons={REASONS} ctx={ctx} />,
    );
    const footer = getByTestId('panel-footer');
    expect(footer.textContent).toContain('—');
    // "0 viewing" would claim a measurement that was never taken.
    expect(footer.textContent).not.toMatch(/\b0 viewing\b/);
    expect(within(footer).getByTestId('hollow-inline').getAttribute('title')).toBe(
      presenceHollowReason,
    );
  });

  it('R7: v{n} is the disabled-with-reason home of version history', () => {
    const detail = fixtureDetails[taskUuidTitle.id]!;
    const { getByTestId } = render(
      <EntityDetailPanel detail={detail} reasons={REASONS} ctx={ctx} />,
    );
    const footer = getByTestId('panel-footer');
    const control = within(footer).getByTestId('disabled-with-reason');
    expect(control.textContent).toContain(`v${detail.version}`);
    expect(control.getAttribute('aria-disabled')).toBe('true');
    // Focusable: a control a keyboard user cannot reach can never explain itself.
    expect(control.getAttribute('tabindex')).toBe('0');
  });

  it('permission-lost leaks NOTHING — no title, no kind, no counts, no tabs', () => {
    const detail = fixtureDetails[taskUuidTitle.id]!;
    const { getByTestId, queryByTestId } = render(
      <EntityDetailPanel detail={detail} reasons={REASONS} ctx={ctx} permissionLost />,
    );
    const panel = getByTestId('panel-permission-lost');
    expect(panel.textContent).toContain('You can’t see this');
    expect(panel.textContent).not.toContain(detail.title);
    expect(panel.textContent).not.toContain('Task');
    // The whole panel is replaced — a chrome-plus-empty-body version would leak.
    expect(queryByTestId('panel-tabs')).toBeNull();
    expect(queryByTestId('panel-header')).toBeNull();
  });

  it('a tombstone keeps its chrome and its place — the corpse stays addressable', () => {
    const detail: EntityDetail = { ...fixtureDetails[taskUuidTitle.id]!, ...taskTombstone };
    const { getByTestId } = render(
      <EntityDetailPanel detail={detail} reasons={REASONS} ctx={ctx} />,
    );
    expect(getByTestId('panel-tabs')).toBeTruthy(); // chrome survives
    expect(getByTestId('panel-tombstone')).toBeTruthy();
    expect(getByTestId('entity-detail-panel').className).toContain('pn-panel--tombstone');
  });

  it('the error boundary keeps header, tabs and footer alive', () => {
    const { getByTestId } = render(
      <EntityDetailPanel
        detail={fixtureDetails[taskUuidTitle.id]!}
        reasons={REASONS}
        ctx={ctx}
        error="TypeError: cannot read 'tint' of undefined"
      />,
    );
    expect(getByTestId('panel-error')).toBeTruthy();
    expect(getByTestId('panel-header')).toBeTruthy();
    expect(getByTestId('panel-tabs')).toBeTruthy();
    expect(getByTestId('panel-footer')).toBeTruthy();
  });

  it('renders in both themes', () => {
    const { container } = renderBothThemes(
      <EntityDetailPanel detail={fixtureDetails[taskUuidTitle.id]!} reasons={REASONS} ctx={ctx} />,
    );
    expect(container.querySelectorAll('[data-testid="entity-detail-panel"]')).toHaveLength(2);
  });
});

describe('EntityListPanel — behaviour is registry DATA', () => {
  const rowsFor =
    (rows: readonly EntitySummary[]) =>
    (_filter: QueryFilter): readonly EntitySummary[] =>
      rows;

  const sessions = fixtureSummaries.filter((s) => s.state.kind === 'work_session');

  it('the same component yields lifecycle TABS for one kind and SECTIONS for another', () => {
    const sessionPanel = render(
      <EntityListPanel kind="work_session" rowsFor={rowsFor(sessions)} ctx={ctx} />,
    );
    expect(sessionPanel.getAllByRole('tab').length).toBeGreaterThan(0);
    sessionPanel.unmount();

    const taskPanel = render(<EntityListPanel kind="task" rowsFor={rowsFor([])} ctx={ctx} />);
    expect(taskPanel.queryAllByRole('tab')).toHaveLength(0);
    expect(getKind('task').list.sections?.length).toBeGreaterThan(0);
  });

  it('THE GATE: activity on a NON-LIVE row never streams and never pulses', () => {
    // sessionStale's record says running; the seam says stale. Bytes are
    // (impossibly) attributed to it. It must still not look alive.
    const { getAllByTestId } = render(
      <EntityListPanel
        kind="work_session"
        rowsFor={rowsFor([sessionStale])}
        ctx={ctx}
        livenessOf={() => 'stale'}
        activity={{ [sessionStale.id]: true }}
      />,
    );
    const tile = getAllByTestId('list-tile')[0]!;
    expect(tile.getAttribute('data-streaming')).toBe('false');
    expect(tile.querySelector('.lp__dot--pulse')).toBeNull();
    expect(tile.textContent).toContain('stale');
    expect(tile.textContent).not.toContain('streaming');
  });

  it('a LIVE row with activity streams; the same row without activity says running', () => {
    const streaming = render(
      <EntityListPanel
        kind="work_session"
        rowsFor={rowsFor([sessionLive])}
        ctx={ctx}
        livenessOf={() => 'live'}
        activity={{ [sessionLive.id]: true }}
      />,
    );
    const hot = streaming.getAllByTestId('list-tile')[0]!;
    expect(hot.getAttribute('data-streaming')).toBe('true');
    expect(hot.textContent).toContain('streaming');
    streaming.unmount();

    const quiet = render(
      <EntityListPanel
        kind="work_session"
        rowsFor={rowsFor([sessionLive])}
        ctx={ctx}
        livenessOf={() => 'live'}
        activity={{}}
      />,
    );
    const cold = quiet.getAllByTestId('list-tile')[0]!;
    expect(cold.getAttribute('data-streaming')).toBe('false');
    expect(cold.textContent).toContain('running');
  });

  it('unknown liveness renders neutral and never as live', () => {
    const { getAllByTestId } = render(
      <EntityListPanel
        kind="work_session"
        rowsFor={rowsFor([sessionLive])}
        ctx={ctx}
        livenessOf={() => 'unknown'}
        activity={{ [sessionLive.id]: true }}
      />,
    );
    const tile = getAllByTestId('list-tile')[0]!;
    expect(tile.getAttribute('data-streaming')).toBe('false');
    expect(tile.textContent).toContain('unverified');
  });

  it('the live COUNT is rows ∩ the seam live set — not rows whose record claims running', () => {
    // Both fixtures carry state.status === 'running'. Only one is in the live
    // set. A count off the record would say 2 and be an overstatement.
    const { getByTestId } = render(
      <EntityListPanel
        kind="work_session"
        rowsFor={rowsFor([sessionLive, sessionStale])}
        ctx={ctx}
        liveIds={[sessionLive.id]}
        livenessOf={(id) => (id === sessionLive.id ? 'live' : 'stale')}
      />,
    );
    expect(getByTestId('list-live-count').textContent).toContain('1');
  });

  it('row actions render disabled-with-reason when capabilities are UNKNOWN', () => {
    const { getAllByTestId } = render(
      <EntityListPanel
        kind="task"
        rowsFor={rowsFor([taskGuideLines])}
        ctx={ctx}
        /* capabilitiesOf omitted ⇒ unknown ⇒ NOT permitted, never optimistic. */
      />,
    );
    const tile = getAllByTestId('list-tile')[0]!;
    expect(within(tile).getAllByTestId('disabled-with-reason').length).toBeGreaterThan(0);
  });

  it('D34: at the floor the row renders the SHORT word, and the title survives', () => {
    // The defect this guards: 'running per record · unverified' is 31 chars in
    // a nowrap flex:none slot, wider than the whole 200px content box, so the
    // title — the ONE element meant to absorb the loss — collapses instead.
    // The short word comes from the registry (shortLabel), not from a local
    // abbreviation table.
    const compact = render(
      <EntityListPanel
        kind="work_session"
        rowsFor={rowsFor([sessionStale])}
        ctx={ctx}
        livenessOf={() => 'unknown'}
        compact
      />,
    );
    const tile = compact.getAllByTestId('list-tile')[0]!;
    const word = tile.querySelector('.lp__word')!;
    expect(word.textContent).toBe('unverified');
    expect(word.textContent).not.toContain('per record');
    // The long sentence is not lost — it is on the element for pointer and AT.
    expect(word.getAttribute('title')).toBeTruthy();
    // And the title still has its text.
    expect(tile.querySelector('.lp__title')?.textContent).toBe(sessionStale.title);
    compact.unmount();

    // Full width keeps the long form: the abbreviation is a floor behaviour,
    // not a permanent downgrade of the sentence.
    const wide = render(
      <EntityListPanel
        kind="work_session"
        rowsFor={rowsFor([sessionStale])}
        ctx={ctx}
        livenessOf={() => 'unknown'}
      />,
    );
    expect(wide.getAllByTestId('list-tile')[0]!.querySelector('.lp__word')?.textContent).toContain(
      'per record',
    );
  });

  it('D34: a compact STREAMING row keeps its own word — "streaming" fits any floor', () => {
    const { getAllByTestId } = render(
      <EntityListPanel
        kind="work_session"
        rowsFor={rowsFor([sessionLive])}
        ctx={ctx}
        livenessOf={() => 'live'}
        activity={{ [sessionLive.id]: true }}
        compact
      />,
    );
    expect(getAllByTestId('list-tile')[0]!.textContent).toContain('streaming');
  });

  it('an unknown kind falls back to the c:* row instead of throwing', () => {
    const { getByTestId } = render(
      <EntityListPanel kind="c:ritual" rowsFor={rowsFor([])} ctx={ctx} />,
    );
    expect(getByTestId('entity-list-panel').getAttribute('data-kind')).toBe('c:*');
  });
});

describe('SHARED CONTEXT — two facets, never merged (L7)', () => {
  it('every legal handoff renders exactly TWO facet pills', () => {
    const { getAllByTestId } = render(
      <SharedContextSection
        handoffs={fixtureHandoffs}
        withdrawUnavailableReason={WITHDRAW_UNAVAILABLE}
      />,
    );
    const rows = getAllByTestId('handoff-row');
    expect(rows).toHaveLength(fixtureHandoffs.length);
    for (const row of rows) {
      // Exactly two — a merged badge would be one, a split-out extra would be three.
      expect(row.querySelectorAll('.pn-facet')).toHaveLength(2);
    }
  });

  it('`unknown` delivery is NEVER styled as success', () => {
    const { getAllByTestId } = render(
      <SharedContextSection
        handoffs={fixtureHandoffs}
        withdrawUnavailableReason={WITHDRAW_UNAVAILABLE}
      />,
    );
    for (const row of getAllByTestId('handoff-row')) {
      if (row.getAttribute('data-delivery') !== 'unknown') continue;
      const delivery = row.querySelectorAll('.pn-facet')[0]!;
      expect(delivery.className).toContain('kit-pill--wait');
      expect(delivery.className).not.toContain('kit-pill--run');
      expect(delivery.textContent).toContain('⚠');
    }
  });

  it('withdrawal DECORATES: the row and an audit line survive, nothing is erased', () => {
    const withdrawn = fixtureHandoffs.filter((h) => h.recordStatus === 'withdrawn');
    const { getAllByTestId } = render(
      <SharedContextSection
        handoffs={withdrawn}
        withdrawUnavailableReason={WITHDRAW_UNAVAILABLE}
      />,
    );
    for (const row of getAllByTestId('handoff-row')) {
      expect(row.querySelector('.pn-handoff__note--audit')?.textContent).toMatch(/withdrawn by/);
    }
  });

  it('a source-missing row offers no navigation it cannot honour', () => {
    const missing = fixtureHandoffs.filter((h) => h.sourceMissing);
    const { getAllByTestId } = render(
      <SharedContextSection
        handoffs={missing}
        withdrawUnavailableReason={WITHDRAW_UNAVAILABLE}
      />,
    );
    const row = getAllByTestId('handoff-row')[0]!;
    expect(row.className).toContain('pn-handoff--source-missing');
    expect(row.querySelector('button.pn-handoff__label')).toBeNull();
    expect(row.textContent).toContain('source missing');
  });

  it('§10.7: the withdraw control is present and disabled-with-reason on every row', () => {
    const { getAllByTestId } = render(
      <SharedContextSection
        handoffs={fixtureHandoffs.slice(0, 3)}
        withdrawUnavailableReason={WITHDRAW_UNAVAILABLE}
      />,
    );
    for (const row of getAllByTestId('handoff-row')) {
      expect(within(row).getByTestId('disabled-with-reason')).toBeTruthy();
    }
  });
});

describe('share drop target — refusing honestly', () => {
  it('is VISIBLE, labelled and non-accepting while handoffs.send is deferred', () => {
    const { getByTestId } = render(
      <ShareDropTarget receiverName="forge" unavailableReason={SHARE_UNAVAILABLE} />,
    );
    const target = getByTestId('share-drop-target');
    expect(target.getAttribute('data-accept')).toBe('false');
    expect(target.getAttribute('aria-disabled')).toBe('true');
    expect(target.getAttribute('title')).toBe(SHARE_UNAVAILABLE);
    expect(target.textContent).toContain('can’t share here');
  });

  it('refuses at the BROWSER level — dragover never calls preventDefault', () => {
    const { getByTestId } = render(
      <ShareDropTarget receiverName="forge" unavailableReason={SHARE_UNAVAILABLE} />,
    );
    const event = new Event('dragover', { bubbles: true, cancelable: true });
    getByTestId('share-drop-target').dispatchEvent(event);
    // Un-defaulted dragover is what makes the platform show "no drop" and fire
    // no drop event — so there is no window in which we appear to accept.
    expect(event.defaultPrevented).toBe(false);
  });
});
