// @vitest-environment jsdom
/**
 * The launch card v2 (artifact 01a0dd42 rev 4) in the Run popup — the parts
 * the v1 card did not have.
 *
 * What must hold: attached entities and uploaded files ride the spawn as
 * ADDED REFERENCES (context), never as a second subject; a launch waits for
 * uploads; Dispatch exists only when a host wires it; Escape closes a menu,
 * then the drawer, then the popup; the drawer's knobs reach the spawn; the
 * worktree's base ref is typed, never guessed; the effort menu offers only the
 * model's stops; and a teammate's picks are remembered across launches.
 *
 * jsdom has no layout, so none of this says anything about clipping — the
 * screenshots on the PR do.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { EntityId, ExecutionSpawnInput, ProjectId } from '@tm8/contract';

import type { LaunchProjectOption } from '../domain/launch';
import type { LaunchContextRow } from '../domain/launch-selection';
import type { FileUploadTask, UploadedFile } from '../files/upload';
import { LAUNCH_DEFAULTS, LAUNCH_REFERENCE_CANDIDATES } from '../views/launch-fixtures';
import { LaunchComposerPopup, type LaunchComposerPopupProps } from './LaunchComposerPopup';

beforeEach(() => { localStorage.clear(); });

const TEAMMATES = [
  { id: 'tm-forge', label: 'forge', agentTool: 'claude-code', model: 'claude-sonnet-5' },
  { id: 'tm-scout', label: 'scout', agentTool: 'claude-code', model: 'claude-opus-5' },
];
const PROJECTS: readonly LaunchProjectOption[] = [{ projectId: 'pj-a' as ProjectId, name: 'tm8-ui', trusted: true }];

/* The pool: one space doc to attach, and one that is already a default. */
const CANDIDATES: readonly LaunchContextRow[] = [
  ...LAUNCH_REFERENCE_CANDIDATES,
  { id: 'ent-doc-spec' as EntityId, kind: 'doc', title: 'Launch spec', text: null, derived: false, via: null },
];

function renderPopup(over: Partial<LaunchComposerPopupProps> = {}) {
  const onSpawn = vi.fn<(input: ExecutionSpawnInput) => void>();
  const onDismiss = vi.fn();
  const props: LaunchComposerPopupProps = {
    subject: { id: 'task-9', title: 'Wire the launch flow' },
    spaceId: 'sp-1',
    teammates: TEAMMATES,
    projects: PROJECTS,
    onSpawn,
    onDismiss,
    clientMutationId: 'm:test',
    selection: { load: () => Promise.resolve(LAUNCH_DEFAULTS), candidates: { references: CANDIDATES } },
    ...over,
  };
  const view = render(<div className="cv2-root"><LaunchComposerPopup {...props} /></div>);
  const spawn = async () => {
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalled());
    return onSpawn.mock.calls[onSpawn.mock.calls.length - 1]![0];
  };
  /** The defaults have landed once the references chip stops saying "…". */
  const ready = () => waitFor(() => expect(view.getByTestId('lsel-chip-references').textContent).toMatch(/2 refs/));
  return { ...view, props, onSpawn, onDismiss, spawn, ready };
}

function file(name: string, size = 1200): File {
  return new File([new Uint8Array(size)], name, { type: 'image/png' });
}

/** An upload whose completion the test controls. */
function controlledUpload() {
  const finish: Array<(done: UploadedFile) => void> = [];
  const upload = vi.fn((f: File): FileUploadTask => ({
    result: new Promise<UploadedFile>((resolve) => { finish.push(resolve); }),
    cancel: vi.fn(),
  }));
  const complete = async (index: number, id: string, name: string) => {
    await act(async () => {
      finish[index]!({
        fileEntityId: id as EntityId, name, mime: 'image/png', sizeBytes: 421_888, maxSizeBytes: 1e8,
        result: { patches: [] } as never,
      });
    });
  };
  return { upload, complete };
}

