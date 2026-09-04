// @vitest-environment jsdom
/**
 * THE HOOK, BEHAVIOURALLY — driven through a host the way a surface drives
 * it: a controlled textarea, the shipped popover and chips, and a stubbed
 * upload task whose resolution the test controls.
 *
 * What is deliberately asserted here rather than in unit tests of the pure
 * modules: the keyboard CONTRACT (arrows browse, Enter commits the row and
 * not the message, Escape closes the picker and nothing else), the
 * capability distinctions (`options: undefined` types plain text; absent
 * uploader leaves paste inert), the R2 paste boundary WITH its stated
 * refusal, and both R4 placements — chips whose ids ride the message, and
 * the caret insert that survives typing-during-upload.
 */
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CommandResult } from '@tm8/contract';
import type { FileUploadTask, UploadedFile } from '../files/upload';
import {
  AttachmentChips,
  TriggerPopover,
  skillReference,
  useRichInput,
  type RichInputAttachmentsSpec,
  type RichInputTriggerSpec,
} from './index';

afterEach(cleanup);

function uploadedFile(name: string, id = 'file-1', mime = 'application/pdf'): UploadedFile {
  return { fileEntityId: id, name, mime, sizeBytes: 1, maxSizeBytes: 100, result: {} as CommandResult };
}

function stubTask() {
  let resolve!: (u: UploadedFile) => void;
  let reject!: (e: unknown) => void;
  const cancel = vi.fn();
  const task: FileUploadTask = {
    result: new Promise<UploadedFile>((res, rej) => { resolve = res; reject = rej; }),
    cancel,
  };
  return { task, resolve, reject, cancel };
}

function pdf(name = 'report.pdf'): File {
  return new File(['x'], name, { type: 'application/pdf' });
}

function png(name = 'image.png'): File {
  return new File(['x'], name, { type: 'image/png' });
}

function zip(name = 'bundle.zip'): File {
  return new File(['x'], name, { type: 'application/zip' });
}

function clipboard(files: File[]) {
  return {
    clipboardData: {
      items: files.map((f) => ({ getAsFile: () => f })),
      files,
      types: files.length ? ['Files'] : [],
      getData: () => '',
    },
  };
}

function Host({
  triggers,
  attachments,
  onSubmit,
  onHostPaste,
  initial = '',
}: {
  triggers?: RichInputTriggerSpec[];
  attachments?: RichInputAttachmentsSpec;
  onSubmit?: (body: string) => void;
  onHostPaste?: () => void;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const rich = useRichInput({
    value,
    onChange: setValue,
    areaRef,
    triggers: triggers ?? [],
    ...(attachments ? { attachments } : {}),
    onKeyDown: (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        onSubmit?.(value);
      }
    },
    ...(onHostPaste ? { onPaste: onHostPaste } : {}),
  });
  return (
    <div className="ri-host">
      <textarea aria-label="draft" ref={areaRef} value={value} {...rich.areaProps} />
      <TriggerPopover popover={rich.popover} label="options" />
      <AttachmentChips attachments={rich.attachments} />
      <button type="button" onClick={() => rich.openTrigger('@')}>open-at</button>
      <span data-testid="ids">{rich.attachments?.uploadedIds().join(',') ?? ''}</span>
      <span data-testid="blocked">{String(rich.attachments?.blocked ?? false)}</span>
    </div>
  );
}

const PEOPLE: RichInputTriggerSpec = {
  sigil: '@',
  options: [
    { id: 'p1', display: 'Alice Chen' },
    { id: 'p2', display: 'Bob' },
  ],
  onSelect: (option) => ({ insert: `@${option.display} ` }),
};

function type(text: string) {
  fireEvent.change(screen.getByLabelText('draft'), { target: { value: text } });
}

