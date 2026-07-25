import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { IconRail } from '../IconRail';
import { ProjectTabBar } from '../ProjectTabBar';

describe('IconRail — Maestro chrome over tm8 routes', () => {
  it('keeps all eight source affordances, caps real badges, and disables missing routes with a reason', () => {
    const navigate = vi.fn();
    render(
      <IconRail
        activeSection="workspace"
        onSectionChange={navigate}
        taskCount={128}
        memberCount={71}
        teamCount={11}
      />,
    );

    expect(screen.getAllByRole('button')).toHaveLength(8);
    expect(screen.getByText('99+')).toBeTruthy();
    expect(screen.getByText('71')).toBeTruthy();
    expect(screen.getByText('11')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(navigate).toHaveBeenCalledWith('workspace');
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(navigate).toHaveBeenCalledWith('docs');

    const skills = screen.getByRole('button', { name: /Skills — unavailable/ }) as HTMLButtonElement;
    expect(skills.disabled).toBe(true);
    expect(skills.title).toContain('not available');
  });
});

describe('ProjectTabBar — spaces rendered as Maestro projects', () => {
  it('does not paint unknown counts or status as a real zero', () => {
    render(
      <ProjectTabBar
        projects={[{ id: 'sp_1', name: 'Agent-maestro' }, { id: 'sp_2', name: 'Will' }]}
        activeProjectId="sp_1"
        onSelectProject={() => undefined}
      />,
    );

    expect(document.querySelectorAll('.projectTab')).toHaveLength(2);
    expect(document.querySelectorAll('.pn-dot')).toHaveLength(0);
    expect(document.querySelectorAll('.projectTabCount')).toHaveLength(0);
  });

  it('renders only real status/count inputs and keeps unsupported actions disabled-with-reason', () => {
    const select = vi.fn();
    render(
      <ProjectTabBar
        projects={[{ id: 'sp_1', name: 'Agent-maestro', count: 4, workingCount: 2 }]}
        activeProjectId="sp_1"
        onSelectProject={select}
      />,
    );

    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(document.querySelector('.pn-dot--run')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Agent-maestro/ }));
    expect(select).toHaveBeenCalledWith('sp_1');

    const add = screen.getByRole('button', { name: /Add project — unavailable/ }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.title).toContain('not available');
  });
});
