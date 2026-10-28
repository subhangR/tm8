// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CollabError, type EntitySummary, type SpaceId, type ToolView } from '@tm8/contract';
import type { LoopsClient } from './api';
import { createFixtureLoopsClient, fixtureLoopView } from './fixture';
import { LoopForm, type LoopFormSources } from './LoopForm';
import { PREVIEW_DEBOUNCE_MS } from './SchedulePreview';
import { expressionOf, presetOf } from './schedule-presets';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const SPACE = '019fe999-0000-7000-8000-00000000a000' as SpaceId;
const ADA = '019fe999-0000-7000-8000-00000000a001';
const TOOL = '019fe999-0000-7000-8000-00000000a002';
const DOC = '019fe999-0000-7000-8000-00000000a003';

const summary = (id: string, kind: string, title: string) => ({ id, kind, title } as unknown as EntitySummary);

const TOOL_VIEW = {
  id: TOOL, spaceId: SPACE, version: 3, sourceSha256: '0'.repeat(64),
  definition: {
    name: 'sweep', description: '', help: '', runtime: 'bash', source: 'echo', tm8Access: 'none', timeoutSeconds: 60,
    inputs: [
      { name: 'depth', type: 'int', required: true, min: 1, max: 5 },
      { name: 'token', type: 'secret' },
    ],
  },
  executionVersion: 1, configRevision: 0, config: {}, secretBindings: [],
} as unknown as ToolView;

function sources(): LoopFormSources & { query: ReturnType<typeof vi.fn> } {
  const rows: Record<string, EntitySummary[]> = {
    team_member: [summary(ADA, 'team_member', 'Ada')],
    tool: [summary(TOOL, 'tool', 'sweep')],
    interaction_profile: [],
    memory: [],
  };
  const query = vi.fn(async (input: { kinds?: string[] }) => ({
    page: { items: input.kinds ? rows[input.kinds[0]!] ?? [] : [summary(DOC, 'doc', 'Roadmap')], nextCursor: null },
  }));
  return {
    query: query as never,
    entity: (async (id: string) => ({ id, title: id === DOC ? 'Roadmap' : 'Memory', state: { kind: 'doc' } })) as never,
    projects: (async () => []) as never,
    commands: { tools: { get: async () => TOOL_VIEW } },
  } as never;
}

function mount(client: LoopsClient, extra: Partial<Parameters<typeof LoopForm>[0]> = {}) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <div className="cv2-root">
      <LoopForm mode="create" spaceId={SPACE} client={client} sources={sources()} onSaved={onSaved} onClose={onClose} {...extra} />
    </div>,
  );
  return { onSaved, onClose };
}

const name = (text: string) => fireEvent.change(screen.getByLabelText('Name'), { target: { value: text } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: /Create loop|Save loop/ }));

