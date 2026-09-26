/**
 * Shared setup for the launch card v3 suites: one popup renderer, the
 * two-step commit (Launch → preview → Launch), and a controllable upload.
 * Not a test file — vitest only collects `*.test.*`.
 */
import { expect, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import type { EntityId, ExecutionSpawnInput, ProjectId } from '@tm8/contract';

import type { LaunchProjectOption } from '../domain/launch';
import type { LaunchContextRow } from '../domain/launch-selection';
import type { FileUploadTask, UploadedFile } from '../files/upload';
import { LAUNCH_DEFAULTS, LAUNCH_REFERENCE_CANDIDATES } from '../views/launch-fixtures';
import { LaunchComposerPopup, type LaunchComposerPopupProps } from './LaunchComposerPopup';

export const TEAMMATES = [
  { id: 'tm-forge', label: 'forge', agentTool: 'claude-code', model: 'claude-sonnet-5' },
  { id: 'tm-scout', label: 'scout', agentTool: 'claude-code', model: 'claude-opus-5' },
];
export const PROJECTS: readonly LaunchProjectOption[] = [{ projectId: 'pj-a' as ProjectId, name: 'tm8-ui', trusted: true }];

const row = (id: string, kind: string, title: string): LaunchContextRow => ({ id: id as EntityId, kind, title, text: null, derived: false, via: null });

/** The pools Attach offers: one doc to add, the spec (already a default), a memory and a skill. */
export const POOLS = {
  references: [...LAUNCH_REFERENCE_CANDIDATES, row('ent-doc-spec', 'doc', 'Launch spec'), row('ent-task-2', 'task', 'Refresh token rotation')],
  memories: [row('mem-extra', 'memory', 'Never restart 7778')],
  skills: [row('sk-extra', 'skill', 'graphify')],
};

export function renderPopup(over: Partial<LaunchComposerPopupProps> = {}) {
  const onSpawn = vi.fn<(input: ExecutionSpawnInput) => void>();
  const onDismiss = vi.fn();
  const load = vi.fn(async () => LAUNCH_DEFAULTS);
  const props: LaunchComposerPopupProps = {
    subject: { id: 'task-9', title: 'Wire the launch flow' },
    spaceId: 'sp-1',
    teammates: TEAMMATES,
    projects: PROJECTS,
    onSpawn,
    onDismiss,
    clientMutationId: 'm:test',
    selection: { load, candidates: POOLS },
    ...over,
  };
  const view = render(<div className="cv2-root"><LaunchComposerPopup {...props} /></div>);
  /** Launch opens the preview; its Launch commits. */
  const spawn = async () => {
    const calls = onSpawn.mock.calls.length;
    /* A teammate change re-reads the defaults, and Launch rightly waits for them. */
    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(view.getByTestId('nsx-send'));
    fireEvent.click(await view.findByTestId('lcd3-preview-confirm'));
    await waitFor(() => expect(onSpawn.mock.calls.length).toBe(calls + 1));
    return onSpawn.mock.calls[onSpawn.mock.calls.length - 1]![0];
  };
  /** The defaults have landed once the strip shows its docs group. */
  const ready = () => waitFor(() => expect(view.getByTestId('lcd3-group-doc')).toBeTruthy());
  const openGroup = async (kind: string) => {
    await ready();
    fireEvent.click(view.getByTestId(`lcd3-group-${kind}`));
    return view.getByTestId('lcd3-group-menu');
  };
  return { ...view, props, onSpawn, onDismiss, load, spawn, ready, openGroup };
}

export function file(name: string, size = 1200): File {
  return new File([new Uint8Array(size)], name, { type: 'image/png' });
}

/** An upload whose completion (or failure) the test controls. */
export function controlledUpload() {
  const settle: Array<{ resolve(done: UploadedFile): void; reject(e: Error): void }> = [];
  const upload = vi.fn((_f: File): FileUploadTask => ({
    result: new Promise<UploadedFile>((resolve, reject) => { settle.push({ resolve, reject }); }),
    cancel: vi.fn(),
  }));
  const complete = async (index: number, id: string, name: string) => {
    await act(async () => {
      settle[index]!.resolve({
        fileEntityId: id as EntityId, name, mime: 'image/png', sizeBytes: 421_888, maxSizeBytes: 1e8,
        result: { patches: [] } as never,
      });
    });
  };
  const failAt = async (index: number, message: string) => {
    await act(async () => { settle[index]!.reject(new Error(message)); });
  };
  return { upload, complete, failAt };
}
