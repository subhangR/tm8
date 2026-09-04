// @vitest-environment jsdom
/**
 * THE PROSE SURFACES — the entity field editor, the two memory forms and the
 * task description, driven the way a writer drives them.
 *
 * These four were bare textareas, and they are the surfaces whose text goes
 * to an agent MOST directly: a description is read by every agent that opens
 * the entity, and a memory is injected verbatim at spawn. What they gain is
 * the caret placement (R4 — prose splices a reference in at the cursor, it
 * does not stage a chip) and `/` skill references (R1).
 *
 * The anchorless case is asserted rather than assumed: the memory forms
 * author an entity that does not exist yet, so there is no id to upload
 * against, and the primitive's answer is the ordinary "capability absent" —
 * paste and drop inert, nothing claiming otherwise.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CommandResult, EntityDetail } from '@tm8/contract';
import type { FileUploadTask, UploadedFile } from '../files/upload';
import { EditEntityDialog, MemoryComposer } from '../authoring';
import type { EntityEditHandle } from '../authoring/useEntityEdit';
import type { MemoryComposerHandle } from '../authoring/useMemoryWorkingSet';
import { SubtreeBody } from '../panels/bodies/SubtreeBody';

afterEach(cleanup);

const SKILLS = [{ id: 'skill-3', display: 'triage', meta: 'sort the inbox' }];

function uploadedFile(id: string, name: string, mime: string): UploadedFile {
  return { fileEntityId: id, name, mime, sizeBytes: 1, maxSizeBytes: 100, result: {} as CommandResult };
}

function stubTask() {
  let resolve!: (uploaded: UploadedFile) => void;
  let reject!: (reason: unknown) => void;
  const task: FileUploadTask = {
    result: new Promise<UploadedFile>((res, rej) => { resolve = res; reject = rej; }),
    cancel: vi.fn(),
  };
  return { task, resolve, reject };
}

function clipboard(files: File[]) {
  return {
    clipboardData: {
      items: files.map((file) => ({ getAsFile: () => file })),
      files,
      types: files.length ? ['Files'] : [],
      getData: () => '',
    },
  };
}

const png = () => new File(['x'], 'shot.png', { type: 'image/png' });
const zip = () => new File(['x'], 'bundle.zip', { type: 'application/zip' });

// ---------------------------------------------------------------------------
// The entity field editor
// ---------------------------------------------------------------------------

function editHandle(values: Record<string, string>, set: (k: string, v: string) => void): EntityEditHandle {
  return {
    state: { phase: 'idle' },
    open: true,
    values,
    initialValues: values,
    dirty: false,
    unavailable: null,
    begin: vi.fn(),
    set,
    save: vi.fn(async () => undefined),
    cancel: vi.fn(),
    dismiss: vi.fn(),
  } as unknown as EntityEditHandle;
}

function renderDialog(options: { attach?: (file: File) => FileUploadTask } = {}) {
  const values: Record<string, string> = { 'content.description': '' };
  const set = vi.fn((key: string, value: string) => { values[key] = value; });
  const view = render(
    <EditEntityDialog
      flow={editHandle(values, set)}
      fields={[{ target: 'content', source: 'description', label: 'Description', multiline: true }]}
      title="Edit doc"
      skillOptions={SKILLS}
      {...(options.attach ? { attach: options.attach } : {})}
    />,
  );
  return { view, set, values };
}

describe('the entity field editor', () => {
  it('commits a skill REFERENCE into a multiline field (R1)', () => {
    const { set } = renderDialog();
    const field = screen.getByTestId('edit-field-content.description');
    fireEvent.change(field, { target: { value: '/tri', selectionStart: 4, selectionEnd: 4 } });
    fireEvent.click(screen.getByRole('option', { name: /triage/ }));
    expect(set).toHaveBeenLastCalledWith(
      'content.description',
      '[/triage](tm8://skill/skill-3) ',
    );
  });

  it('a pasted image lands as a markdown reference AT THE CARET, not as a chip', async () => {
    const { task, resolve } = stubTask();
    const attach = vi.fn(() => task);
    const { set } = renderDialog({ attach });

    const field = screen.getByTestId('edit-field-content.description');
    fireEvent.paste(field, clipboard([png()]));
    expect(attach).toHaveBeenCalledTimes(1);

    await act(async () => { resolve(uploadedFile('file-2', 'shot.png', 'image/png')); });
    // An IMAGE gets an image reference; a chat surface would have staged a
    // chip and left the body alone.
    expect(set).toHaveBeenLastCalledWith(
      'content.description',
      '![shot.png](tm8://file/file-2)',
    );
  });

  it('a refused paste says so, and nothing is uploaded (R2)', () => {
    const attach = vi.fn(() => stubTask().task);
    renderDialog({ attach });
    fireEvent.paste(screen.getByTestId('edit-field-content.description'), clipboard([zip()]));
    expect(attach).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('bundle.zip');
  });

  it('an upload failure is held beside the field that asked for it', async () => {
    const { task, reject } = stubTask();
    renderDialog({ attach: () => task });
    fireEvent.paste(screen.getByTestId('edit-field-content.description'), clipboard([png()]));
    await act(async () => { reject(new Error('the node refused the bytes')); });
    /* The NAME is the one paste extraction assigned (`renameAll` — a pasted
       screenshot arrives with no filename at all), and it is the name the
       chip and this line must agree on. */
    expect(screen.getByRole('alert').textContent).toMatch(/image1\.png — /);
  });

  it('with no attach port the field says nothing about files, and paste is inert', () => {
    const { set } = renderDialog();
    fireEvent.paste(screen.getByTestId('edit-field-content.description'), clipboard([png()]));
    expect(set).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('drop or paste');
  });
});

