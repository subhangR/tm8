// @vitest-environment jsdom
/**
 * THE PANEL'S PHONE CHROME — the tab row is gone and its contents are data now.
 *
 * WHAT THIS FILE CAN AND CANNOT SEE. jsdom loads no stylesheets and has no
 * layout, so nothing here proves the band got shorter, that a chip clears 44px,
 * or that the emptied bar collapses to zero pixels. Those are measurements and
 * they belong to the instrument, not to vitest — `panel-controls-phone.css` says
 * which of its claims are which.
 *
 * What vitest CAN pin, and what every case below is about, is the part a
 * screenshot cannot distinguish:
 *
 *   · that the strip and the action cluster are ABSENT on a phone and PRESENT
 *     on a desktop. Asserted in both directions on purpose: a removal that also
 *     removed them from the desktop would satisfy half of this file and ship a
 *     regression to the shell that is in daily use;
 *   · that the menu's contents are DERIVED from the registry rather than typed
 *     out, which is checked by driving the assertion off `allKinds()` — add a
 *     kind, declare a primary, and it appears here without this file changing;
 *   · that a refused verb is IN the list carrying its reason, never omitted
 *     (house rule 1), and that refused and live are structurally distinguishable
 *     rather than one boolean.
 *
 * === RED-FIRST RECORD (measured; each break applied to the fixed tree, run,
 * captured, reverted). Instrument:
 *   ./node_modules/.bin/vitest run src/panels/detail/panel-phone-chrome.test.tsx
 * from `packages/tm8-ui`. Counts are in the PR body; the mutated line is printed
 * back in each entry because a zero-red mutation is usually a mutation that
 * failed to apply. ===
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ActorSummary, EntityDetail, EntityId } from '@tm8/contract';
import {
  REASONS as DOMAIN_REASONS,
  allKinds,
  getKind,
  resolveAction,
  type ActionContext,
  type ActionRef,
} from '../../domain';
import {
  FIXTURE_SPACE_ID,
  fixtureDetails,
  presenceHollowReason,
  taskUuidTitle,
} from '../../fixtures';
import { MobileSurfaceProvider } from '../../mobile';
import { EntityDetailPanel, type ControlHost, type DetailReasons } from '../index';
import { PANEL_TABS, panelActionContext, panelMenuItems, type PanelTab } from './chrome';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const REASONS: DetailReasons = {
  presenceHollow: presenceHollowReason,
  versionHistory: DOMAIN_REASONS.versionHistoryDeferred,
  provenanceHollow: 'Session provenance is not recorded yet.',
  shareUnavailable: 'not in the stamped seam',
  withdrawUnavailable: 'not in the stamped seam',
};

const TASK: EntityDetail = fixtureDetails[taskUuidTitle.id]!;

const ADA: ActorSummary = {
  id: 'member-ada' as EntityId,
  kind: 'member',
  displayName: 'Ada',
  avatar: null,
  isAgent: false,
};

function controlHost(): ControlHost {
  return {
    kind: 'task',
    ctx,
    capabilitiesOf: () => TASK.capabilities,
    onSetState: vi.fn(),
    onSetValue: vi.fn(),
    onAssign: vi.fn(),
    onArchive: vi.fn(),
    assignableActors: [ADA],
  };
}

/**
 * The panel inside the phone shell. `MobileSurfaceProvider` is the ONLY thing
 * that turns `oneSurface` on — there is no provider on any desktop path — so
 * wrapping in it is exactly the fork the shipped shell makes, and the desktop
 * helper below is the same mount with the wrapper removed and nothing else
 * changed.
 */
function onPhone(over: Partial<React.ComponentProps<typeof EntityDetailPanel>> = {}) {
  const host = document.createElement('div');
  host.className = 'msheet-host';
  document.body.append(host);
  return render(
    <div className="cv2-root" data-shell="mobile">
      <MobileSurfaceProvider sheetHost={host}>
        <EntityDetailPanel
          detail={TASK}
          reasons={REASONS}
          ctx={ctx}
          controls={controlHost()}
          onAction={() => {}}
          {...over}
        />
      </MobileSurfaceProvider>
    </div>,
  );
}

