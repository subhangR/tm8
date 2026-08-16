// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import type { EntityDetail, EntitySummary } from '@tm8/contract';
import { ALL_MODES, allKinds, getKind, resolveAction, type ActionContext, type QueryFilter } from '../domain';
import { REASONS as DOMAIN_REASONS } from '../domain';
import {
  FIXTURE_SPACE_ID,
  fixtureDetails,
  fixtureHandoffs,
  fixtureSummaries,
  presenceHollowReason,
  channelDesign,
  sessionLive,
  sessionStale,
  docLayoutSpec,
  taskGuideLines,
  taskTombstone,
  taskUuidTitle,
  teamMemberForge,
  ada,
  noor,
} from '../fixtures';
import { EntityDetailPanel, EntityListPanel, SharedContextSection, ShareDropTarget } from './index';
import { HANDLED_SOURCES } from './list/tile-badges';
import type { DetailReasons } from './EntityDetailPanel';

/**
 * The registry walk renders a full panel per kind. Measured 283ms warm and
 * alone, but 5781ms (A1b, concurrent browser) and 8976ms (B4, cold package
 * run) under real load — and the default 5000ms fires exactly when the
 * important verification runs. Warm-and-alone was the condition where the
 * problem cannot occur, which is why my first reading was under-powered.
 * Sized to the cold measurement with headroom; the per-kind split above is a
 * separate fix for a separate problem (attribution).
 */
vi.setConfig({ testTimeout: 20_000 });

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

/**
 * The panel's Run expand takes the SAME `LaunchSources` the list panel does —
 * one shape, so the two surfaces cannot drift into two different launches.
 * `onSpawn` is present because a config that cannot commit refuses at its own
 * Launch button, and these tests are about the verb ABOVE that.
 */