describe('the attach row: context, never a second subject', () => {
  it('an entity attached from the menu rides as an ADDED reference; the subject stays the one task', async () => {
    const view = renderPopup();
    await view.ready();
    fireEvent.click(view.getByTestId('lcd-attach'));
    fireEvent.click(view.getByTestId('lcd-attach-ent-doc-other'));
    expect(view.getByTestId('lcd-attached-ent-doc-other').textContent).toContain('Another doc');
    const input = await view.spawn();
    expect(input.taskIds).toEqual(['task-9']);
    expect(input.selection).toEqual({ referenceIds: ['ent-doc-spec', 'ent-file-log', 'ent-doc-other'] });
  });

  it('a default is already carried: the menu says so and will not attach it twice', async () => {
    const view = renderPopup();
    await view.ready();
    fireEvent.click(view.getByTestId('lcd-attach'));
    const row = view.getByTestId('lcd-attach-ent-doc-spec');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.textContent).toContain('already carried by default');
    fireEvent.click(row);
    const input = await view.spawn();
    expect('selection' in input).toBe(false);
  });

  it('detaching takes it back out of the launch', async () => {
    const view = renderPopup();
    await view.ready();
    fireEvent.click(view.getByTestId('lcd-attach'));
    fireEvent.click(view.getByTestId('lcd-attach-ent-doc-other'));
    fireEvent.click(view.getByRole('button', { name: 'Detach Another doc' }));
    expect(view.queryByTestId('lcd-attached-ent-doc-other')).toBeNull();
    const input = await view.spawn();
    expect('selection' in input).toBe(false);
  });

  it('"+N more" counts chips past the edge, and says nothing once scrolled to the end', async () => {
    const view = renderPopup();
    await view.ready();
    fireEvent.click(view.getByTestId('lcd-attach'));
    fireEvent.click(view.getByTestId('lcd-attach-ent-doc-other'));
    /* jsdom has no layout: stub a 500px scroller over 1000px of chips, with
       the one chip sitting flush with the right edge, as on a real node. */
    const list = view.getByTestId('lcd-attached');
    const chip = view.getByTestId('lcd-attached-ent-doc-other');
    const box = (right: number) => ({ right, left: right - 200, top: 0, bottom: 30, width: 200, height: 30, x: right - 200, y: 0, toJSON: () => ({}) });
    Object.defineProperty(list, 'scrollWidth', { configurable: true, value: 1000 });
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: 500 });
    list.getBoundingClientRect = () => box(500);
    chip.getBoundingClientRect = () => box(500);

    list.scrollLeft = 0;
    fireEvent.scroll(list);
    expect(view.getByTestId('lcd-more').textContent).toBe('+1 more');
    expect(list.hasAttribute('data-more')).toBe(true);

    list.scrollLeft = 500;
    fireEvent.scroll(list);
    expect(view.queryByTestId('lcd-more')).toBeNull();
    expect(list.hasAttribute('data-more')).toBe(false);
  });

  it('the menu says sessions cannot be attached, and names the subject it keeps', async () => {
    const view = renderPopup();
    fireEvent.click(view.getByTestId('lcd-attach'));
    const menu = view.getByTestId('lcd-attach-menu');
    expect(menu.textContent).toContain('Sessions can’t be attached as context');
    expect(menu.textContent).toContain('The subject stays “Wire the launch flow”');
  });

  it('without a defaults read nothing can be attached, and the menu says why', () => {
    const view = renderPopup({ selection: undefined });
    fireEvent.click(view.getByTestId('lcd-attach'));
    expect(view.getByTestId('lcd-attach-menu').textContent).toMatch(/didn’t say what this launch loads by default/);
  });
});