function onDesktop(over: Partial<React.ComponentProps<typeof EntityDetailPanel>> = {}) {
  return render(
    <EntityDetailPanel
      detail={TASK}
      reasons={REASONS}
      ctx={ctx}
      controls={controlHost()}
      onAction={() => {}}
      {...over}
    />,
  );
}

describe('the tab row is gone on a phone and untouched on a desktop', () => {
  it('a phone panel renders no tab strip and no action cluster', () => {
    const { queryByTestId } = onPhone();
    expect(queryByTestId('panel-tabs')).toBeNull();
    expect(queryByTestId('panel-action-bar')).toBeNull();
    /* The desktop bar's own id goes with it: a row that kept the name while
       containing neither the tabs nor the cluster would make every assertion
       against `panel-toolbar` in the four anatomy suites ambiguous instead of
       failing honestly. */
    expect(queryByTestId('panel-toolbar')).toBeNull();
  });

  it('a desktop panel still renders both — the removal is one shell declining, not a deletion', () => {
    const { getByTestId } = onDesktop();
    expect(getByTestId('panel-tabs')).not.toBeNull();
    expect(getByTestId('panel-action-bar')).not.toBeNull();
    /* Three tabs, off the same constant the phone declines to draw. If this
       count moves, the vocabulary was trimmed to fit a shell — which is the one
       thing the ruling forbids. */
    expect(getByTestId('panel-tabs').querySelectorAll('[role="tab"]')).toHaveLength(
      PANEL_TABS.length,
    );
  });

  it('the phone bar carries no element children when nothing needs saying', () => {
    /*
     * THE STRUCTURAL HALF OF "the row is absent entirely". `SaveControls` and
     * `TransferControl` both self-gate to null — a clean edit, and a node with no
     * remote server — so the row is one node with zero element children. That it
     * then occupies zero pixels is `:empty` in `panel-bar-phone.css`, and no
     * vitest in this repo loads a stylesheet; this is the half that can be
     * asserted, and asserting only it is why the other half is named here.
     *
     * `commands` is passed so `useTaskSave` reports the save as AVAILABLE-and-
     * clean rather than unavailable: without it `SaveControls` renders its
     * permanent refusal and the row is legitimately non-empty, which would make
     * this case pass for the wrong reason on a panel that has no save wiring.
     */
    const { getByTestId } = onPhone({
      commands: { patchTask: vi.fn() } as never,
    });
    expect(getByTestId('panel-phone-bar').childElementCount).toBe(0);
  });

  it('the phone body is the content tab even when the host controls it to another', () => {
    /*
     * `activeTab` is a controlled prop and `EntityView` drives it from state
     * shared with the desktop, so a back press or a restored route can leave it
     * holding an aux tab. The body must not then draw a connections list under
     * the sheet showing the same connections.
     *
     * ASSERTED ON `#tabpanel-connections`, which is the element `ConnectionsTab`
     * actually renders. The first draft of this case asserted a `panel-connections`
     * testid that does not exist anywhere in the tree, so it was null on both
     * sides of the clamp and the case passed with the clamp DELETED — a green
     * assertion about nothing. Found by mutation, recorded here because a
     * query for a witness that was never emitted is the quietest way a suite
     * can lie.
     */
    const phone = onPhone({ activeTab: 'connections' });
    expect(phone.container.querySelector('#tabpanel-connections')).toBeNull();

    /* And the same prop on a desktop DOES draw it — otherwise the case above
       would pass on a panel whose connections body had simply been deleted. */
    const desktop = onDesktop({ activeTab: 'connections' });
    expect(desktop.container.querySelector('#tabpanel-connections')).not.toBeNull();
  });
});