// ---------------------------------------------------------------------------
// The memory composer — the anchorless case
// ---------------------------------------------------------------------------

describe('the memory composer', () => {
  function composerHandle(set: (key: string, value: string) => void): MemoryComposerHandle {
    return {
      open: true,
      saving: false,
      values: {},
      refusal: null,
      set,
      submit: vi.fn(),
      cancel: vi.fn(),
    } as unknown as MemoryComposerHandle;
  }

  it('references a skill — a memory is injected into agent context verbatim', () => {
    const set = vi.fn();
    render(<MemoryComposer composer={composerHandle(set)} holderLabel="forge" skillOptions={SKILLS} />);

    const first = screen.getAllByRole('textbox')[0]!;
    fireEvent.change(first, { target: { value: '/tri', selectionStart: 4, selectionEnd: 4 } });
    fireEvent.click(screen.getByRole('option', { name: /triage/ }));
    expect(set.mock.calls.at(-1)![1]).toBe('[/triage](tm8://skill/skill-3) ');
  });

  it('is ANCHORLESS, so it offers no file affordance at all', () => {
    render(<MemoryComposer composer={composerHandle(vi.fn())} holderLabel="forge" skillOptions={SKILLS} />);
    // No hint, no picker, no dead control: the memory does not exist yet, so
    // there is no id for a file to attach to, and the form does not pretend
    // there is.
    expect(document.body.textContent).not.toContain('drop or paste');
    expect(screen.queryByRole('button', { name: /attach/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The task description
// ---------------------------------------------------------------------------

function taskDetail(description: string): EntityDetail {
  return {
    id: 'task-1',
    kind: 'task',
    title: 'A task',
    spaceId: 'space-1',
    version: 1,
    capabilities: {},
    content: { kind: 'task', description },
    state: { kind: 'task' },
    hierarchy: { parent: null, children: { items: [], nextCursor: null } },
    connections: { outgoing: [], incoming: [] },
    createdBy: { id: 'm1', kind: 'member', displayName: 'alex', isAgent: false },
  } as unknown as EntityDetail;
}

describe('the task description', () => {
  it('a pasted image becomes a reference in the description draft', async () => {
    const { task, resolve } = stubTask();
    const onChange = vi.fn();
    /* An EMPTY description opens as the editor and keeps its invitation —
       the stance rule this body already had, unchanged by the migration. */
    render(
      <SubtreeBody
        detail={taskDetail('')}
        descriptionDraft=""
        onDescriptionChange={onChange}
        attach={() => task}
        skillOptions={SKILLS}
      />,
    );

    fireEvent.paste(screen.getByLabelText('Description'), clipboard([png()]));
    await act(async () => { resolve(uploadedFile('file-5', 'shot.png', 'image/png')); });
    expect(onChange.mock.calls.at(-1)![0]).toBe('![shot.png](tm8://file/file-5)');
  });

  it('references a skill from the description (R1)', () => {
    const onChange = vi.fn();
    render(
      <SubtreeBody
        detail={taskDetail('')}
        descriptionDraft=""
        onDescriptionChange={onChange}
        skillOptions={SKILLS}
      />,
    );
    const field = screen.getByLabelText('Description');
    fireEvent.change(field, { target: { value: '/tri', selectionStart: 4, selectionEnd: 4 } });
    fireEvent.click(screen.getByRole('option', { name: /triage/ }));
    expect(onChange).toHaveBeenLastCalledWith('[/triage](tm8://skill/skill-3) ');
  });

  it('a read-only description refuses uploads — the draft could not receive them', () => {
    const attach = vi.fn(() => stubTask().task);
    render(
      <SubtreeBody
        detail={taskDetail('')}
        descriptionUnavailableReason="You can read this task, not write to it"
        attach={attach}
      />,
    );
    fireEvent.paste(screen.getByLabelText('Description'), clipboard([png()]));
    expect(attach).not.toHaveBeenCalled();
  });
});
