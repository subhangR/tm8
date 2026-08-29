// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { getKind } from '../domain';
import { EntityCreateControl } from './EntityCreateControl';
import type { AuthoringCommands } from './commands';
import type { NewTaskHandle } from './useNewTask';

afterEach(cleanup);

const immediate: NewTaskHandle = {
  state: { phase: 'idle' },
  unavailable: null,
  create: vi.fn(async () => undefined),
  dismiss: vi.fn(),
};

const commands = {
  createEntity: vi.fn(),
  patchEntity: vi.fn(),
  patchTask: vi.fn(),
} as unknown as AuthoringCommands;

describe('the registry selects the honest create flow', () => {
  it('opens the staged form for a scheduled-work kind', () => {
    render(
      <div className="cv2-root">
        <EntityCreateControl
          config={getKind('loop')}
          immediate={immediate}
          spaceId="space-1"
          commands={commands}
        />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'New loop' }));
    expect(screen.getByTestId('loop-create-dialog')).toBeTruthy();
    expect(immediate.create).not.toHaveBeenCalled();
  });

  it('keeps the immediate placeholder flow for ordinary quick-create kinds', () => {
    render(
      <div className="cv2-root">
        <EntityCreateControl
          config={getKind('task')}
          immediate={immediate}
          spaceId="space-1"
          commands={commands}
        />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    expect(immediate.create).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('loop-create-dialog')).toBeNull();
  });
});