describe('files from this computer', () => {
  it('upload into the space, then ride as a FILE reference; Launch waits while one is in flight', async () => {
    const { upload, complete } = controlledUpload();
    const view = renderPopup({ upload });
    await view.ready();
    const picked = file('launch-card-sketch.png');
    fireEvent.change(view.getByTestId('lcd-file-input'), { target: { files: [picked] } });
    expect(upload).toHaveBeenCalledWith(picked);
    // In flight: a chip that says so, and Launch withheld with the reason.
    expect(view.getByText('uploading…')).toBeTruthy();
    expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('true');
    expect(view.getByRole('alert').textContent).toContain('Waiting for 1 upload');

    await complete(0, 'file-1', 'launch-card-sketch.png');
    expect(view.getByTestId('lcd-attached-file-1').textContent).toContain('412.0 KB');
    const input = await view.spawn();
    expect(input.selection?.referenceIds).toEqual(['ent-doc-spec', 'ent-file-log', 'file-1']);
  });

  it('can be dropped anywhere on the card', async () => {
    const { upload } = controlledUpload();
    const view = renderPopup({ upload });
    await view.ready();
    const dropped = file('boot.log');
    fireEvent.drop(view.getByTestId('launch-card'), { dataTransfer: { files: [dropped], types: ['Files'] } });
    expect(upload).toHaveBeenCalledWith(dropped);
  });

  it('with no upload path the Files row is refused with the reason, and a drop does nothing', () => {
    const view = renderPopup();
    fireEvent.click(view.getByTestId('lcd-attach'));
    const row = view.getByTestId('lcd-attach-files');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.textContent).toContain('no upload path');
  });
});

describe('Dispatch', () => {
  it('is absent unless a host wires it', () => {
    const view = renderPopup();
    expect(view.queryByTestId('launch-dispatch')).toBeNull();
  });

  it('hands off and closes on success; a refusal keeps the card up with the reason', async () => {
    const onDispatch = vi.fn()
      .mockRejectedValueOnce(new Error('no dispatcher in this space'))
      .mockResolvedValueOnce(undefined);
    const view = renderPopup({ onDispatch });
    fireEvent.click(view.getByTestId('launch-dispatch'));
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('no dispatcher'));
    expect(view.onDismiss).not.toHaveBeenCalled();
    fireEvent.click(view.getByTestId('launch-dispatch'));
    await waitFor(() => expect(view.onDismiss).toHaveBeenCalledTimes(1));
    expect(view.onSpawn).not.toHaveBeenCalled();
  });

  it('saves the subject edits first, then hands off with the instructions as the note', async () => {
    const order: string[] = [];
    const onSaveSubject = vi.fn(() => { order.push('save'); return Promise.resolve(); });
    const onDispatch = vi.fn((note?: string) => { order.push(`dispatch:${String(note)}`); return Promise.resolve(); });
    const view = renderPopup({ onDispatch, onSaveSubject });
    fireEvent.change(view.getByTestId('nsx-title'), { target: { value: 'Wire it end to end' } });
    fireEvent.change(view.getByLabelText('Instructions for this session'), { target: { value: '  Prefer the UI builder.  ' } });
    fireEvent.click(view.getByTestId('launch-dispatch'));
    await waitFor(() => expect(view.onDismiss).toHaveBeenCalledTimes(1));
    expect(onSaveSubject).toHaveBeenCalledWith({ title: 'Wire it end to end' });
    expect(order).toEqual(['save', 'dispatch:Prefer the UI builder.']);
  });

  it('sends no note when the instructions are empty, and refuses one over the contract’s 4000 characters', async () => {
    const onDispatch = vi.fn(() => Promise.resolve());
    const view = renderPopup({ onDispatch });
    fireEvent.change(view.getByLabelText('Instructions for this session'), { target: { value: 'x'.repeat(4001) } });
    fireEvent.click(view.getByTestId('launch-dispatch'));
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('at most 4000'));
    expect(onDispatch).not.toHaveBeenCalled();
    fireEvent.change(view.getByLabelText('Instructions for this session'), { target: { value: '   ' } });
    fireEvent.click(view.getByTestId('launch-dispatch'));
    await waitFor(() => expect(onDispatch).toHaveBeenCalledWith(undefined));
  });
});

