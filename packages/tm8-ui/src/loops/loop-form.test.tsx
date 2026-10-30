// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CollabError, type EntitySummary, type SpaceId, type ToolView } from '@tm8/contract';
import { MobileSurfaceProvider } from '../mobile/surface';
import { fieldPathOf, type LoopsClient } from './api';
import { createFixtureLoopsClient, fixtureLoopView } from './fixture';
import { LoopEditDialog } from './LoopEditDialog';
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

const WRITE_TOOL = { ...TOOL_VIEW, definition: { ...TOOL_VIEW.definition, tm8Access: 'write' } } as unknown as ToolView;

function sources(getTool: () => Promise<ToolView> = async () => TOOL_VIEW): LoopFormSources & { query: ReturnType<typeof vi.fn> } {
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
    commands: { tools: { get: getTool } },
  } as never;
}

function mount(client: LoopsClient, extra: Record<string, unknown> = {}, getTool?: () => Promise<ToolView>) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const props = { mode: 'create', spaceId: SPACE, client, sources: sources(getTool), onSaved, onClose, ...extra } as Parameters<typeof LoopForm>[0];
  render(
    <div className="cv2-root">
      <LoopForm {...props} />
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
    // Nothing is bound for `token`, so the form says so rather than promising a secret.
    expect(inputs.textContent).toContain('No secret is bound on the tool for this input');
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

describe('a tool loop runs as a persona', () => {
  it('a tool that reaches tm8 needs the teammate it runs as, and sends it', async () => {
    const client = createFixtureLoopsClient();
    const create = vi.spyOn(client, 'create');
    mount(client, {}, async () => WRITE_TOOL);
    name('Sweep');
    fireEvent.click(screen.getByTestId('loop-action-tool'));
    fireEvent.click(screen.getByTestId('loop-tool'));
    fireEvent.click(await screen.findByTestId(`loop-tool-${TOOL}`));
    fireEvent.change(await screen.findByLabelText('depth'), { target: { value: '3' } });
    submit();
    expect(await screen.findByText('This tool works in tm8, so pick the teammate it runs as.')).toBeTruthy();
    expect(create).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('loop-tool-persona'));
    fireEvent.click(await screen.findByTestId(`loop-tool-persona-${ADA}`));
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![1]).toMatchObject({ action: 'tool', toolId: TOOL, teamMemberId: ADA, toolInputs: { depth: 3 } });
  });

  it("the server's persona refusal is drawn under Runs as, without the path head", async () => {
    const client = createFixtureLoopsClient();
    vi.spyOn(client, 'create').mockRejectedValue(new CollabError('invalid_input',
      'definition.teamMemberId: a tool with tm8Access read runs as a persona; name one', { details: { path: 'definition.teamMemberId' } }));
    mount(client);
    name('Sweep');
    fireEvent.click(screen.getByTestId('loop-action-tool'));
    fireEvent.click(screen.getByTestId('loop-tool'));
    fireEvent.click(await screen.findByTestId(`loop-tool-${TOOL}`));
    fireEvent.change(await screen.findByLabelText('depth'), { target: { value: '3' } });
    submit();
    expect(await screen.findByText('a tool with tm8Access read runs as a persona; name one')).toBeTruthy();
  });
});

