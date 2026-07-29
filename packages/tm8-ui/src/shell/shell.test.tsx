// @vitest-environment jsdom
/**
 * Shell composition tests — anatomy and behavior, NOT layout.
 *
 * jsdom has no layout engine, so nothing here asserts a width, a breakpoint, or
 * a rendered position; D10 makes real-browser pixel acceptance a named
 * precondition of the R5 gate and these tests do not stand in for it. What they
 * do cover: the three menu row grammars, the fail-closed path end to end, D1's
 * retired toggle, the notice vocabulary, and the Esc law.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { EntityId, MenuConfig, SpaceId, SpaceSummary } from '@tm8/contract';
import { MenuRail, type KindPresenter, type RefPresentation } from './MenuRail';
import { SpaceTabBar } from './SpaceTabBar';
import { PanelStack } from './PanelStack';
import { NoticeHost } from './NoticeHost';
import { REASONS, SHIPPED_DEFAULT_MENU } from '../domain';
import { resolveMenu } from './menu-resolve';
import { demotionNotice, describeDropped, overflowNotice } from './notices';
import type { NavPort } from './nav-port';

/** Stand-in for the domain registry (A1a's). Shell must never map kinds itself. */
const presentKind: KindPresenter = (ref) => {
  const table: Record<string, RefPresentation> = {
    task: { label: 'Tasks', icon: '◔', badge: 18 },
    work_session: { label: 'Sessions', icon: '▣', live: 3 },
    doc: { label: 'Docs', icon: '▤' },
    team_member: { label: 'Teammates', icon: '◯' },
    project: { label: 'Projects', icon: '⬒' },
    pull_request: { label: 'Pull requests', icon: '⑂' },
    member: { label: 'Members', icon: '◯' },
  };
  return table[ref] ?? null;
};

const renderRail = (props: Partial<React.ComponentProps<typeof MenuRail>> = {}) =>
  render(
    <div className="cv2-root">
      <MenuRail
        config={SHIPPED_DEFAULT_MENU}
        collapsed={false}
        onToggle={() => {}}
        onNavigate={() => {}}
        presentKind={presentKind}
        {...props}
      />
    </div>,
  );