describe('what the phone action menu contains is derived, not typed out', () => {
  /* `panelActionContext` is what the panel feeds BOTH the action bar and the
     menu, and it is what carries the fixture's capabilities in. Building a bare
     `ctx` here instead would refuse every verb with "permissions are not known
     yet" and the suite would be asserting against a loading state. */
  const menu = (over: Partial<Parameters<typeof panelMenuItems>[0]> = {}) =>
    panelMenuItems({
      config: getKind('task'),
      ctx: panelActionContext(TASK, ctx),
      onSelectTab: () => {},
      onAction: () => {},
      ...over,
    });

  it('every kind gets a row for every primary its registry row declares', () => {
    /*
     * DRIVEN OFF `allKinds()`, so this assertion covers a kind that does not
     * exist yet. The point is not that task has two primaries today — it is that
     * nothing in `panelMenuItems` names a kind or an action, so declaring a new
     * primary in the registry produces a row without this file being touched.
     *
     * `processControlFor` may SWAP a ref (terminate → resume on a session that
     * has ended), so the assertion is on the COUNT and on the tabs being
     * present alongside, not on the declared ids surviving verbatim.
     *
     * THE COUNT IS EXACT, and that is what makes it the guard against a row
     * being invented here. The `+ 1` it carried until 2026-08-20 was `⤢ Open
     * full view` — a row this function typed out itself, refused on every mount
     * that exists, and the one thing in the menu the registry could not account
     * for. It is gone; the arithmetic says so.
     */
    const aux = PANEL_TABS.filter((t) => t.id !== 'content').length;
    for (const config of allKinds()) {
      const items = panelMenuItems({
        config,
        ctx: panelActionContext({ ...TASK, kind: config.kind } as EntityDetail, ctx),
        onSelectTab: () => {},
        onAction: () => {},
      });
      const declared = (config.panel.primaries ?? []).length;
      expect(items.length, `${config.kind}: ${aux} tabs + ${declared} primaries`).toBe(
        aux + declared,
      );
    }
  });

  it('a primary carries the registry\u2019s own label and glyph, never a typed-out one', () => {
    const items = menu();
    for (const ref of getKind('task').panel.primaries ?? []) {
      const def = resolveAction(ref as ActionRef);
      const row = items.find((i) => i.id === ref);
      expect(row, `${ref} has a row`).toBeDefined();
      expect(row?.label).toBe(def.label);
      expect(row?.glyph).toBe(def.icon);
    }
  });

  it('a refused primary is IN the list, dimmed, with its reason — never omitted', () => {
    /*
     * `wiredActions` is what a host uses to say WHICH verbs its dispatcher can
     * perform. Naming none of them refuses every primary, which is the R5 #9
     * unwired arm — and the assertion is that the rows are still there. House
     * rule 1: unavailable is never invisible.
     */
    const items = menu({ wiredActions: [] }).filter((i) =>
      (getKind('task').panel.primaries ?? []).includes(i.id as ActionRef),
    );
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.reason, `${item.id} carries a reason`).toBeTruthy();
      /*
       * REFUSED AND LIVE ARE STRUCTURALLY DIFFERENT, not one boolean. This is
       * the `panel-primary-<ref>` discipline carried into the data: the bar
       * marks its LIVE arm only, because a witness on both arms collapses
       * "pressable" and "refused-with-reason" into one fact. Here the same
       * discrimination is `onSelect` — a refused row has none, so it cannot be
       * activated by a menu that merely forgot to check `reason`.
       */
      expect(item.onSelect, `${item.id} cannot be activated`).toBeUndefined();
    }
  });

  it('a live primary dispatches through the host, and a refused one cannot', () => {
    const onAction = vi.fn();
    const live = menu({ onAction, wiredActions: ['edit'] }).find((i) => i.id === 'edit');
    expect(live?.reason).toBeUndefined();
    live?.onSelect?.();
    expect(onAction).toHaveBeenCalledWith('edit');
  });

  it('Run opens the host\u2019s full launch sheet rather than the inline expand', () => {
    /*
     * D44's precedence, which `mobile/CONTRACT.md` §4 makes mandatory here: the
     * inline expand is a 300px popover anchored to an action bar this shell no
     * longer has. Where the host mounts the sheet, Run opens it with the SUBJECT
     * — a sheet is bound to an entity and there is no subject in an action ref.
     */
    const onOpenLaunch = vi.fn();
    const run = menu({ onOpenLaunch, launchSubjectId: TASK.id }).find((i) => i.id === 'run');
    expect(run?.reason).toBeUndefined();
    run?.onSelect?.();
    expect(onOpenLaunch).toHaveBeenCalledWith(TASK.id);
  });

  it('a flow verb with no sheet is refused for the arrangement, not for missing plumbing', () => {
    /*
     * The merge confirm is a commitment card with no phone arrangement. The
     * failure this guards is the OPPOSITE of hiding it: dispatching it would
     * perform a merge with its confirmation step silently skipped. The reason
     * must therefore name the arrangement rather than say "isn't connected yet",
     * which would send the reader to fix plumbing that is not broken.
     */
    const items = panelMenuItems({
      config: getKind('pull_request'),
      ctx: panelActionContext({ ...TASK, kind: 'pull_request' } as EntityDetail, ctx),
      onSelectTab: () => {},
      onAction: () => {},
      wiredActions: [],
    });
    const merge = items.find((i) => i.id === 'merge-pr');
    expect(merge).toBeDefined();
    expect(merge?.onSelect).toBeUndefined();
    expect(merge?.reason).toContain('phone');
  });

  it('the two aux tabs select through onTabChange, carrying the counts the strip got', () => {
    const onSelectTab = vi.fn();
    const counts: Partial<Record<PanelTab, number>> = { discussion: 3, connections: 0 };
    const items = panelMenuItems({
      config: getKind('task'),
      ctx,
      counts,
      onSelectTab,
      onAction: () => {},
    });

    /* Content is NOT in the menu: it is the body, and a row that selects the
       thing already on screen is furniture. */
    expect(items.some((i) => i.id === 'content')).toBe(false);

    for (const { id, label } of PANEL_TABS.filter((t) => t.id !== 'content')) {
      const row = items.find((i) => i.id === id);
      expect(row?.label).toBe(label);
      /* A literal 0 renders: measured-zero is a real answer, and the count came
         from a read that actually ran. `toBe(0)` and not a truthiness check for
         exactly that reason. */
      expect(row?.count).toBe(counts[id]);
      row?.onSelect?.();
      expect(onSelectTab).toHaveBeenCalledWith(id);
    }
  });

  /**
   * `⤢ OPEN FULL VIEW` IS NOT IN THIS MENU — owner ruling 2026-08-20, on seeing
   * it: "who asked for full screen — if it's not there, don't show it".
   *
   * It was typed out here rather than derived, it was refused-with-reason on
   * every phone mount that exists (`EntityView` never wired `onPromote`, and
   * this shell has no second panel slot to promote a panel into), and the
   * refusal drew a four-line caption across the menu to say so. Disabled-with-
   * reason is the honest treatment of a verb the viewer cannot reach RIGHT NOW;
   * a verb with no implementation on this shell at all is a different thing,
   * and it belongs off the surface.
   *
   * ASSERTED ACROSS EVERY KIND, not just task: the row was unconditional, so a
   * check on one kind would pass again the moment it was reintroduced under any
   * gate at all.
   */
  it('offers no ⤢ Open full view row on any kind — the phone cannot promote a panel', () => {
    for (const config of allKinds()) {
      const items = panelMenuItems({
        config,
        ctx: panelActionContext({ ...TASK, kind: config.kind } as EntityDetail, ctx),
        onSelectTab: () => {},
        onAction: () => {},
      });
      expect(items.map((i) => i.id), config.kind).not.toContain('open-full-view');
      expect(items.some((i) => i.label.includes('full view')), config.kind).toBe(false);
    }
  });

  it('a session that has ended offers Resume, not a refused Terminate', () => {
    /*
     * The `processControlFor` swap the action bar makes, made here too. Without
     * it the menu would offer one permanently-refused verb on a dead session and
     * no way back — the hole the bar had until 2026-08-19, reopened on the one
     * shell where the bar no longer exists to compensate.
     */
    const items = panelMenuItems({
      config: getKind('work_session'),
      ctx: panelActionContext({ ...TASK, kind: 'work_session', category: 'done' } as EntityDetail, ctx),
      onSelectTab: () => {},
      onAction: () => {},
    });
    expect(items.some((i) => i.id === 'resume')).toBe(true);
    expect(items.some((i) => i.id === 'terminate')).toBe(false);
  });
});
