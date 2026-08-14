// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  EntityUnavailableRefusal,
  NotSpaceMemberRefusal,
  SpaceAccessRefusal,
  WrongNodeRefusal,
} from '.';

describe('shared-link refusal surfaces', () => {
  it('names a Space that is absent from this node without navigating elsewhere', () => {
    render(<WrongNodeRefusal />);

    expect(screen.getByRole('alert').textContent).toContain('not on this tm8 node');
    expect(screen.getByText(/different tm8 node/)).toBeTruthy();
    expect(screen.getByText(/Nothing else was opened/)).toBeTruthy();
  });

  it('tells a non-member exactly how to get access', () => {
    render(<NotSpaceMemberRefusal />);

    expect(screen.getByRole('alert').textContent).toContain('not a member of this Space');
    expect(screen.getByText(/Ask whoever sent you this link for an invite/)).toBeTruthy();
    expect(screen.getByText(/no other Space was substituted/)).toBeTruthy();
  });

  it('offers one privacy-preserving state for an indistinguishable Space refusal', () => {
    render(<SpaceAccessRefusal />);

    expect(screen.getByRole('alert').textContent).toContain('do not have access to this link’s Space');
    expect(screen.getByText(/different tm8 node, or you may need an invite/)).toBeTruthy();
  });

  it('renders an unavailable entity alone and provides a live way back', () => {
    const onOpenSpace = vi.fn();
    render(<EntityUnavailableRefusal onOpenSpace={onOpenSpace} />);

    expect(screen.getByRole('alert').textContent).toContain('linked entity is unavailable');
    expect(screen.getByText(/deleted or purged/)).toBeTruthy();
    expect(screen.getByText(/no companion view has been substituted/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open the Space' }));
    expect(onOpenSpace).toHaveBeenCalledOnce();
  });

  it('only renders a recovery action when its caller can perform it', () => {
    const { rerender } = render(<WrongNodeRefusal />);
    expect(screen.queryByRole('button')).toBeNull();

    const onOpenAvailableSpace = vi.fn();
    rerender(<WrongNodeRefusal onOpenAvailableSpace={onOpenAvailableSpace} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open an available Space' }));
    expect(onOpenAvailableSpace).toHaveBeenCalledOnce();
  });
});