describe('MenuRail — three row grammars, chosen by data shape (LLD §4.1)', () => {
  it('GRAMMAR 1: a group header is a label and nothing else — never clickable', () => {
    const { container } = renderRail();
    const headers = container.querySelectorAll('.shell-rail__header');
    expect(headers).toHaveLength(SHIPPED_DEFAULT_MENU.groups.length);
    headers.forEach((header) => {
      // Not a button, not focusable, no handler surface.
      expect(header.tagName).not.toBe('BUTTON');
      expect(header.getAttribute('tabindex')).toBeNull();
      expect(header.closest('button')).toBeNull();
    });
    expect(headers[0]?.textContent).toBe('Home');
  });

  it('GRAMMAR 2: a plain item renders one navigating row with its glyph', () => {
    const onNavigate = vi.fn();
    const { getByText } = renderRail({ onNavigate });
    fireEvent.click(getByText('Pull requests'));
    expect(onNavigate).toHaveBeenCalledWith({ type: 'kind', ref: 'pull_request' });
  });

  it('GRAMMAR 3: the caret row navigates on the ROW and toggles on the CARET', () => {
    const onNavigate = vi.fn();
    const { container, getByLabelText, queryByText } = renderRail({ onNavigate });

    // NOTE: "Workspace" legitimately appears TWICE — as the group header and as
    // the caret row beneath it. T1-1 draws exactly that, the two separated by
    // type treatment (mono 9.5px uppercase header vs 12.5px UI row), so the
    // query has to name the row rather than the text.
    const row = [...container.querySelectorAll('.shell-rail__row')].find((element) =>
      element.querySelector('.shell-rail__label')?.textContent === 'Workspace',
    ) as HTMLElement;
    expect(row).toBeDefined();

    // Ships expanded, per the canvas.
    expect(queryByText('Tasks')).not.toBeNull();

    // Caret collapses WITHOUT navigating — the two controls are independent.
    fireEvent.click(getByLabelText('Collapse Workspace'));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(queryByText('Tasks')).toBeNull();

    // Row click opens the composed view (RULING E) without re-expanding.
    fireEvent.click(row);
    expect(onNavigate).toHaveBeenCalledWith({ type: 'view', ref: 'workspace' });
    expect(queryByText('Tasks')).toBeNull();

    fireEvent.click(getByLabelText('Expand Workspace'));
    expect(queryByText('Tasks')).not.toBeNull();
  });

  it('renders leaves with the guide rule and no icon column (T1-1)', () => {
    const { container, getByText } = renderRail();
    const leaf = getByText('Sessions').closest('.shell-rail__leaf');
    expect(leaf).not.toBeNull();
    expect(leaf?.querySelector('.shell-rail__guide')).not.toBeNull();
    expect(leaf?.querySelector('.shell-rail__icon')).toBeNull();
    expect(container.querySelectorAll('.shell-rail__leaf')).toHaveLength(4);
  });

  it('marks the active target with aria-current, and only that one', () => {
    const { container } = renderRail({ activeTarget: { type: 'kind', ref: 'task' } });
    const current = container.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain('Tasks');
  });

  it('is DISCRETE: 165 expanded, 48 collapsed, nothing between', () => {
    const { container: expanded } = renderRail({ collapsed: false });
    const { container: collapsed } = renderRail({ collapsed: true });
    expect((expanded.querySelector('[data-testid="menu-rail"]') as HTMLElement).style.width).toBe(
      '165px',
    );
    expect((collapsed.querySelector('[data-testid="menu-rail"]') as HTMLElement).style.width).toBe(
      '48px',
    );
  });

  it('collapsed renders icons only — labels, leaves and headers all go', () => {
    const { container, queryByText } = renderRail({ collapsed: true });
    expect(queryByText('Tasks')).toBeNull();
    expect(container.querySelectorAll('.shell-rail__leaf')).toHaveLength(0);
    expect(container.querySelectorAll('.shell-rail__header')).toHaveLength(0);
    // Group headers degrade to dividers rather than vanishing.
    expect(container.querySelectorAll('.shell-rail__divider').length).toBeGreaterThan(0);
  });

  it('collapsed corner marks render their NUMBERS — both of them (D31)', () => {
    // RENAMED AND REWRITTEN. The previous version was called "collapsed demotes
    // counts to corner marks rather than dropping them" and asserted the badge's
    // NUMBER but only that the live element was NOT NULL — an assertion a
    // decorative dot satisfies while carrying no count at all. It stood green
    // over exactly the defect its name denied. Both halves now assert the
    // information, not the element.
    const config: MenuConfig = {
      schemaVersion: 1,
      revision: 1,
      groups: [
        {
          id: 'library',
          label: 'Library',
          items: [
            { type: 'kind', ref: 'task' },
            { type: 'kind', ref: 'work_session' },
            { type: 'view', ref: 'settings' },
          ],
        },
      ],
    };
    const { container } = renderRail({ collapsed: true, config });
    expect(container.querySelector('.shell-rail__badge-corner')?.textContent).toBe('18');
    expect(container.querySelector('.shell-rail__live-corner')?.textContent).toBe('3');
  });

  it('collapsed marks do not collide: badge takes one corner, live the other', () => {
    // Both are absolutely positioned; before D31 they sat 1-2px apart, which was
    // latent only because one was a dot. Now that both are numeric pills, a row
    // carrying both would render two unreadable overlapping numbers.
    const config: MenuConfig = {
      schemaVersion: 1,
      revision: 1,
      groups: [{
        id: 'g',
        label: 'G',
        items: [{ type: 'kind', ref: 'both' } as never, { type: 'view', ref: 'settings' }],
      }],
    };
    const presentBoth: KindPresenter = (ref) =>
      ref === 'both' ? { label: 'Both', icon: '◔', badge: 18, live: 3 } : null;
    const { container } = renderRail({ collapsed: true, config, presentKind: presentBoth });
    const badge = container.querySelector('.shell-rail__badge-corner');
    const live = container.querySelector('.shell-rail__live-corner');
    expect(badge?.textContent).toBe('18');
    expect(live?.textContent).toBe('3');
    // Distinct elements in distinct corners — asserted via the class contract
    // the stylesheet keys off, since jsdom computes no geometry (D10).
    expect(badge).not.toBe(live);
  });

  it('the collapsed row NAMES both counts to assistive tech (D31)', () => {
    // An aria-label on a button REPLACES the name computed from its contents, so
    // every corner mark inside is invisible to AT regardless of what it renders.
    // Before D31 the label was the bare kind name: sighted users got the badge
    // number, AT users got nothing — the same information dropped, differently,
    // in both marks. The label is now composed from the parts.
    const config: MenuConfig = {
      schemaVersion: 1,
      revision: 1,
      groups: [{
        id: 'g',
        label: 'G',
        items: [{ type: 'kind', ref: 'both' } as never, { type: 'view', ref: 'settings' }],
      }],
    };
    const presentBoth: KindPresenter = (ref) =>
      ref === 'both' ? { label: 'Sessions', icon: '▣', badge: 18, live: 3 } : null;
    const { getByLabelText } = renderRail({ collapsed: true, config, presentKind: presentBoth });
    // C8/L10 asymmetry: `live` is a STATUS so it carries the WORD; `badge` is a
    // quantity and is complete as a number.
    getByLabelText('Sessions, 18, 3 live');
  });

  it('the EXPANDED live mark carries the word "live", not a bare number (C8/L10)', () => {
    const { container } = renderRail();
    const live = container.querySelector('.shell-rail__live');
    // Colour alone never carries status; the word rides along visually-hidden.
    expect(live?.textContent).toContain('live');
  });

  it('gives every collapsed row an accessible name (icons alone are not a label)', () => {
    // NOTE: `toBeTruthy` here is satisfied by any non-empty string, including
    // the bare kind name that dropped both counts before D31. The assertion
    // that the name CARRIES the counts is a separate test above; this one only
    // covers the weaker "every row is named at all".
    const { container } = renderRail({ collapsed: true });
    container.querySelectorAll('.shell-rail__row').forEach((row) => {
      expect(row.getAttribute('aria-label')).toBeTruthy();
    });
  });

  it('renders add-server DISABLED WITH REASON — never hidden, never faked (L6/R10)', () => {
    const { getByTitle } = renderRail();
    // D28: aria-disabled AND still focusable. The previous version asserted
    // `control.disabled === true`, which pinned the violation in place — a
    // natively disabled control leaves the tab order, so the reason it carries
    // becomes unreachable for keyboard and screen-reader users.
    const control = getByTitle(REASONS.addServerDeferred) as HTMLButtonElement;
    // D28's trio, per A1a: PRESENT, ANNOUNCED, and REACHABLE.
    expect(control.getAttribute('aria-disabled')).toBe('true'); // announced
    expect(control.disabled).toBe(false); // inverted guard: native attr must NOT return
    control.focus(); // reachable — the reason is useless if you cannot land on it
    expect(document.activeElement).toBe(control);
  });

  it('drops a ref it cannot present rather than drawing a blank row', () => {
    // DEFENCE IN DEPTH, not the primary mechanism. The real guard is upstream:
    // `resolveMenu` fails the whole config closed onto the shipped default when
    // it names kind refs the registry cannot render (reason 'unrenderable-refs'),
    // so a viewer is never silently short a row. This only covers a presenter
    // that returns null after that check has already passed.
    const { queryByText } = renderRail({ presentKind: () => null });
    expect(queryByText('Tasks')).toBeNull();
    // View refs still resolve — they are shell's own table.
    expect(queryByText('Dashboard')).not.toBeNull();
  });
});

