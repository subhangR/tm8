// @vitest-environment jsdom
/**
 * THE `file` KIND'S CREATE DOOR.
 *
 * This is the fix for "three broken entities exist in the production space,
 * one per press of this button", and it shipped in an earlier draft with no
 * test at all while the preview beside it got nineteen. An adversarial review
 * pointed that out; this file is the answer.
 *
 * The property that matters is NEGATIVE and easy to lose: pressing the button
 * must create NOTHING until bytes are stored. The old flow committed an entity
 * first and uploaded never, which is why `files.download` 404s on those three.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Seam } from '../data/seam';
import { FileUploadCreateControl } from './FileUploadCreateControl';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// jsdom ships no WebCrypto; the upload task refuses to checksum without it,
// which is correct behaviour and not what these tests are about.
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        ...globalThis.crypto,
        randomUUID: () => `id-${Math.random().toString(16).slice(2)}`,
        subtle: { digest: async () => new Uint8Array(32).buffer },
      },
    });
  }
});

const SPACE = 'space-1' as never;

/** A `seam.files` group whose grant lifecycle can be steered per test. */
function filesGroup(overrides: Partial<Seam['files']> = {}): Seam['files'] {
  return {
    uploadInit: vi.fn(async () => ({
      uploadId: 'u1',
      uploadUrl: '/v2/files/uploads/u1/content',
      token: 't',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxSizeBytes: 10_000_000,
    })),
    putBytes: vi.fn(async () => undefined),
    // `rowFromEntity` discriminates STRUCTURALLY on state.name/mimeType/
    // sizeBytes — a double that puts them anywhere else is a different type,
    // and the task correctly refuses it.
    complete: vi.fn(async () => ({
      patches: [],
      entity: {
        id: 'file-1',
        kind: 'file',
        title: 'notes.txt',
        state: { kind: 'file', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 5 },
        createdBy: { id: 'm1', displayName: 'Someone', isAgent: false, avatar: null },
        createdAt: '2026-08-12T00:00:00Z',
      },
    })),
    abort: vi.fn(async () => ({ patches: [] })),
    downloadHref: (id: string) => `/v2/files/${id}/download`,
    ...overrides,
  } as unknown as Seam['files'];
}

/** Drives the OS picker `pickFiles` opens, without a real file dialog. */
function stubPicker(files: File[]): void {
  const realClick = HTMLInputElement.prototype.click;
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    if (this.type !== 'file') {
      realClick.call(this);
      return;
    }
    Object.defineProperty(this, 'files', { value: files, configurable: true });
    this.dispatchEvent(new Event('change'));
  });
}

describe('pressing "Upload file"', () => {
  it('creates NOTHING until the bytes are actually stored', async () => {
    const files = filesGroup();
    const created = vi.fn();
    stubPicker([new File(['hello'], 'notes.txt', { type: 'text/plain' })]);

    render(<FileUploadCreateControl label="Upload file" spaceId={SPACE} files={files} onCreated={created} />);
    fireEvent.click(screen.getByText('Upload file'));

    await waitFor(() => expect(created).toHaveBeenCalled());
    // The order is the whole point: a grant, then bytes, then completion — and
    // the entity id the caller receives comes from the COMPLETION, so it names
    // something the node has stored.
    expect(files.uploadInit).toHaveBeenCalled();
    expect(files.putBytes).toHaveBeenCalled();
    expect(files.complete).toHaveBeenCalled();
    expect(created).toHaveBeenCalledWith('file-1', expect.objectContaining({ patches: expect.anything() }));
  });

  it('creates nothing at all when the upload fails', async () => {
    // The old flow's defect, inverted into a test: a failure must leave no
    // entity behind, rather than an "Untitled file" with a 404 download.
    const files = filesGroup({
      putBytes: vi.fn(async () => {
        throw Object.assign(new Error('nope'), { code: 'payload_too_large' });
      }),
    });
    const created = vi.fn();
    const notices: string[] = [];
    stubPicker([new File(['hello'], 'big.bin')]);

    render(
      <FileUploadCreateControl
        label="Upload file"
        spaceId={SPACE}
        files={files}
        onCreated={created}
        onNotice={(t) => notices.push(t)}
      />,
    );
    fireEvent.click(screen.getByText('Upload file'));

    await waitFor(() => expect(notices.length).toBe(1));
    expect(created).not.toHaveBeenCalled();
    expect(files.complete).not.toHaveBeenCalled();
    // A failed upload releases its grant rather than orphaning the slot.
    expect(files.abort).toHaveBeenCalled();
    expect(notices[0]).toContain('big.bin');
  });

  it('never commits a placeholder entity, whatever happens', async () => {
    // The regression in one assertion: nothing in this control may reach a
    // generic entity-create path. If it ever does, this fails.
    const files = filesGroup();
    const createEntity = vi.fn();
    stubPicker([]);

    render(<FileUploadCreateControl label="Upload file" spaceId={SPACE} files={files} />);
    fireEvent.click(screen.getByText('Upload file'));

    await waitFor(() => expect(files.uploadInit).not.toHaveBeenCalled());
    expect(createEntity).not.toHaveBeenCalled();
    // A cancelled pick is a no-op, not an empty file.
    expect(files.putBytes).not.toHaveBeenCalled();
  });

  it('reports progress while several files are in flight', async () => {
    let release: (() => void) | undefined;
    const files = filesGroup({
      putBytes: vi.fn(() => new Promise<void>((resolve) => { release = () => resolve(); })),
    });
    stubPicker([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]);

    render(<FileUploadCreateControl label="Upload file" spaceId={SPACE} files={files} />);
    fireEvent.click(screen.getByText('Upload file'));

    expect(await screen.findByText('Uploading 2…')).toBeTruthy();
    release?.();
  });
});
