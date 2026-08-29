// @vitest-environment jsdom
/**
 * THE DOC SOURCE OVER THE SHARED HOOK — the prose surface's half of the
 * rich-input adoption (R4: prose inserts at the caret).
 *
 * The drop→insert path already has behavioural coverage in `docEdit.test.tsx`
 * and stayed green through the migration; what is asserted here is what the
 * migration ADDED: paste now works (drop never implied paste before), `/`
 * references a skill inline, and both stay honestly inert on a read-only or
 * attach-less mount.
 */
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { UploadedFile } from '../files/upload';
import { DocSource, type DocAttach } from './DocSource';
import type { DocSaveHandle } from './useDocSave';

afterEach(cleanup);

/** A hand-rolled handle: real draft state, live ref, everything else inert. */
function Harness({
  attach,
  skillOptions,
  unavailable = null,
  initial = 'first line',
}: {
  attach?: DocAttach;
  skillOptions?: { id: string; display: string; meta?: string }[];
  unavailable?: DocSaveHandle['unavailable'];
  initial?: string;
}) {
  const [body, setBody] = useState(initial);
  const live = useRef(body);
  live.current = body;
  const save: DocSaveHandle = {
    state: 'clean',
    body,
    liveBody: () => live.current,
    dirty: false,
    baseVersion: null,
    nextVersion: null,
    savedVersion: null,
    unavailable,
    theirVersion: null,
    canReload: false,
    canOverwrite: false,
    edit: (edits) => {
      if (edits.body !== undefined) setBody(edits.body);
    },
    save: async () => {},
    cancel: () => {},
    reload: () => {},
    overwrite: async () => {},
    dismiss: () => {},
  };
  return <DocSource save={save} attach={attach} skillOptions={skillOptions} />;
}

function area(): HTMLTextAreaElement {
  return screen.getByTestId('doc-source') as HTMLTextAreaElement;
}

function clipboard(files: File[]) {
  return {
    clipboardData: {
      items: files.map((f) => ({ getAsFile: () => f })),
      files,
      types: ['Files'],
      getData: () => '',
    },
  };
}

describe('paste into the document (new — drop never implied paste)', () => {
  it('a pasted screenshot uploads and lands as a markdown image reference at the caret', async () => {
    let resolve!: (u: UploadedFile) => void;
    const attach: DocAttach = () => ({
      result: new Promise<UploadedFile>((res) => { resolve = res; }),
      cancel: vi.fn(),
    });
    render(<Harness attach={attach} />);
    area().setSelectionRange(5, 5);

    fireEvent.paste(area(), clipboard([new File(['x'], 'image.png', { type: 'image/png' })]));
    await act(async () => {
      resolve({
        fileEntityId: 'file-img',
        name: 'image1.png',
        mime: 'image/png',
        sizeBytes: 1,
        maxSizeBytes: 100,
        result: {} as never,
      });
    });
    expect(area().value).toContain('![image1.png](tm8://file/file-img)');
    expect(area().value.startsWith('first')).toBe(true);
  });

  it('stays inert without an uploader, and on a read-only draft', () => {
    render(<Harness unavailable={{ cause: 'read-only', remedy: 'x' } as never} attach={() => { throw new Error('must not upload'); }} />);
    fireEvent.paste(area(), clipboard([new File(['x'], 'a.png', { type: 'image/png' })]));
    expect(area().value).toBe('first line');
  });
});

describe('the / skill reference in prose (R1)', () => {
  it('opens over the textarea and commits an inline tm8://skill link', () => {
    render(<Harness skillOptions={[{ id: 'sk1', display: 'handover', meta: 'How to hand over' }]} />);
    fireEvent.change(area(), { target: { value: 'first line /han' } });
    expect(screen.getByRole('listbox', { name: 'Available skills' })).toBeTruthy();

    fireEvent.keyDown(area(), { key: 'Enter' });
    expect(area().value).toBe('first line [/handover](tm8://skill/sk1) ');
  });

  it('absent skillOptions keeps / as plain markdown text', () => {
    render(<Harness />);
    fireEvent.change(area(), { target: { value: 'path /usr' } });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