describe('MenuRail — fail-closed rendering, end to end (§4.1)', () => {
  const renderResolved = (raw: MenuConfig | null, error?: unknown) => {
    const { config } = resolveMenu(raw, error);
    return renderRail({ config });
  };

  it('renders the shipped default when the seam resolves null (the Phase-1 path)', () => {
    // createFixtureSeam ships no menu row, so this IS the gate rendering.
    const { container, getByText } = renderResolved(null);
    // Row labels, not raw text: group headers legitimately repeat these words.
    const labels = [...container.querySelectorAll('.shell-rail__label')].map((n) => n.textContent);
    expect(labels).toContain('Workspace');
    expect(labels).toContain('Settings');
    getByText('Tasks');
  });

  it('renders the shipped default for a future schemaVersion instead of nothing', () => {
    const { container } = renderResolved({ schemaVersion: 4, revision: 1, groups: [] } as never);
    const labels = [...container.querySelectorAll('.shell-rail__label')].map((n) => n.textContent);
    expect(labels).toContain('Dashboard');
    expect(labels).toContain('Settings');
  });

  it('renders a valid custom config faithfully — data drives the rail', () => {
    const custom: MenuConfig = {
      schemaVersion: 1,
      revision: 12,
      groups: [
        { id: 'ops', label: 'Ops', items: [{ type: 'kind', ref: 'task' }] },
        { id: 'admin', label: 'Admin', items: [{ type: 'view', ref: 'settings' }] },
      ],
    };
    const { getByText, queryByText } = renderResolved(custom);
    getByText('Ops');
    getByText('Tasks');
    // The shipped default's groups are NOT merged in.
    expect(queryByText('Tracking')).toBeNull();
  });

  it('always keeps a route to settings, whatever the server said', () => {
    for (const input of [null, {} as MenuConfig, { schemaVersion: 9 } as never]) {
      const { container, unmount } = renderResolved(input);
      const labels = [...container.querySelectorAll('.shell-rail__label')].map((n) => n.textContent);
      expect(labels).toContain('Settings');
      unmount();
    }
  });
});

