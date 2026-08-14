// @vitest-environment jsdom
/**
 * THE DISCUSSION COMPOSER SPEAKS THE SHARED RICH INPUT — the defect these pin.
 *
 * This surface shipped a bare single-line `<input>` whose placeholder read
 * "Reply — @ to mention" and whose empty state invited "press / and mention
 * someone". NEITHER SIGIL EXISTED. The tests below are written against that
 * pair of lies specifically: the copy is asserted to follow what is DECLARED,
 * and each capability is asserted to actually work when it is.
 *
 * The wire half matters as much as the picker: `PostMessageInput` has accepted
 * `mentionIds` and `attachmentIds` since the batch write landed, and the tab
 * sent neither. Every assertion here that matters is made at the `onPost`
 * seam, because that is the boundary a regression would cross silently.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CommandResult, MessageView } from '@tm8/contract';
import type { FileUploadTask, UploadedFile } from '../../files/upload';
import { DiscussionTab, type DiscussionPostInput } from './tabs';

afterEach(cleanup);

const PEOPLE = [
  { id: 'member-1', display: 'alex', meta: 'member' },
  { id: 'agent-1', display: 'forge', meta: 'agent' },
];

const SKILLS = [{ id: 'skill-1', display: 'triage', meta: 'sort the inbox' }];

function uploadedFile(name: string, id = 'file-1', mime = 'application/pdf'): UploadedFile {
  return { fileEntityId: id, name, mime, sizeBytes: 1, maxSizeBytes: 100, result: {} as CommandResult };
}

function stubTask() {
  let resolve!: (uploaded: UploadedFile) => void;
  const cancel = vi.fn();
  const task: FileUploadTask = {
    result: new Promise<UploadedFile>((res) => { resolve = res; }),
    cancel,
  };
  return { task, resolve, cancel };
}

function pdf(name = 'report.pdf'): File {
  return new File(['x'], name, { type: 'application/pdf' });
}

function zip(name = 'bundle.zip'): File {
  return new File(['x'], name, { type: 'application/zip' });
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

function mount(props: Partial<Parameters<typeof DiscussionTab>[0]> = {}) {
  const onPost = vi.fn<(input: DiscussionPostInput) => Promise<void>>(async () => undefined);
  render(
    <DiscussionTab
      messages={[] as readonly MessageView[]}
      provenanceHollowReason="Not recorded"
      canPost
      onPost={onPost}
      {...props}
    />,
  );
  return { onPost, field: screen.getByLabelText('Reply') as HTMLTextAreaElement };
}

function type(field: HTMLTextAreaElement, value: string, caret = value.length) {
  fireEvent.change(field, { target: { value, selectionStart: caret, selectionEnd: caret } });
}

describe('the composer advertises only what it has', () => {
  it('names NEITHER sigil when the host wired neither', () => {
    const { field } = mount();
    expect(field.placeholder).toBe('Reply');
    expect(screen.getByText(/No discussion yet/).textContent).toBe(
      'No discussion yet — reply below.',
    );
  });

  it('names @ alone when only mentions are wired', () => {
    const { field } = mount({ mentionOptions: PEOPLE });
    expect(field.placeholder).toBe('Reply — @ to mention');
    expect(screen.getByText(/No discussion yet/).textContent).toContain('@ to mention');
    expect(screen.getByText(/No discussion yet/).textContent).not.toContain('/');
  });

  it('names both when both are wired', () => {
    const { field } = mount({ mentionOptions: PEOPLE, skillOptions: SKILLS });
    expect(field.placeholder).toBe('Reply — @ to mention · / to reference a skill');
  });

  it('an EMPTY option list still counts as wired — [] is a measured zero', () => {
    // The distinction the whole primitive rests on: a space with no skills
    // yet keeps its `/`, and the picker gets to say there are none.
    const { field } = mount({ skillOptions: [] });
    expect(field.placeholder).toBe('Reply — / to reference a skill');
  });
});

describe('@ mentions reach the wire', () => {
  it('committing a row inserts the name AND sends the id it stands for', async () => {
    const { onPost, field } = mount({ mentionOptions: PEOPLE });

    type(field, '@al');
    fireEvent.click(screen.getByRole('option', { name: /alex/ }));
    expect(field.value).toBe('@alex ');

    type(field, '@alex ping');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    expect(onPost.mock.calls[0]![0]).toEqual({ body: '@alex ping', mentionIds: ['member-1'] });
  });

  it('the arrow keys browse and Enter commits the ROW, not the message', async () => {
    const { onPost, field } = mount({ mentionOptions: PEOPLE });
    type(field, '@');
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field.value).toBe('@forge ');
    // The message did NOT go out on that Enter — the picker consumed it.
    expect(onPost).not.toHaveBeenCalled();
  });

  it('with no options declared, @ is ordinary text and no picker opens', async () => {
    const { onPost, field } = mount();
    type(field, '@alex hi');
    expect(screen.queryByTestId('pn-composer-popover')).toBeNull();
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    // No `mentionIds` key at all: nothing was picked, so nothing is claimed.
    expect(onPost.mock.calls[0]![0]).toEqual({ body: '@alex hi' });
  });
});

describe('/ REFERENCES a skill (R1) — it never invokes one', () => {
  it('commits a markdown link into the body and dispatches nothing', async () => {
    const { onPost, field } = mount({ skillOptions: SKILLS });
    type(field, '/tri');
    fireEvent.click(screen.getByRole('option', { name: /triage/ }));
    expect(field.value).toBe('[/triage](tm8://skill/skill-1) ');

    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    const posted = onPost.mock.calls[0]![0];
    expect(posted.body).toBe('[/triage](tm8://skill/skill-1)');
    // The reference rides the BODY — the one channel an agent reads verbatim.
    expect(posted.mentionIds).toBeUndefined();
    expect(posted.attachmentIds).toBeUndefined();
  });
});

describe('attachments are chips whose ids ride the message (R4)', () => {
  it('a pasted file uploads and its entity id reaches onPost', async () => {
    const { task, resolve } = stubTask();
    const attach = vi.fn(() => task);
    const { onPost, field } = mount({ attach });

    fireEvent.paste(field, clipboard([pdf()]));
    expect(attach).toHaveBeenCalledTimes(1);
    expect(screen.getByText('report.pdf')).toBeTruthy();

    await act(async () => { resolve(uploadedFile('report.pdf', 'file-9')); });
    type(field, 'see this');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    expect(onPost.mock.calls[0]![0]).toEqual({ body: 'see this', attachmentIds: ['file-9'] });
    // The body is untouched: a chat surface stages a chip, it does not splice
    // a reference into the text the way the doc editor does.
    expect(field.value).toBe('');
  });

  it('Send is withheld while an upload is in flight, and says why', async () => {
    const { task } = stubTask();
    const { onPost, field } = mount({ attach: () => task });

    fireEvent.paste(field, clipboard([pdf()]));
    type(field, 'ready?');

    const send = screen.getByRole('button', { name: 'Send reply' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(send.getAttribute('title')).toContain('attachments are not ready');
    // And the keyboard path is gated with it — otherwise Enter would post the
    // message and drop the file the writer is watching upload.
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onPost).not.toHaveBeenCalled();
  });

  it('a pasted file the agents cannot read is REFUSED OUT LOUD (R2)', () => {
    const { task } = stubTask();
    const attach = vi.fn(() => task);
    mount({ attach });

    fireEvent.paste(screen.getByLabelText('Reply'), clipboard([zip()]));
    expect(attach).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('bundle.zip');
    expect(screen.getByRole('alert').textContent).toContain('agents cannot read');
  });

  it('no attach port ⇒ the control is disabled WITH ITS REASON, and paste is inert', () => {
    mount();
    const control = screen.getByRole('button', { name: 'Attach a file' });
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(document.body.textContent).toContain('this panel was mounted without an attachment port');
    // Inert, not silent-failing: nothing is staged and nothing is claimed.
    fireEvent.paste(screen.getByLabelText('Reply'), clipboard([pdf()]));
    expect(screen.queryByText('report.pdf')).toBeNull();
  });
});

describe('what the Surface Audit built survives the migration', () => {
  it('Shift+Enter is a newline now, and Enter still sends', async () => {
    const { onPost, field } = mount();
    type(field, 'line one');
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(onPost).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
  });

  it('a refused post keeps the draft and holds the reason beside it', async () => {
    const onPost = vi.fn(async () => { throw new Error('anchor is archived'); });
    render(
      <DiscussionTab
        messages={[]}
        provenanceHollowReason="Not recorded"
        canPost
        onPost={onPost}
      />,
    );
    const field = screen.getByLabelText('Reply') as HTMLTextAreaElement;
    type(field, 'kept');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('anchor is archived'));
    // S17: when the write failed, the draft is the only copy that exists.
    expect(field.value).toBe('kept');
  });

  it('no dispatcher ⇒ the field is disabled with the true reason, never enabled-inert', () => {
    render(<DiscussionTab messages={[]} provenanceHollowReason="Not recorded" />);
    const field = screen.getByLabelText('Reply') as HTMLTextAreaElement;
    expect(field.disabled).toBe(true);
    expect(field.title).toContain('Posting isn’t connected in this surface yet');
  });

  it('a blocked composer refuses to upload — the file would attach to a message nobody can send', () => {
    const attach = vi.fn(() => stubTask().task);
    render(
      <DiscussionTab
        messages={[]}
        provenanceHollowReason="Not recorded"
        canPost={false}
        postDisabledReason="You can read this entity, not write to it"
        onPost={vi.fn()}
        attach={attach}
      />,
    );
    fireEvent.paste(screen.getByLabelText('Reply'), clipboard([pdf()]));
    expect(attach).not.toHaveBeenCalled();
  });
});
