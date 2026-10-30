// @vitest-environment jsdom
/**
 * The launch card v3 (mock 01a0df08) in the Run popup — the card itself.
 *
 * What must hold: the title row is one line with + and the pinned task, and
 * + says why nothing more can go in full yet; the notes ride as promptExtra
 * and nothing is written onto the task; the strip is ONE row of type groups
 * with files first, each group a view of the selection; Attach adds several
 * at once, each to its group; uploads land in Files, can fail and be retried,
 * and hold Launch; Launch and Dispatch commit on their first press, and the
 * card collapses to one launching line (or hands off to the host through
 * `onLaunchStarted`); Dispatch refuses what the node can't carry yet and reads
 * an undelivered result as a warning; a timed-out spawn is checked before any
 * retry; Escape unwinds a menu, the drawer, then the card; a closed card
 * keeps a draft.
 *
 * jsdom has no layout, so none of this says anything about clipping or the
 * card's width — the screenshots on the PR do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, waitFor, within } from '@testing-library/react';

import { LAUNCH_DEFAULTS } from '../views/launch-fixtures';
import { McpProvider } from '../mcp/context';
import type { McpPort } from '../mcp/port';
import { DETACH_AFTER_MS, LaunchComposerPopup } from './LaunchComposerPopup';
import { controlledUpload, file, renderPopup } from './launch-test-kit';

beforeEach(() => { localStorage.clear(); });

describe('the title row', () => {
  it('is + then the task, pinned; the peek is read-only and never edits the task', async () => {
    const view = renderPopup({ loadDescription: () => Promise.resolve('Reconnect drops after 30s.'), canEditSubject: true });
    expect(view.getByTestId('lcd3-subject').textContent).toContain('Wire the launch flow');
    fireEvent.click(view.getByTestId('lcd3-subject'));
    await waitFor(() => expect(view.getByTestId('lcd3-description').textContent).toBe('Reconnect drops after 30s.'));
    expect(view.getByTestId('lcd3-subject-peek').querySelector('textarea')).toBeNull();
    fireEvent.click(view.getByTestId('lcd3-edit-subject'));
    expect(view.onDismiss).toHaveBeenCalled();
  });

  it('hides "Edit on the task" from a viewer who cannot edit it', () => {
    const view = renderPopup({ canEditSubject: false });
    fireEvent.click(view.getByTestId('lcd3-subject'));
    expect(view.queryByTestId('lcd3-edit-subject')).toBeNull();
  });

  it('+ says why nothing more can be sent in full, and the search still filters by type', async () => {
    const view = renderPopup();
    await view.ready();
    const plus = view.getByTestId('lcd3-add-full');
    expect(plus.getAttribute('aria-disabled')).toBe('true');
    expect(plus.getAttribute('title')).toMatch(/in-full channel/);
    fireEvent.click(plus);
    const menu = view.getByTestId('lcd3-full-menu');
    expect(menu.textContent).toMatch(/in-full channel/);
    fireEvent.click(within(menu).getByTestId('lcd3-full-type'));
    expect(within(menu).getByTestId('lcd3-full-types').textContent).toMatch(/Memories/);
    expect(within(menu).queryByTestId('lcd3-full-type-file')).toBeNull();
    fireEvent.click(within(menu).getByTestId('lcd3-full-type-task'));
    expect(within(menu).getByTestId('lcd3-full-type').textContent).toContain('Tasks');
    expect(within(menu).getByTestId('lcd3-full-add-ent-task-2')).toBeTruthy();
    expect(within(menu).queryByTestId('lcd3-full-add-ent-doc-other')).toBeNull();
  });
});

describe('the notes', () => {
  it('ride as promptExtra and the spawn is titled from the task', async () => {
    const view = renderPopup();
    fireEvent.change(view.getByTestId('lcd3-notes'), { target: { value: '  focus on the reconnect path  ' } });
    const input = await view.spawn();
    expect(input.promptExtra).toBe('focus on the reconnect path');
    expect(input.title).toBe('Wire the launch flow');
  });

  it('survive closing the card, as a draft for the same task, until a launch succeeds', async () => {
    const first = renderPopup();
    fireEvent.change(first.getByTestId('lcd3-notes'), { target: { value: 'half-written thought' } });
    first.unmount();
    const second = renderPopup();
    expect((second.getByTestId('lcd3-notes') as HTMLTextAreaElement).value).toBe('half-written thought');
    await second.spawn();
    second.unmount();
    const third = renderPopup();
    expect((third.getByTestId('lcd3-notes') as HTMLTextAreaElement).value).toBe('');
  });
});

describe('the strip', () => {
  it('is one row of type groups, files first, each shown only when it has a row', async () => {
    const view = renderPopup();
    await view.ready();
    const kinds = [...view.getByTestId('lcd3-strip').querySelectorAll('[data-testid^="lcd3-group-"]')]
      .map((el) => el.getAttribute('data-testid'));
    expect(kinds).toEqual(['lcd3-group-file', 'lcd3-group-memory', 'lcd3-group-skill', 'lcd3-group-doc']);
    expect(view.queryByTestId('lcd3-group-task')).toBeNull();
  });

  it('a group opens its rows with where each came from; unticking a default turns the chip amber and rides the spawn', async () => {
    const view = renderPopup();
    const menu = await view.openGroup('doc');
    expect(within(menu).getByTestId('lcd3-row-ent-doc-spec').textContent).toContain('linked to the task');
    fireEvent.click(within(within(menu).getByTestId('lcd3-row-ent-doc-spec')).getByRole('menuitemcheckbox'));
    expect(view.getByTestId('lcd3-group-doc').getAttribute('data-edited')).toBe('true');
    const input = await view.spawn();
    expect(input.selection?.referenceIds).toEqual(['ent-file-log']);
  });

  it('files and docs share one selection group on the wire; an untouched launch sends no selection', async () => {
    const view = renderPopup();
    await view.ready();
    const input = await view.spawn();
    expect(input.selection).toBeUndefined();
  });

  it('"↑ in full" says why a file never can, and why nothing can yet', async () => {
    const view = renderPopup();
    const files = await view.openGroup('file');
    expect(within(files).getByTestId('lcd3-row-full-ent-file-log').getAttribute('title')).toMatch(/file references/);
    fireEvent.keyDown(document, { key: 'Escape' });
    const docs = await view.openGroup('doc');
    expect(within(docs).getByTestId('lcd3-row-full-ent-doc-spec').getAttribute('title')).toMatch(/in-full channel/);
  });

  it('+ Add in a group adds from that type only', async () => {
    const view = renderPopup();
    const menu = await view.openGroup('memory');
    expect(within(menu).queryByTestId('lcd3-group-add-ent-doc-other')).toBeNull();
    fireEvent.click(within(menu).getByTestId('lcd3-group-add-mem-extra'));
    const input = await view.spawn();
    expect(input.selection?.memoryIds).toEqual(['ent-mem-tokens', 'mem-extra']);
  });
});

describe('Attach', () => {
  it('takes several picks at once, each into its own group; the task itself is never offered', async () => {
    const view = renderPopup();
    await view.ready();
    fireEvent.click(view.getByTestId('lcd3-attach'));
    const menu = view.getByTestId('lcd3-attach-menu');
    expect(within(menu).queryByTestId('lcd3-attach-row-task-9')).toBeNull();
    expect(within(menu).getByTestId('lcd3-attach-row-ent-doc-spec').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(within(menu).getByTestId('lcd3-attach-row-ent-doc-other'));
    fireEvent.click(within(menu).getByTestId('lcd3-attach-row-mem-extra'));
    fireEvent.click(within(menu).getByTestId('lcd3-attach-row-sk-extra'));
    expect(within(menu).getByTestId('lcd3-attach-add').textContent).toBe('Add 3');
    fireEvent.click(within(menu).getByTestId('lcd3-attach-add'));
    expect(view.queryByTestId('lcd3-attach-menu')).toBeNull();
    const input = await view.spawn();
    expect(input.selection?.referenceIds).toEqual(['ent-doc-spec', 'ent-file-log', 'ent-doc-other']);
    expect(input.selection?.memoryIds).toEqual(['ent-mem-tokens', 'mem-extra']);
    expect(input.selection?.skillIds).toEqual(['ent-sk-review', 'sk-extra']);
  });

  it('an unticked default is SUGGESTED first in Attach, and one click ticks it back', async () => {
    const view = renderPopup();
    const menu = await view.openGroup('doc');
    fireEvent.click(within(within(menu).getByTestId('lcd3-row-ent-doc-spec')).getByRole('menuitemcheckbox'));
    fireEvent.click(view.getByTestId('lcd3-attach'));
    const attach = view.getByTestId('lcd3-attach-menu');
    const first = within(attach).getAllByRole('menuitemcheckbox')[0]!;
    expect(first.getAttribute('data-testid')).toBe('lcd3-attach-suggested-ent-doc-spec');
    fireEvent.click(first);
    await waitFor(() => expect(view.getByTestId('lcd3-group-doc').getAttribute('data-edited')).toBeNull());
  });

  it('its type filter replaces the results while open, and keeps the picks across types', async () => {
    const view = renderPopup();
    await view.ready();
    fireEvent.click(view.getByTestId('lcd3-attach'));
    const menu = view.getByTestId('lcd3-attach-menu');
    fireEvent.click(within(menu).getByTestId('lcd3-attach-row-mem-extra'));
    fireEvent.click(within(menu).getByTestId('lcd3-attach-type'));
    expect(within(menu).queryByTestId('lcd3-attach-row-mem-extra')).toBeNull();
    expect(menu.textContent).toContain('1 selected — kept while you switch type');
    fireEvent.click(within(menu).getByTestId('lcd3-attach-type-skill'));
    expect(within(menu).getByTestId('lcd3-attach-row-sk-extra')).toBeTruthy();
    expect(within(menu).queryByTestId('lcd3-attach-row-ent-doc-other')).toBeNull();
    expect(within(menu).getByTestId('lcd3-attach-add').textContent).toBe('Add 1');
  });

  it('offers teammates as a type, drawn but not sendable yet, with the reason', async () => {
    const view = renderPopup();
    await view.ready();
    fireEvent.click(view.getByTestId('lcd3-attach'));
    const row = within(view.getByTestId('lcd3-attach-menu')).getByTestId('lcd3-attach-row-tm-scout');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.getAttribute('title')).toMatch(/can’t take teammates/);
    expect(within(view.getByTestId('lcd3-attach-menu')).queryByTestId('lcd3-attach-row-tm-forge')).toBeNull();
  });
});

describe('files from this computer', () => {
  it('upload into Files; Launch waits while one is in flight', async () => {
    const { upload, complete } = controlledUpload();
    const view = renderPopup({ upload });
    await view.ready();
    const picked = file('launch-card-sketch.png');
    fireEvent.change(view.getByTestId('lcd3-file-input'), { target: { files: [picked] } });
    expect(upload).toHaveBeenCalledWith(picked);
    expect(view.getByTestId('lcd3-upload-upload:1').textContent).toContain('uploading…');
    expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('true');
    expect(view.getByRole('alert').textContent).toContain('Waiting for 1 upload');
    await complete(0, 'file-1', 'launch-card-sketch.png');
    const input = await view.spawn();
    expect(input.selection?.referenceIds).toEqual(['ent-doc-spec', 'ent-file-log', 'file-1']);
  });

  it('a failed upload says why, and can be retried or removed', async () => {
    const { upload, failAt, complete } = controlledUpload();
    const view = renderPopup({ upload });
    await view.ready();
    fireEvent.change(view.getByTestId('lcd3-file-input'), { target: { files: [file('big.har')] } });
    const key = view.getByTestId('lcd3-strip').querySelector('[data-testid^="lcd3-upload-upload:"]')!.getAttribute('data-testid')!.slice('lcd3-upload-'.length);
    await failAt(0, 'too large');
    expect(view.getByTestId(`lcd3-upload-${key}`).getAttribute('title')).toContain('too large');
    fireEvent.click(view.getByTestId(`lcd3-upload-retry-${key}`));
    expect(upload).toHaveBeenCalledTimes(2);
    await complete(1, 'file-2', 'big.har');
    expect(view.queryByTestId(`lcd3-upload-${key}`)).toBeNull();
  });

  it('can be dropped anywhere on the card', async () => {
    const { upload } = controlledUpload();
    const view = renderPopup({ upload });
    await view.ready();
    const dropped = file('boot.log');
    fireEvent.drop(view.getByTestId('launch-card'), { dataTransfer: { files: [dropped], types: ['Files'] } });
    expect(upload).toHaveBeenCalledWith(dropped);
  });

  it('with no upload path, Attach’s Files row is refused with the reason', () => {
    const view = renderPopup();
    fireEvent.click(view.getByTestId('lcd3-attach'));
    const row = view.getByTestId('lcd3-attach-files');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.textContent).toContain('no upload path');
  });
});

describe('the verb switch', () => {
  it('sets the KIND of session — worker, coordinator, dispatcher', async () => {
    const view = renderPopup();
    expect(view.getByTestId('lcd-verb').textContent).toContain('RUN');
    fireEvent.click(view.getByTestId('lcd-verb'));
    fireEvent.click(view.getByTestId('lcd-verb-coordinator'));
    expect((await view.spawn()).mode).toBe('coordinator');
  });

  it('opens on the opening verb’s mode', () => {
    const view = renderPopup({ mode: 'coordinator', verbLabel: 'Coordinate' });
    expect(view.getByTestId('lcd-verb').textContent).toContain('COORDINATE');
  });

  const WITH_MODES = [
    { id: 'tm-forge', label: 'forge', agentTool: 'claude-code', model: 'claude-sonnet-5', mode: 'worker' },
    { id: 'tm-router', label: 'router', agentTool: 'claude-code', model: 'claude-sonnet-5', mode: 'dispatcher' },
  ];

  it('DISPATCH offers only dispatcher-capable teammates, and moves onto one', async () => {
    const view = renderPopup({ teammates: WITH_MODES });
    fireEvent.click(view.getByTestId('lcd-verb'));
    fireEvent.click(view.getByTestId('lcd-verb-dispatcher'));
    await waitFor(() => expect(view.getByTestId('nsx-team').getAttribute('aria-label')).toBe('Teammate: router'));
    fireEvent.click(view.getByTestId('nsx-team'));
    const names = within(view.getByTestId('nsx-team-menu')).getAllByRole('menuitemradio').map((b) => b.textContent);
    expect(names.some((n) => n?.includes('forge'))).toBe(false);
  });

  it('DISPATCH hides the Teammates type from Attach: a dispatcher gets the whole roster', async () => {
    const view = renderPopup({ teammates: WITH_MODES });
    await view.ready();
    fireEvent.click(view.getByTestId('lcd-verb'));
    fireEvent.click(view.getByTestId('lcd-verb-dispatcher'));
    fireEvent.click(view.getByTestId('lcd3-attach'));
    fireEvent.click(view.getByTestId('lcd3-attach-type'));
    expect(view.queryByTestId('lcd3-attach-type-teammate')).toBeNull();
  });

  it('RUN keeps the Teammates type in Attach', async () => {
    const view = renderPopup({ teammates: WITH_MODES });
    await view.ready();
    fireEvent.click(view.getByTestId('lcd3-attach'));
    fireEvent.click(view.getByTestId('lcd3-attach-type'));
    expect(view.getByTestId('lcd3-attach-type-teammate')).toBeTruthy();
  });

  it('DISPATCH refuses when the node doesn’t say which teammates can dispatch', () => {
    const view = renderPopup();
    fireEvent.click(view.getByTestId('lcd-verb'));
    fireEvent.click(view.getByTestId('lcd-verb-dispatcher'));
    expect(view.getByTestId('nsx-send').getAttribute('title')).toMatch(/doesn’t say which teammates can run as a dispatcher/);
  });

  it('DISPATCH locks access at Full access, with the node’s reason', async () => {
    const view = renderPopup({ teammates: WITH_MODES });
    fireEvent.click(view.getByTestId('lcd-verb'));
    fireEvent.click(view.getByTestId('lcd-verb-dispatcher'));
    const access = view.getByTestId('nsx-perm');
    expect(access.getAttribute('aria-disabled')).toBe('true');
    expect(access.getAttribute('title')).toMatch(/forces it for dispatchers/);
    fireEvent.click(access);
    expect(view.queryByTestId('nsx-perm-menu')).toBeNull();
    expect((await view.spawn()).mode).toBe('dispatcher');
  });

  it('the drawer no longer carries a Session mode select', () => {
    const view = renderPopup();
    fireEvent.click(view.getByTestId('lcd-advanced-toggle'));
    expect(view.queryByTestId('lcd-mode')).toBeNull();
  });
});

describe('Launch commits on the first press', () => {
  it('one press sends the notes and the strip; nothing opens in between', async () => {
    const view = renderPopup();
    await view.ready();
    fireEvent.change(view.getByTestId('lcd3-notes'), { target: { value: 'be brief' } });
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(view.onSpawn).toHaveBeenCalledTimes(1));
    expect(view.onSpawn.mock.calls[0]![0].promptExtra).toBe('be brief');
  });

  it('⌘↵ commits', async () => {
    const view = renderPopup();
    await view.ready();
    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false'));
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(view.onSpawn).toHaveBeenCalledTimes(1));
  });

  it('while the node answers, the card is ONE launching line naming what was pressed', async () => {
    const view = renderPopup({ onSpawn: vi.fn(() => new Promise<void>(() => {})) });
    await view.ready();
    fireEvent.click(view.getByTestId('nsx-send'));
    const line = await view.findByTestId('lcd3-launching');
    expect(line.textContent).toContain('Launching Wire the launch flow');
    expect(line.textContent).toContain('forge');
    expect(line.getAttribute('role')).toBe('status');
  });

  it('a refusal returns to the card with the reason, and does not dismiss', async () => {
    const view = renderPopup({ onSpawn: vi.fn(() => Promise.reject(new Error('teammate is paused'))) });
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('teammate is paused'));
    expect(view.queryByTestId('lcd3-launching')).toBeNull();
    expect(view.onDismiss).not.toHaveBeenCalled();
  });

  it('a retry of the SAME launch reuses its mutation id; a changed launch mints a new one', async () => {
    let n = 0;
    const onSpawn = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('refused')))
      .mockImplementationOnce(() => Promise.reject(new Error('refused')))
      .mockImplementation(() => Promise.resolve());
    const view = renderPopup({ onSpawn, clientMutationId: undefined, newClientMutationId: () => `m:${String(++n)}` });
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(2));
    expect(onSpawn.mock.calls[1]![0].clientMutationId).toBe(onSpawn.mock.calls[0]![0].clientMutationId);
    await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());
    fireEvent.change(view.getByTestId('lcd3-notes'), { target: { value: 'changed' } });
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(3));
    expect(onSpawn.mock.calls[2]![0].clientMutationId).not.toBe(onSpawn.mock.calls[0]![0].clientMutationId);
  });
});

describe('the onLaunchStarted handoff', () => {
  it('true: the host takes the launch — the seam sees the exact input, onSpawn still fires, the card dismisses at once', async () => {
    let settle: (() => void) | null = null;
    const onSpawn = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    const onLaunchStarted = vi.fn(() => true);
    const view = renderPopup({ onSpawn, onLaunchStarted });
    await view.ready();
    fireEvent.change(view.getByTestId('lcd3-notes'), { target: { value: 'be brief' } });
    fireEvent.click(view.getByTestId('nsx-send'));
    expect(onLaunchStarted).toHaveBeenCalledTimes(1);
    expect(view.onDismiss).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));
    const input = onSpawn.mock.calls[0]![0] as { clientMutationId: string; title?: string };
    expect(onLaunchStarted.mock.calls[0]![0]).toMatchObject({
      clientMutationId: input.clientMutationId,
      subjectId: 'task-9',
      title: input.title,
      verb: 'worker',
      teammate: { id: 'tm-forge', name: 'forge' },
      notes: 'be brief',
      workdir: { kind: 'project', projectId: 'pj-a', mode: 'worktree', baseRef: null },
    });
    settle!();
  });

  it('true: a failure afterwards is the host’s to show — the card draws nothing and throws nothing', async () => {
    const view = renderPopup({ onSpawn: vi.fn(() => Promise.reject(new Error('no'))), onLaunchStarted: () => true });
    await view.ready();
    fireEvent.click(view.getByTestId('nsx-send'));
    expect(view.onDismiss).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(view.props.onSpawn).toHaveBeenCalled());
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('false (or absent): the card keeps its launching line until onSpawn settles', async () => {
    let settle: (() => void) | null = null;
    const onSpawn = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    const onLaunchStarted = vi.fn(() => false);
    const view = renderPopup({ onSpawn, onLaunchStarted });
    await view.ready();
    fireEvent.click(view.getByTestId('nsx-send'));
    expect(onLaunchStarted).toHaveBeenCalledTimes(1);
    expect(view.onDismiss).not.toHaveBeenCalled();
    expect(await view.findByTestId('lcd3-launching')).toBeTruthy();
    settle!();
    await waitFor(() => expect(view.onDismiss).toHaveBeenCalledTimes(1));
  });

  it('true clears the draft on that dismiss', async () => {
    const view = renderPopup({ onLaunchStarted: () => true });
    await view.ready();
    fireEvent.change(view.getByTestId('lcd3-notes'), { target: { value: 'draft words' } });
    fireEvent.click(view.getByTestId('nsx-send'));
    view.unmount();
    const again = renderPopup();
    expect((again.getByTestId('lcd3-notes') as HTMLTextAreaElement).value).toBe('');
  });
});

describe('a spawn that timed out', () => {
  const timeout = () => Promise.reject(Object.assign(new Error('the tm8 node did not answer within 180000ms'), { code: 'upstream_unavailable' }));

  it('is checked before any retry: a session found means nothing more to launch', async () => {
    const sessionsSince = vi.fn(async () => [{ id: 'ws-1', title: 'Wire the launch flow' }]);
    const onSpawn = vi.fn(timeout);
    const view = renderPopup({ onSpawn, sessionsSince });
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('already working on the task'));
    expect(sessionsSince).toHaveBeenCalledWith('task-9', expect.any(String));
    fireEvent.click(view.getByTestId('nsx-send'));
    expect(onSpawn).toHaveBeenCalledTimes(1);
  });

  it('no session found: retry is offered', async () => {
    const onSpawn = vi.fn(timeout);
    const view = renderPopup({ onSpawn, sessionsSince: async () => [] });
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('Launch again to retry'));
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(2));
  });

  it('with no way to check, it says so rather than calling a retry safe', async () => {
    const view = renderPopup({ onSpawn: vi.fn(timeout) });
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('may have started'));
  });
});

describe('Dispatch', () => {
  it('is absent unless a host wires it', () => {
    expect(renderPopup().queryByTestId('launch-dispatch')).toBeNull();
  });

  it('commits on its first press, sends only the notes, and closes on success', async () => {
    const onDispatch = vi.fn(async () => ({ delivery: 'delivered', dispatcherSpawned: false }));
    const view = renderPopup({ onDispatch });
    fireEvent.change(view.getByTestId('lcd3-notes'), { target: { value: 'route to a UI person' } });
    fireEvent.click(view.getByTestId('launch-dispatch'));
    await waitFor(() => expect(view.onDismiss).toHaveBeenCalled());
    expect(onDispatch).toHaveBeenCalledWith('route to a UI person', expect.any(String));
  });

  it('with no dispatcher read, its state is unknown — neither grey nor glowing — and the tooltip says so', () => {
    const view = renderPopup({ onDispatch: vi.fn() });
    const button = view.getByTestId('launch-dispatch');
    expect(button.getAttribute('data-live')).toBeNull();
    expect(button.querySelector('[data-unknown]')).not.toBeNull();
    expect(button.getAttribute('title')).toMatch(/doesn’t report its dispatchers/);
  });

  it('an undelivered request is a warning, not a success', async () => {
    const view = renderPopup({ onDispatch: vi.fn(async () => ({ delivery: 'undelivered', dispatcherSpawned: true })) });
    fireEvent.click(view.getByTestId('launch-dispatch'));
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('couldn’t deliver it to the dispatcher it just started'));
    expect(view.onDismiss).not.toHaveBeenCalled();
  });

  it('refuses a coordinator or dispatcher kind, and notes over 4000 characters, with the reasons', () => {
    const view = renderPopup({ onDispatch: vi.fn() });
    fireEvent.change(view.getByTestId('lcd3-notes'), { target: { value: 'x'.repeat(4001) } });
    expect(view.getByTestId('launch-dispatch').getAttribute('title')).toMatch(/at most 4000 characters/);
    fireEvent.change(view.getByTestId('lcd3-notes'), { target: { value: '' } });
    fireEvent.click(view.getByTestId('lcd-verb'));
    fireEvent.click(view.getByTestId('lcd-verb-coordinator'));
    const button = view.getByTestId('launch-dispatch');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toMatch(/can’t ask for a coordinator yet/);
    fireEvent.click(button);
    expect(view.props.onDispatch).not.toHaveBeenCalled();
  });

  it('a retried dispatch reuses its key', async () => {
    const onDispatch = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('flaky')))
      .mockImplementation(async () => ({ delivery: 'delivered' }));
    const view = renderPopup({ onDispatch });
    fireEvent.click(view.getByTestId('launch-dispatch'));
    await waitFor(() => expect(onDispatch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());
    fireEvent.click(view.getByTestId('launch-dispatch'));
    await waitFor(() => expect(onDispatch).toHaveBeenCalledTimes(2));
    expect(onDispatch.mock.calls[1]![1]).toBe(onDispatch.mock.calls[0]![1]);
  });
});

describe('the keyboard', () => {
  it('Escape closes a menu first, then the drawer, then the popup', () => {
    const view = renderPopup();
    fireEvent.click(view.getByTestId('lcd3-attach'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(view.queryByTestId('lcd3-attach-menu')).toBeNull();
    fireEvent.click(view.getByTestId('lcd-advanced-toggle'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(view.getByTestId('lcd-drawer').getAttribute('data-open')).toBeNull();
    expect(view.onDismiss).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(view.onDismiss).toHaveBeenCalled();
  });
});

describe('the bottom band', () => {
  it('access starts on the teammate’s default and sends none until changed', async () => {
    const view = renderPopup();
    expect(view.getByTestId('nsx-perm').getAttribute('aria-label')).toMatch(/Default/);
    expect((await view.spawn()).accessMode).toBeUndefined();
  });

  it('the effort menu offers exactly the stops the model takes', () => {
    const view = renderPopup();
    fireEvent.click(view.getByTestId('nsx-effort'));
    const stops = within(view.getByTestId('lcd-effort-menu')).getAllByRole('menuitemradio').map((b) => b.textContent?.replace('✓', ''));
    expect(stops).toEqual(['Low', 'Medium', 'High', 'Max']);
  });
});

describe('remembered picks, per teammate', () => {
  it('a successful launch remembers them, and the next popup for that teammate restores them', async () => {
    const first = renderPopup();
    fireEvent.click(first.getByTestId('nsx-effort'));
    fireEvent.click(within(first.getByTestId('lcd-effort-menu')).getByRole('menuitemradio', { name: 'Low' }));
    await first.spawn();
    first.unmount();
    const second = renderPopup();
    await waitFor(() => expect(second.getByTestId('nsx-effort').getAttribute('aria-label')).toBe('Reasoning effort: Low'));
    expect((await second.spawn()).reasoningEffort).toBe('low');
  });
});

describe('present-only: the card draws what this launch carries', () => {
  const EMPTY = { items: [], total: 0, budget: null, floor: 1.5, minEntries: 1 };

  it('nothing attached ⇒ just Attach: no group chips and no placeholder sentence', async () => {
    const view = renderPopup({
      selection: { load: async () => ({ ...LAUNCH_DEFAULTS, memories: EMPTY, skills: EMPTY, references: EMPTY }) },
    });
    await waitFor(() => expect(view.queryByTestId('lcd3-strip-empty')).toBeNull());
    expect(view.getByTestId('lcd3-attach')).toBeTruthy();
    expect(view.getByTestId('lcd3-strip').children).toHaveLength(0);
    expect(view.getByTestId('launch-card').textContent).not.toMatch(/None\.|Empty\.|Nothing else|Nothing attached/);
  });

  it('a group whose every row is unticked leaves the card once its menu closes — and stays one click away in Attach', async () => {
    const view = renderPopup();
    const menu = await view.openGroup('memory');
    fireEvent.click(within(menu).getByRole('menuitemcheckbox'));
    expect(view.getByTestId('lcd3-group-memory')).toBeTruthy(); // its menu is still open
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(view.queryByTestId('lcd3-group-memory')).toBeNull());
    expect(view.getByTestId('lcd3-attach-suggested-count').textContent).toContain('1 suggested');
    fireEvent.click(view.getByTestId('lcd3-attach'));
    expect(view.queryByTestId('lcd3-attach-row-ent-mem-tokens')).toBeNull(); // listed once, under Suggested
    fireEvent.click(view.getByTestId('lcd3-attach-suggested-ent-mem-tokens'));
    await waitFor(() => expect(view.getByTestId('lcd3-group-memory')).toBeTruthy());
    expect(view.queryByTestId('lcd3-attach-suggested-count')).toBeNull();
  });

  it('the in-full lane is not drawn while nothing is in full; + stays', () => {
    const view = renderPopup();
    expect(view.queryByTestId('lcd3-full-lane')).toBeNull();
    expect(view.getByTestId('lcd3-add-full')).toBeTruthy();
  });

  it('connectors: the block is hidden at count 0 but the picker stays mounted', () => {
    const view = renderPopup();
    const slot = view.getByTestId('lcd3-connectors');
    expect(slot.hidden).toBe(true);
  });
});

describe('a press in flight', () => {
  it('Escape and the scrim do nothing while launching; the answer still closes the card, once', async () => {
    let settle: (() => void) | null = null;
    const view = renderPopup({ onSpawn: vi.fn(() => new Promise<void>((resolve) => { settle = resolve; })) });
    await view.ready();
    fireEvent.click(view.getByTestId('nsx-send'));
    await view.findByTestId('lcd3-launching');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(document.querySelector('.nsx-popup__scrim')!);
    expect(view.onDismiss).not.toHaveBeenCalled();
    settle!();
    await waitFor(() => expect(view.onDismiss).toHaveBeenCalledTimes(1));
  });

  it('a refusal after Escape was pressed mid-flight is still drawn on the card', async () => {
    let reject: ((e: Error) => void) | null = null;
    const view = renderPopup({ onSpawn: vi.fn(() => new Promise<void>((_, no) => { reject = no; })) });
    await view.ready();
    fireEvent.click(view.getByTestId('nsx-send'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(reject).not.toBeNull());
    reject!(new Error('teammate is paused'));
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('teammate is paused'));
    expect(view.onDismiss).not.toHaveBeenCalled();
  });

  it('a double press in one frame calls onSpawn once', async () => {
    const onSpawn = vi.fn(() => new Promise<void>(() => {}));
    const view = renderPopup({ onSpawn, onDismiss: () => {} });
    await view.ready();
    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(view.getByTestId('nsx-send'));
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(onSpawn).toHaveBeenCalledTimes(1);
  });

  it('handed off to a host that keeps the card mounted: the card is idle again, and a second press replays the same key', async () => {
    const onSpawn = vi.fn(() => new Promise<void>(() => {}));
    const view = renderPopup({ onSpawn, onDismiss: () => {}, onLaunchStarted: () => true });
    await view.ready();
    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));
    expect(view.queryByTestId('lcd3-launching')).toBeNull();
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(2));
    const ids = onSpawn.mock.calls.map((c) => (c as unknown as [{ clientMutationId: string }])[0].clientMutationId);
    expect(ids[1]).toBe(ids[0]);
  });

  it('a handoff that throws is a refused launch: nothing is sent and the card says why', async () => {
    const onSpawn = vi.fn();
    const view = renderPopup({ onSpawn, onLaunchStarted: () => { throw new Error('host exploded'); } });
    await view.ready();
    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('host exploded'));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(onSpawn).not.toHaveBeenCalled();
    expect(view.queryByTestId('lcd3-launching')).toBeNull();
  });

  it('focus is parked on the launching line, never on the page behind', async () => {
    const view = renderPopup({ onSpawn: vi.fn(() => new Promise<void>(() => {})) });
    await view.ready();
    fireEvent.click(view.getByTestId('nsx-send'));
    const line = await view.findByTestId('lcd3-launching');
    expect(document.activeElement).toBe(line);
  });
});

describe('the advanced drawer', () => {
  it('reads the plugin facts when it first opens — not at open, and not again on every render', async () => {
    const loadInstalledPlugins = vi.fn(async () => ({ installed: ['sales@synced'] }));
    const view = renderPopup({ loadInstalledPlugins });
    await view.ready();
    expect(loadInstalledPlugins).not.toHaveBeenCalled();
    fireEvent.click(view.getByTestId('lcd-advanced-toggle'));
    await waitFor(() => expect(loadInstalledPlugins).toHaveBeenCalledTimes(1));
    fireEvent.change(view.getByTestId('lcd3-notes'), { target: { value: 'a re-render' } });
    fireEvent.change(view.getByTestId('lcd3-notes'), { target: { value: 'another' } });
    expect(loadInstalledPlugins).toHaveBeenCalledTimes(1);
  });
});

describe('detaching a long press', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('before DETACH_AFTER_MS Escape does nothing and there is no ✕; after it, ✕ and Escape close the card and the press goes on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let settle: (() => void) | null = null;
    const onSpawn = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    const view = renderPopup({ onSpawn });
    await view.ready();
    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(view.getByTestId('nsx-send'));
    await view.findByTestId('lcd3-launching');
    act(() => { vi.advanceTimersByTime(DETACH_AFTER_MS - 100); });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(view.queryByTestId('lcd3-detach')).toBeNull();
    expect(view.onDismiss).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(200); });
    expect(view.getByTestId('lcd3-detach')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(view.onDismiss).toHaveBeenCalledTimes(1);
    settle!();
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(view.onDismiss).toHaveBeenCalledTimes(1); // the success does not dismiss twice
  });

  it('a refusal after detaching goes to the host’s onDetachedRefusal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reject: ((e: Error) => void) | null = null;
    const onDetachedRefusal = vi.fn();
    const view = renderPopup({ onSpawn: vi.fn(() => new Promise<void>((_, no) => { reject = no; })), onDetachedRefusal });
    await view.ready();
    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(reject).not.toBeNull());
    act(() => { vi.advanceTimersByTime(DETACH_AFTER_MS); });
    fireEvent.click(view.getByTestId('lcd3-detach'));
    expect(view.onDismiss).toHaveBeenCalledTimes(1);
    reject!(new Error('teammate is paused'));
    await waitFor(() => expect(onDetachedRefusal).toHaveBeenCalledWith('teammate is paused'));
  });
});

describe('round 3: a press and what is still on the card', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('a menu open at the press is closed by the collapse: after 8 s Escape detaches instead of closing a hidden menu', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = renderPopup({ onSpawn: vi.fn(() => new Promise<void>(() => {})) });
    await view.ready();
    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(view.getByTestId('nsx-model'));
    expect(view.getByTestId('nsx-model-menu')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true });
    await view.findByTestId('lcd3-launching');
    act(() => { vi.advanceTimersByTime(DETACH_AFTER_MS); });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(view.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('files dropped while a press is in flight are not taken', async () => {
    const { upload } = controlledUpload();
    const view = renderPopup({ upload, onSpawn: vi.fn(() => new Promise<void>(() => {})) });
    await view.ready();
    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(view.getByTestId('nsx-send'));
    await view.findByTestId('lcd3-launching');
    fireEvent.drop(view.getByTestId('launch-card'), { dataTransfer: { files: [file('late.log')], types: ['Files'] } });
    expect(upload).not.toHaveBeenCalled();
  });

  it('a press belongs to its subject: after the subject changes, the old answer is ignored and the new card launches', async () => {
    let settle: (() => void) | null = null;
    const onSpawn = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { settle = resolve; }))
      .mockImplementation(() => new Promise<void>(() => {}));
    const view = renderPopup({ onSpawn });
    await view.ready();
    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));
    view.rerender(<div className="cv2-root"><LaunchComposerPopup {...view.props} subject={{ id: 'task-10', title: 'Another task' }} /></div>);
    await waitFor(() => expect(view.queryByTestId('lcd3-launching')).toBeNull());
    settle!();
    await act(async () => { await Promise.resolve(); });
    expect(view.onDismiss).not.toHaveBeenCalled();
    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(2));
    expect((onSpawn.mock.calls[1]![0] as { taskIds?: string[] }).taskIds).toEqual(['task-10']);
  });
});

describe('round 3: connectors', () => {
  const portWith = (catalog: () => Promise<never>) => ({ catalog }) as unknown as McpPort;

  it('a connector read that FAILED shows its line and Retry — the block is not hidden', async () => {
    const port = portWith(() => Promise.reject(new Error('down')));
    const view = renderPopup({}, (card) => <McpProvider port={port}>{card}</McpProvider>);
    const slot = view.getByTestId('lcd3-connectors');
    await waitFor(() => expect(slot.hidden).toBe(false));
    expect(within(slot).getByRole('alert').textContent).toContain('Retry connectors');
  });

  it('while connectors are still read, Launch says so — not "choose an account" — and the block stays hidden', async () => {
    const port = portWith(() => new Promise<never>(() => {}));
    const view = renderPopup({}, (card) => <McpProvider port={port}>{card}</McpProvider>);
    await view.ready();
    expect(view.getByTestId('nsx-send').getAttribute('title')).toBe('Reading connectors…');
    expect(view.getByTestId('lcd3-connectors').hidden).toBe(true);
  });
});

describe('round 4', () => {
  afterEach(() => { vi.useRealTimers(); });
  const timeout = () => Promise.reject(Object.assign(new Error('the tm8 node did not answer within 180000ms'), { code: 'upstream_unavailable' }));

  it('a subject change during the timeout check clears it: the new subject can launch', async () => {
    const onSpawn = vi.fn().mockImplementationOnce(timeout).mockImplementation(() => new Promise<void>(() => {}));
    const view = renderPopup({ onSpawn, sessionsSince: () => new Promise(() => {}) });
    await view.ready();
    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('title')).toMatch(/Checking whether the launch that timed out started/));
    view.rerender(<div className="cv2-root"><LaunchComposerPopup {...view.props} subject={{ id: 'task-10', title: 'Another task' }} /></div>);
    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false'));
    expect(view.queryByRole('alert')).toBeNull();
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(2));
  });

  it('a refusal brings back the SAME card: the picker is not remounted, so connectors are not read again', async () => {
    /* A failed read leaves the picker ready (the server resolves defaults), so Launch can be pressed. */
    const catalog = vi.fn(() => Promise.reject(new Error('down')));
    const port = { catalog } as unknown as McpPort;
    const view = renderPopup({ onSpawn: vi.fn(() => Promise.reject(new Error('teammate is paused'))) }, (card) => <McpProvider port={port}>{card}</McpProvider>);
    await view.ready();
    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false'));
    const reads = catalog.mock.calls.length;
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(view.getByTestId('launch-card').textContent).toContain('teammate is paused'));
    expect(catalog.mock.calls.length).toBe(reads);
  });

  it('⌘. does nothing while the card is collapsed', async () => {
    const loadInstalledPlugins = vi.fn(async () => ({ installed: ['sales@synced'] }));
    const view = renderPopup({ loadInstalledPlugins, onSpawn: vi.fn(() => new Promise<void>(() => {})) });
    await view.ready();
    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(view.getByTestId('nsx-send'));
    await view.findByTestId('lcd3-launching');
    fireEvent.keyDown(document, { key: '.', metaKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(loadInstalledPlugins).not.toHaveBeenCalled();
    expect(view.getByTestId('lcd-drawer').getAttribute('data-open')).toBeNull();
  });

  it('after a handoff to a host that keeps the card mounted, what is typed next is kept as a draft', async () => {
    const view = renderPopup({ onLaunchStarted: () => true, onDismiss: () => {}, onSpawn: vi.fn(() => new Promise<void>(() => {})) });
    await view.ready();
    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(view.getByTestId('nsx-send'));
    fireEvent.change(view.getByTestId('lcd3-notes'), { target: { value: 'typed after the handoff' } });
    view.unmount();
    const again = renderPopup();
    expect((again.getByTestId('lcd3-notes') as HTMLTextAreaElement).value).toBe('typed after the handoff');
  });

  it('detached under a host that keeps it mounted: the line stays (no ✕) until the press settles, then the card is idle', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reject: ((e: Error) => void) | null = null;
    const view = renderPopup({ onDismiss: () => {}, onSpawn: vi.fn(() => new Promise<void>((_, no) => { reject = no; })) });
    await view.ready();
    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(reject).not.toBeNull());
    act(() => { vi.advanceTimersByTime(DETACH_AFTER_MS); });
    fireEvent.click(view.getByTestId('lcd3-detach'));
    expect(view.getByTestId('lcd3-launching')).toBeTruthy();
    expect(view.queryByTestId('lcd3-detach')).toBeNull();
    reject!(new Error('no'));
    await waitFor(() => expect(view.queryByTestId('lcd3-launching')).toBeNull());
    expect(view.getByTestId('nsx-send')).toBeTruthy();
  });
});
