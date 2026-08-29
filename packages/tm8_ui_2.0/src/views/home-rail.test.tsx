// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import {
  composeEntityNavigation,
  entityNavigationLabel,
  homeRailGroups,
} from '../domain';
import { HomeRail } from './HomeRail';

function navigationGroups() {
  return composeEntityNavigation(
    homeRailGroups(),
    () => ({ total: 8, unseen: 2 }),
    (config) => (config.list.liveTreatment ? 1 : undefined),
  );
}

describe('HomeRail entity navigation', () => {
  it('renders the full registry hierarchy with exact state in each accessible name', () => {
    const groups = navigationGroups();
    const active = groups[0]!.items[1]!;
    const { getByTestId } = render(
      <div className="cv2-root">
        <HomeRail
          groups={groups}
          activeKind={active.config.kind}
          onSelect={() => undefined}
          collapsed={false}
          onToggleCollapsed={() => undefined}
        />
      </div>,
    );
    const rail = getByTestId('home-rail');

    const kindCount = groups.reduce((sum, group) => sum + group.items.length, 0);
    expect(within(rail).getAllByRole('button')).toHaveLength(kindCount + 1);
    for (const group of groups) {
      expect(within(rail).getByRole('group', { name: `${group.label}: ${group.description}` })).toBeTruthy();
    }
    expect(
      within(rail).getByRole('button', { name: entityNavigationLabel(active) }).getAttribute('aria-current'),
    ).toBe('page');
  });

  it('selects a kind and keeps collapse as a separate, labelled control', () => {
    const groups = navigationGroups();
    const target = groups[1]!.items[2]!;
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const { getByTestId } = render(
      <div className="cv2-root">
        <HomeRail
          groups={groups}
          activeKind={null}
          onSelect={onSelect}
          collapsed
          onToggleCollapsed={onToggle}
        />
      </div>,
    );
    const rail = getByTestId('home-rail');

    fireEvent.click(within(rail).getByRole('button', { name: entityNavigationLabel(target) }));
    expect(onSelect).toHaveBeenCalledWith(target.config.kind);
    fireEvent.click(within(rail).getByRole('button', { name: 'Expand entity navigation' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(within(rail).getByText(target.config.labelPlural)).toBeTruthy();
  });
});
