// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CommandResult, CreateEntityInput } from '@tm8/contract';
import type { AuthoringCommands } from '../authoring';
import { LoopCreateControl } from './LoopCreateControl';

afterEach(cleanup);

const SPACE = '019fb748-0068-76dc-9869-1bb36133c554';
const OK = { entity: { id: '019fe999-0000-7000-8000-000000000001' }, patches: [] } as unknown as CommandResult;

function mount() {
  const createEntity = vi.fn(async () => OK);
  const commands = {
    createEntity,
    patchEntity: vi.fn(),
    patchTask: vi.fn(),
  } as unknown as AuthoringCommands;
  const onCreated = vi.fn();
  render(
    <div className="cv2-root">
      <LoopCreateControl
        spaceId={SPACE}
        commands={commands}
        label="New loop"
        onCreated={onCreated}
      />
    </div>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'New loop' }));
  return { createEntity, onCreated };
}

function titleInput(): HTMLInputElement {
  return screen.getByLabelText(/^Title/) as HTMLInputElement;
}

describe('loop creation uses the ordinary create door with a complete schedule payload', () => {
  it('sends the runner/subject null semantics and a real first deadline', async () => {
    const before = Date.now();
    const { createEntity, onCreated } = mount();
    fireEvent.change(titleInput(), { target: { value: 'Daily project sweep' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create loop' }));

    await waitFor(() => expect(createEntity).toHaveBeenCalledTimes(1));
    const [input] = createEntity.mock.calls[0] as unknown as [CreateEntityInput];
    expect(input.kind).toBe('loop');
    expect(input.title).toBe('Daily project sweep');
    expect(input.content).toMatchObject({
      schedule: 'every 1d',
      teamMemberId: null,
      subjectId: null,
      prompt: '',
      config: {},
      enabled: true,
    });
    const next = Date.parse(String(input.content?.nextRunAt));
    expect(next).toBeGreaterThanOrEqual(before + 24 * 60 * 60_000);
    expect(next).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60_000);
    expect(onCreated).toHaveBeenCalledWith(OK.entity?.id, OK);
  });

  it('creates disabled loops without claiming a scheduled first run', async () => {
    const { createEntity } = mount();
    fireEvent.change(titleInput(), { target: { value: 'Paused sweep' } });
    fireEvent.click(screen.getByLabelText('Enable after creation'));
    fireEvent.click(screen.getByRole('button', { name: 'Create loop' }));
    await waitFor(() => expect(createEntity).toHaveBeenCalledTimes(1));
    const [input] = createEntity.mock.calls[0] as unknown as [CreateEntityInput];
    expect(input.content).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('refuses malformed config and malformed schedules before the command', async () => {
    const { createEntity } = mount();
    fireEvent.change(titleInput(), { target: { value: 'Bad draft' } });
    fireEvent.change(screen.getByLabelText(/Spawn config/), { target: { value: '[]' } });
    expect(screen.getByText('Spawn config must be a JSON object.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Create loop' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/^Schedule/), { target: { value: 'tomorrow' } });
    expect(screen.getByText(/cron expressions have 5 fields/)).toBeTruthy();
    await waitFor(() => expect(createEntity).not.toHaveBeenCalled());
  });
});