describe('an edit never rewrites what the human did not touch', () => {
  const toolLoop = () => fixtureLoopView('019fe999-0000-7000-8000-00000000b002', SPACE, {
    title: 'Sweep', action: 'tool', toolId: TOOL, teamMemberId: ADA, toolInputs: { depth: 2 },
  }, { version: 4 });

  it('a tool loop keeps its persona and inputs, even while the tool is still being read', async () => {
    const view = toolLoop();
    const client = createFixtureLoopsClient([view]);
    const update = vi.spyOn(client, 'update');
    mount(client, { mode: 'edit', view }, () => new Promise<ToolView>(() => undefined));
    name('Sweep (nightly)');
    submit();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1]).toEqual({ title: 'Sweep (nightly)' });
  });

  it('a tool loop sends only the input that changed once the tool is read', async () => {
    const view = toolLoop();
    const client = createFixtureLoopsClient([view]);
    const update = vi.spyOn(client, 'update');
    mount(client, { mode: 'edit', view });
    const depth = await screen.findByLabelText('depth') as HTMLInputElement;
    expect(depth.value).toBe('2');
    fireEvent.change(depth, { target: { value: '4' } });
    submit();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1]).toEqual({ toolInputs: { depth: 4 } });
  });

  it('a spawn loop keeps a max runtime off the minute, a lone agent tool and its schedule spelling', async () => {
    const view = fixtureLoopView('019fe999-0000-7000-8000-00000000b003', SPACE, {
      title: 'Nightly', action: 'spawn', teamMemberId: ADA, schedule: '0  9 * * *', maxRuntimeSeconds: 90,
      config: { agentTool: 'codex', accessMode: 'auto' },
    }, { version: 2 });
    const client = createFixtureLoopsClient([view]);
    const update = vi.spyOn(client, 'update');
    mount(client, { mode: 'edit', view });
    name('Nightly sweep');
    submit();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1]).toEqual({ title: 'Nightly sweep' });

    update.mockClear();
    fireEvent.click(screen.getByText('Advanced'));
    fireEvent.change(screen.getByLabelText('Max runtime (minutes)'), { target: { value: '3' } });
    submit();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1]).toEqual({ title: 'Nightly sweep', maxRuntimeSeconds: 180 });
  });

  it('switching to Dispatcher decides clears the runner and the tool (a dispatch loop names neither)', async () => {
    const view = toolLoop();
    const client = createFixtureLoopsClient([view]);
    const update = vi.spyOn(client, 'update');
    mount(client, { mode: 'edit', view });
    fireEvent.click(screen.getByTestId('loop-action-dispatch'));
    submit();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1]).toEqual({ action: 'dispatch', teamMemberId: null, toolId: null, toolInputs: {} });
  });

  it('a create leaves the retry delay at the contract default', async () => {
    const client = createFixtureLoopsClient();
    const create = vi.spyOn(client, 'create');
    mount(client);
    name('Morning triage');
    fireEvent.click(screen.getByTestId('loop-action-dispatch'));
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![1]).toMatchObject({ retry: { attempts: 0, delaySeconds: 300 } });
  });
});

