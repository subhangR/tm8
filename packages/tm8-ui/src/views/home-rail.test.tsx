// @vitest-environment jsdom
/**
 * The Home icon rail's three bands (task 01a0fb09 "Icon Rail Collapse"):
 * New (quick-create), Pinned, and the collapsible groups. The composition —
 * which kinds sit in which group, and the default pins — is pinned in
 * `domain/home-rail.test.ts`; this file pins what the rail DRAWS from it.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import { DEFAULT_HOME_RAIL_PINS, homeRailGroups, homeRailPinnedKinds } from '../domain';
import { HomeRail, type HomeRailProps } from './HomeRail';

function renderRail(overrides: Partial<HomeRailProps> = {}) {
  const props: HomeRailProps = {
    groups: homeRailGroups(),
    pinned: homeRailPinnedKinds(DEFAULT_HOME_RAIL_PINS),
    create: [],
    activeKind: null,
    onSelect: vi.fn(),
    onTogglePin: vi.fn(),
    openGroups: {},
    onToggleGroup: vi.fn(),
    collapsed: true,
    onToggleCollapsed: vi.fn(),
    ...overrides,
  };
  const view = render(<HomeRail {...props} />);
  const rail = view.getByTestId('home-rail');
  const labels = () => [...rail.querySelectorAll('.hr-rail__label')].map((n) => n.textContent);
  return { view, rail, labels, props };
}

describe('the Home icon rail bands', () => {
  it('opens with only the pinned rows showing — every group closed', () => {
    const { rail, labels } = renderRail();
    expect(labels()).toEqual(['Chats', 'Tasks', 'Sessions']);
    for (const header of within(rail).getAllByRole('button', { expanded: false })) {
      // The rail's own expand toggle is the one closed control that is not a group.
      if (header.classList.contains('hr-rail__toggle')) continue;
      expect(header.classList).toContain('hr-rail__group-toggle');
    }
  });

  it('draws a pinned kind ONCE — it leaves its group while pinned', () => {
    const { rail, labels } = renderRail({ openGroups: { work: true } });
    const work = within(rail).getByRole('group', { name: 'Work' });
    expect(within(work).queryByRole('button', { name: /^Tasks/ })).toBeNull();
    expect(labels().filter((label) => label === 'Tasks')).toHaveLength(1);
    expect(labels()).toContain('Forms');
  });

  it('opens the group holding the active list, and only that one, by default', () => {
    const { labels } = renderRail({ activeKind: 'doc' });
    expect(labels()).toContain('Docs');
    expect(labels()).toContain('Graphs');
    expect(labels()).not.toContain('Commits');
  });

  it('honours an explicit choice over the default — and marks a closed active group current', () => {
    const { rail, labels } = renderRail({ activeKind: 'doc', openGroups: { library: false } });
    expect(labels()).not.toContain('Docs');
    const header = within(rail).getByRole('button', { name: 'Library' });
    expect(header.getAttribute('aria-current')).toBe('true');
  });

  it('reports a header click as the opposite of what it shows', () => {
    const onToggleGroup = vi.fn();
    const { rail } = renderRail({ onToggleGroup, openGroups: { code: true } });
    fireEvent.click(within(rail).getByRole('button', { name: 'Code' }));
    expect(onToggleGroup).toHaveBeenLastCalledWith('code', false);
    fireEvent.click(within(rail).getByRole('button', { name: 'Admin' }));
    expect(onToggleGroup).toHaveBeenLastCalledWith('admin', true);
  });

  it('pins and unpins through each row’s own toggle', () => {
    const onTogglePin = vi.fn();
    const { rail } = renderRail({ onTogglePin, openGroups: { library: true } });
    const unpin = within(rail).getByRole('button', { name: 'Unpin Tasks' });
    expect(unpin.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(unpin);
    expect(onTogglePin).toHaveBeenLastCalledWith('task');
    fireEvent.click(within(rail).getByRole('button', { name: 'Pin Docs' }));
    expect(onTogglePin).toHaveBeenLastCalledWith('doc');
  });

  it('draws no Pinned band when nothing is pinned, and lets the groups hold everything', () => {
    const { rail } = renderRail({ pinned: [], openGroups: { work: true } });
    expect(within(rail).queryByRole('group', { name: 'Pinned' })).toBeNull();
    const work = within(rail).getByRole('group', { name: 'Work' });
    expect(within(work).getByRole('button', { name: /^Tasks/ })).toBeTruthy();
  });

  it('puts the create buttons first, and refuses with a reason rather than hiding', () => {
    const onCreate = vi.fn();
    const refused = vi.fn();
    const { rail } = renderRail({
      create: [
        { kind: 'task', label: 'New task', refusal: null, onCreate },
        {
          kind: 'work_session',
          label: 'New terminal',
          refusal: { cause: 'No server', remedy: 'connect one' },
          onCreate: refused,
        },
      ],
    });
    const bands = rail.querySelectorAll('.hr-rail__scroll > *');
    expect(bands[0]?.getAttribute('aria-label')).toBe('Create');
    fireEvent.click(within(rail).getByRole('button', { name: 'New task' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    const terminal = within(rail).getByRole('button', { name: 'New terminal' });
    expect(terminal.getAttribute('aria-disabled')).toBe('true');
    expect(terminal.getAttribute('title')).toBe('No server — connect one');
    fireEvent.click(terminal);
    expect(refused).not.toHaveBeenCalled();
  });
});