describe('SpaceTabBar (T0-1, D1)', () => {
  const spaces = [
    { id: 'sp_1' as SpaceId, name: 'atelier' },
    { id: 'sp_2' as SpaceId, name: 'playground' },
  ] as SpaceSummary[];

  const renderBar = (props: Partial<React.ComponentProps<typeof SpaceTabBar>> = {}) =>
    render(
      <div className="cv2-root">
        <SpaceTabBar
          spaces={spaces}
          activeSpaceId={'sp_1' as SpaceId}
          onSelectSpace={() => {}}
          {...props}
        />
      </div>,
    );

  it('D1: renders NO ◐ theme toggle, even though the T0-1 canvas draws one', () => {
    // This assertion is the point of the entry: the amendment supersedes the
    // pixels, so "restoring" the toggle to match the canvas is a regression.
    const { container } = renderBar();
    expect(container.textContent).not.toContain('◐');
    expect(container.querySelector('.shell-tabbar__theme')).toBeNull();
  });

  it('exposes the account menu — theme’s one home per D1', () => {
    const onOpenAccount = vi.fn();
    const { getByLabelText } = renderBar({ onOpenAccount, accountInitial: 'A' });
    fireEvent.click(getByLabelText('Toggle theme'));
    expect(onOpenAccount).toHaveBeenCalled();
  });

  it('marks exactly one space tab selected and switches on click', () => {
    const onSelectSpace = vi.fn();
    const { getAllByRole, getByText } = renderBar({ onSelectSpace });
    const selected = getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toContain('atelier');
    fireEvent.click(getByText('playground'));
    expect(onSelectSpace).toHaveBeenCalledWith('sp_2');
  });

  it('shows the selected Server immediately after the tm8 mark', () => {
    const { container, getByLabelText } = renderBar({
      activeServer: { label: 'ec2 · ubuntu', reachability: 'online' },
    });
    expect(getByLabelText('Selected server: ec2 · ubuntu, online')).toBeTruthy();
    const mark = container.querySelector('.shell-tabbar__mark');
    expect(mark?.nextElementSibling?.classList.contains('shell-tabbar__server')).toBe(true);
  });

  it('renders add-space disabled-with-reason rather than hiding it (L6)', () => {
    const control = renderBar().getByLabelText('Add space') as HTMLButtonElement;
    expect(control.getAttribute('aria-disabled')).toBe('true'); // announced
    expect(control.disabled).toBe(false); // inverted guard against the native attr
    control.focus(); // reachable
    expect(document.activeElement).toBe(control);
  });
});

