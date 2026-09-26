// @vitest-environment jsdom
/**
 * The launch card v3 (mock 01a0df08) in the Run popup — the card itself.
 *
 * What must hold: the title row is one line with + and the pinned task, and
 * + says why nothing more can go in full yet; the notes ride as promptExtra
 * and nothing is written onto the task; the strip is ONE row of type groups
 * with files first, each group a view of the selection; Attach adds several
 * at once, each to its group; uploads land in Files, can fail and be retried,
 * and hold Launch; Launch and Dispatch both go through a preview; Dispatch
 * refuses what the node can't carry yet and reads an undelivered result as a
 * warning; a timed-out spawn is checked before any retry; Escape unwinds the
 * preview, a menu, the drawer, then the card; a closed card keeps a draft.
 *
 * jsdom has no layout, so none of this says anything about clipping or the
 * card's width — the screenshots on the PR do.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, waitFor, within } from '@testing-library/react';

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

  it('an unticked default counts as not in the launch, so picking it ticks it back', async () => {
    const view = renderPopup();
    const menu = await view.openGroup('doc');
    fireEvent.click(within(within(menu).getByTestId('lcd3-row-ent-doc-spec')).getByRole('menuitemcheckbox'));
    fireEvent.click(view.getByTestId('lcd3-attach'));
    const attach = view.getByTestId('lcd3-attach-menu');
    fireEvent.click(within(attach).getByTestId('lcd3-attach-row-ent-doc-spec'));
    fireEvent.click(within(attach).getByTestId('lcd3-attach-add'));
    expect(view.getByTestId('lcd3-group-doc').getAttribute('data-edited')).toBeNull();
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

describe('Launch goes through "What the agent gets"', () => {
  it('lists the task, the notes, and where each strip item goes today', async () => {
    const view = renderPopup();
    await view.ready();
    fireEvent.change(view.getByTestId('lcd3-notes'), { target: { value: 'be brief' } });
    fireEvent.click(view.getByTestId('nsx-send'));
    const preview = view.getByTestId('lcd3-preview');
    expect(preview.textContent).toContain('What the agent gets');
    expect(preview.textContent).toContain('Wire the launch flow');
    expect(preview.textContent).toContain('be brief');
    expect(within(view.getByTestId('lcd3-preview-memories')).getByText(/tokens\.css/)).toBeTruthy();
    expect(view.getByTestId('lcd3-preview-index').textContent).toContain('Launch spec');
    expect(view.getByTestId('lcd3-preview-files').textContent).toContain('boot.log');
    expect(view.onSpawn).not.toHaveBeenCalled();
  });

  it('Back returns to the card, and Escape closes the preview before anything else', async () => {
    const view = renderPopup();
    fireEvent.click(view.getByTestId('nsx-send'));
    fireEvent.click(view.getByTestId('lcd3-preview-back'));
    expect(view.queryByTestId('lcd3-preview')).toBeNull();
    fireEvent.click(view.getByTestId('nsx-send'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(view.queryByTestId('lcd3-preview')).toBeNull();
    expect(view.onDismiss).not.toHaveBeenCalled();
  });

  it('⌘↵ opens the preview, and ⌘↵ in the preview commits', async () => {
    const view = renderPopup();
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true });
    expect(view.getByTestId('lcd3-preview')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(view.onSpawn).toHaveBeenCalledTimes(1));
  });

  it('a refusal keeps the card up with the reason inside the preview', async () => {
    const view = renderPopup({ onSpawn: vi.fn(() => Promise.reject(new Error('teammate is paused'))) });
    fireEvent.click(view.getByTestId('nsx-send'));
    fireEvent.click(view.getByTestId('lcd3-preview-confirm'));
    await waitFor(() => expect(view.getByTestId('lcd3-preview').textContent).toContain('teammate is paused'));
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
    fireEvent.click(view.getByTestId('lcd3-preview-confirm'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByTestId('lcd3-preview-confirm'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(2));
    expect(onSpawn.mock.calls[1]![0].clientMutationId).toBe(onSpawn.mock.calls[0]![0].clientMutationId);
    fireEvent.click(view.getByTestId('lcd3-preview-back'));
    fireEvent.change(view.getByTestId('lcd3-notes'), { target: { value: 'changed' } });
    fireEvent.click(view.getByTestId('nsx-send'));
    fireEvent.click(view.getByTestId('lcd3-preview-confirm'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(3));
    expect(onSpawn.mock.calls[2]![0].clientMutationId).not.toBe(onSpawn.mock.calls[0]![0].clientMutationId);
  });
});

describe('a spawn that timed out', () => {
  const timeout = () => Promise.reject(Object.assign(new Error('the tm8 node did not answer within 180000ms'), { code: 'upstream_unavailable' }));

  it('is checked before any retry: a session found means nothing more to launch', async () => {
    const sessionsSince = vi.fn(async () => [{ id: 'ws-1', title: 'Wire the launch flow' }]);
    const onSpawn = vi.fn(timeout);
    const view = renderPopup({ onSpawn, sessionsSince });
    fireEvent.click(view.getByTestId('nsx-send'));
    fireEvent.click(view.getByTestId('lcd3-preview-confirm'));
    await waitFor(() => expect(view.getByTestId('lcd3-preview').textContent).toContain('It started'));
    expect(sessionsSince).toHaveBeenCalledWith('task-9', expect.any(String));
    fireEvent.click(view.getByTestId('lcd3-preview-confirm'));
    expect(onSpawn).toHaveBeenCalledTimes(1);
  });

  it('no session found: retry is offered', async () => {
    const onSpawn = vi.fn(timeout);
    const view = renderPopup({ onSpawn, sessionsSince: async () => [] });
    fireEvent.click(view.getByTestId('nsx-send'));
    fireEvent.click(view.getByTestId('lcd3-preview-confirm'));
    await waitFor(() => expect(view.getByTestId('lcd3-preview').textContent).toContain('Launch again to retry'));
    fireEvent.click(view.getByTestId('lcd3-preview-confirm'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(2));
  });

  it('with no way to check, it says so rather than calling a retry safe', async () => {
    const view = renderPopup({ onSpawn: vi.fn(timeout) });
    fireEvent.click(view.getByTestId('nsx-send'));
    fireEvent.click(view.getByTestId('lcd3-preview-confirm'));
    await waitFor(() => expect(view.getByTestId('lcd3-preview').textContent).toContain('may have started'));
  });
});

describe('Dispatch', () => {
  it('is absent unless a host wires it', () => {
    expect(renderPopup().queryByTestId('launch-dispatch')).toBeNull();
  });

  it('goes through "What the dispatcher gets", sends only the notes, and closes on success', async () => {
    const onDispatch = vi.fn(async () => ({ delivery: 'delivered', dispatcherSpawned: false }));
    const view = renderPopup({ onDispatch });
    fireEvent.change(view.getByTestId('lcd3-notes'), { target: { value: 'route to a UI person' } });
    fireEvent.click(view.getByTestId('launch-dispatch'));
    const preview = view.getByTestId('lcd3-dispatch-preview');
    expect(preview.textContent).toContain('What the dispatcher gets');
    expect(preview.textContent).toContain('route to a UI person');
    expect(preview.textContent).toMatch(/Teammate · project · model/);
    fireEvent.click(view.getByTestId('lcd3-preview-confirm'));
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
    fireEvent.click(view.getByTestId('lcd3-preview-confirm'));
    await waitFor(() => expect(view.getByTestId('lcd3-dispatch-preview').textContent).toContain('couldn’t deliver it to the dispatcher it just started'));
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
    expect(view.queryByTestId('lcd3-dispatch-preview')).toBeNull();
  });

  it('a retried dispatch reuses its key', async () => {
    const onDispatch = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('flaky')))
      .mockImplementation(async () => ({ delivery: 'delivered' }));
    const view = renderPopup({ onDispatch });
    fireEvent.click(view.getByTestId('launch-dispatch'));
    fireEvent.click(view.getByTestId('lcd3-preview-confirm'));
    await waitFor(() => expect(onDispatch).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByTestId('lcd3-preview-confirm'));
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