describe('where the form is drawn', () => {
  it('inline (a draft tab) is not a modal and ignores a window Escape', () => {
    const { onClose } = mount(createFixtureLoopsClient(), { inline: true });
    expect(screen.getByTestId('loop-form')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('.au-dialog__backdrop')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('as a dialog it is modal and Escape closes it', () => {
    const { onClose } = mount(createFixtureLoopsClient());
    expect(screen.getByRole('dialog', { name: 'New loop' }).getAttribute('aria-modal')).toBe('true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the edit dialog reads the loop, opens the form on it and saves under its version', async () => {
    const view = fixtureLoopView('019fe999-0000-7000-8000-00000000b004', SPACE, { title: 'Weekly', action: 'dispatch' }, { version: 6 });
    const client = createFixtureLoopsClient([view]);
    const update = vi.spyOn(client, 'update');
    const onSaved = vi.fn();
    render(<div className="cv2-root"><LoopEditDialog editor={{ loopId: view.id, spaceId: SPACE, client, sources: sources(), onSaved }} onClose={() => undefined} /></div>);
    expect(screen.getByText('Reading the loop…')).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Weekly'));
    name('Weekly digest');
    submit();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![0]).toMatchObject({ id: view.id, version: 6 });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });
});

describe('the field a refusal names', () => {
  it('reads a string details.path and drops the path head the doors repeat', () => {
    expect(fieldPathOf(new CollabError('invalid_input', 'schedule: cron needs 5 fields, got 2', { details: { path: 'definition.schedule' } })))
      .toEqual({ path: 'schedule', message: 'cron needs 5 fields, got 2' });
    expect(fieldPathOf(new CollabError('invalid_input', 'definition.config.model: Expected string', { details: { path: 'definition.config.model' } })))
      .toEqual({ path: 'config.model', message: 'Expected string' });
    expect(fieldPathOf(new CollabError('invalid_input', 'until must be in the future', { details: { path: 'until' } })))
      .toEqual({ path: 'until', message: 'until must be in the future' });
  });

  it('a schedule refusal shows its text, not its path, under the schedule', async () => {
    const client = createFixtureLoopsClient();
    vi.spyOn(client, 'create').mockRejectedValue(new CollabError('invalid_input', 'schedule: cron needs 5 fields, got 2', { details: { path: 'definition.schedule' } }));
    mount(client);
    name('X');
    fireEvent.click(screen.getByTestId('loop-action-dispatch'));
    submit();
    expect(await screen.findByText('cron needs 5 fields, got 2')).toBeTruthy();
    expect(screen.queryByText(/^schedule: /)).toBeNull();
  });
});

/* --- PR5a review fixes --------------------------------------------------- */

const conflict = () => new CollabError('version_conflict', 'version 9 is stale');

describe('an edit refused for a stale version (every firing moves it)', () => {
  const stored = () => fixtureLoopView('019fe999-0000-7000-8000-00000000e001', SPACE, {
    title: 'Nightly', action: 'dispatch', prompt: 'sweep',
  }, { version: 9 });

  it('re-reads and resends the same patch, under the same mutation id, when nothing it changes has moved', async () => {
    const view = stored();
    const client = createFixtureLoopsClient([view]);
    // The loop fired meanwhile: same definition, a newer version.
    client.loops.set(view.id, { ...view, version: 10, state: { ...view.state, lastRunAt: new Date().toISOString() } });
    const update = vi.spyOn(client, 'update');
    const { onSaved } = mount(client, { mode: 'edit', view });
    name('Nightly sweep');
    submit();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0]![0]).toMatchObject({ version: 9 });
    expect(update.mock.calls[1]![0]).toMatchObject({ version: 10 });
    expect(update.mock.calls[1]![1]).toEqual({ title: 'Nightly sweep' });
    expect(update.mock.calls[1]![2]!.clientMutationId).toBe(update.mock.calls[0]![2]!.clientMutationId);
  });

  it('a real overlap asks the human to re-read, and the re-read keeps their edit over the fresh loop', async () => {
    const view = stored();
    const client = createFixtureLoopsClient([view]);
    // Someone renamed it and rewrote the instructions.
    client.loops.set(view.id, { ...view, version: 11, definition: { ...view.definition, title: 'Their title', prompt: 'their prompt' } });
    const update = vi.spyOn(client, 'update');
    const { onSaved } = mount(client, { mode: 'edit', view });
    name('My title');
    submit();
    expect(await screen.findByText('save refused — this loop changed while you were editing')).toBeTruthy();
    expect(screen.getByText(/Someone changed the name since you opened it/)).toBeTruthy();
    expect(update).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 're-read' }));
    // Their instructions arrive; my title stays.
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('My title');
    expect((screen.getByTestId('loop-instructions') as HTMLTextAreaElement).value).toBe('their prompt');
    submit();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[1]![0]).toMatchObject({ version: 11 });
    expect(update.mock.calls[1]![1]).toEqual({ title: 'My title' });
  });

  it('a conflict the re-read cannot settle reads as a re-read-and-retry hint, never a raw error', async () => {
    const view = stored();
    const client = createFixtureLoopsClient([view]);
    vi.spyOn(client, 'update').mockRejectedValue(conflict());
    vi.spyOn(client, 'get').mockRejectedValue(new Error('offline'));
    mount(client, { mode: 'edit', view });
    name('Nightly sweep');
    submit();
    expect(await screen.findByText(/A loop's version also moves each time it fires: re-read it and retry/)).toBeTruthy();
  });
});