describe('triggers through the textarea', () => {
  it('typing the sigil opens the picker; typing filters it; typing past the word closes it', () => {
    render(<Host triggers={[PEOPLE]} />);
    type('@');
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(2);

    type('@bo');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option').textContent).toContain('Bob');

    type('@bob sent');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('options: undefined means the sigil is plain text — capability absent, no popover', () => {
    render(<Host triggers={[{ ...PEOPLE, options: undefined }]} />);
    type('@');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('arrows browse, Enter commits the highlighted row — not the message', () => {
    const sent = vi.fn();
    render(<Host triggers={[PEOPLE]} onSubmit={sent} />);
    type('@');
    fireEvent.keyDown(screen.getByLabelText('draft'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByLabelText('draft'), { key: 'Enter' });

    expect(sent).not.toHaveBeenCalled();
    expect((screen.getByLabelText('draft') as HTMLTextAreaElement).value).toBe('@Bob ');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Tab commits too', () => {
    render(<Host triggers={[PEOPLE]} />);
    type('@al');
    fireEvent.keyDown(screen.getByLabelText('draft'), { key: 'Tab' });
    expect((screen.getByLabelText('draft') as HTMLTextAreaElement).value).toBe('@Alice Chen ');
  });

  it('Escape closes the picker and is consumed; the next Enter reaches the host', () => {
    const sent = vi.fn();
    render(<Host triggers={[PEOPLE]} onSubmit={sent} />);
    type('hello @');
    fireEvent.keyDown(screen.getByLabelText('draft'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.keyDown(screen.getByLabelText('draft'), { key: 'Enter' });
    expect(sent).toHaveBeenCalledWith('hello @');
  });

  it('a `/` trigger commits a durable skill reference into the body', () => {
    const skills: RichInputTriggerSpec = {
      sigil: '/',
      options: [{ id: 'sk1', display: 'code review', meta: 'How we review' }],
      onSelect: (option) => ({ insert: skillReference(option.display, option.id) }),
    };
    render(<Host triggers={[skills]} />);
    type('please /co');
    fireEvent.keyDown(screen.getByLabelText('draft'), { key: 'Enter' });
    expect((screen.getByLabelText('draft') as HTMLTextAreaElement).value)
      .toBe('please [/code review](tm8://skill/sk1) ');
  });

  it('a mouse click commits, and hover moves the highlight so mouse and keys agree', () => {
    render(<Host triggers={[PEOPLE]} />);
    type('@');
    const rows = screen.getAllByRole('option');
    fireEvent.mouseEnter(rows[1]!);
    expect(rows[1]!.getAttribute('data-active')).toBe('true');
    fireEvent.click(rows[1]!);
    expect((screen.getByLabelText('draft') as HTMLTextAreaElement).value).toBe('@Bob ');
  });

  it('the toolbar path types the sigil (separator included) and opens the same picker', () => {
    render(<Host triggers={[PEOPLE]} initial="hi" />);
    // The user was typing, so the caret sits at the end when the button is hit.
    (screen.getByLabelText('draft') as HTMLTextAreaElement).setSelectionRange(2, 2);
    fireEvent.click(screen.getByRole('button', { name: 'open-at' }));
    expect((screen.getByLabelText('draft') as HTMLTextAreaElement).value).toBe('hi @');
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('a measured zero draws the stated empty row, not a vanished popover', () => {
    render(<Host triggers={[{ ...PEOPLE, options: [] }]} />);
    type('@');
    expect(screen.getByRole('status').textContent).toContain('No matches');
  });
});

describe('attachments — chip placement (chat surfaces)', () => {
  it('a pasted readable file uploads and stages a chip; its id rides uploadedIds once landed', async () => {
    const { task, resolve } = stubTask();
    const start = vi.fn(() => task);
    render(<Host attachments={{ start, placement: { mode: 'chip' } }} />);

    fireEvent.paste(screen.getByLabelText('draft'), clipboard([pdf()]));
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toContain('uploading');
    expect(screen.getByTestId('blocked').textContent).toBe('true');

    await act(async () => { resolve(uploadedFile('report.pdf', 'file-9')); });
    expect(screen.getByTestId('ids').textContent).toBe('file-9');
    expect(screen.getByTestId('blocked').textContent).toBe('false');
  });

  it('a refused paste is SAID, not swallowed — and nothing uploads', () => {
    const start = vi.fn();
    render(<Host attachments={{ start: start as never, placement: { mode: 'chip' } }} />);

    fireEvent.paste(screen.getByLabelText('draft'), clipboard([zip()]));
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('bundle.zip');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a text-only paste falls through to the host untouched', () => {
    const hostPaste = vi.fn();
    const start = vi.fn();
    render(
      <Host attachments={{ start: start as never, placement: { mode: 'chip' } }} onHostPaste={hostPaste} />,
    );
    fireEvent.paste(screen.getByLabelText('draft'), clipboard([]));
    expect(start).not.toHaveBeenCalled();
    expect(hostPaste).toHaveBeenCalled();
  });

  it('paste stays inert when no uploader is wired — capability absent', () => {
    const hostPaste = vi.fn();
    render(
      <Host attachments={{ start: undefined, placement: { mode: 'chip' } }} onHostPaste={hostPaste} />,
    );
    fireEvent.paste(screen.getByLabelText('draft'), clipboard([pdf()]));
    expect(screen.queryByTestId('ri-attachments')).toBeNull();
    expect(hostPaste).toHaveBeenCalled();
  });

  it('remove cancels an in-flight upload', () => {
    const { task, cancel } = stubTask();
    render(<Host attachments={{ start: () => task, placement: { mode: 'chip' } }} />);
    fireEvent.paste(screen.getByLabelText('draft'), clipboard([pdf()]));

    // The chip's accessible name is its aria-label; the visible text says Cancel.
    fireEvent.click(screen.getByRole('button', { name: 'Remove report.pdf' }));
    expect(cancel).toHaveBeenCalled();
    expect(screen.queryByTestId('ri-attachments')).toBeNull();
  });

  it('a failed upload says why and Try again re-runs the same file', async () => {
    const first = stubTask();
    const second = stubTask();
    const start = vi.fn()
      .mockImplementationOnce(() => first.task)
      .mockImplementationOnce(() => second.task);
    render(<Host attachments={{ start, placement: { mode: 'chip' } }} />);
    fireEvent.paste(screen.getByLabelText('draft'), clipboard([pdf()]));

    await act(async () => { first.reject(Object.assign(new Error('x'), { code: 'payload_too_large' })); });
    expect(screen.getByRole('alert').textContent).toContain('larger than the allowed');

    fireEvent.click(screen.getByRole('button', { name: /Try report.pdf again/ }));
    expect(start).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve(uploadedFile('report.pdf', 'file-2')); });
    expect(screen.getByTestId('ids').textContent).toBe('file-2');
  });

  it('a dropped file stages a chip — drop is deliberately unfiltered', () => {
    const { task } = stubTask();
    const start = vi.fn(() => task);
    render(<Host attachments={{ start, placement: { mode: 'chip' } }} />);
    fireEvent.drop(screen.getByLabelText('draft'), {
      dataTransfer: { files: [zip()], types: ['Files'] },
    });
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe('attachments — caret placement (prose surfaces)', () => {
  function CaretHost({ start }: { start: (file: File) => FileUploadTask }) {
    const [value, setValue] = useState('start end');
    const live = useRef(value);
    live.current = value;
    const areaRef = useRef<HTMLTextAreaElement | null>(null);
    const rich = useRichInput({
      value,
      onChange: setValue,
      areaRef,
      attachments: {
        start,
        placement: {
          mode: 'caret',
          liveText: () => live.current,
          setText: setValue,
        },
      },
    });
    return (
      <div className="ri-host">
        <textarea aria-label="draft" ref={areaRef} value={value} {...rich.areaProps} />
        <AttachmentChips attachments={rich.attachments} />
      </div>
    );
  }

  it('an upload lands as a markdown reference at the caret, not as a chip', async () => {
    const { task, resolve } = stubTask();
    render(<CaretHost start={() => task} />);
    const area = screen.getByLabelText('draft') as HTMLTextAreaElement;
    area.setSelectionRange(5, 5);

    fireEvent.drop(area, { dataTransfer: { files: [png('shot.png')], types: ['Files'] } });
    await act(async () => { resolve(uploadedFile('shot.png', 'file-img', 'image/png')); });

    expect(area.value).toContain('![shot.png](tm8://file/file-img)');
    expect(area.value.startsWith('start')).toBe(true);
    expect(area.value.endsWith('end')).toBe(true);
    expect(screen.queryByTestId('ri-attachments')).toBeNull();
  });

  it('typing during the upload is preserved — the body is read at RESOLUTION', async () => {
    const { task, resolve } = stubTask();
    render(<CaretHost start={() => task} />);
    const area = screen.getByLabelText('draft') as HTMLTextAreaElement;
    area.setSelectionRange(9, 9);
    fireEvent.drop(area, { dataTransfer: { files: [pdf()], types: ['Files'] } });

    // The writer keeps typing while the upload runs.
    fireEvent.change(area, { target: { value: 'start end and more typed meanwhile' } });

    await act(async () => { resolve(uploadedFile('report.pdf', 'file-doc')); });
    expect(area.value).toContain('and more typed meanwhile');
    expect(area.value).toContain('[report.pdf](tm8://file/file-doc)');
  });

  it('a caret-mode failure is held visibly beside the text', async () => {
    const { task, reject } = stubTask();
    render(<CaretHost start={() => task} />);
    fireEvent.drop(screen.getByLabelText('draft'), {
      dataTransfer: { files: [pdf()], types: ['Files'] },
    });
    await act(async () => { reject(Object.assign(new Error('x'), { code: 'forbidden' })); });
    expect(screen.getByRole('alert').textContent).toContain('report.pdf');
    expect(screen.getByRole('alert').textContent).toContain('permission');
  });
});
