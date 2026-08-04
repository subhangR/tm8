// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type {
  ActorSummary,
  EntityCapabilities,
  EntityCounters,
  EntityDetail,
  EntityState,
  EntitySummary,
} from '@tm8/contract';
import type { FileUploadTask, UploadedFile } from '../files/upload';
import { DocEditor, fileReference, spliceInto, useDocSave, type DocCommands } from './index';

/**
 * INSERTING AN UPLOADED FILE INTO THE DOCUMENT.
 *
 * THE DEFECT THIS CLOSES, stated plainly: a writer could attach an image to a
 * doc and had no way to put it in the doc. The reference syntax is
 * `tm8://file/<uuid>` and the uuid was never shown anywhere in the UI, so
 * "type it yourself" was not an escape hatch — it was a wall.
 *
 * The assertions below are on the DRAFT TEXT the editor produces, not on a
 * call being made: a wired uploader that writes the reference into the wrong
 * offset, or into the served body instead of the draft, is green on every
 * spy-based test and loses the writer's work in the first two cases.
 */

afterEach(cleanup);

const ada: ActorSummary = { id: 'm-ada', kind: 'member', displayName: 'ada', isAgent: false };
const COUNTERS: EntityCounters = {
  likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null,
};
const CAPS: EntityCapabilities = {
  canEdit: true, canDelete: false, canAddChild: true, canLink: true,
  canPull: false, canReact: true, canGrantPoints: false, canComplete: false,
};
const STATE: EntityState = { kind: 'doc', format: 'markdown', childCount: 0 };

function docDetail(body: string): EntityDetail {
  const base: EntitySummary = {
    id: 'doc-1', spaceId: 'sp-test', kind: 'doc', title: 'Spec',
    parentId: null, position: 0, visibility: 'space', version: 3,
    activityAt: '2026-08-04T09:00:00.000Z', createdAt: '2026-08-04T09:00:00.000Z',
    updatedAt: '2026-08-04T09:00:00.000Z', deletedAt: null,
    createdBy: ada, counters: COUNTERS, state: STATE, badges: {},
  };
  return {
    ...base,
    content: { kind: 'doc', body, format: 'markdown' },
    hierarchy: { parent: null, children: { items: [], nextCursor: null }, path: [] },
    connections: { outgoing: [], incoming: [], unresolvedHardDependencyCount: 0 },
    capabilities: CAPS,
  };
}

const COMMANDS: DocCommands = { patchEntity: () => Promise.resolve({ patches: [] }) };

/** An uploader that lands, carrying whatever the caller wants it to have made. */
function landing(uploaded: Partial<UploadedFile> = {}) {
  const files: File[] = [];
  const attach = (file: File): FileUploadTask => {
    files.push(file);
    return {
      result: Promise.resolve({
        fileEntityId: 'file-9' as UploadedFile['fileEntityId'],
        name: file.name,
        mime: file.type,
        sizeBytes: 1,
        maxSizeBytes: 10_000,
        ...uploaded,
      }),
      cancel: () => {},
    };
  };
  return { attach, files };
}

function Harness({
  body,
  attach,
}: {
  body: string;
  attach?: (file: File) => FileUploadTask;
}) {
  const [detail] = useState(() => docDetail(body));
  const save = useDocSave({ detail, commands: COMMANDS });
  return (
    <div className="cv2-root">
      <DocEditor save={save} detail={detail} attach={attach} />
    </div>
  );
}

const png = (name = 'shot.png') => new File(['x'], name, { type: 'image/png' });

// ---------------------------------------------------------------------------
// the two pure decisions
// ---------------------------------------------------------------------------

describe('fileReference — the markdown a file deserves', () => {
  it('writes an IMAGE reference for an image', () => {
    expect(fileReference('shot.png', 'f-1', 'image/png')).toBe('![shot.png](tm8://file/f-1)');
  });

  it('writes a LINK for anything else — a PDF as an image is a broken-image chip', () => {
    expect(fileReference('notes.pdf', 'f-2', 'application/pdf')).toBe('[notes.pdf](tm8://file/f-2)');
  });

  it('escapes a bracket in the name, which would otherwise close the label early', () => {
    expect(fileReference('a]b.png', 'f-3', 'image/png')).toBe('![a\\]b.png](tm8://file/f-3)');
  });

  it('encodes the id rather than trusting it to be URL-safe', () => {
    expect(fileReference('x.png', 'a b', 'image/png')).toBe('![x.png](tm8://file/a%20b)');
  });
});