describe('one intent, one mutation id', () => {
  it('the refusal card\'s retry resends a create under the id it first used', async () => {
    const client = createFixtureLoopsClient();
    const create = vi.spyOn(client, 'create').mockRejectedValueOnce(new CollabError('upstream_unavailable', 'node busy', { retryable: true }));
    const { onSaved } = mount(client);
    name('Morning triage');
    fireEvent.click(screen.getByTestId('loop-action-dispatch'));
    submit();
    fireEvent.click(await screen.findByRole('button', { name: 'retry' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledTimes(2);
    const first = create.mock.calls[0]![3]!.clientMutationId;
    expect(first).toMatch(/^au-/);
    expect(create.mock.calls[1]![3]!.clientMutationId).toBe(first);
  });

  it('an unchanged edit sends nothing and closes', async () => {
    const view = fixtureLoopView('019fe999-0000-7000-8000-00000000e002', SPACE, { title: 'Weekly', action: 'dispatch' });
    const client = createFixtureLoopsClient([view]);
    const update = vi.spyOn(client, 'update');
    const { onClose, onSaved } = mount(client, { mode: 'edit', view });
    submit();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(update).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('the pickers', () => {
  it('the subject search asks the server for words through filters, not a top-level key', async () => {
    const held = sources();
    render(<div className="cv2-root"><LoopForm mode="create" spaceId={SPACE} client={createFixtureLoopsClient()} sources={held} onSaved={vi.fn()} onClose={vi.fn()} /></div>);
    fireEvent.click(screen.getAllByTestId('membership-add')[0]!);
    fireEvent.change(screen.getByLabelText('Filter candidates by title'), { target: { value: 'road' } });
    await screen.findByText('Roadmap');
    const searched = held.query.mock.calls.map(([input]) => input as Record<string, unknown>).filter(input => !input.kinds);
    expect(searched.at(-1)).toMatchObject({ spaceId: SPACE, filters: { words: 'road' } });
    expect(searched.every(input => !('words' in input))).toBe(true);
  });

  it('Enter in the subject filter picks the match without submitting; Escape closes the picker, not the dialog', async () => {
    const client = createFixtureLoopsClient();
    const create = vi.spyOn(client, 'create');
    const { onClose } = mount(client);
    fireEvent.click(screen.getAllByTestId('membership-add')[0]!);
    const filter = screen.getByLabelText('Filter candidates by title');
    fireEvent.change(filter, { target: { value: 'road' } });
    await screen.findByText('Roadmap');
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(screen.queryByLabelText('Filter candidates by title')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByTestId('membership-add')[0]!);
    const again = screen.getByLabelText('Filter candidates by title');
    fireEvent.change(again, { target: { value: 'road' } });
    await screen.findByText('Roadmap');
    fireEvent.keyDown(again, { key: 'Enter' });
    expect((await screen.findByTestId('loop-subject')).textContent).toContain('Roadmap');
    expect(create).not.toHaveBeenCalled();
  });

  it('re-picking the tool already chosen keeps what was typed for it', async () => {
    mount(createFixtureLoopsClient());
    fireEvent.click(screen.getByTestId('loop-action-tool'));
    fireEvent.click(screen.getByTestId('loop-tool'));
    fireEvent.click(await screen.findByTestId(`loop-tool-${TOOL}`));
    fireEvent.change(await screen.findByLabelText('depth'), { target: { value: '4' } });
    fireEvent.click(screen.getByTestId('loop-tool'));
    fireEvent.click(await screen.findByTestId(`loop-tool-${TOOL}`));
    expect((screen.getByLabelText('depth') as HTMLInputElement).value).toBe('4');
  });

  it('a list that cannot be read says so instead of looking empty', async () => {
    const failing = sources();
    failing.query.mockImplementation(async () => { throw new Error('read refused'); });
    render(<div className="cv2-root"><LoopForm mode="create" spaceId={SPACE} client={createFixtureLoopsClient()} sources={failing} onSaved={vi.fn()} onClose={vi.fn()} /></div>);
    fireEvent.click(screen.getByTestId('loop-teammate'));
    expect(await screen.findByText(/Could not read the list: read refused/)).toBeTruthy();
  });

  it('a tool still being read holds a create back rather than skipping its input checks', async () => {
    const client = createFixtureLoopsClient();
    const create = vi.spyOn(client, 'create');
    mount(client, {}, () => new Promise<ToolView>(() => undefined));
    name('Sweep');
    fireEvent.click(screen.getByTestId('loop-action-tool'));
    fireEvent.click(screen.getByTestId('loop-tool'));
    fireEvent.click(await screen.findByTestId(`loop-tool-${TOOL}`));
    submit();
    expect(await screen.findByText('The tool is still being read; its inputs appear in a moment.')).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it('a bound secret is named as bound', async () => {
    const bound = { ...TOOL_VIEW, secretBindings: [{ inputName: 'token' }] } as unknown as ToolView;
    mount(createFixtureLoopsClient(), {}, async () => bound);
    fireEvent.click(screen.getByTestId('loop-action-tool'));
    fireEvent.click(screen.getByTestId('loop-tool'));
    fireEvent.click(await screen.findByTestId(`loop-tool-${TOOL}`));
    expect((await screen.findByTestId('loop-tool-inputs')).textContent).toContain('Uses the secret bound on the tool');
  });

  it('a draft or retired profile is offered, refused with why', async () => {
    const withProfiles = sources();
    const rows: Record<string, EntitySummary[]> = {
      team_member: [summary(ADA, 'team_member', 'Ada')],
      interaction_profile: [
        { id: 'p-active', kind: 'interaction_profile', title: 'Careful', state: { kind: 'interaction_profile', status: 'active' } },
        { id: 'p-draft', kind: 'interaction_profile', title: 'Sketch', state: { kind: 'interaction_profile', status: 'draft' } },
      ] as unknown as EntitySummary[],
    };
    withProfiles.query.mockImplementation(async (input: { kinds?: string[] }) => ({ page: { items: rows[input.kinds?.[0] ?? ''] ?? [], nextCursor: null } }));
    render(<div className="cv2-root"><LoopForm mode="create" spaceId={SPACE} client={createFixtureLoopsClient()} sources={withProfiles} onSaved={vi.fn()} onClose={vi.fn()} /></div>);
    fireEvent.click(screen.getByText('Advanced'));
    fireEvent.click(screen.getByTestId('loop-profile'));
    const draft = await screen.findByTestId('loop-profile-p-draft');
    expect(draft.getAttribute('aria-disabled')).toBe('true');
    expect(draft.getAttribute('title')).toMatch(/draft/);
    expect(screen.getByTestId('loop-profile-p-active').getAttribute('aria-disabled')).toBeNull();
  });
});

describe('the fields keep what the human typed', () => {
  it('an emptied Every field stays empty (no snap to 1) and names what is missing', async () => {
    const client = createFixtureLoopsClient();
    const create = vi.spyOn(client, 'create');
    mount(client);
    name('Often');
    fireEvent.click(screen.getByTestId('loop-action-dispatch'));
    fireEvent.change(screen.getByTestId('loop-preset'), { target: { value: 'interval' } });
    fireEvent.change(screen.getByLabelText('Every'), { target: { value: '' } });
    expect((screen.getByLabelText('Every') as HTMLInputElement).value).toBe('');
    submit();
    expect(await screen.findByText('Enter how often, as a whole number.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Every'), { target: { value: '45' } });
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![1]).toMatchObject({ schedule: 'every 45m' });
  });

  it('a max runtime that is not a whole number is refused, not silently cleared', async () => {
    const client = createFixtureLoopsClient();
    const create = vi.spyOn(client, 'create');
    mount(client);
    name('Bounded');
    fireEvent.click(screen.getByTestId('loop-action-dispatch'));
    fireEvent.click(screen.getByText('Advanced'));
    fireEvent.change(screen.getByLabelText('Max runtime (minutes)'), { target: { value: '1e' } });
    submit();
    expect(await screen.findByText(/Max runtime \(minutes\) must be a whole number from 1 to 1440/)).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it('a typed custom cron survives a round trip through another preset', () => {
    mount(createFixtureLoopsClient());
    fireEvent.change(screen.getByTestId('loop-preset'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '17 3 * * 1-5' } });
    fireEvent.change(screen.getByTestId('loop-preset'), { target: { value: 'hourly' } });
    fireEvent.change(screen.getByTestId('loop-preset'), { target: { value: 'custom' } });
    expect((screen.getByLabelText('Cron expression') as HTMLInputElement).value).toBe('17 3 * * 1-5');
  });

  it('a stored JSON input opens as JSON, and an untouched one is not resent', async () => {
    const jsonTool = { ...TOOL_VIEW, definition: { ...TOOL_VIEW.definition, inputs: [{ name: 'payload', type: 'json' }] } } as unknown as ToolView;
    const view = fixtureLoopView('019fe999-0000-7000-8000-00000000e003', SPACE, {
      title: 'Post', action: 'tool', toolId: TOOL, toolInputs: { payload: 'abc' },
    }, { version: 2 });
    const client = createFixtureLoopsClient([view]);
    const update = vi.spyOn(client, 'update');
    mount(client, { mode: 'edit', view }, async () => jsonTool);
    expect(((await screen.findByLabelText('payload')) as HTMLTextAreaElement).value).toBe('"abc"');
    name('Post daily');
    submit();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1]).toEqual({ title: 'Post daily' });
  });
});

describe('the schedule an edit opens on', () => {
  it('uses the preview loops.get returned, and a stored schedule that never fires does not block a title edit', async () => {
    const view = fixtureLoopView('019fe999-0000-7000-8000-00000000e004', SPACE, { title: 'Leap', action: 'dispatch', schedule: '0 0 30 2 *' }, {
      schedule: { valid: false, problem: 'the schedule never matches within a year', summary: '', next: [] },
    });
    const client = createFixtureLoopsClient([view]);
    const preview = vi.spyOn(client, 'schedulePreview');
    const update = vi.spyOn(client, 'update');
    mount(client, { mode: 'edit', view });
    expect(screen.getByTestId('loop-schedule-problem').textContent).toBe('the schedule never matches within a year');
    expect(screen.getByTestId('loop-schedule-stored-note')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save loop' }) as HTMLButtonElement).disabled).toBe(false);
    name('Leap day');
    submit();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1]).toEqual({ title: 'Leap day' });
    expect(preview).not.toHaveBeenCalled();
  });
});

describe('while a save is in flight', () => {
  it('the action radios are disabled, and Escape does not close the form', async () => {
    const client = createFixtureLoopsClient();
    let release: (value: never) => void = () => undefined;
    vi.spyOn(client, 'create').mockImplementation(() => new Promise(resolve => { release = resolve as never; }));
    const { onClose } = mount(client);
    name('Slow');
    fireEvent.click(screen.getByTestId('loop-action-dispatch'));
    submit();
    await waitFor(() => expect((screen.getByTestId('loop-action-spawn') as HTMLButtonElement).disabled).toBe(true));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { release(fixtureLoopView('019fe999-0000-7000-8000-00000000e005', SPACE) as never); });
  });

  it('the radio group moves with the arrow keys', () => {
    mount(createFixtureLoopsClient());
    const group = screen.getByRole('radiogroup', { name: 'What should run?' });
    expect(screen.getByTestId('loop-action-spawn').getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(screen.getByTestId('loop-action-dispatch').getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('loop-action-dispatch'));
    fireEvent.keyDown(group, { key: 'End' });
    expect(screen.getByTestId('loop-action-tool').getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(screen.getByTestId('loop-action-spawn').getAttribute('aria-checked')).toBe('true');
  });
});

describe('on the phone', () => {
  it('the dialog joins the sheet host, so a picker sheet opened from it is drawn above it', () => {
    const host = document.createElement('div');
    host.className = 'msheet-host';
    document.body.appendChild(host);
    render(
      <MobileSurfaceProvider sheetHost={host}>
        <div className="cv2-root">
          <LoopForm mode="create" spaceId={SPACE} client={createFixtureLoopsClient()} sources={sources()} onSaved={vi.fn()} onClose={vi.fn()} />
        </div>
      </MobileSurfaceProvider>,
    );
    expect(host.querySelector(':scope > .au-dialog__backdrop [data-testid="loop-form"]')).toBeTruthy();
    host.remove();
  });
});

describe('the panel edit dialog hands Escape to the loop form', () => {
  it('Escape mid-save cancels nothing; Escape at rest closes once', async () => {
    const { EditEntityDialog } = await import('../authoring/EditEntityDialog');
    const view = fixtureLoopView('019fe999-0000-7000-8000-00000000e006', SPACE, { title: 'Weekly', action: 'dispatch' });
    const client = createFixtureLoopsClient([view]);
    let release: (value: never) => void = () => undefined;
    vi.spyOn(client, 'update').mockImplementation(() => new Promise(resolve => { release = resolve as never; }));
    const cancel = vi.fn();
    const flow = {
      open: true, cancel, state: { phase: 'idle' }, values: {}, initialValues: {},
      loopEditor: { loopId: view.id, spaceId: SPACE, client, sources: sources(), onSaved: vi.fn() },
    } as never;
    render(<div className="cv2-root"><EditEntityDialog flow={flow} fields={[]} title="Edit loop" /></div>);
    await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Weekly'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(cancel).toHaveBeenCalledTimes(1);
    cancel.mockClear();
    name('Weekly digest');
    submit();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving…' })).toBeTruthy());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => { release(view as never); });
  });
});
