// @vitest-environment jsdom
/**
 * THE REPORTER'S GESTURE, AS A TEST. "When I upload images, the image is going
 * in the chat, but in the chat ui it's not visible."
 *
 * The write path was whole the entire time — the composer staged the upload,
 * `postMessage` carried `attachmentIds`, the server stored them and returned
 * them on every read, and the agent received the file. The transcript was the
 * only thing that never asked. So the case that had to exist is exactly this:
 * a turn whose message CARRIES attachments, rendered.
 *
 * Each `it` below is one of the three ways this can be wrong, and the second
 * two are the ones a naive fix gets wrong: a PDF must not become an `<img>`,
 * and a surface with no bytes resolver must degrade to the chip rather than
 * emit an `<img src>` pointing nowhere.
 */
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

const PNG = '019f0000-0000-7000-8000-000000000041' as EntityId;
const PDF = '019f0000-0000-7000-8000-000000000042' as EntityId;

/** The host's resolver, stubbed the way the real seam behaves: a relative
 *  bytes route per file entity, built by the SEAM and never by a component. */
const href = (id: EntityId) => `/v2/files/${id}/download`;

function renderTranscript(assetHref?: (id: EntityId) => string | null) {
  const { port } = createChatHomeFixturePort();
  return render(
    <ChatHomeScreen
      port={port}
      spaceId={SPACE_ID}
      models={MODELS}
      {...(assetHref ? { assetHref } : {})}
    />,
  );
}

describe('Chat transcript attachments', () => {
  it('renders an attached image inline and a non-image as its chip', async () => {
    const view = renderTranscript(href);
    const row = await waitFor(() => view.getByTestId('chat-turn-attachments'));

    /* THE BUG, INVERTED. Before this, the transcript drew no attachment
       element at all — the whole row is the assertion. */
    const image = row.querySelector('img');
    expect(image).not.toBeNull();
    expect(image!.getAttribute('src')).toBe(href(PNG));
    // The name is the alt text: a screenshot with no accessible name is
    // invisible to exactly the readers who most need it named.
    expect(image!.getAttribute('alt')).toBe('launch-board.png');
    // No layout jump: the bytes are fetched only when the row is near view.
    expect(image!.getAttribute('loading')).toBe('lazy');

    // The PDF stays the chip it always was — one `<img>` on the row, not two.
    expect(row.querySelectorAll('img')).toHaveLength(1);
    expect(row.textContent).toContain('launch-plan.pdf');
    expect(row.textContent).toContain('application/pdf');
  });

  it('opens the file entity when an attachment is clicked', async () => {
    const opened: EntityId[] = [];
    const { port } = createChatHomeFixturePort();
    const view = render(
      <ChatHomeScreen
        port={port}
        spaceId={SPACE_ID}
        models={MODELS}
        assetHref={href}
        onOpenEntity={(id) => opened.push(id)}
      />,
    );
    const row = await waitFor(() => view.getByTestId('chat-turn-attachments'));
    (row.querySelector('button[aria-label="Open attachment launch-board.png"]') as HTMLButtonElement).click();
    (row.querySelector('button[aria-label="Open attachment launch-plan.pdf"]') as HTMLButtonElement).click();
    expect(opened).toEqual([PNG, PDF]);
  });

  it('degrades to the chip when the host resolves no bytes href', async () => {
    // No resolver at all — a host with no files seam. The image is still a
    // real file you can open; what is missing is the ability to FETCH it, and
    // an `<img>` with no source is a broken image, not an honest gap.
    const view = renderTranscript();
    const row = await waitFor(() => view.getByTestId('chat-turn-attachments'));
    expect(row.querySelector('img')).toBeNull();
    expect(row.textContent).toContain('launch-board.png');
    expect(row.textContent).toContain('image/png');
  });

  it('degrades to the chip when the resolver answers null for that one file', async () => {
    // Per-file, not all-or-nothing: `DownloadHref` may legitimately answer
    // null for a node whose bytes are not reachable while others are.
    const view = renderTranscript((id) => (id === PNG ? null : href(id)));
    const row = await waitFor(() => view.getByTestId('chat-turn-attachments'));
    expect(row.querySelector('img')).toBeNull();
    expect(row.textContent).toContain('launch-board.png');
  });

  it('draws no attachment element for a turn that carries none', async () => {
    // The agent's turn in the fixture has no files. An empty frame under every
    // message would be the other way to get this wrong.
    const view = renderTranscript(href);
    await waitFor(() => expect(view.getAllByTestId('chat-turn-attachments')).toHaveLength(1));
    expect(CHAT_HOME_FIXTURE_THREAD.turns[1]!.attachments ?? []).toEqual([]);
  });
});