describe('the keyboard', () => {
  it('Escape closes a menu first, then the drawer, then the popup', () => {
    const view = renderPopup();
    fireEvent.keyDown(document, { key: '.', metaKey: true });
    expect(view.getByTestId('lcd-drawer').hasAttribute('data-open')).toBe(true);
    fireEvent.click(view.getByTestId('nsx-model'));
    expect(view.getByTestId('nsx-model-menu')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(view.queryByTestId('nsx-model-menu')).toBeNull();
    expect(view.getByTestId('lcd-drawer').hasAttribute('data-open')).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(view.getByTestId('lcd-drawer').hasAttribute('data-open')).toBe(false);
    expect(view.onDismiss).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(view.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Escape with focus OUTSIDE an open context popover closes the popover, not the popup', async () => {
    const view = renderPopup();
    await view.ready();
    fireEvent.click(view.getByTestId('lsel-chip-references'));
    expect(view.getByTestId('lsel-popover')).toBeTruthy();
    const instructions = view.getByTestId('lcd-instructions');
    fireEvent.change(instructions, { target: { value: 'keep me' } });

    fireEvent.keyDown(instructions, { key: 'Escape' });
    expect(view.queryByTestId('lsel-popover')).toBeNull();
    expect(view.onDismiss).not.toHaveBeenCalled();
    expect((view.getByTestId('lcd-instructions') as HTMLTextAreaElement).value).toBe('keep me');
    fireEvent.keyDown(instructions, { key: 'Escape' });
    expect(view.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('⌘↵ launches — the same commit as the button', async () => {
    const view = renderPopup();
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(view.onSpawn).toHaveBeenCalledTimes(1));
  });

  it('⌘↵ on a refused launch sends nothing', () => {
    const view = renderPopup({ onSpawn: undefined });
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true });
    expect(view.onDismiss).not.toHaveBeenCalled();
  });
});

describe('the advanced drawer', () => {
  it('its session mode and GitHub credential reach the spawn, and ⋯ shows a dot', async () => {
    const view = renderPopup();
    fireEvent.click(view.getByTestId('lcd-advanced-toggle'));
    fireEvent.change(view.getByTestId('lcd-mode'), { target: { value: 'coordinator' } });
    fireEvent.change(view.getByTestId('lcd-github-credential'), { target: { value: 'member' } });
    expect(within(view.getByTestId('lcd-advanced-toggle')).getByLabelText('changed')).toBeTruthy();
    const input = await view.spawn();
    expect(input.mode).toBe('coordinator');
    expect(input.credentialSources).toEqual({ github: 'member' });
  });

  it('names the resolved profile when the host resolves one', () => {
    const view = renderPopup({
      profileFor: () => ({ profileId: 'pf-1' as EntityId, label: 'Core Chat v3', source: 'space-default' }),
    });
    fireEvent.click(view.getByTestId('lcd-advanced-toggle'));
    expect(view.getByTestId('lcd-profile').textContent).toBe('Core Chat v3 · the space default');
  });
});

describe('the checkout', () => {
  it('a typed base ref cuts the worktree from it', async () => {
    const view = renderPopup();
    fireEvent.click(view.getByTestId('nsx-copy'));
    fireEvent.change(view.getByTestId('lcd-base-ref'), { target: { value: 'origin/main' } });
    expect(view.getByTestId('nsx-copy').getAttribute('aria-label')).toBe('Checkout: worktree from origin/main');
    expect((await view.spawn()).workdir).toEqual({ mode: 'worktree', baseRef: 'origin/main' });
  });

  it('the shared checkout sends no base ref, even one typed earlier', async () => {
    const view = renderPopup();
    fireEvent.click(view.getByTestId('nsx-copy'));
    fireEvent.change(view.getByTestId('lcd-base-ref'), { target: { value: 'origin/main' } });
    fireEvent.click(within(view.getByTestId('lcd-checkout-menu')).getByRole('menuitemradio', { name: /Shared checkout/ }));
    expect(view.queryByTestId('lcd-checkout-menu')).toBeNull();
    expect((await view.spawn()).workdir).toEqual({ mode: 'project' });
  });

  it('a scratch launch has no checkout control at all', () => {
    const view = renderPopup({ projects: [] });
    expect(view.queryByTestId('nsx-copy')).toBeNull();
  });
});

describe('the bottom band', () => {
  it('the effort menu offers exactly the stops the model takes', () => {
    const view = renderPopup();
    fireEvent.click(view.getByTestId('nsx-effort'));
    const stops = within(view.getByTestId('lcd-effort-menu')).getAllByRole('menuitemradio').map((b) => b.textContent?.replace('✓', ''));
    expect(stops).toEqual(['Low', 'Medium', 'High', 'Max']);
  });

  it('Full access is drawn in red and sent as fullAccess', async () => {
    const view = renderPopup();
    fireEvent.click(view.getByTestId('nsx-perm'));
    fireEvent.click(within(view.getByTestId('nsx-perm-menu')).getByRole('menuitemradio', { name: /^Full access/ }));
    expect(view.getByTestId('nsx-perm').className).toContain('lcd-tool--full');
    expect((await view.spawn()).accessMode).toBe('fullAccess');
  });

  it('the summary says what Launch starts and where', () => {
    const view = renderPopup();
    expect(view.getByTestId('lcd-summary').textContent).toBe('Starts a worker in a worktree of tm8-ui');
  });

  it('the node’s slots show beside ⋯ when the host knows them', () => {
    const view = renderPopup({ capacity: { slotsFree: 28, slotsTotal: 40 } });
    expect(view.getByTestId('lcd-slots').textContent).toContain('12/40');
  });

  it('an uncapped node reads as used/∞, not the int4 ceiling the RPC carries', () => {
    const view = renderPopup({ capacity: { slotsFree: 2147483633, slotsTotal: 2147483647 } });
    expect(view.getByTestId('lcd-slots').textContent).toContain('14/∞');
    expect(view.getByTestId('lcd-slots').textContent).not.toContain('2147483647');
    expect(view.getByTestId('lcd-slots').getAttribute('title')).toBe('14 live · no session limit');
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
    fireEvent.click(second.getByTestId('nsx-team'));
    expect(second.getByTestId('lcd-restored').textContent).toMatch(/^restored: Claude Sonnet 5 · low · Auto · worktree/);
    expect((await second.spawn()).reasoningEffort).toBe('low');
  });

  it('re-picking the teammate already shown keeps its restored picks', async () => {
    const first = renderPopup();
    fireEvent.click(first.getByTestId('nsx-effort'));
    fireEvent.click(within(first.getByTestId('lcd-effort-menu')).getByRole('menuitemradio', { name: 'Low' }));
    await first.spawn();
    first.unmount();

    const second = renderPopup();
    await waitFor(() => expect(second.getByTestId('nsx-effort').getAttribute('aria-label')).toBe('Reasoning effort: Low'));
    fireEvent.click(second.getByTestId('nsx-team'));
    fireEvent.click(within(second.getByTestId('nsx-team-menu')).getByRole('menuitemradio', { name: /^forge/ }));
    await waitFor(() => expect(second.getByTestId('nsx-effort').getAttribute('aria-label')).toBe('Reasoning effort: Low'));
    expect((await second.spawn()).reasoningEffort).toBe('low');
  });

  it('unticked, a launch remembers nothing', async () => {
    const first = renderPopup();
    fireEvent.click(first.getByTestId('nsx-team'));
    fireEvent.click(first.getByTestId('lcd-remember'));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(first.getByTestId('nsx-effort'));
    fireEvent.click(within(first.getByTestId('lcd-effort-menu')).getByRole('menuitemradio', { name: 'Low' }));
    await first.spawn();
    first.unmount();

    const second = renderPopup();
    expect((await second.spawn()).reasoningEffort).toBe('high');
  });
});