describe('PanelStack — render order and the Esc law (§5.2/§5.3)', () => {
  const makeNav = (stack: string[], pinned: string[]): NavPort & { popped: number } => {
    const port = {
      stack: stack as EntityId[],
      pinned: pinned as EntityId[],
      popped: 0,
      push: () => {},
      pop() {
        port.popped += 1;
      },
      close: () => {},
      pin: () => ({ ok: true as const }),
      unpin: () => {},
      promote: () => {},
      applyNormalization: () => {},
    };
    return port;
  };

  const renderStack = (nav: NavPort, props: Partial<React.ComponentProps<typeof PanelStack>> = {}) =>
    render(
      <div className="cv2-root">
        <PanelStack nav={nav} renderPanel={(id) => <span>{id}</span>} {...props} />
      </div>,
    );

  it('orders columns pins-left-to-right then stack-top RIGHTMOST', () => {
    const nav = makeNav(['s1', 's2'], ['p1', 'p2']);
    const { container } = renderStack(nav);
    const columns = [...container.querySelectorAll('.shell-stack__col')];
    expect(columns.map((c) => c.getAttribute('data-panel-id'))).toEqual(['p1', 'p2', 's2']);
    // Only the stack TOP renders — that is why the whole stack costs ONE slot.
    expect(container.textContent).not.toContain('s1');
  });

  it('renders one slot for a stack of any depth', () => {
    const { container } = renderStack(makeNav(['a', 'b', 'c', 'd'], []));
    expect(container.querySelectorAll('.shell-stack__col')).toHaveLength(1);
    expect(container.querySelector('[data-testid="panel-stack"]')?.getAttribute('data-slots')).toBe(
      '1',
    );
  });

  it('labels each column with its host so the panel can pick its chrome', () => {
    const { container } = renderStack(makeNav(['s1'], ['p1']));
    const hosts = [...container.querySelectorAll('.shell-stack__col')].map((c) =>
      c.getAttribute('data-host'),
    );
    expect(hosts).toEqual(['pinned', 'stack']);
  });

  it('keeps the empty-center slot rather than collapsing it (02-LAYOUT §2.2)', () => {
    const { container } = renderStack(makeNav([], []));
    expect(container.querySelector('.shell-stack--empty')).not.toBeNull();
  });

  it('ESC pops the stack top', () => {
    const nav = makeNav(['s1', 's2'], ['p1']);
    renderStack(nav);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav.popped).toBe(1);
  });

  it('ESC NEVER pops a pin — with an empty stack it does nothing at all', () => {
    const nav = makeNav([], ['p1', 'p2']);
    renderStack(nav);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav.popped).toBe(0);
    expect(nav.pinned).toEqual(['p1', 'p2']);
  });

  it('ESC stands aside when a higher keyboard layer owns it (§7)', () => {
    const nav = makeNav(['s1'], []);
    renderStack(nav, { isKeyboardOwnedAbove: () => true });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav.popped).toBe(0);
  });

  it('ignores keys that are not Escape', () => {
    const nav = makeNav(['s1'], []);
    renderStack(nav);
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'p' });
    expect(nav.popped).toBe(0);
  });

  it('detaches its listener on unmount', () => {
    const nav = makeNav(['s1'], []);
    const { unmount } = renderStack(nav);
    unmount();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav.popped).toBe(0);
  });
});

describe('notice vocabulary (T1-4 / R4-7)', () => {
  it('names the CLASS of dropped state and never a raw id', () => {
    const body = describeDropped({ pin: 2, filter: 1 });
    expect(body).toBe("2 pinned panels and 1 filter weren't carried in this link.");
    expect(body).not.toMatch(/ent_|[0-9a-f]{8}-/);
  });

  it('matches the T1-4 canvas copy exactly for the drawn case', () => {
    const notice = overflowNotice({ pin: 2, filter: 1 });
    expect(notice?.title).toBe('Link restored partially');
    expect(notice?.body).toBe("2 pinned panels and 1 filter weren't carried in this link.");
    expect(notice?.ttlMs).toBe(6000);
  });

  it('singularizes honestly', () => {
    expect(describeDropped({ tab: 1 })).toBe("1 tab weren't carried in this link.");
    expect(describeDropped({ panel: 3 })).toBe("3 panels weren't carried in this link.");
  });

  it('emits nothing when nothing was dropped', () => {
    expect(describeDropped({})).toBeNull();
    expect(overflowNotice({ pin: 0 })).toBeNull();
    expect(demotionNotice([])).toBeNull();
  });

  it('gives repeat notices a STABLE id so cards aggregate instead of stacking', () => {
    expect(overflowNotice({ pin: 1 })?.id).toBe(overflowNotice({ tab: 4 })?.id);
    expect(demotionNotice(['a' as EntityId])?.id).toBe(
      demotionNotice(['a', 'b'] as EntityId[])?.id,
    );
  });

  it('demotion copy states the count and the irreversibility (§5.3)', () => {
    const notice = demotionNotice(['a', 'b'] as EntityId[]);
    expect(notice?.title).toBe('Pinned panels were unpinned');
    expect(notice?.body).toContain('2 pinned panels');
    expect(notice?.body).toContain('Widening does not restore them');
  });

  it('renders as an aria-live polite region with a dismiss control', () => {
    const onDismiss = vi.fn();
    const notice = overflowNotice({ pin: 2 })!;
    const { getByTestId } = render(
      <div className="cv2-root">
        <NoticeHost notices={[notice]} onDismiss={onDismiss} />
      </div>,
    );
    const host = getByTestId('notice-host');
    expect(host.getAttribute('aria-live')).toBe('polite');
    fireEvent.click(within(host).getByText('dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('route-overflow');
  });
});
