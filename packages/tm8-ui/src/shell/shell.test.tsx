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
import { SpaceSwitcher, SWITCHER_ADD_SERVER_REASON } from './SpaceSwitcher';
import { PanelStack } from './PanelStack';
import { NoticeHost } from './NoticeHost';
import { SHIPPED_DEFAULT_MENU } from '../domain';
import { resolveMenu } from './menu-resolve';
import { demotionNotice, describeDropped, overflowNotice } from './notices';
import type { NavPort } from './nav-port';

/** Stand-in for the domain registry (A1a's). Shell must never map kinds itself. */
const presentKind: KindPresenter = (ref) => {
  const table: Record<string, RefPresentation> = {
    task: { label: 'Tasks', icon: '◔', badge: 18, unseen: 4 },
    work_session: { label: 'Sessions', icon: '▣', live: 3 },
    doc: { label: 'Docs', icon: '▤' },
    channel: { label: 'Channels', icon: '#' },
    team_member: { label: 'Teammates', icon: '◯' },
    memory: { label: 'Memories', icon: '◈' },
    artifact: { label: 'Artifacts', icon: '❖' },
    loop: { label: 'Loops', icon: '↻' },
    file: { label: 'Files', icon: '▥' },
    project: { label: 'Projects', icon: '⬒' },
    pull_request: { label: 'Pull requests', icon: '⑂' },
    worktree: { label: 'Worktrees', icon: '⑂' },
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
  it('GRAMMAR 1: groups are boundaries, not printed labels (revision 11)', () => {
    // The expanded rail draws NO eyebrow headers — six intent clusters of one
    // or two rows each made a header above every row say what the row already
    // says. The label survives as the group's ACCESSIBLE name and the boundary
    // as spacing/hairlines.
    const { container } = renderRail();
    expect(container.querySelectorAll('.shell-rail__header')).toHaveLength(0);
    const groups = [...container.querySelectorAll('.shell-rail__group')];
    expect(groups).toHaveLength(SHIPPED_DEFAULT_MENU.groups.length);
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(
      SHIPPED_DEFAULT_MENU.groups.map((g) => g.label),
    );
  });

  /**
   * Menu revision 5 (user ruling 2026-08-01): CHANNELS LEFT THE RAIL. They are
   * entities, so they live in the Entity List Panel with every other
   * collection. The rail keeps the dynamic-group mechanism — voice rooms still
   * use it — so this asserts the mechanism still works AND that no channel row
   * or Channels header rides along on the shipped default.
   */
  it('appends dynamic voice rows beneath the Channels cluster (revision 12)', () => {
    const onNavigate = vi.fn();
    const { container, getByText } = renderRail({
      onNavigate,
      dynamicGroups: {
        channels: {
          items: [{ id: 'vc-studio', kind: 'voice_channel', label: 'studio', icon: '\u266a', live: 2 }],
        },
      },
    });

    const channels = [...container.querySelectorAll('.shell-rail__group')].find(
      (group) => group.getAttribute('aria-label') === 'Channels',
    ) as HTMLElement;
    expect(channels).toBeDefined();
    // Authored conversation rows stay \u2014 the dynamic rows APPEND, never replace.
    expect(within(channels).getByText('Channels')).toBeTruthy();
    expect(within(channels).getByText('Messages')).toBeTruthy();
    expect(channels.querySelectorAll('[data-entity-id]')).toHaveLength(1);

    fireEvent.click(getByText('studio'));
    expect(onNavigate).toHaveBeenCalledWith({ type: 'entity', ref: 'vc-studio', kind: 'voice_channel' });
  });

  it('GRAMMAR 2: a plain item renders one navigating row with its glyph', () => {
    const onNavigate = vi.fn();
    const { getByText } = renderRail({ onNavigate });
    fireEvent.click(getByText('Channels'));
    expect(onNavigate).toHaveBeenCalledWith({ type: 'kind', ref: 'channel' });
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

    // Revision 11: carets ship CLOSED — ~8 intent rows on first paint, the
    // classification one caret-click deeper.
    expect(queryByText('Tasks')).toBeNull();

    // Caret expands WITHOUT navigating — the two controls are independent.
    fireEvent.click(getByLabelText('Expand Workspace'));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(queryByText('Tasks')).not.toBeNull();

    // Row click opens the composed view (RULING E) without re-collapsing.
    fireEvent.click(row);
    expect(onNavigate).toHaveBeenCalledWith({ type: 'view', ref: 'workspace' });
    expect(queryByText('Tasks')).not.toBeNull();

    fireEvent.click(getByLabelText('Collapse Workspace'));
    expect(queryByText('Tasks')).toBeNull();
  });

  it('renders leaves with the guide rule and no icon column (T1-1)', () => {
    const { container, getByText, getByLabelText } = renderRail();
    fireEvent.click(getByLabelText('Expand Workspace'));
    const leaf = getByText('Sessions').closest('.shell-rail__leaf');
    expect(leaf).not.toBeNull();
    expect(leaf?.querySelector('.shell-rail__guide')).not.toBeNull();
    expect(leaf?.querySelector('.shell-rail__icon')).toBeNull();
    const leaves = [...container.querySelectorAll('.shell-rail__leaf')];
    expect(leaves).toHaveLength(8);
    // Revision 11: channel left for Chats; file fills the eighth slot.
    expect(leaves.map((row) => row.querySelector('.shell-rail__label')?.textContent)).toEqual([
      'Tasks', 'Sessions', 'Docs', 'Teammates', 'Memories', 'Artifacts', 'Loops', 'Files',
    ]);
  });

  it('renders the dev collections as ordinary Work rows with the git view beneath (revision 12, R3/D1)', () => {
    // The Code caret retired with its group: no caret hides these three, and
    // the git topology view survives as a plain navigating row.
    const onNavigate = vi.fn();
    const { container, getByText, queryByLabelText } = renderRail({ onNavigate });
    expect(queryByLabelText('Expand Code')).toBeNull();
    const work = [...container.querySelectorAll('.shell-rail__group')].find(
      (group) => group.getAttribute('aria-label') === 'Work',
    ) as HTMLElement;
    const rows = [...work.querySelectorAll('.shell-rail__row')];
    expect(rows.map((row) => row.querySelector('.shell-rail__label')?.textContent)).toEqual([
      'Workspace', 'Projects', 'Pull requests', 'Worktrees', 'Code',
    ]);
    fireEvent.click(within(work).getByText('Pull requests'));
    expect(onNavigate).toHaveBeenCalledWith({ type: 'kind', ref: 'pull_request' });
    fireEvent.click(within(work).getByText('Code'));
    expect(onNavigate).toHaveBeenCalledWith({ type: 'view', ref: 'git' });
  });

  it('marks the active target with aria-current, and only that one', () => {
    const { container } = renderRail({ activeTarget: { type: 'kind', ref: 'channel' } });
    const current = container.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain('Channels');
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

  /**
   * REWRITTEN, and the rename records what changed. This used to assert that
   * LEAVES GO when the rail collapses, and that was survivable only while the
   * rail opened expanded — collapsing was then a deliberate act by someone who
   * knew what they were hiding. The rail now opens COLLAPSED, and the shipped
   * default hangs eight destinations (Tasks, Sessions, Docs, Channels,
   * Teammates, Memories, Artifacts, Loops) off one caret row: dropping leaves
   * would make the first paint of the product unable to reach any of them.
   *
   * What a 48px rail has no room for is the WORD, not the row. So the law the
   * assertions below hold is the one that was always meant: collapsed renders
   * ICONS ONLY. Every label goes; nothing navigable goes with it.
   */
  it('collapsed renders icons only — labels and headers go, destinations do not', () => {
    const { container, queryByText, getByRole } = renderRail({ collapsed: true });
    // No WORDS anywhere: not on the row, not on the leaf.
    expect(queryByText('Tasks')).toBeNull();
    expect(container.querySelectorAll('.shell-rail__label')).toHaveLength(0);
    expect(container.querySelectorAll('.shell-rail__header')).toHaveLength(0);
    // Group headers degrade to dividers rather than vanishing.
    expect(container.querySelectorAll('.shell-rail__divider').length).toBeGreaterThan(0);
    // The leaf is still THERE, still navigable, and still says what it is to
    // assistive tech — an icon whose only name is a tooltip is not a control.
    expect(container.querySelectorAll('.shell-rail__leaf').length).toBeGreaterThan(0);
    expect(getByRole('button', { name: /^Tasks/ })).toBeTruthy();
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
    // The badge corner reports NEWS (4 unseen of 18), not the lifetime total.
    expect(container.querySelector('.shell-rail__badge-corner')?.textContent).toBe('4');
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
      ref === 'both' ? { label: 'Both', icon: '◔', badge: 18, unseen: 4, live: 3 } : null;
    const { container } = renderRail({ collapsed: true, config, presentKind: presentBoth });
    const badge = container.querySelector('.shell-rail__badge-corner');
    const live = container.querySelector('.shell-rail__live-corner');
    expect(badge?.textContent).toBe('4');
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
    const { container, getByLabelText } = renderRail();
    fireEvent.click(getByLabelText('Expand Workspace'));
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

  it('renders the identity slot at the head of the scroll area', () => {
    // The in-rail server rows and the add-server footer RETIRED with revision
    // 11 — the identity block (SpaceSwitcher) is their one successor, and the
    // rail hosts it as a slot rather than knowing servers itself.
    const { container } = renderRail({ identitySlot: <div data-testid="ident" /> });
    const scroll = container.querySelector('.shell-rail__scroll');
    expect(scroll?.firstElementChild?.getAttribute('data-testid')).toBe('ident');
    expect(container.querySelector('.shell-rail__servers')).toBeNull();
    expect(container.textContent).not.toContain('add server');
  });

  it('drops a ref it cannot present rather than drawing a blank row', () => {
    // DEFENCE IN DEPTH, not the primary mechanism. The real guard is upstream:
    // `resolveMenu` fails the whole config closed onto the shipped default when
    // it names kind refs the registry cannot render (reason 'unrenderable-refs'),
    // so a viewer is never silently short a row. This only covers a presenter
    // that returns null after that check has already passed.
    const { queryByText } = renderRail({ presentKind: () => null });
    expect(queryByText('Channels')).toBeNull();
    // View refs still resolve — they are shell's own table. (Revision 13
    // retired the Home group, so the surviving witness is Workspace, whose
    // row is a VIEW ref even though its caret children are kinds.)
    expect(queryByText('Workspace')).not.toBeNull();
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
    const labels = [...container.querySelectorAll('.shell-rail__label')].map((n) => n.textContent);
    expect(labels).toContain('Workspace');
    expect(labels).toContain('Settings');
    getByText('Channels');
  });

  it('renders the shipped default for a future schemaVersion instead of nothing', () => {
    const { container } = renderResolved({ schemaVersion: 4, revision: 1, groups: [] } as never);
    const labels = [...container.querySelectorAll('.shell-rail__label')].map((n) => n.textContent);
    expect(labels).toContain('Workspace');
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
    const { container, getByText, queryByText } = renderResolved(custom);
    // Group labels are accessible names now, not printed eyebrows.
    const groups = [...container.querySelectorAll('.shell-rail__group')];
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Ops', 'Admin']);
    getByText('Tasks');
    // The shipped default's groups are NOT merged in.
    expect(queryByText('Collab')).toBeNull();
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

describe('SpaceTabBar (T0-1, D1 — revision 11: the product bar)', () => {
  const renderBar = (props: Partial<React.ComponentProps<typeof SpaceTabBar>> = {}) =>
    render(
      <div className="cv2-root">
        <SpaceTabBar {...props} />
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

  it('carries NO server chip and NO space tabs — the identity block owns both (r11)', () => {
    const { container } = renderBar();
    expect(container.querySelector('.shell-tabbar__server')).toBeNull();
    expect(container.querySelector('.shell-tabbar__spaces')).toBeNull();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });

  it('the bell opens Inbox when a host wires it', () => {
    const onOpenInbox = vi.fn();
    const { getByTestId } = renderBar({ onOpenInbox });
    const bell = getByTestId('open-inbox');
    expect(bell.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(bell);
    expect(onOpenInbox).toHaveBeenCalledOnce();
  });

  it('the bell keeps the D28 posture without a host: announced, reachable, refused', () => {
    const bell = renderBar().getByTestId('open-inbox') as HTMLButtonElement;
    expect(bell.getAttribute('aria-disabled')).toBe('true'); // announced
    expect(bell.disabled).toBe(false); // inverted guard against the native attr
    bell.focus(); // reachable
    expect(document.activeElement).toBe(bell);
  });

  it('opens the prompt catalog from the bar when the host wires it', () => {
    const onOpenPrompts = vi.fn();
    const { getByTestId } = renderBar({ onOpenPrompts });
    fireEvent.click(getByTestId('open-prompts'));
    expect(onOpenPrompts).toHaveBeenCalled();
  });

  it('omits the prompts control entirely when no host handles it', () => {
    // Same rule the accountSlot follows: a bar rendered without a host shows no
    // control at all, rather than one that does nothing when clicked.
    expect(renderBar().queryByTestId('open-prompts')).toBeNull();
  });
});

describe('SpaceSwitcher — the identity block (revision 11)', () => {
  const servers = [
    { id: 'local', label: 'local', local: true, reachability: 'online' as const },
    { id: 'utho', label: 'utho · tm8', local: false, reachability: 'offline' as const },
  ];
  const spaces = [
    { id: 'sp_1' as SpaceId, name: 'atelier' },
    { id: 'sp_2' as SpaceId, name: 'playground' },
  ] as SpaceSummary[];

  const renderSwitcher = (
    props: Partial<React.ComponentProps<typeof SpaceSwitcher>> = {},
  ) =>
    render(
      <div className="cv2-root">
        <SpaceSwitcher
          servers={servers}
          activeServerId="local"
          spaces={spaces}
          activeSpaceId={'sp_1' as SpaceId}
          collapsed={false}
          onSelectServer={() => {}}
          onSelectSpace={() => {}}
          {...props}
        />
      </div>,
    );

  it('names the pair — active space and its server — on the trigger', () => {
    const { getByLabelText } = renderSwitcher();
    expect(getByLabelText('Server and space: local · atelier')).toBeTruthy();
  });

  it('switches space from the popover and closes', () => {
    const onSelectSpace = vi.fn();
    const { getByLabelText, getByText, queryByRole } = renderSwitcher({ onSelectSpace });
    fireEvent.click(getByLabelText('Server and space: local · atelier'));
    fireEvent.click(getByText('playground'));
    expect(onSelectSpace).toHaveBeenCalledWith('sp_2');
    expect(queryByRole('dialog')).toBeNull();
  });

  it('marks the current space and does NOT re-select it on click', () => {
    const onSelectSpace = vi.fn();
    const { getByLabelText, getByRole } = renderSwitcher({ onSelectSpace });
    fireEvent.click(getByLabelText('Server and space: local · atelier'));
    // Scoped to the popover: the trigger also prints the space name.
    const dialog = getByRole('dialog');
    const current = within(dialog).getByText('atelier').closest('button');
    expect(current?.getAttribute('aria-current')).toBe('true');
    fireEvent.click(current as HTMLElement);
    expect(onSelectSpace).not.toHaveBeenCalled();
  });

  it('an INACTIVE server row is the switch; its spaces are honestly not listed', () => {
    const onSelectServer = vi.fn();
    const { getByLabelText, getByText } = renderSwitcher({ onSelectServer });
    fireEvent.click(getByLabelText('Server and space: local · atelier'));
    // No cross-server aggregation exists: the popover says so instead of
    // pretending to list a remote server's spaces.
    expect(getByText('switch to see its spaces')).toBeTruthy();
    fireEvent.click(getByText('utho · tm8'));
    expect(onSelectServer).toHaveBeenCalledWith('utho');
  });

  it('renders both add-affordances disabled-with-reason when unhosted (D28/L6)', () => {
    const { getByLabelText, getByTitle } = renderSwitcher();
    fireEvent.click(getByLabelText('Server and space: local · atelier'));
    const addServer = getByTitle(SWITCHER_ADD_SERVER_REASON) as HTMLButtonElement;
    expect(addServer.getAttribute('aria-disabled')).toBe('true');
    expect(addServer.disabled).toBe(false);
    addServer.focus();
    expect(document.activeElement).toBe(addServer);
  });

  it('wires add-space and add-server when the host supplies them', () => {
    const onAddSpace = vi.fn();
    const onAddServer = vi.fn();
    const { getByLabelText, getByText } = renderSwitcher({ onAddSpace, onAddServer });
    fireEvent.click(getByLabelText('Server and space: local · atelier'));
    fireEvent.click(getByText('＋ new space'));
    expect(onAddSpace).toHaveBeenCalledOnce();
    fireEvent.click(getByLabelText('Server and space: local · atelier'));
    fireEvent.click(getByText('＋ add server'));
    expect(onAddServer).toHaveBeenCalledOnce();
  });

  it('Escape closes the popover', () => {
    const { getByLabelText, queryByRole } = renderSwitcher();
    fireEvent.click(getByLabelText('Server and space: local · atelier'));
    expect(queryByRole('dialog')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(queryByRole('dialog')).toBeNull();
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

describe('per-kind counters — the rail shows what is NEW, not how much exists', () => {
  /**
   * `task` has news, `doc` is fully caught up, `project` has no counters at
   * all (a node that cannot serve them). `work_session` carries news AND a
   * running count, which must stay two separate facts.
   */
  const presentCounts: KindPresenter = (ref) => {
    const table: Record<string, RefPresentation> = {
      task: { label: 'Tasks', icon: '◔', badge: 142, unseen: 7 },
      doc: { label: 'Docs', icon: '▤', badge: 210, unseen: 0 },
      work_session: { label: 'Sessions', icon: '▣', badge: 38, unseen: 2, live: 3 },
      project: { label: 'Projects', icon: '⬒' },
    };
    return table[ref] ?? null;
  };

  /* A flat config: revision 11 tucks these kinds behind closed carets in the
     shipped default, and these tests are about COUNTERS, not caret state. */
  const countsConfig: MenuConfig = {
    schemaVersion: 1,
    revision: 1,
    groups: [
      {
        id: 'counts',
        label: 'Counts',
        items: [
          { type: 'kind', ref: 'task' },
          { type: 'kind', ref: 'doc' },
          { type: 'kind', ref: 'work_session' },
          { type: 'kind', ref: 'project' },
          { type: 'view', ref: 'settings' },
        ],
      },
    ],
  };

  it('draws the UNSEEN count, not the lifetime total', () => {
    const { container } = renderRail({ config: countsConfig, presentKind: presentCounts });
    const badges = [...container.querySelectorAll('.shell-rail__badge')];
    const texts = badges.map((b) => b.textContent?.replace(/\D/g, ''));
    // 7 new, not 142 total. A total only grows, is the same on every visit,
    // and cannot be acted on — it is not what the rail's one slot is for.
    expect(texts).toContain('7');
    expect(texts).not.toContain('142');
  });

  it('a caught-up kind draws NO badge — not a zero', () => {
    const { container } = renderRail({ config: countsConfig, presentKind: presentCounts });
    const badges = [...container.querySelectorAll('.shell-rail__badge')];
    // Docs: 210 total, 0 unseen. A `0` on every row of a caught-up workspace
    // is noise, and reads as a state rather than as the absence of news.
    expect(badges.map((b) => b.textContent?.replace(/\D/g, ''))).not.toContain('210');
    expect(badges.some((b) => b.textContent?.trim() === '0')).toBe(false);
  });

  it('the TOTAL is demoted to the hover title, not discarded', () => {
    const { container } = renderRail({ config: countsConfig, presentKind: presentCounts });
    const row = [...container.querySelectorAll('.shell-rail__leaf, .shell-rail__row')]
      .find((element) => element.querySelector('.shell-rail__label')?.textContent === 'Tasks');
    expect(row?.getAttribute('title')).toBe('142 tasks, 7 new');
  });

  it('ABSENT counters draw nothing at all', () => {
    const { container } = renderRail({ config: countsConfig, presentKind: presentCounts });
    const projects = [...container.querySelectorAll('.shell-rail__row')]
      .find((element) => element.querySelector('.shell-rail__label')?.textContent === 'Projects');
    expect(projects?.querySelector('.shell-rail__badge')).toBeNull();
    expect(projects?.getAttribute('title')).toBeNull();
  });

  it('sessions keep the green RUNNING dot beside their news count', () => {
    const { container } = renderRail({ config: countsConfig, presentKind: presentCounts });
    // Two different facts: 3 PTYs are running (about the world), 2 rows are
    // new to me (about this viewer). Neither may absorb the other.
    const live = [...container.querySelectorAll('.shell-rail__live')]
      .find((n) => n.textContent?.includes('3'));
    expect(live?.querySelector('.shell-rail__live-dot')).toBeTruthy();
    expect(live?.textContent).toContain('live');
    const sessions = [...container.querySelectorAll('.shell-rail__badge')]
      .find((b) => b.textContent?.startsWith('2'));
    expect(sessions?.classList.contains('shell-rail__badge--unseen')).toBe(true);
  });

  it('COLLAPSED, the corner mark is the news count and AT still hears the total', () => {
    const config: MenuConfig = {
      schemaVersion: 1,
      revision: 1,
      groups: [{
        id: 'g',
        label: 'G',
        items: [{ type: 'kind', ref: 'task' } as never, { type: 'view', ref: 'settings' }],
      }],
    };
    const { container, getByLabelText } = renderRail({
      collapsed: true,
      config,
      presentKind: presentCounts,
    });
    const corner = container.querySelector('.shell-rail__badge-corner');
    // 7, not 142 — a permanent two-digit total pinned to a 48px icon rail was
    // exactly the noise this change removes.
    expect(corner?.textContent).toBe('7');
    // The total survives for assistive tech: a collapsed rail offers AT no
    // hover to reach `title` with, so dropping it would cost AT users only.
    expect(getByLabelText('Tasks, 142, 7 new')).toBeTruthy();
  });
});