describe('spliceInto — where the text lands and where the caret goes', () => {
  it('replaces the selection and reports the caret after the insert', () => {
    const { body, caret } = spliceInto('one\n\nTWO\n\nthree', 5, 8, 'X');
    expect(body).toBe('one\n\nX\n\nthree');
    expect(caret).toBe(6);
  });

  it('breaks the paragraph so a block image does not render inside a sentence', () => {
    const { body } = spliceInto('a sentence', 10, 10, 'IMG');
    expect(body).toBe('a sentence\n\nIMG');
  });

  it('adds no padding where the neighbours are already blank lines', () => {
    expect(spliceInto('a\n\n\n\nb', 3, 3, 'IMG').body).toBe('a\n\nIMG\n\nb');
  });

  it('clamps an out-of-range offset instead of producing `undefined` in the text', () => {
    expect(spliceInto('abc', 99, 99, 'X').body).toBe('abc\n\nX');
  });
});

// ---------------------------------------------------------------------------
// the wired path
// ---------------------------------------------------------------------------

describe('the doc editor inserts an uploaded file at the caret', () => {
  it('writes the reference into the DRAFT, at the caret, and dirties the save', async () => {
    const { attach } = landing({ fileEntityId: 'file-abc' as UploadedFile['fileEntityId'] });
    const { getByTestId } = render(<Harness body={'intro\n\ntail'} attach={attach} />);

    const area = getByTestId('doc-source') as HTMLTextAreaElement;
    area.setSelectionRange(5, 5); // end of "intro"
    fireEvent.change(getByTestId('doc-insert-input'), { target: { files: [png()] } });

    await waitFor(() => {
      expect(area.value).toBe('intro\n\n![shot.png](tm8://file/file-abc)\n\ntail');
    });
    // Dirty, not saved: the insert is an EDIT the writer can still cancel.
    expect(getByTestId('doc-save').textContent).toContain('Save');
  });

  it('splices into the draft, never the served body — a pending edit is not lost', async () => {
    const { attach } = landing({ fileEntityId: 'file-abc' as UploadedFile['fileEntityId'] });
    const { getByTestId } = render(<Harness body="served" attach={attach} />);

    const area = getByTestId('doc-source') as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: 'typed since load' } });
    area.setSelectionRange(area.value.length, area.value.length);
    fireEvent.change(getByTestId('doc-insert-input'), { target: { files: [png()] } });

    await waitFor(() => expect(area.value).toContain('tm8://file/file-abc'));
    expect(area.value.startsWith('typed since load')).toBe(true);
    expect(area.value).not.toContain('served');
  });

  it('walks the caret across a multi-file insert instead of stacking them all at one offset', async () => {
    let n = 0;
    const attach = (file: File): FileUploadTask => {
      n += 1;
      const id = `f${n}`;
      return {
        result: Promise.resolve({
          fileEntityId: id as UploadedFile['fileEntityId'],
          name: file.name, mime: file.type, sizeBytes: 1, maxSizeBytes: 10,
        }),
        cancel: () => {},
      };
    };
    const { getByTestId } = render(<Harness body="" attach={attach} />);
    fireEvent.change(getByTestId('doc-insert-input'), {
      target: { files: [png('a.png'), png('b.png')] },
    });

    const area = getByTestId('doc-source') as HTMLTextAreaElement;
    await waitFor(() => expect(area.value).toContain('f2'));
    expect(area.value).toBe('![a.png](tm8://file/f1)\n\n![b.png](tm8://file/f2)');
  });

  it('states an upload failure and leaves the text alone', async () => {
    const attach = (): FileUploadTask => ({
      result: Promise.reject(Object.assign(new Error('nope'), { code: 'payload_too_large' })),
      cancel: () => {},
    });
    const { getByTestId, findByRole } = render(<Harness body="body" attach={attach} />);
    fireEvent.change(getByTestId('doc-insert-input'), { target: { files: [png('huge.png')] } });

    const alert = await findByRole('alert');
    expect(alert.textContent).toContain('huge.png');
    expect(alert.textContent).toContain('larger than the allowed upload size');
    expect((getByTestId('doc-source') as HTMLTextAreaElement).value).toBe('body');
  });

  it('with no uploader the control is VISIBLE and says why — never silently absent', () => {
    const { getByTestId, queryByTestId } = render(<Harness body="body" />);
    expect(queryByTestId('doc-insert')).toBeNull();
    expect(getByTestId('disabled-with-reason').textContent).toContain('Insert a file');
  });
});
