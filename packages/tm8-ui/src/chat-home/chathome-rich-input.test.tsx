// @vitest-environment jsdom
/**
 * CHAT HOME SPEAKS THE SHARED RICH INPUT — files on a prompt, and `/`.
 *
 * The two facts these pin, both of them about the ANCHOR:
 *
 *  1. An upload starts IMMEDIATELY, against the anchor, not against the
 *     thread. A new conversation has no root message until Send, so a chat
 *     that waited for one would leave a pasted file doing nothing visible
 *     until the writer finished typing. The anchor — bare Home's seeded
 *     default channel, or a contextual host's own entity — exists first.
 *  2. The ids reach BOTH write paths. `createRoot` and `postTurn` are two
 *     different calls, and a migration that wired only the second would drop
 *     every attachment on the first message of every conversation.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CommandResult, EntityId } from '@tm8/contract';
import type { FileUploadTask, UploadedFile } from '../files/upload';
import { ChatHomeScreen } from './ChatHomeScreen';
import { createChatHomeFixturePort } from './fixtures';
import type { ChatModelOption } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];
const SKILLS = [{ id: 'skill-7', display: 'triage', meta: 'sort the inbox' }];

function uploadedFile(id: string, name = 'report.pdf'): UploadedFile {
  return { fileEntityId: id, name, mime: 'application/pdf', sizeBytes: 1, maxSizeBytes: 100, result: {} as CommandResult };
}

function stubTask() {
  let resolve!: (uploaded: UploadedFile) => void;
  const task: FileUploadTask = {
    result: new Promise<UploadedFile>((res) => { resolve = res; }),
    cancel: vi.fn(),
  };
  return { task, resolve };
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

const pdf = () => new File(['x'], 'report.pdf', { type: 'application/pdf' });

describe('a pasted file rides the chat prompt', () => {
  it('uploads with NO anchor immediately and sends its id with the opening turn', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const { task, resolve } = stubTask();
    const attach = vi.fn(() => task);
    const view = render(
      <ChatHomeScreen
        port={port}
        spaceId={SPACE_ID}
        models={MODELS}
        attach={attach}
        newMutationId={(prefix) => `${prefix}:test`}
      />,
    );

    await waitFor(() => expect(view.getByRole('button', { name: /new chat/i })).toBeTruthy());
    fireEvent.click(view.getByRole('button', { name: /new chat/i }));

    const field = view.getByLabelText('Message the chat agent');
    fireEvent.paste(field, clipboard([pdf()]));

    // Immediately: no chat exists yet, and the upload is already running. 176
    // changed WHAT it runs against — there is no anchor, because the chat this
    // file belongs to has not been created. The file lands in the space library
    // and `chat.start` attaches it to the opening message via `attachmentIds`.
    // Before this, every staged file was attached to the seeded default
    // channel, which is an entity the conversation had nothing to do with.
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[0]![1]).toBeUndefined();
    expect(view.getByText('report.pdf')).toBeTruthy();

    // Send is withheld until it lands — the file must not be dropped from the
    // message that was supposed to carry it.
    fireEvent.change(field, { target: { value: 'read this' } });
    expect(view.getByRole('button', { name: /send/i }).getAttribute('aria-disabled')).toBe('true');

    await act(async () => { resolve(uploadedFile('file-42')); });
    fireEvent.click(view.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(controls.roots).toHaveLength(1));
    expect(controls.roots[0]).toMatchObject({
      body: 'read this',
      attachmentIds: ['file-42'],
    });
  });

  it('carries ids on a REPLY turn too, and forgets the chips after the send', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const { task, resolve } = stubTask();
    const view = render(
      <ChatHomeScreen
        port={port}
        spaceId={SPACE_ID}
        models={MODELS}
        attach={() => task}
      />,
    );
    // The fixture opens on an existing thread, so this is `postTurn`.
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());

    const field = view.getByLabelText('Message the chat agent');
    fireEvent.paste(field, clipboard([pdf()]));
    await act(async () => { resolve(uploadedFile('file-8')); });
    fireEvent.change(field, { target: { value: 'and this' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(controls.posts).toHaveLength(1));
    expect(controls.posts[0]).toMatchObject({ body: 'and this', attachmentIds: ['file-8'] });
    // The chip is gone from the NEXT message, without its upload being
    // cancelled — the id is already on the one just sent.
    await waitFor(() => expect(view.queryByText('report.pdf')).toBeNull());
  });

  it('no attach port ⇒ the control says why, and paste stays inert', async () => {
    const { port } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByLabelText('Message the chat agent')).toBeTruthy());

    /* Attach lives in the ＋ menu now ("add to this turn"); the row is drawn
       disabled WITH the reason, never dropped. */
    fireEvent.click(view.getByRole('button', { name: 'Add to this turn' }));
    const control = view.getByRole('button', { name: 'Attach a file' });
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(document.body.textContent).toContain('this chat was mounted without an attachment port');

    fireEvent.paste(view.getByLabelText('Message the chat agent'), clipboard([pdf()]));
    expect(view.queryByText('report.pdf')).toBeNull();
  });
});

describe('/ references a skill in the prompt (R1)', () => {
  it('commits a tm8://skill link into the body the agent reads', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = render(
      <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} skillOptions={SKILLS} />,
    );
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());

    const field = view.getByLabelText('Message the chat agent') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '/tri', selectionStart: 4, selectionEnd: 4 } });
    fireEvent.click(view.getByRole('option', { name: /triage/ }));
    expect(field.value).toBe('[/triage](tm8://skill/skill-7) ');

    fireEvent.change(field, { target: { value: '[/triage](tm8://skill/skill-7) do it' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(controls.posts).toHaveLength(1));
    // The BODY carries it — the one channel delivered to the model verbatim.
    expect(controls.posts[0]!.body).toBe('[/triage](tm8://skill/skill-7) do it');
  });

  it('with no skills declared, / is ordinary text and the control is not drawn', async () => {
    const { port } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByLabelText('Message the chat agent')).toBeTruthy());

    const field = view.getByLabelText('Message the chat agent') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '/tri', selectionStart: 4, selectionEnd: 4 } });
    expect(view.queryByTestId('tch-skill-picker')).toBeNull();
    expect(view.queryByRole('button', { name: 'Reference a skill' })).toBeNull();
    expect(field.value).toBe('/tri');
  });
});

describe('what the chat composer already did survives', () => {
  it('Enter sends and Shift+Enter does not', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());

    const field = view.getByLabelText('Message the chat agent');
    fireEvent.change(field, { target: { value: 'first line' } });
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(controls.posts).toHaveLength(0);

    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(controls.posts).toHaveLength(1));
  });
});