describe('the loop form validates per action', () => {
  it('a teammate loop needs a name and a teammate before anything is sent', async () => {
    const client = createFixtureLoopsClient();
    const create = vi.spyOn(client, 'create');
    mount(client);
    submit();
    expect(await screen.findByText('Give the loop a name.')).toBeTruthy();
    expect(screen.getByText('Pick the teammate who runs it.')).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it('a Dispatcher loop needs no runner and sends a null teammate', async () => {
    const client = createFixtureLoopsClient();
    const create = vi.spyOn(client, 'create');
    const { onSaved } = mount(client);
    name('Morning triage');
    fireEvent.click(screen.getByTestId('loop-action-dispatch'));
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [space, definition, enabled] = create.mock.calls[0]!;
    expect(space).toBe(SPACE);
    expect(definition).toMatchObject({ title: 'Morning triage', action: 'dispatch', teamMemberId: null, toolId: null, schedule: '0 9 * * *' });
    expect(enabled).toBe(true);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('a tool loop needs a tool and its required inputs, and never offers a secret field', async () => {
    const client = createFixtureLoopsClient();
    const create = vi.spyOn(client, 'create');
    mount(client);
    name('Sweep');
    fireEvent.click(screen.getByTestId('loop-action-tool'));
    submit();
    expect(await screen.findByText('Pick the tool to run.')).toBeTruthy();

    fireEvent.click(screen.getByTestId('loop-tool'));
    fireEvent.click(await screen.findByTestId(`loop-tool-${TOOL}`));
    const inputs = await screen.findByTestId('loop-tool-inputs');
    expect(inputs.textContent).toContain('Uses the secret bound on the tool');
    expect(screen.queryByLabelText('token')).toBeNull();
    submit();
    expect(await screen.findByText('A value is required.')).toBeTruthy();
    expect(create).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('depth'), { target: { value: '3' } });
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![1]).toMatchObject({ action: 'tool', toolId: TOOL, toolInputs: { depth: 3 }, teamMemberId: null });
  });
});

describe('the pickers write ids the human never types', () => {
  it('teammate, subject and Enable now land in the create call', async () => {
    const client = createFixtureLoopsClient();
    const create = vi.spyOn(client, 'create');
    mount(client);
    name('Daily sweep');
    fireEvent.click(screen.getByTestId('loop-teammate'));
    fireEvent.click(await screen.findByTestId(`loop-teammate-${ADA}`));
    // The first picker is About; the memories picker sits inside the collapsed Advanced.
    fireEvent.click(screen.getAllByTestId('membership-add')[0]!);
    fireEvent.click(await screen.findByText('Roadmap'));
    expect(screen.getByTestId('loop-subject').textContent).toContain('Roadmap');
    fireEvent.click(screen.getByLabelText('Enable now'));
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [, definition, enabled] = create.mock.calls[0]!;
    expect(definition).toMatchObject({ action: 'spawn', teamMemberId: ADA, subjectId: DOC });
    expect(enabled).toBe(false);
    // No raw id field anywhere on the form.
    expect(screen.queryByText(/entity id/i)).toBeNull();
    expect(screen.queryByText(/JSON/)).toBeNull();
  });

  it('presets write expressions; custom keeps what was typed', () => {
    expect(expressionOf({ ...presetOf(''), kind: 'weekdays', hour: 8, minute: 30 })).toBe('30 8 * * 1-5');
    expect(expressionOf({ ...presetOf(''), kind: 'weekly', weekday: 4, hour: 9, minute: 0 })).toBe('0 9 * * 4');
    expect(expressionOf({ ...presetOf(''), kind: 'interval', every: 15, unit: 'm' })).toBe('every 15m');
    expect(presetOf('every 2h')).toMatchObject({ kind: 'interval', every: 2, unit: 'h' });
    expect(presetOf('17 3 1 * *')).toMatchObject({ kind: 'custom', cron: '17 3 1 * *' });
    expect(presetOf('5 * * * *')).toMatchObject({ kind: 'hourly', minute: 5 });
  });
});

describe('the schedule preview is the server\'s, debounced', () => {
  it('asks once after typing pauses and shows the summary and next runs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = createFixtureLoopsClient();
    const preview = vi.spyOn(client, 'schedulePreview').mockResolvedValue({
      valid: true, problem: null, summary: 'Every 2 hours', next: ['2026-10-28T20:00:00.000Z', '2026-10-28T22:00:00.000Z'],
    });
    mount(client);
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS + 10);
    preview.mockClear();
    fireEvent.change(screen.getByTestId('loop-preset'), { target: { value: 'custom' } });
    for (const text of ['e', 'ev', 'every 2h']) {
      fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: text } });
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(preview).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0]!.slice(1, 3)).toEqual(['every 2h', expect.any(String)]);
    await waitFor(() => expect(screen.getByTestId('loop-schedule-summary').textContent).toBe('Every 2 hours'));
    expect(screen.getByRole('list', { name: 'Next runs' }).children).toHaveLength(2);
  });

  it('shows the server\'s problem text and blocks saving an invalid schedule', async () => {
    const client = createFixtureLoopsClient();
    vi.spyOn(client, 'schedulePreview').mockResolvedValue({ valid: false, problem: 'cron needs 5 fields, got 2', summary: '', next: [] });
    const create = vi.spyOn(client, 'create');
    mount(client);
    expect((await screen.findByTestId('loop-schedule-problem')).textContent).toBe('cron needs 5 fields, got 2');
    expect((screen.getByRole('button', { name: 'Create loop' }) as HTMLButtonElement).disabled).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('defaults the timezone to the browser zone', () => {
    mount(createFixtureLoopsClient());
    expect((screen.getByLabelText('Timezone') as HTMLSelectElement).value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  });
});

describe('edit mode', () => {
  it('opens prefilled and sends only what changed, under the version', async () => {
    const view = fixtureLoopView('019fe999-0000-7000-8000-00000000b001', SPACE, {
      title: 'Nightly', schedule: 'every 2h', timezone: 'Europe/London', action: 'spawn', teamMemberId: ADA, subjectId: DOC,
      retry: { attempts: 2, delaySeconds: 120 },
    }, { version: 9 });
    const client = createFixtureLoopsClient([view]);
    const update = vi.spyOn(client, 'update');
    mount(client, { mode: 'edit', view });
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Nightly');
    expect((screen.getByTestId('loop-preset') as HTMLSelectElement).value).toBe('interval');
    expect((screen.getByLabelText('Every') as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText('Timezone') as HTMLSelectElement).value).toBe('Europe/London');
    expect((await screen.findByTestId('loop-subject')).textContent).toContain('Roadmap');
    expect(screen.queryByLabelText('Enable now')).toBeNull();

    name('Nightly sweep');
    submit();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const [ref, definition] = update.mock.calls[0]!;
    expect(ref).toMatchObject({ id: view.id, version: 9 });
    expect(definition).toEqual({ title: 'Nightly sweep' });
  });
});

describe('server validation errors render on the named field', () => {
  it('a zod-style path prefix lands under the schedule', async () => {
    const client = createFixtureLoopsClient();
    vi.spyOn(client, 'create').mockRejectedValue(new CollabError('invalid_input', 'definition.timezone: unknown time zone Mars/Base'));
    mount(client);
    name('X');
    fireEvent.click(screen.getByTestId('loop-action-dispatch'));
    submit();
    expect(await screen.findByText('unknown time zone Mars/Base')).toBeTruthy();
  });

  it('details.path on an advanced field opens Advanced and marks that field', async () => {
    const client = createFixtureLoopsClient();
    vi.spyOn(client, 'create').mockRejectedValue(new CollabError('invalid_input', 'retry attempts out of range', { details: { path: ['definition', 'retry', 'attempts'] } }));
    mount(client);
    name('X');
    fireEvent.click(screen.getByTestId('loop-action-dispatch'));
    submit();
    expect(await screen.findByText('retry attempts out of range')).toBeTruthy();
    expect((document.querySelector('.loop-form__advanced') as HTMLDetailsElement).open).toBe(true);
  });

  it('a refusal with no field path is a whole-form refusal card', async () => {
    const client = createFixtureLoopsClient();
    vi.spyOn(client, 'create').mockRejectedValue(new CollabError('forbidden', 'not a member'));
    mount(client);
    name('X');
    fireEvent.click(screen.getByTestId('loop-action-dispatch'));
    submit();
    await waitFor(() => expect(document.querySelector('.au-refusal, [data-testid="refusal-card"]') ?? screen.queryByText(/back to the form/)).toBeTruthy());
  });
});