const LAUNCH_SOURCES = {
  spaceId: FIXTURE_SPACE_ID,
  teammates: [{ id: 'tm-forge', label: 'forge', agentTool: 'claude-code', model: 'claude-opus-5' }],
  projects: [],
  onSpawn: () => {},
  mutationId: (entityId: string) => `launch:${entityId}`,
};

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
  /**
   * D3: FOUR TABS ALWAYS, every kind, no exceptions — asserted PER KIND rather
   * than in one loop.
   *
   * Split for ATTRIBUTION, not for speed. The single looping version reported
   * "some kind is wrong" and made you re-run to find which; `it.each` names the
   * failing kind in the failure itself. It also removes a timeout exposure as a
   * side effect: the loop measured 283ms in isolation but 5781ms under
   * concurrent browser load, and a per-kind test carries ~20x headroom against
   * the same contention. Bumping the limit would have treated a load artifact
   * as a code cost and kept the poor attribution.
   */
  const kindsWithFixtures = allKinds()
    .map((config) => ({
      config,
      detail: Object.values(fixtureDetails).find((d) => d.kind === config.kind),
    }))
    .filter((row): row is { config: (typeof row)['config']; detail: EntityDetail } => row.detail != null);

  it('the registry walk covers a meaningful share of kinds (a walk over nothing proves nothing)', () => {
    expect(kindsWithFixtures.length).toBeGreaterThan(10);
  });

  it.each(kindsWithFixtures.map((r) => [r.config.kind, r.detail] as const))(
    'D3: %s renders FOUR tabs in fixed order — the first names the KIND (user ruling 2026-07-29)',
    (kind, detail) => {
      const { getByTestId } = render(
        <EntityDetailPanel detail={detail} reasons={REASONS} ctx={ctx} />,
      );
      const labels = within(getByTestId('panel-tabs'))
        .getAllByRole('tab')
        .map((t) => t.textContent?.replace(/\d+$/, '').trim());
      // The first tab reads the kind's SINGULAR registry label ("Task",
      // "Session"), superseding the canvas's generic "Content" by user
      // ruling; the other three and the fixed order are unchanged law.
      expect(labels).toEqual([getKind(kind).label, 'Discussion', 'Connections', 'Activity']);
    },
  );

  it('routes the body by ARCHETYPE, never by kind — work_session gets the terminal body', () => {
    const detail = fixtureDetails[sessionStale.id]!;
    const { getByTestId } = render(
      <EntityDetailPanel detail={detail} reasons={REASONS} ctx={ctx} liveness="stale" />,
    );
    expect(getByTestId('entity-detail-panel').getAttribute('data-archetype')).toBe('terminal');
    expect(getByTestId('terminal-body')).toBeTruthy();
  });

  /**
   * USER RULING 2026-07-31 — "terminal all the way, till the component bottom."
   * The footer is the LAST strip between the canvas and the panel's edge, so
   * terminal panels do without it. Both halves are asserted together because
   * the risk is symmetric: dropping it everywhere would silently delete honest
   * chrome (D7.2's hollow "— viewing") from every document panel.
   *
   * D2 (session-UI design v1, 2026-08-06) EXTENDS the exclusion — deliberately
   * overturning this test's earlier "and only for it" half: a
   * `composition: 'chat'` body (channel's hub) ends at its composer for the
   * same structural reason the terminal ends at its canvas. Document panels
   * still keep the footer.
   */
  it('drops the footer for the terminal archetype and chat compositions, and only those', () => {
    const session = render(
      <EntityDetailPanel
        detail={fixtureDetails[sessionStale.id]!}
        reasons={REASONS}
        ctx={ctx}
        liveness="stale"
      />,
    );
    expect(session.queryByTestId('panel-footer')).toBeNull();

    const channel = render(
      <EntityDetailPanel detail={fixtureDetails[channelDesign.id]!} reasons={REASONS} ctx={ctx} />,
    );
    expect(channel.queryByTestId('panel-footer')).toBeNull();

    const task = render(
      <EntityDetailPanel detail={fixtureDetails[taskUuidTitle.id]!} reasons={REASONS} ctx={ctx} />,
    );
    expect(task.queryByTestId('panel-footer')).not.toBeNull();
  });

  /**
   * USER RULING 2026-07-31 — "the terminal, chat tab should be at the top row
   * at the right with two switchable chips."
   *
   * The switch is owned two levels down (WorkSessionContent) and portals into
   * a slot the panel bar publishes. That indirection is exactly what a test
   * has to pin: the switch rendering AT ALL proves nothing about WHERE, and
   * "where" is the whole ruling. Asserted by containment in `.pn-panelbar`,
   * not by a testid on the slot, so moving the slot inside the bar stays free
   * and moving it OUT of the bar fails.
   */
  it('mounts the terminal/chat switch inside the panel bar, not above the canvas', () => {
    const detail = fixtureDetails[sessionStale.id]!;
    const withChat = {
      ...detail,
      content: {
        ...detail.content,
        interactionProfile: {
          chatEnabled: true,
          initialContentSurface: 'terminal',
          compatibility: 'compatible',
          templateKey: 'session_chat_v1',
          templateVersion: 1,
        },
      },
    } as typeof detail;
    const { container, getByTestId } = render(
      <EntityDetailPanel detail={withChat} reasons={REASONS} ctx={ctx} liveness="stale" />,
    );
    const bar = container.querySelector('.pn-panelbar');
    const surfaceSwitch = getByTestId('work-session-surface-switch');
    expect(bar).not.toBeNull();
    expect(bar!.contains(surfaceSwitch)).toBe(true);
    expect(surfaceSwitch.className).toContain('pn-surface-switch--bar');
    // Still switchable in the bar — relocating a control may not quietly cost
    // it its behaviour. Debug and Graph are always present (neither depends on
    // the chat pin), and the Git UI wave added the Git surface to every
    // session panel, so a chat-enabled session shows all five.
    const tabs = [...surfaceSwitch.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(['Terminal', 'Chat', 'Git', 'Debug', 'Graph']);
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

  it('does not insert an unavailable launch block above the Sessions search', () => {
    const { container, getByTestId } = render(
      <EntityListPanel kind="work_session" rowsFor={rowsFor(sessions)} ctx={ctx} />,
    );

    expect(container.querySelector('.lp__actions')).toBeNull();
    expect(getByTestId('list-search')).toBeTruthy();
  });

  /**
   * VANILLA TERMINALS (101), and the ruling behind the placement: the start
   * controls belong at the TOP of the sessions list, beside Launch session.
   */
  it('draws ▮ Terminal in the sessions header, beside Launch session', () => {
    const onAction = vi.fn();
    const { container, getByTestId } = render(
      <EntityListPanel
        kind="work_session"
        rowsFor={rowsFor(sessions)}
        ctx={ctx}
        onAction={onAction}
        wiredActions={['start-terminal']}
      />,
    );

    const actions = container.querySelector('.lp__actions');
    expect(actions).toBeTruthy();
    // BESIDE, not instead of: both verbs are in the one header slot.
    expect(actions?.textContent).toContain('Terminal');
    expect(actions?.textContent).toContain('Launch session');

    fireEvent.click(getByTestId('list-quick-start'));
    expect(onAction).toHaveBeenCalledWith('start-terminal', '');
  });

  it('draws a vanilla terminal as a TERMINAL, not as an agent with an unknown tool', () => {
    const shell = {
      ...sessions[0]!,
      id: 'ws_shell_tile',
      title: 'Terminal',
      state: {
        kind: 'work_session', status: 'running', agentTool: null, model: null,
        shareMode: 'none', startedAt: null, exitedAt: null, sessionKind: 'shell',
      },
    } as EntitySummary;
    const { container } = render(
      <EntityListPanel kind="work_session" rowsFor={rowsFor([shell])} ctx={ctx} />,
    );
    const mark = container.querySelector('[data-agent-kind]');
    // `(tool || 'agent')` used to make this read `agent` — a shell wearing an
    // agent's glyph and an agent's aria-label.
    expect(mark?.getAttribute('data-agent-kind')).toBe('shell');
    expect(mark?.getAttribute('aria-label')).toBe('terminal');
  });

  it('still calls a tool-less AGENT row an agent — absence is not shell-ness', () => {
    // The other side of the same branch. A row with no `sessionKind` is a
    // pre-083 payload, and a session that never recorded its tool is an agent
    // whose tool is unknown — drawing it as a terminal would swap one wrong
    // label for another.
    const unknownTool = {
      ...sessions[0]!,
      id: 'ws_unknown_tool',
      state: {
        kind: 'work_session', status: 'running', agentTool: null, model: null,
        shareMode: 'none', startedAt: null, exitedAt: null,
      },
    } as EntitySummary;
    const { container } = render(
      <EntityListPanel kind="work_session" rowsFor={rowsFor([unknownTool])} ctx={ctx} />,
    );
    expect(container.querySelector('[data-agent-kind]')?.getAttribute('data-agent-kind')).toBe('agent');
  });

  it('names the TEAMMATE and the TOOL together — the avatar takes the slot, the tool marks its corner', () => {
    const attributed = {
      ...sessions[0]!,
      id: 'ws_attributed',
      state: {
        kind: 'work_session', status: 'running', agentTool: 'codex', model: null,
        shareMode: 'none', startedAt: null, exitedAt: null,
        teammate: {
          id: 'tm_fable', kind: 'team_member', displayName: 'Fable', avatar: null,
          role: null, isAgent: true,
        },
      },
    } as unknown as EntitySummary;
    const { container } = render(
      <EntityListPanel kind="work_session" rowsFor={rowsFor([attributed])} ctx={ctx} />,
    );
    const slot = container.querySelector('[data-agent-kind]');
    // The tool did not move out of the slot, it moved INTO the corner: two
    // sessions on the same tool are now told apart by whose face is on them.
    expect(slot?.getAttribute('data-teammate-id')).toBe('tm_fable');
    expect(slot?.querySelector('.pn-agent__tool')?.textContent).toBe('✦');
    expect(slot?.querySelector('.kit-avatar')?.getAttribute('aria-label')).toBe('Fable · codex');
  });

  it('a run with no persona keeps the tool-only mark — no monogram is invented for it', () => {
    const unattributed = {
      ...sessions[0]!,
      id: 'ws_unattributed',
      state: {
        kind: 'work_session', status: 'running', agentTool: 'claude-code', model: null,
        shareMode: 'none', startedAt: null, exitedAt: null, teammate: null,
      },
    } as unknown as EntitySummary;
    const { container } = render(
      <EntityListPanel kind="work_session" rowsFor={rowsFor([unattributed])} ctx={ctx} />,
    );
    const slot = container.querySelector('[data-agent-kind]');
    expect(slot?.querySelector('.kit-avatar')).toBeNull();
    expect(slot?.querySelector('.pn-agent__mark')?.textContent).toBe('✳');
    expect(slot?.getAttribute('aria-label')).toBe('claude-code');
  });

  it('R5 #9: the unwired half of the pair refuses with a reason, it is not drawn live', () => {
    // `Terminal` commits and `Launch session ▸` does not, because the sheet
    // needs a launch SUBJECT the header has no way to name. That asymmetry has
    // to be VISIBLE — a live button whose click the host's switch drops is the
    // enabled-inert failure this panel refuses everywhere else.
    const { container, getByTestId } = render(
      <EntityListPanel
        kind="work_session"
        rowsFor={rowsFor(sessions)}
        ctx={ctx}
        onAction={() => {}}
        wiredActions={['start-terminal']}
      />,
    );

    const actions = container.querySelector('.lp__actions');
    expect(within(actions as HTMLElement).getAllByTestId('disabled-with-reason')).toHaveLength(1);
    // …and the live one is a real button, not a second refusal.
    expect(getByTestId('list-quick-start').tagName).toBe('BUTTON');
  });

  it('D41: lifecycle tabs are UNIVERSAL, and coexist with sections rather than replacing them', () => {
    // Pre-ratification this asserted the opposite — that task had NO tabs.
    // The user ratified the three-tier model as drawn on every collection
    // kind, and T0-1 draws tabs AND sections together: tabs are the lifecycle
    // band, sections are triage grouping within it.
    for (const kind of ['task', 'work_session', 'doc']) {
      const panel = render(<EntityListPanel kind={kind} rowsFor={rowsFor([])} ctx={ctx} />);
      expect(panel.getAllByRole('tab'), `${kind} tabs`).toHaveLength(3);
      panel.unmount();
    }
    // and task keeps its sections — the withdrawal of the rename proposal
    expect(getKind('task').list.sections?.length).toBeGreaterThan(0);
  });

  it('D41: the filter chips SURVIVE alongside the tabs', () => {
    // Making tiers universal briefly deleted the filter trigger from every
    // kind, because tabs and chips had been coded as either/or while
    // work_session was the only kind with tabs. They are different axes.
    const { getByTestId, getAllByRole } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([])} ctx={ctx} />,
    );
    expect(getAllByRole('tab')).toHaveLength(3);
    expect(getByTestId('filter-trigger')).toBeTruthy();
  });

  it('D41: an unsupported tier renders honestly empty with its reason, never hidden', () => {
    // A1a measured that most kinds have no completion state the contract can
    // express, so `done` carries `unsupported`. The tab must still render.
    const withUnsupported = allKinds().find((k) =>
      k.list.lifecycle?.some((t) => t.unsupported),
    );
    expect(withUnsupported, 'some kind should have an unsupported tier').toBeTruthy();
    const { container, getAllByRole } = render(
      <EntityListPanel kind={withUnsupported!.kind} rowsFor={rowsFor([])} ctx={ctx} />,
    );
    expect(getAllByRole('tab')).toHaveLength(3);
    const dimmed = container.querySelector('[data-unsupported="true"]');
    expect(dimmed, 'unsupported tab present').not.toBeNull();
    expect(dimmed?.getAttribute('title')).toBeTruthy();
  });

  it('D41: tab counts, footer line and selector total all come from the SAME per-tier query', () => {
    const { getByTestId, getAllByRole } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([taskUuidTitle, taskGuideLines])} ctx={ctx} />,
    );
    const tabCounts = getAllByRole('tab').map((t) => Number((t.textContent ?? '').match(/\d+$/)?.[0] ?? 0));
    const total = Number(getByTestId('kind-total').textContent);
    // The total is the sum of the tiers — not a second source that could
    // disagree with the tabs it claims to summarise.
    expect(total).toBe(tabCounts.reduce((a, b) => a + b, 0));
    const footer = getByTestId('list-footer').textContent ?? '';
    for (const id of ['open', 'done', 'archived']) expect(footer).toContain(id);
  });

  it('marks a generic attention request IN PLACE — the flagged parent keeps its children', () => {
    // The regression this pins: attention used to hoist the row into its own
    // flat band, which took it out of the set the tree is built from — so a
    // flagged PARENT re-rooted every child it had and the hierarchy the user
    // was reading fell apart. Being flagged is a fact about the row, not a
    // reason to move it.
    const attention = {
      ...taskGuideLines,
      badges: {
        ...taskGuideLines.badges,
        attention: {
          pendingCount: 2,
          totalPoints: 130,
          maxPoints: 90,
          latestReason: 'Choose the API shape',
          oldestRequestedAt: '2026-07-30T00:00:00.000Z',
        },
      },
    } satisfies EntitySummary;
    const child = { ...taskUuidTitle, parentId: attention.id } satisfies EntitySummary;
    const view = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([attention, child])} ctx={ctx} />,
    );

    // No band: nothing was lifted out of the tree.
    expect(view.queryByText('NEEDS ATTENTION · 1')).toBeNull();

    const flagged = view
      .getAllByTestId('list-tile')
      .find((tile) => tile.textContent?.includes(attention.title))!;
    expect(within(flagged).getByText('Needs attention').getAttribute('title')).toBe('Choose the API shape');

    // …and the child is still NESTED under it rather than re-rooted.
    const nested = view.getByTestId('list-tile-children');
    expect(nested.textContent).toContain(child.title);
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
    expect(tile.querySelector('.pn-agent--live')).toBeNull();
    expect(tile.querySelector('.pn-agent--streaming')).toBeNull();
    expect(tile.querySelector('.pn-st__statusglyph')?.getAttribute('title')).toContain('node restarted');
  });

  it('merges liveness and streaming into the subtle agent character', () => {
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
    expect(hot.querySelector('.pn-agent--live.pn-agent--streaming .pn-agent__mark')).not.toBeNull();
    expect(hot.querySelector('.pn-dot')).toBeNull();
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
    expect(cold.querySelector('.pn-agent--live .pn-agent__mark')).not.toBeNull();
    expect(cold.querySelector('.pn-agent--streaming')).toBeNull();
  });

  it('renders a spark character, compact model, and hover actions; details reveal linked tasks', () => {
    const exited = {
      ...sessionLive,
      id: 'session-codex-exited',
      state: { ...sessionLive.state, agentTool: 'codex', model: 'gpt-5.6-sol', status: 'exited' },
    } as EntitySummary;
    const onTerminate = vi.fn();
    const { getByTestId, getByRole, queryByText } = render(
      <EntityListPanel
        kind="work_session"
        rowsFor={rowsFor([exited])}
        ctx={ctx}
        livenessOf={() => 'not-running'}
        linkedTasksOf={() => [taskGuideLines]}
        onTerminate={onTerminate}
      />,
    );
    const tile = getByTestId('list-tile');
    expect(tile.querySelector('[data-agent-kind="codex"] .pn-agent__mark')?.textContent).toBe('✦');
    expect(tile.querySelector('img')).toBeNull();
    expect(tile.textContent).toContain('gpt-5.6-sol');
    expect(tile.querySelector('.pn-st__radio')).toBeNull();
    expect(queryByText(taskGuideLines.title)).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Expand details' }));
    expect(tile.textContent).toContain(taskGuideLines.title);
    fireEvent.click(getByRole('button', { name: 'Close session' }));
    expect(onTerminate).toHaveBeenCalledWith(exited.id);
    expect(getByRole('button', { name: 'Copy session ID' })).toBeTruthy();
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
    expect(tile.querySelector('.pn-agent--live')).toBeNull();
    expect(tile.querySelector('.pn-st__statusglyph')?.getAttribute('title')).toContain('unverified');
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

  it('D34: at the floor the one-line title and model survive without a status metadata row', () => {
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
    expect(tile.querySelector('.pn-st__titleText')?.textContent).toBe(sessionStale.title);
    expect(tile.querySelector('.pn-st__model')?.textContent).toBe(sessionStale.state.kind === 'work_session' ? sessionStale.state.model : null);
    expect(tile.querySelector('.pn-st__inforow')).toBeNull();
  });

  it('D34: a compact streaming row animates the agent mark without adding a text row', () => {
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
    const tile = getAllByTestId('list-tile')[0]!;
    expect(tile.querySelector('.pn-agent--streaming')).not.toBeNull();
    expect(tile.querySelector('.pn-st__inforow')).toBeNull();
  });

  it('the filter ROW is bounded by construction — one trigger, never one chip per option', () => {
    // THE REGRESSION THIS GUARDS: the row used to flat-map every option of
    // every FilterSpec into its own chip. For `task` that is 7 status + 1
    // ready-to-pull + 2 deleted = TEN chips in a row that is overflow:hidden,
    // so the surplus was silently clipped and read as a truncated label.
    // A FilterSpec is ONE chip — its own type says so.
    const optionCount = getKind('task').list.filters.reduce((n, f) => n + f.options.length, 0);
    expect(optionCount).toBeGreaterThan(5); // the bound is only meaningful if there ARE many

    const { container, getByTestId } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([])} ctx={ctx} />,
    );
    const chips = container.querySelectorAll('.lp__filters .lp__chip');
    // Nothing selected: exactly the trigger + the sort chip.
    expect(chips).toHaveLength(2);
    expect(chips.length).toBeLessThan(optionCount);
    expect(getByTestId('filter-trigger').textContent).toBe('filter ▾');
  });

  it('people filtering is membership-conditional and uses createdByIds', () => {
    const solo = render(
      <EntityListPanel
        kind="task"
        rowsFor={rowsFor([taskUuidTitle, taskGuideLines])}
        members={[ada]}
        ctx={ctx}
      />,
    );
    // Authorship in the result page is deliberately irrelevant: a one-member
    // space keeps the exact two-chip row it had before this feature.
    expect(solo.queryByTestId('people-filter-trigger')).toBeNull();
    expect(solo.container.querySelectorAll('.lp__filters .lp__chip')).toHaveLength(2);
    solo.unmount();

    const seen: QueryFilter[] = [];
    const capturing = (filter: QueryFilter) => {
      seen.push(filter);
      return [];
    };
    const multi = render(
      <EntityListPanel
        kind="task"
        rowsFor={capturing}
        members={[ada, noor]}
        ctx={ctx}
      />,
    );
    fireEvent.click(multi.getByTestId('people-filter-trigger'));
    const menu = multi.getByTestId('people-filter-menu');
    const options = within(menu).getAllByRole('menuitemcheckbox');
    expect(options).toHaveLength(2);
    expect(menu.querySelectorAll('.kit-avatar')).toHaveLength(2);
    fireEvent.click(options[0]!);
    expect(seen.some((filter) =>
      Array.isArray(filter.createdByIds) && filter.createdByIds.includes(ada.id),
    )).toBe(true);

    // If the same mounted panel moves into a solo space, a formerly selected
    // person cannot survive as an invisible filter.
    seen.length = 0;
    multi.rerender(
      <EntityListPanel kind="task" rowsFor={capturing} members={[ada]} ctx={ctx} />,
    );
    expect(multi.queryByTestId('people-filter-trigger')).toBeNull();
    expect(multi.container.querySelector('.lp__chip--person')).toBeNull();
    // The first transition render necessarily observes the old state before
    // the membership effect clears it. A subsequent render must carry none.
    seen.length = 0;
    multi.rerender(
      <EntityListPanel kind="task" rowsFor={capturing} members={[ada]} ctx={ctx} />,
    );
    expect(seen.some((filter) => Array.isArray(filter.createdByIds))).toBe(false);
  });

  it('the unbounded option set lives in the picker, which scrolls', () => {
    const { getByTestId, queryByTestId } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([])} ctx={ctx} />,
    );
    expect(queryByTestId('filter-menu')).toBeNull();
    fireEvent.click(getByTestId('filter-trigger'));
    const menu = getByTestId('filter-menu');
    const options = menu.querySelectorAll('[role="menuitemcheckbox"]');
    const optionCount = getKind('task').list.filters.reduce((n, f) => n + f.options.length, 0);
    expect(options).toHaveLength(optionCount);
  });

  it('selecting adds ONE active chip carrying its clear affordance; clearing removes it', () => {
    const { container, getByTestId, getByRole } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([])} ctx={ctx} />,
    );
    fireEvent.click(getByTestId('filter-trigger'));
    fireEvent.click(getByRole('menuitemcheckbox', { name: /Blocked/ }));

    const active = container.querySelectorAll('.lp__chip--active');
    expect(active).toHaveLength(1);
    // The word survives with its clear glyph — never truncated to fit.
    expect(active[0]!.textContent).toBe('Blocked ✕');

    fireEvent.click(active[0]!);
    expect(container.querySelectorAll('.lp__chip--active')).toHaveLength(0);
  });

  it('a multi spec combines selections and UNIONS their contract filters', () => {
    const seen: unknown[] = [];
    const capturing = (filter: QueryFilter) => {
      seen.push(filter);
      return [] as readonly EntitySummary[];
    };
    const { getByTestId, getByRole } = render(
      <EntityListPanel kind="task" rowsFor={capturing} ctx={ctx} />,
    );
    fireEvent.click(getByTestId('filter-trigger'));
    fireEvent.click(getByRole('menuitemcheckbox', { name: /Blocked/ }));
    fireEvent.click(getByRole('menuitemcheckbox', { name: /^Open$/ }));

    // Assert SOME query carried the union — not "the last one". The last call
    // is now a tier-count query (D41 counts each tier by querying it), so a
    // last-call heuristic silently started measuring the wrong call. `multi`
    // means the options COMBINE, so the arrays union rather than the second
    // selection overwriting the first.
    const union = (seen as Record<string, unknown>[]).find(
      (f) =>
        Array.isArray(f.workStatus) &&
        (f.workStatus as string[]).includes('blocked') &&
        (f.workStatus as string[]).includes('open'),
    );
    expect(union, `no query carried the unioned filter; saw ${JSON.stringify(seen)}`).toBeTruthy();
  });

  it('at the floor the sort chip collapses to its glyph and never disappears', () => {
    const { container } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([])} ctx={ctx} compact />,
    );
    const chips = [...container.querySelectorAll('.lp__filters .lp__chip')];
    expect(chips.map((c) => c.textContent)).toContain('↓');
  });

  it('both popovers dismiss on Escape and on an outside click', () => {
    // Caught in the real-browser pass, in BOTH the filter picker and the kind
    // selector: a popover that closes only by re-clicking its own trigger is a
    // control the user must already know how to escape. Asserted for both,
    // because fixing only the one I had just built would have left its twin.
    const { getByTestId, queryByTestId, container } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([])} ctx={ctx} />,
    );

    fireEvent.click(getByTestId('filter-trigger'));
    expect(getByTestId('filter-menu')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryByTestId('filter-menu')).toBeNull();

    fireEvent.click(getByTestId('filter-trigger'));
    expect(getByTestId('filter-menu')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(queryByTestId('filter-menu')).toBeNull();

    const kindButton = container.querySelector('.lp__kind') as HTMLElement;
    fireEvent.click(kindButton);
    expect(container.querySelector('.lp__kindmenu')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('.lp__kindmenu')).toBeNull();
  });

  it('CONSUMER COVERAGE: every TileBadgeSource the registry emits has a renderer', () => {
    // THE GUARD THAT WOULD HAVE CAUGHT THE R5 FINDING AT AUTHORING TIME.
    // `tile.badges` had no consumer at all: the renderer read only
    // `tile.pulse`, so all 35 declared sources rendered nothing and every
    // kind but work_session showed a bare title. work_session looked correct
    // only because it owns `liveTreatment` — a different field on a different
    // path — which is what disguised a universal break as a task-specific one.
    //
    // A registry-side test asserting `tile.badges` is POPULATED passes over
    // dead data (A1a's own finding about their suite). The assertion that
    // bites is this one: the two sides must MEET.
    const declared = new Set(allKinds().flatMap((k) => k.list.tile.badges.map((b) => b.source)));
    expect(declared.size).toBeGreaterThan(20); // meaningful only if the registry really declares many
    const unhandled = [...declared].filter((s) => !HANDLED_SOURCES.has(s));
    expect(unhandled, `TileBadgeSource with no renderer: ${unhandled.join(', ')}`).toEqual([]);
  });

  it('R5 #1: the control-card anatomy maps status, priority, assignees and progress from real data', () => {
    const { getAllByTestId } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([taskUuidTitle])} ctx={ctx} />,
    );
    const tile = getAllByTestId('list-tile')[0]!;
    expect(tile.getAttribute('data-anatomy')).toBe('control-card');
    expect(tile.querySelector('.pn-stat'), 'status glyph').not.toBeNull();
    expect(tile.querySelector('.pn-tt__status-text')?.textContent, 'status word').toBe('in review');
    expect(tile.querySelector('.pn-tt__main .pn-tag'), 'no duplicated header priority').toBeNull();

    fireEvent.click(within(tile).getByRole('button', { name: /expand details/i }));
    const expanded = tile.querySelector('.pn-tt__meta')?.textContent ?? '';
    /* The expanded priority is now a CONTROL, not a badge (2026-08-04) — it
       is addressed by the registry field it writes rather than by a badge
       class, so this holds whether it renders as the picker or as the honest
       refusal, which is what it does here with no `onSetValue` wired. The
       word is still the badge's word: same fact, one spelling. */
    expect(
      tile.querySelector('.pn-tt__meta [data-source="priority"]')?.textContent,
      'expanded priority control',
    ).toBe('URGENT');
    // 2/4, and it must AGREE with the detail panel's ACCEPTANCE region for the
    // same task — the fixture used to say 6 total against a detail carrying 4.
    expect(expanded, 'expanded facts').toContain('2/4 criteria');
    expect(expanded).toContain('Ada +1');
    expect(expanded).toContain('3 pulled');
    expect(
      within(tile).getByRole('button', { name: /collapse details/i }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  /**
   * The defect this pins: the row's avatar slot read `state.assignees` and
   * nothing else, and on a real space 48 of 50 tasks are unassigned — so the
   * list rendered with no faces at all. Every task fixture here was assigned,
   * which is precisely why no test saw it. `createdBy` is never null, so the
   * unassigned row falls back to provenance and says so.
   */
  it('an unassigned task row shows the creator as provenance, labelled as such', () => {
    const unassigned: EntitySummary = {
      ...taskGuideLines,
      id: 'task-unassigned',
      title: 'Nobody has pulled this yet',
      createdBy: noor,
      state: { ...taskGuideLines.state, assignees: [] } as EntitySummary['state'],
    };
    const { getAllByTestId } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([unassigned])} ctx={ctx} />,
    );
    const tile = getAllByTestId('list-tile')[0]!;
    const group = tile.querySelector('.pn-av-group');
    expect(group, 'unassigned rows still render a face').not.toBeNull();
    expect(group!.classList.contains('pn-av-group--creator')).toBe(true);
    expect(group!.getAttribute('aria-label')).toBe('Created by Noor, unassigned');
    // Provenance is ONE face, never a stack — a creator is not a roster.
    expect(group!.querySelectorAll('.kit-avatar').length).toBe(1);
    expect(group!.querySelector('.kit-avatar')?.getAttribute('data-actor-id')).toBe(noor.id);
  });

  it('an assigned task row shows the assignees, not the creator', () => {
    const { getAllByTestId } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([taskUuidTitle])} ctx={ctx} />,
    );
    const group = getAllByTestId('list-tile')[0]!.querySelector('.pn-av-group')!;
    expect(group.classList.contains('pn-av-group--creator')).toBe(false);
    expect(group.getAttribute('aria-label')).toBe('Assigned to Ada, forge');
  });

  it('renders a task hierarchy as attached cards and expands/collapses children inline', () => {
    const parent: EntitySummary = {
      ...taskGuideLines,
      id: 'task-parent-card',
      title: 'Workspace layout',
      parentId: null,
    };
    const child: EntitySummary = {
      ...taskUuidTitle,
      id: 'task-child-card',
      title: 'Center sizing law',
      parentId: parent.id,
    };
    const onSelect = vi.fn();
    const { getAllByTestId, getByRole, queryByText } = render(
      <EntityListPanel
        kind="task"
        rowsFor={rowsFor([parent, child])}
        ctx={ctx}
        onSelect={onSelect}
      />,
    );

    expect(getAllByTestId('list-tile')).toHaveLength(2);
    expect(getAllByTestId('list-tile')[1]?.getAttribute('data-depth')).toBe('1');
    const disclosure = getByRole('button', { name: /collapse workspace layout, 1 child/i });
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(disclosure);
    expect(getAllByTestId('list-tile')).toHaveLength(1);
    expect(queryByText('Center sizing law')).toBeNull();
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(disclosure);
    fireEvent.click(getByRole('button', { name: 'Center sizing law' }));
    expect(onSelect).toHaveBeenLastCalledWith(child.id);
  });

  it('uses the same hierarchy and semantic status colors for coordinator/session children', () => {
    const coordinator: EntitySummary = {
      ...sessionLive,
      id: 'session-coordinator-card',
      title: 'Coordinator session',
      parentId: null,
    };
    const worker: EntitySummary = {
      ...sessionStale,
      id: 'session-worker-card',
      title: 'Worker session',
      parentId: coordinator.id,
    };
    const { getAllByTestId, getByRole } = render(
      <EntityListPanel
        kind="work_session"
        rowsFor={rowsFor([coordinator, worker])}
        ctx={ctx}
        livenessOf={() => 'live'}
      />,
    );

    expect(getAllByTestId('list-tile')).toHaveLength(2);
    expect(getAllByTestId('list-tile')[0]?.querySelector('.lp__statusmark--run')).not.toBeNull();
    fireEvent.click(getByRole('button', { name: /collapse coordinator session, 1 child/i }));
    expect(getAllByTestId('list-tile')).toHaveLength(1);
  });

  it('R5 #1 is a CLASS: a non-session, non-task kind renders anatomy too', () => {
    // The finding was seen on tasks but the mechanism silenced every kind.
    // Docs prove the fix is general rather than task-shaped.
    const { getAllByTestId } = render(
      <EntityListPanel kind="doc" rowsFor={rowsFor([docLayoutSpec])} ctx={ctx} />,
    );
    const tile = getAllByTestId('list-tile')[0]!;
    expect(tile.querySelector('.lp__meta')?.textContent).toContain('markdown');
  });

  it('the seam VERDICT outranks the record status badge on a session row', () => {
    // work_session declares a sessionStatus badge AND has a liveTreatment.
    // The record says 'running'; the seam says stale. If the badge won, the
    // row would print "running" — the exact lie D6 forbids.
    const { getAllByTestId } = render(
      <EntityListPanel
        kind="work_session"
        rowsFor={rowsFor([sessionStale])}
        ctx={ctx}
        livenessOf={() => 'stale'}
      />,
    );
    const tile = getAllByTestId('list-tile')[0]!;
    expect(tile.querySelector('.pn-agent--live')).toBeNull();
    expect(tile.querySelector('.pn-st__statusglyph')?.getAttribute('title')).toContain('node restarted');
  });

  it('R5 #2: in-panel search narrows rows client-side, and says WHY when nothing matches', () => {
    const { getByTestId, queryAllByTestId, container } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([taskUuidTitle, taskGuideLines])} ctx={ctx} />,
    );
    expect(queryAllByTestId('list-tile')).toHaveLength(2);

    fireEvent.change(getByTestId('list-search'), { target: { value: 'guide' } });
    expect(queryAllByTestId('list-tile')).toHaveLength(1);

    // A filter that hides every row and says nothing is indistinguishable
    // from a list that failed to load.
    fireEvent.change(getByTestId('list-search'), { target: { value: 'zzzz-no-match' } });
    expect(queryAllByTestId('list-tile')).toHaveLength(0);
    const empty = container.querySelector('[data-testid="panel-empty"]')?.textContent ?? '';
    expect(empty).toContain('zzzz-no-match');
    expect(empty).toMatch(/clear the search/i);
  });

  it('R5 #3: the view switcher shows every non-hidden position; unbuilt ones are disabled-with-reason', () => {
    const { getByTestId } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([])} ctx={ctx} />,
    );
    // T0-1's switcher is FOUR positions — List, Tree, Board, Graph — not the
    // registry's six modes; feed and gallery are CollectionView layouts the
    // composed workspace canvas does not offer in a side panel.
    const sw = getByTestId('view-switcher');
    const controls = sw.querySelectorAll('button, [role="button"]');
    expect(controls).toHaveLength(4);
    // A2: list AND board are live for task (the registry declares `board`);
    // tree and graph stay visible-and-disabled with their reasons.
    expect(sw.querySelectorAll('.lp__view')).toHaveLength(2);
    expect(sw.querySelectorAll('[data-testid="disabled-with-reason"]')).toHaveLength(2);
  });

  it('R7: graph is never HIDDEN — visible, labelled, unclickable', () => {
    // hidden and disabled are different states; only one teaches that the
    // feature exists. A registry that hid graph would silently satisfy a
    // test that only counted positions, so assert the mode itself.
    for (const k of allKinds()) {
      expect(k.hiddenModes, `${k.kind} hides graph`).not.toContain('graph');
    }
  });

  it('R5 #7: the dark scope adds NO dom level — a wrapper breaks the shell\'s direct-child rule', () => {
    // d806c90 wrapped the panel in a display:contents element. That generates
    // no box, so it looked free — but display:contents removes an element
    // from the BOX tree, NOT the DOM, so the shell's `.shell-stack__col > *`
    // flex-grow rule matched the wrapper (which cannot grow) instead of the
    // panel. Session panels alone took content width. The scope now lives ON
    // the panel element, so the shell's child relationship is preserved.
    const detail = fixtureDetails[sessionStale.id]!;
    const { container, getByTestId } = render(
      <EntityDetailPanel detail={detail} reasons={REASONS} ctx={ctx} liveness="stale" />,
    );
    const panel = getByTestId('entity-detail-panel');
    // The rendered root IS the panel — nothing wraps it.
    expect(container.firstElementChild).toBe(panel);
    // and it still opens the dark token scope
    expect(panel.classList.contains('cv2-root')).toBe(true);
    expect(panel.getAttribute('data-theme')).toBe('dark');
  });

  it('R5 #4B: the header pill obeys the VERDICT, never the record, on a stale session', () => {
    // The record says running; the seam says stale. Rendering live green here
    // is the D6 lie that reached the user's screen at the gate.
    const detail = fixtureDetails[sessionStale.id]!;
    const { getByTestId } = render(
      <EntityDetailPanel detail={detail} reasons={REASONS} ctx={ctx} liveness="stale" />,
    );
    const header = getByTestId('panel-header');
    expect(header.textContent).toContain('stale');
    expect(header.querySelector('.kit-pill--run')).toBeNull();
  });

  it('R5 #9: an UNWIRED verb is disabled-with-reason, never enabled-inert', () => {
    // The user clicked Run and nothing happened. The primaries had landed
    // ahead of their behaviour and rendered as live buttons that silently did
    // nothing — the F6/X4 class. An enabled control that does not respond is
    // worse than a disabled one: the user cannot tell a broken app from an
    // unimplemented feature, so they click it again.
    // Structural check (is there a handler?), so it cannot drift from what is
    // actually wired. Asserted at EVERY action site, not just the one the
    // user happened to click.
    const detail = fixtureDetails[taskUuidTitle.id]!;

    // 1. detail action bar — no onAction passed
    const panel = render(<EntityDetailPanel detail={detail} reasons={REASONS} ctx={ctx} />);
    const bar = panel.getByTestId('panel-action-bar');
    expect(bar.querySelectorAll('[data-testid="disabled-with-reason"]').length).toBeGreaterThan(0);
    expect(bar.querySelectorAll('button.pn-btn--primary')).toHaveLength(0);
    panel.unmount();

    // 2. list row actions + quick launch — no onAction passed
    const list = render(
      <EntityListPanel kind="task" rowsFor={() => [taskUuidTitle]} ctx={ctx} />,
    );
    const tile = list.getAllByTestId('list-tile')[0]!;
    expect(tile.querySelectorAll('.lp__rowaction')).toHaveLength(0);
    expect(tile.querySelectorAll('[data-testid="disabled-with-reason"]').length).toBeGreaterThan(0);
  });

  it('R5 #9: a WIRED verb is live — the guard gates on the handler, not on everything', () => {
    // Both halves: the check must go green when the handler exists, or it is
    // a detector that fires on everything and discriminates nothing.
    const detail = fixtureDetails[taskUuidTitle.id]!;
    const { getByTestId } = render(
      <EntityDetailPanel
        detail={detail}
        reasons={REASONS}
        ctx={{ ...ctx, capabilities: detail.capabilities }}
        onAction={() => {}}
      />,
    );
    const bar = getByTestId('panel-action-bar');
    expect(bar.querySelectorAll('button.pn-btn--primary').length).toBeGreaterThan(0);
  });

  /*
   * THE REPORTED DEFECT, both halves (user report 2026-08-07): "in the session
   * terminal view, there is a terminate button which is not enabled and
   * working", and "there is a run button on the tasks, teammates, other
   * entities, this also has not been enabled".
   *
   * Both verbs were declared by the registry and drawn by this bar for the
   * whole of its life; neither had a handler at any of the five mount sites,
   * so R5 #9 correctly rendered them dead. These assert the LIVE side.
   */
  it('DEFECT: Terminate on a live session panel commits, and names the session', () => {
    // The VERDICT decides, not the record (R5 #4B) — this fixture's recorded
    // status is stale, and a `live` seam verdict is what makes the verb legal.
    const detail = fixtureDetails[sessionStale.id]!;
    const fired: string[] = [];
    const { getByTestId } = render(
      <EntityDetailPanel
        detail={detail}
        reasons={REASONS}
        ctx={{ ...ctx, capabilities: detail.capabilities }}
        liveness="live"
        onAction={(ref) => fired.push(ref)}
        wiredActions={['terminate']}
      />,
    );
    const bar = getByTestId('panel-action-bar');
    // Not a DisabledIconControl any more — a real button carrying the word.
    const button = within(bar).getByRole('button', { name: /terminate/i });
    expect(bar.querySelectorAll('[data-testid="disabled-with-reason"]')).toHaveLength(0);
    fireEvent.click(button);
    expect(fired).toEqual(['terminate']);
  });

  it('an EXITED session still refuses Terminate, with the liveness reason', () => {
    // Wiring the handler must not defeat the availability gate: there is no
    // process to signal, and the honest control says so rather than sending a
    // command the node would refuse.
    const detail = fixtureDetails[sessionStale.id]!;
    const { getByTestId } = render(
      <EntityDetailPanel
        detail={detail}
        reasons={REASONS}
        ctx={{ ...ctx, capabilities: detail.capabilities }}
        liveness="exited"
        onAction={() => {}}
        wiredActions={['terminate']}
      />,
    );
    const bar = getByTestId('panel-action-bar');
    expect(bar.querySelectorAll('[data-testid="disabled-with-reason"]').length).toBeGreaterThan(0);
    expect(bar.textContent).toContain('Terminate');
  });

  it('DEFECT: Run on a task panel expands the SAME quick config the list rows open', () => {
    const detail = fixtureDetails[taskUuidTitle.id]!;
    const { getByTestId, queryByTestId } = render(
      <EntityDetailPanel
        detail={detail}
        reasons={REASONS}
        ctx={{ ...ctx, capabilities: detail.capabilities }}
        launch={LAUNCH_SOURCES}
      />,
    );
    const bar = getByTestId('panel-action-bar');
    const run = within(bar).getByRole('button', { name: /run/i });
    // A flow verb is live WITHOUT `onAction`: it configures, it does not
    // dispatch. Wiring it to the dispatcher would have been the wrong fix.
    expect(run.getAttribute('aria-expanded')).toBe('false');
    expect(queryByTestId('launch-quick-config')).toBeNull();

    fireEvent.click(run);
    expect(run.getAttribute('aria-expanded')).toBe('true');
    expect(getByTestId('launch-quick-config')).toBeTruthy();

    fireEvent.click(run);
    expect(queryByTestId('launch-quick-config')).toBeNull();
  });

  it('USER RULING 2026-08-07: the Run config takes NO ROW — the header is already crammed', () => {
    // "dont add any new rows or components, in the exisitng view only
    // functionality should be added". The expand therefore hangs off the bar
    // out of flow; a card that occupied layout height would push the terminal
    // canvas down on every press of Run, which is the relayout the ruling
    // exists to prevent. Structural: the card must be INSIDE the absolute
    // slot, not a sibling of the bar.
    const detail = fixtureDetails[taskUuidTitle.id]!;
    const { getByTestId } = render(
      <EntityDetailPanel
        detail={detail}
        reasons={REASONS}
        ctx={{ ...ctx, capabilities: detail.capabilities }}
        launch={LAUNCH_SOURCES}
      />,
    );
    fireEvent.click(within(getByTestId('panel-action-bar')).getByRole('button', { name: /run/i }));
    const slot = getByTestId('panel-action-flow');
    expect(slot.className).toContain('pn-actions__flow');
    expect(within(slot).getByTestId('launch-quick-config')).toBeTruthy();
    // And it lives inside the bar, so the bar is still the only row.
    expect(getByTestId('panel-action-bar').contains(slot)).toBe(true);
  });

  it('Run with NO launch sources keeps its refusal rather than opening an empty config', () => {
    // A config with no teammates over an un-committable Launch is a worse
    // answer than the honest "not wired here".
    const detail = fixtureDetails[taskUuidTitle.id]!;
    const { getByTestId, queryByTestId } = render(
      <EntityDetailPanel
        detail={detail}
        reasons={REASONS}
        ctx={{ ...ctx, capabilities: detail.capabilities }}
      />,
    );
    const bar = getByTestId('panel-action-bar');
    expect(bar.querySelectorAll('button.pn-btn--primary')).toHaveLength(0);
    expect(bar.querySelectorAll('[data-testid="disabled-with-reason"]').length).toBeGreaterThan(0);
    expect(queryByTestId('panel-action-flow')).toBeNull();
    expect(queryByTestId('launch-quick-config')).toBeNull();
  });

  it('REVIEW F1: switching entity closes the Run config — it never re-targets silently', () => {
    /*
     * PR #46 review, blocking finding. Only `PanelStack` keys its panels by
     * id; EntityView, ChannelView and GraphScreen each mount ONE panel
     * instance and change `selectedId` under it. So component state survives
     * the switch — and `flowRef` is component state.
     *
     * The card dismisses on outside mousedown and on Escape. A BACK BUTTON
     * fires neither. The config therefore stayed open across the navigation
     * and `subject={detail}` silently re-pointed it at whatever entity had
     * arrived: you would press Launch on a card that named one thing and
     * spawned against another. Worse when the new kind has no Run at all —
     * the trigger is gone and the card is orphaned with no way to close it.
     */
    const task = fixtureDetails[taskUuidTitle.id]!;
    const session = fixtureDetails[sessionStale.id]!;
    const view = render(
      <EntityDetailPanel
        detail={task}
        reasons={REASONS}
        ctx={{ ...ctx, capabilities: task.capabilities }}
        launch={LAUNCH_SOURCES}
      />,
    );
    fireEvent.click(
      within(view.getByTestId('panel-action-bar')).getByRole('button', { name: /^Run$/i }),
    );
    expect(view.getByTestId('launch-quick-config').textContent).toContain(task.title);

    // The SAME instance, a different entity — exactly what a Back press does.
    view.rerender(
      <EntityDetailPanel
        detail={session}
        reasons={REASONS}
        ctx={{ ...ctx, capabilities: session.capabilities }}
        launch={LAUNCH_SOURCES}
      />,
    );

    expect(view.queryByTestId('launch-quick-config')).toBeNull();
    expect(view.queryByTestId('panel-action-flow')).toBeNull();
  });

  it('REVIEW F1: the same entity re-rendering does NOT close the config', () => {
    // The other half: a reset keyed on anything but identity would slam the
    // card shut on every unrelated re-render, which is a worse bug than the
    // one it fixes.
    const task = fixtureDetails[taskUuidTitle.id]!;
    const view = render(
      <EntityDetailPanel
        detail={task}
        reasons={REASONS}
        ctx={{ ...ctx, capabilities: task.capabilities }}
        launch={LAUNCH_SOURCES}
      />,
    );
    fireEvent.click(
      within(view.getByTestId('panel-action-bar')).getByRole('button', { name: /^Run$/i }),
    );
    view.rerender(
      <EntityDetailPanel
        detail={{ ...task, counters: { ...task.counters, messages: task.counters.messages + 1 } }}
        reasons={REASONS}
        ctx={{ ...ctx, capabilities: task.capabilities }}
        launch={LAUNCH_SOURCES}
      />,
    );
    expect(view.getByTestId('launch-quick-config')).toBeTruthy();
  });

  it('REVIEW R3: switching verb with the card OPEN re-seeds it — Run cannot spawn a coordinator', async () => {
    /*
     * The team_member panel is the one surface carrying BOTH launch verbs
     * (`['run','coordinate']`). The card is not remounted when the opening
     * verb changes: same element type, same position, no key — so React reuses
     * the instance. `mode` and `verbLabel` are props and re-render, but the
     * config is STATE, seeded once. Press Coordinate then Run and the heading
     * says "Run configuration" over `mode: 'coordinator'`.
     *
     * The dismissal does not save it either: the Run button lives inside
     * `actionBarRef`, the same bounds that contain the card, so an outside
     * click never fires.
     *
     * MY OWN BUG INVERTED, and worse for the heading fix: while the card
     * always said "Run" the payload was at least the only thing lying.
     */
    const detail = fixtureDetails[teamMemberForge.id]!;
    const onSpawn = vi.fn();
    const view = render(
      <EntityDetailPanel
        detail={detail}
        reasons={REASONS}
        ctx={{ ...ctx, capabilities: detail.capabilities }}
        launch={{ ...LAUNCH_SOURCES, onSpawn }}
      />,
    );
    const bar = view.getByTestId('panel-action-bar');
    fireEvent.click(within(bar).getByRole('button', { name: /^Coordinate$/i }));
    expect(view.getByTestId('launch-heading').textContent).toBe('Coordinate configuration');

    // Switch verbs WITHOUT closing the card — two clicks, no navigation.
    fireEvent.click(within(bar).getByRole('button', { name: /^Run$/i }));
    expect(view.getByTestId('launch-heading').textContent).toBe('Run configuration');

    fireEvent.click(view.getByTestId('launch-commit'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalled());
    // The payload must agree with the button that was actually pressed.
    expect(onSpawn.mock.calls[0]![0].mode).toBe('worker');
  });

  it('REVIEW R3: and the converse — Coordinate after Run commits a coordinator', async () => {
    const detail = fixtureDetails[teamMemberForge.id]!;
    const onSpawn = vi.fn();
    const view = render(
      <EntityDetailPanel
        detail={detail}
        reasons={REASONS}
        ctx={{ ...ctx, capabilities: detail.capabilities }}
        launch={{ ...LAUNCH_SOURCES, onSpawn }}
      />,
    );
    const bar = view.getByTestId('panel-action-bar');
    fireEvent.click(within(bar).getByRole('button', { name: /^Run$/i }));
    fireEvent.click(within(bar).getByRole('button', { name: /^Coordinate$/i }));
    fireEvent.click(view.getByTestId('launch-commit'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalled());
    expect(onSpawn.mock.calls[0]![0].mode).toBe('coordinator');
  });

  it('wiredActions narrows the dispatcher: a verb it cannot perform stays refused', () => {
    // The regression this exists to stop: wiring `onAction` at the host turned
    // EVERY primary live, including a doc's `add-child`, which has no executor
    // anywhere. That trades one enabled-inert button for another.
    const detail = fixtureDetails[docLayoutSpec.id]!;
    const { getByTestId } = render(
      <EntityDetailPanel
        detail={detail}
        reasons={REASONS}
        ctx={{ ...ctx, capabilities: detail.capabilities }}
        onAction={() => {}}
        wiredActions={['terminate']}
      />,
    );
    const bar = getByTestId('panel-action-bar');
    expect(bar.textContent).toContain('Add child');
    expect(bar.querySelectorAll('button.pn-btn--primary')).toHaveLength(0);
    expect(bar.querySelectorAll('[data-testid="disabled-with-reason"]').length).toBeGreaterThan(0);
  });

  it('keeps the task title row clear and puts Run + panel controls beside the tabs', () => {
    const detail = fixtureDetails[taskUuidTitle.id]!;
    const { getByTestId, getByRole } = render(
      <EntityDetailPanel
        detail={detail}
        reasons={REASONS}
        ctx={{ ...ctx, capabilities: detail.capabilities }}
        onAction={() => {}}
        onPromote={() => {}}
        onClose={() => {}}
      />,
    );

    const header = getByTestId('panel-header');
    const toolbar = getByTestId('panel-toolbar');
    const tabs = getByTestId('panel-tabs');
    const actions = getByTestId('panel-action-bar');

    expect(header.contains(actions)).toBe(false);
    expect(toolbar.contains(tabs)).toBe(true);
    for (const label of ['Task', 'Discussion', 'Connections', 'Activity']) {
      expect(tabs.textContent).toContain(label);
    }
    expect(toolbar.contains(actions)).toBe(true);
    expect(toolbar.contains(getByRole('button', { name: 'Open full view' }))).toBe(true);
    expect(toolbar.contains(getByRole('button', { name: 'Close panel' }))).toBe(true);
    expect(toolbar.querySelector('[aria-label="More actions"]')).toBeNull();
    expect(toolbar.querySelector('[aria-label="Pin panel"]')).toBeNull();
    expect(actions.textContent).toContain('Run');
    for (const removed of ['Coordinate', 'Complete', 'Points', 'Link', 'Add child']) {
      expect(actions.textContent).not.toContain(removed);
    }
  });

  it('gives terminal panels the same title-first, toolbar-second layout as tasks', () => {
    const detail = fixtureDetails[sessionStale.id]!;
    const { getByTestId, getByRole } = render(
      <EntityDetailPanel
        detail={detail}
        reasons={REASONS}
        ctx={{ ...ctx, capabilities: detail.capabilities, liveness: 'stale' }}
        liveness="stale"
        /*
         * WIRED, and that is what the `Save` assertion below now measures.
         * A session title became editable (085), so this panel mounts the save
         * flow exactly as a task's does — and `SaveControls` renders NOTHING
         * while the draft is clean. Mounted WITHOUT an executor it renders a
         * permanent disabled-with-reason instead, which is the state that
         * squeezed Discussion/Connections/Activity out of this row and the
         * reason the registry flag was false. Both halves are real; the
         * unwired one stays pinned for tasks in save-wiring.test.tsx.
         */
        commands={{ createEntity: vi.fn(), patchTask: vi.fn() }}
        onAction={() => {}}
        onPromote={() => {}}
        onClose={() => {}}
      />,
    );

    const header = getByTestId('panel-header');
    const toolbar = getByTestId('panel-toolbar');
    const tabs = getByTestId('panel-tabs');
    const actions = getByTestId('panel-action-bar');

    expect(header.textContent).toContain(detail.title);
    expect(header.contains(actions)).toBe(false);
    expect(toolbar.contains(tabs)).toBe(true);
    for (const label of ['Session', 'Discussion', 'Connections', 'Activity']) {
      expect(tabs.textContent).toContain(label);
    }
    expect(toolbar.contains(actions)).toBe(true);
    expect(toolbar.contains(getByRole('button', { name: 'Open full view' }))).toBe(true);
    expect(toolbar.contains(getByRole('button', { name: 'Close panel' }))).toBe(true);
    expect(toolbar.querySelector('[aria-label="More actions"]')).toBeNull();
    expect(toolbar.querySelector('[aria-label="Pin panel"]')).toBeNull();
    expect(toolbar.textContent).not.toContain('Save');
    expect(toolbar.querySelector('.hon-caption')).toBeNull();
    expect(actions.textContent).toContain('Terminate');
    expect(actions.textContent).not.toContain('Complete');
    expect(getByTestId('terminal-body')).toBeTruthy();
  });

  it('R5 #4A: the action bar states reasons on the CONTROL, not as stacked sentences', () => {
    const detail = fixtureDetails[sessionStale.id]!;
    const { getByTestId } = render(
      <EntityDetailPanel detail={detail} reasons={REASONS} ctx={ctx} liveness="stale" />,
    );
    const bar = getByTestId('panel-action-bar');
    // The caption form stacks a full sentence per disabled verb and clipped
    // three of them across a 32px overflow-hidden row.
    expect(bar.querySelectorAll('.hon-caption')).toHaveLength(0);
    // The reasons are still reachable — on the controls.
    expect(bar.querySelectorAll('[data-testid="disabled-with-reason"]').length).toBeGreaterThan(0);
  });

  it('R5 #4A: the panel injects the verdict it holds — no consumer reports "unknown"', () => {
    const detail = fixtureDetails[sessionStale.id]!;
    const { getByTestId } = render(
      <EntityDetailPanel detail={detail} reasons={REASONS} ctx={ctx} liveness="stale" />,
    );
    const bar = getByTestId('panel-action-bar');
    const tips = [...bar.querySelectorAll('.hon-tip__cause, .hon-tip__remedy')]
      .map((n) => n.textContent ?? '')
      .join(' ');
    // The panel HAS the verdict and the capabilities; handing them down is
    // what stops the bar reporting a state the strip below contradicts.
    expect(tips).not.toMatch(/unverified/i);
    expect(tips).not.toMatch(/waiting for this entity to load/i);
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

/**
 * ATTACHMENTS IN THE CONTENT BODY — the wiring test, not a component test.
 *
 * `AttachmentStrip.test.tsx` proves the component. THIS file proves the thing
 * that four green suites can hide (the four-links lesson): that the PANEL
 * actually mounts it, in the content body, for every kind, without adding a
 * fifth tab. The strip was correct and unmounted for exactly as long as
 * nobody asserted the mount.
 */
describe('EntityDetailPanel — attachments ride in the content body (D3 intact)', () => {
  // Any kind that MOUNTS the strip — not terminal, not a chat composition
  // (D2: those bodies end at their composer, whose + owns attach).
  const anyDetail = Object.values(fixtureDetails).find(
    (d) =>
      d.deletedAt == null &&
      getKind(d.kind).panel.archetype !== 'terminal' &&
      getKind(d.kind).panel.composition !== 'chat',
  )!;

  /** A file peer on an `attached_to` edge — the shape `edges.list` answers. */
  function withAttachment(detail: EntityDetail, over?: Partial<{ name: string; mime: string }>): EntityDetail {
    const filePeer = {
      ...(anyDetail as unknown as EntitySummary),
      id: 'file-attached-1',
      title: over?.name ?? 'diagram.png',
      state: {
        kind: 'file',
        name: over?.name ?? 'diagram.png',
        mimeType: over?.mime ?? 'image/png',
        sizeBytes: 4096,
      },
    } as unknown as EntitySummary;
    return {
      ...detail,
      connections: {
        ...detail.connections,
        incoming: [
          ...detail.connections.incoming,
          {
            type: 'attached_to',
            direction: 'incoming',
            edges: [{ source: filePeer, target: detail as unknown as EntitySummary }],
          } as unknown as EntityDetail['connections']['incoming'][number],
        ],
      },
    };
  }

  it('STILL FOUR TABS with an attachment present — no fifth tab, ever', () => {
    const { getByTestId } = render(
      <EntityDetailPanel detail={withAttachment(anyDetail)} reasons={REASONS} ctx={ctx} />,
    );
    expect(within(getByTestId('panel-tabs')).getAllByRole('tab')).toHaveLength(4);
  });

  it('renders the attached file INSIDE the panel, with a working download link', () => {
    const { getByTestId } = render(
      <EntityDetailPanel
        detail={withAttachment(anyDetail)}
        reasons={REASONS}
        ctx={ctx}
        attachments={{
          downloadHref: (id) => `/v2/files/${id}/download`,
          startUpload: () => { throw new Error('unused'); },
          // Present because the port requires it, and THROWING is the point:
          // these tests assert rendering, so a detach reaching the seam here
          // would be a test wiring a mutation it never meant to make.
          detach: () => { throw new Error('unused'); },
        }}
      />,
    );
    const panel = getByTestId('entity-detail-panel');
    const strip = within(panel).getByTestId('attachment-strip');
    const img = within(strip).getByAltText('diagram.png') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/v2/files/file-attached-1/download');
    expect(within(strip).getByTestId('attachment-file-input')).toBeTruthy();
  });

  it('renders NOTHING for an entity with no attachments and no uploader', () => {
    const { getByTestId, queryByTestId } = render(
      <EntityDetailPanel detail={anyDetail} reasons={REASONS} ctx={ctx} />,
    );
    expect(getByTestId('entity-detail-panel')).toBeTruthy();
    expect(queryByTestId('attachment-strip')).toBeNull();
  });

  it('is kind-agnostic: EVERY non-terminal, non-chat kind with a fixture mounts the strip', () => {
    // The claim the brief made ("wire it into the shared/generic body path so
    // it appears for task, doc, work_session etc.") measured rather than
    // asserted once on a task and generalised.
    //
    // D2 (session-UI design v1, 2026-08-06) narrows "every non-terminal kind"
    // — deliberately overturning the earlier universal half of this test:
    // a `composition: 'chat'` body (channel's hub) ends at its composer, whose
    // + button already owns attach, so the strip there was duplication.
    const covered = allKinds()
      .map((config) => ({
        config,
        detail: Object.values(fixtureDetails).find((d) => d.kind === config.kind && d.deletedAt == null),
      }))
      .filter(
        (r) =>
          r.detail != null &&
          r.config.panel.archetype !== 'terminal' &&
          r.config.panel.composition !== 'chat',
      );
    expect(covered.length).toBeGreaterThan(8);

    for (const { config, detail } of covered) {
      const { getByTestId, unmount } = render(
        <EntityDetailPanel detail={withAttachment(detail!)} reasons={REASONS} ctx={ctx} />,
      );
      expect(
        within(getByTestId('entity-detail-panel')).queryByTestId('attachment-strip'),
        `${config.kind} did not mount the attachment strip`,
      ).not.toBeNull();
      unmount();
    }
  });

  it('a chat composition (channel) mounts NO strip — the composer + owns attach', () => {
    const { getByTestId, queryByTestId } = render(
      <EntityDetailPanel
        detail={withAttachment(fixtureDetails[channelDesign.id]!)}
        reasons={REASONS}
        ctx={ctx}
      />,
    );
    expect(getByTestId('entity-detail-panel')).toBeTruthy();
    expect(queryByTestId('attachment-strip')).toBeNull();
  });
});

/**
 * AN ATTACHED IMAGE IS ONLY HALF THE FEATURE. The strip proves a file is on the
 * record; putting one INSIDE the prose is the other half, and it was dead in a
 * quiet way — `Markdown`'s `img` override has always resolved `tm8://file/<id>`
 * through an injected `fileHref`, and NOTHING passed one. So every internal
 * image in every doc rendered as the chip that says "this build has no resolver
 * for tm8 file references", which reads as a missing feature rather than a
 * missing prop.
 *
 * The resolver is the SAME `downloadHref` the strip already receives, which is
 * the assertion below: not "an image appeared" but "it points at the bytes the
 * download link points at". One resolver, or the two surfaces drift.
 */
describe('EntityDetailPanel — internal images resolve through the host port', () => {
  const readerKind = allKinds().find((k) => k.panel.archetype === 'reader')!;
  const docDetail = Object.values(fixtureDetails).find(
    (d) => d.kind === readerKind.kind && d.deletedAt == null,
  )!;

  function withBody(detail: EntityDetail, body: string): EntityDetail {
    return { ...detail, content: { ...detail.content, body } as EntityDetail['content'] };
  }

  const BODY = '# Diagram\n\n![the shape](tm8://file/file-in-body-1)\n';

  it('renders the image against the resolver the strip uses', () => {
    const { getByTestId } = render(
      <EntityDetailPanel
        detail={withBody(docDetail, BODY)}
        reasons={REASONS}
        ctx={ctx}
        attachments={{
          downloadHref: (id) => `/v2/files/${id}/download`,
          startUpload: () => { throw new Error('unused'); },
          // Present because the port requires it, and THROWING is the point:
          // these tests assert rendering, so a detach reaching the seam here
          // would be a test wiring a mutation it never meant to make.
          detach: () => { throw new Error('unused'); },
        }}
      />,
    );
    const img = within(getByTestId('entity-detail-panel')).getByTestId('markdown-image');
    expect(img.getAttribute('src')).toBe('/v2/files/file-in-body-1/download');
  });

  it('still states itself when the host has no port — never a guessed URL', () => {
    const { getByTestId, queryByTestId } = render(
      <EntityDetailPanel detail={withBody(docDetail, BODY)} reasons={REASONS} ctx={ctx} />,
    );
    const panel = getByTestId('entity-detail-panel');
    expect(within(panel).queryByTestId('markdown-image')).toBeNull();
    expect(within(panel).getByTestId('markdown-image-unresolved')).toBeTruthy();
    expect(queryByTestId('markdown-image-link')).toBeNull();
  });

  it('never fetches a remote image, resolver or not (the tracking-beacon rule)', () => {
    const { getByTestId } = render(
      <EntityDetailPanel
        detail={withBody(docDetail, '![pixel](https://elsewhere.example/p.gif)')}
        reasons={REASONS}
        ctx={ctx}
        attachments={{
          downloadHref: (id) => `/v2/files/${id}/download`,
          startUpload: () => { throw new Error('unused'); },
          // Present because the port requires it, and THROWING is the point:
          // these tests assert rendering, so a detach reaching the seam here
          // would be a test wiring a mutation it never meant to make.
          detach: () => { throw new Error('unused'); },
        }}
      />,
    );
    const panel = getByTestId('entity-detail-panel');
    expect(within(panel).queryByTestId('markdown-image')).toBeNull();
    expect(within(panel).getByTestId('markdown-image-link')).toBeTruthy();
  });
});

/**
 * THE FILE PANEL'S OWN PREVIEW. `file-preview` drew an empty box captioned
 * "image preview · image/png" — a label naming the exact thing it was not
 * doing — because the block had no way to reach the bytes. It takes the host's
 * resolver now, and it is gated by the same `canThumbnail` the strip uses so
 * the SVG-not-inline rule has one home rather than two.
 */
describe('file-preview renders the real image', () => {
  const fileKind = allKinds().find((k) =>
    (k.panel.blocks ?? []).some((b) => b.block === 'file-preview'),
  )!;
  const base = Object.values(fixtureDetails).find(
    (d) => d.kind === fileKind.kind && d.deletedAt == null,
  )!;

  const withMime = (mime: string): EntityDetail => ({
    ...base,
    state: { ...base.state, mimeType: mime } as EntityDetail['state'],
  });
  const port = {
    downloadHref: (id: string) => `/v2/files/${id}/download`,
    startUpload: () => { throw new Error('unused'); },
    detach: () => { throw new Error('unused'); },
  };

  it('draws an <img> at the resolved URL for a previewable image', () => {
    const { getByTestId } = render(
      <EntityDetailPanel detail={withMime('image/png')} reasons={REASONS} ctx={ctx} attachments={port} />,
    );
    const img = within(getByTestId('block-file-preview')).getByTestId('file-preview-image');
    expect(img.getAttribute('src')).toBe(`/v2/files/${base.id}/download`);
  });

  it('refuses SVG inline and SAYS SO — the server will not serve it inline either', () => {
    const { getByTestId } = render(
      <EntityDetailPanel detail={withMime('image/svg+xml')} reasons={REASONS} ctx={ctx} attachments={port} />,
    );
    const block = getByTestId('block-file-preview');
    expect(within(block).queryByTestId('file-preview-image')).toBeNull();
    expect(block.textContent).toContain('script-bearing document');
  });

  it('with no resolver says the bytes are unreachable, not that the type has no preview', () => {
    // The fixture carries `content.downloadUrl`, which a real detail does not;
    // dropping it is what makes this the no-way-to-fetch case rather than the
    // fixture's own fallback quietly answering.
    const unreachable = withMime('image/png');
    const { getByTestId } = render(
      <EntityDetailPanel
        detail={{ ...unreachable, content: { ...unreachable.content, downloadUrl: undefined } as EntityDetail['content'] }}
        reasons={REASONS}
        ctx={ctx}
      />,
    );
    const block = getByTestId('block-file-preview');
    expect(within(block).queryByTestId('file-preview-image')).toBeNull();
    expect(block.textContent).toContain('no download URL');
  });
});
