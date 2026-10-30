// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { getKind } from '../domain';
import { createToolFixture } from '../tools/fixture';
import { EntityCreateControl } from './EntityCreateControl';
import type { AuthoringCommands } from './commands';
import type { NewTaskHandle } from './useNewTask';
import { createFixtureLoopsClient } from '../loops/fixture';

vi.mock('../tools/SourceEditor', () => ({ SourceEditor: ({ value, onChange }: { value: string; onChange(value: string): void }) => <textarea aria-label="Source" value={value} onChange={(event) => onChange(event.target.value)} /> }));
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
  loops: createFixtureLoopsClient(),
  loopForm: { query: async () => ({ page: { items: [], nextCursor: null } }) },
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
    expect(screen.getByTestId('loop-form')).toBeTruthy();
    expect(immediate.create).not.toHaveBeenCalled();
  });

  it('opens the tool-definition form for a kind made from a definition, with the starters installer beside it', () => {
    const { port } = createToolFixture();
    render(
      <div className="cv2-root">
        <EntityCreateControl
          config={getKind('tool')}
          immediate={immediate}
          spaceId="space-1"
          commands={{ ...commands, tools: port }}
        />
      </div>,
    );
    expect(screen.getByRole('button', { name: 'Install starter tools' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New tool' }));
    expect(screen.getByTestId('tool-create-dialog')).toBeTruthy();
    expect(screen.getByRole('form', { name: 'New tool' })).toBeTruthy();
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
    expect(screen.queryByTestId('loop-form')).toBeNull();
  });
});
