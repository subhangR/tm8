// @vitest-environment jsdom
/**
 * THE COMPOSER OVER THE SHARED HOOK — the chat surface's half of the
 * rich-input adoption, tested at the seam the host actually uses: what
 * `onPost` receives.
 *
 * The mention flow's parity claims (picker opens on `@`, filters by prefix,
 * commits into the draft AND onto `mentionIds`) are asserted here because the
 * migration moved that logic out of this file — a green that only the
 * primitive's own suite could see would say nothing about whether the
 * composer still speaks it. The two NEW capabilities ride the same tests:
 * `/` commits a durable skill reference into the body (R1), and paste takes
 * the agent-readable set with a stated refusal for the rest (R2).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { Composer, type ComposerMentionOption } from './Composer';

afterEach(cleanup);

const MENTIONS: ComposerMentionOption[] = [
  { id: 'member-ada' as EntityId, kind: 'member', display: 'Ada' },
  { id: 'member-bo' as EntityId, kind: 'member', display: 'Bo' },
];

const SKILLS = [
  { id: 'skill-review', display: 'code review', meta: 'How this team reviews' },
];

function mount(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onPost = vi.fn();
  render(
    <Composer
      anchorId={'channel-1' as EntityId}
      anchorNoun="this channel"
      onPost={onPost}
      replyTo={null}
      onCancelReply={() => {}}
      mentionOptions={MENTIONS}
      skillOptions={SKILLS}
      {...overrides}
    />,
  );
  return { onPost, area: screen.getByLabelText('Message this channel') as HTMLTextAreaElement };
}

function type(area: HTMLTextAreaElement, value: string) {
  fireEvent.change(area, { target: { value } });
}

describe('mentions through the shared trigger (parity)', () => {
  it('typing @ opens the picker, prefix-filters, and Enter commits draft + mentionIds', async () => {
    const { onPost, area } = mount();
    type(area, '@a');
    expect(screen.getByTestId('chs-mention-picker')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(1);

    fireEvent.keyDown(area, { key: 'Enter' });
    expect(area.value).toBe('@Ada ');

    type(area, '@Ada hello');
    fireEvent.keyDown(area, { key: 'Enter' });
    await waitFor(() => expect(onPost).toHaveBeenCalled());
    expect(onPost.mock.calls[0]![0]).toMatchObject({
      body: '@Ada hello',
      mentionIds: ['member-ada'],
    });
  });

  it('mentionOptions undefined keeps @ as plain text — capability absent', () => {
    mount({ mentionOptions: undefined, skillOptions: undefined });
    type(screen.getByLabelText('Message this channel') as HTMLTextAreaElement, '@');
    expect(screen.queryByTestId('chs-mention-picker')).toBeNull();
  });
});

describe('the / skill trigger (R1 — a reference, never an invocation)', () => {
  it('commits a tm8://skill link into the body; nothing else rides the post', async () => {
    const { onPost, area } = mount();
    type(area, '/co');
    expect(screen.getByTestId('chs-skill-picker')).toBeTruthy();

    fireEvent.keyDown(area, { key: 'Enter' });
    expect(area.value).toBe('[/code review](tm8://skill/skill-review) ');

    fireEvent.keyDown(area, { key: 'Enter' });
    await waitFor(() => expect(onPost).toHaveBeenCalled());
    const input = onPost.mock.calls[0]![0];
    expect(input.body).toBe('[/code review](tm8://skill/skill-review)');
    expect(input.mentionIds).toBeUndefined();
    expect(input.attachmentIds).toBeUndefined();
  });

  it('the toolbar / button lands in the same typed-trigger state', () => {
    const { area } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Reference a skill' }));
    expect(area.value).toBe('/');
    expect(screen.getByTestId('chs-skill-picker')).toBeTruthy();
  });
});

describe('paste takes the agent-readable set (R2)', () => {
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

  it('a pasted PDF stages an attachment and its id rides the post', async () => {
    const uploaded = {
      fileEntityId: 'file-9' as EntityId,
      name: 'report.pdf',
      mime: 'application/pdf',
      sizeBytes: 1,
      maxSizeBytes: 100,
      result: {} as never,
    };
    const start = vi.fn(() => ({ result: Promise.resolve(uploaded), cancel: vi.fn() }));
    const { onPost, area } = mount({ onStartAttachmentUpload: start });

    fireEvent.paste(area, clipboard([new File(['x'], 'report.pdf', { type: 'application/pdf' })]));
    expect(start).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText('✓ uploaded')).toBeTruthy());

    type(area, 'see attached');
    fireEvent.keyDown(area, { key: 'Enter' });
    await waitFor(() => expect(onPost).toHaveBeenCalled());
    expect(onPost.mock.calls[0]![0]).toMatchObject({ attachmentIds: ['file-9'] });
  });

  it('a pasted archive is refused OUT LOUD and never uploads', () => {
    const start = vi.fn();
    const { area } = mount({ onStartAttachmentUpload: start as never });
    fireEvent.paste(area, clipboard([new File(['x'], 'bundle.zip', { type: 'application/zip' })]));
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByTestId('chs-paste-refusal').textContent).toContain('bundle.zip');
  });
});
