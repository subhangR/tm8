// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { DuelPanel } from './DuelPanel';
import type { WorldEncounter } from './world';

const trainer: WorldEncounter = { id: 'session-1', name: 'Fern', callSign: 'Aster', model: 'graph-model', phase: 'active', status: 'running', completed: 2, total: 3, activity: [{ id: 'm1', at: '2026-10-04', author: 'Fern', text: 'The tests are passing.' }] };
describe('trainer encounter', () => {
  it('renders graph messages and task progress, and opens the session id through the supplied port', () => {
    const open = vi.fn(), leave = vi.fn();
    const { getByRole, getByText } = render(<DuelPanel encounter={trainer} encounters={[trainer]} onSelect={vi.fn()} onOpen={open} onLeave={leave} />);
    expect(getByText('graph-model · running')).toBeTruthy();
    expect(getByText('The tests are passing.')).toBeTruthy();
    const progress = getByRole('progressbar', { name: 'Attached tasks completed' }) as HTMLProgressElement;
    expect(progress.value).toBe(2); expect(progress.max).toBe(3);
    fireEvent.click(getByRole('button', { name: /Open session/ })); expect(open).toHaveBeenCalledWith(trainer.id);
    fireEvent.click(getByRole('button', { name: 'Return to map' })); expect(leave).toHaveBeenCalledOnce();
  });
  it('supports multiple sessions and updates live status/messages without making up progress', () => {
    const select = vi.fn();
    const resting = { ...trainer, id: 'session-2', phase: 'resting' as const, model: null, total: 0, completed: 0, activity: [] };
    const { getByRole, getByText, rerender } = render(<DuelPanel encounter={trainer} encounters={[trainer, resting]} onSelect={select} onOpen={vi.fn()} onLeave={vi.fn()} />);
    fireEvent.change(getByRole('combobox'), { target: { value: resting.id } }); expect(select).toHaveBeenCalledWith(resting.id);
    rerender(<DuelPanel encounter={resting} encounters={[trainer, resting]} onSelect={select} onOpen={vi.fn()} onLeave={vi.fn()} />);
    expect(getByText('No attached tasks')).toBeTruthy(); expect(getByText(/Model not supplied/)).toBeTruthy();
    expect(getByText('At rest')).toBeTruthy();
  });
});
