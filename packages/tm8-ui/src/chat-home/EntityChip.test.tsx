// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { EntityChip, resetChatEntityResolutionCache, type ChatEntityResolver } from './EntityChip';
import { extractEntityRefs, truncateEntityId } from './entity-refs';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatModelOption } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

const TASK_ID = '019f0000-0000-7000-8000-000000000021';
const BARE_ID = '019f0000-0000-7000-8000-000000000022';

beforeEach(() => resetChatEntityResolutionCache());

describe('entity reference extraction', () => {
  it('finds full entity shapes, bare id keys, and JSON-in-text envelopes; skips bookkeeping ids', () => {
    const refs = extractEntityRefs(
      { params: { id: TASK_ID }, spaceId: '019f0000-0000-7000-8000-00000000009f' },
      {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              items: [{ id: TASK_ID, kind: 'task', title: 'Unblock the storage lane' }],
              blockerId: BARE_ID,
              clientMutationId: '019f0000-0000-7000-8000-0000000000aa',
            }),
          },
        ],
      },
    );
    expect(refs).toEqual([
      { id: TASK_ID, kind: 'task', title: 'Unblock the storage lane' },
      { id: BARE_ID },
    ]);
  });

  it('survives non-JSON text, nulls and non-uuid ids without producing chips', () => {
    expect(extractEntityRefs('{not json', null, { id: 'task-114', kind: 'task' }, 42)).toEqual([]);
  });
});

describe('EntityChip', () => {
  /* The transcript stopped rendering chips (the ledger lines replaced them —
     no-tool-boxes.test.tsx owns that surface now). The chip itself survives
     in the entity tray, so these cover it directly. */
  it('renders title and kind and opens the entity on click', () => {
    const onOpenEntity = vi.fn();
    const view = render(
      <EntityChip
        refInfo={{ id: TASK_ID, kind: 'task', title: 'Unblock the storage lane' }}
        onOpen={onOpenEntity}
      />,
    );
    const chip = view.getByTestId('chat-entity-chip');
    expect(within(chip).getByText('Unblock the storage lane')).toBeTruthy();
    expect(within(chip).getByText(/task/i)).toBeTruthy();
    fireEvent.click(chip);
    expect(onOpenEntity).toHaveBeenCalledWith(TASK_ID);
  });

  it('shows a truncated id while resolving, then the resolved title', async () => {
    const resolve: ChatEntityResolver = vi
      .fn()
      .mockResolvedValue({ id: BARE_ID, kind: 'work_session', title: 'Nightly sweep' });
    const view = render(<EntityChip refInfo={{ id: BARE_ID }} resolve={resolve} />);
    const chip = view.getByTestId('chat-entity-chip');
    expect(chip.textContent).toContain(truncateEntityId(BARE_ID));
    await waitFor(() => expect(within(chip).getByText('Nightly sweep')).toBeTruthy());
    expect(within(chip).getByText(/session/i)).toBeTruthy();
    expect(resolve).toHaveBeenCalledWith(BARE_ID as EntityId);
  });

  it('falls back to the truncated id when resolution fails, staying clickable', async () => {
    const onOpenEntity = vi.fn();
    const resolve: ChatEntityResolver = vi.fn().mockRejectedValue(new Error('refused'));
    const view = render(
      <EntityChip refInfo={{ id: BARE_ID }} resolve={resolve} onOpen={onOpenEntity} />,
    );
    const chip = view.getByTestId('chat-entity-chip');
    await waitFor(() => expect(chip.getAttribute('data-resolved')).toBe('unresolved'));
    expect(chip.textContent).toContain(truncateEntityId(BARE_ID));
    fireEvent.click(chip);
    expect(onOpenEntity).toHaveBeenCalledWith(BARE_ID);
  });

  it('renders NO chips in the TRANSCRIPT for the fixture thread — the chip era is over', async () => {
    /* S3 replaced the transcript's chip row with the ledger's counted line;
       S4 replaced the tray's chip strip with the ledger panel. The chip
       survives only where a payload IS content (ExplanationToolCard's
       durable-entity row), which the fixture thread does not exercise.
       
       SCOPED TO THE TRANSCRIPT, and the scope is the ruling rather than a
       weakening of it. What S3/S4 retired was the chip as a SUMMARY — a strip
       of everything a turn happened to touch, which said "these were
       mentioned" and nothing more, and which the counted ledger line says
       better. A chip that names ONE relation is a different thing, and two of
       them landed with the chat entity (Wave 2):
       
         · the conversation header's `about` subject, which is the only place
           the relation appears at all — without it a craft chat and a bare
           Home chat are indistinguishable on screen; and
         · a third-party turn's SOURCE, which is what makes a work session's
           report legible as a report rather than as something you said.
       
       Both are the payload, not a summary of it. The header's is asserted
       below, so this file pins the whole census rather than one half of it. */
    /* The DEMO thread, named rather than defaulted: this case is about the
       transcript's own chip census, and it must not silently change meaning if
       the port's default list ever widens again. */
    const { port } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
    const view = render(
      <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} onOpenEntity={vi.fn()} />,
    );
    await waitFor(() => expect(view.getAllByTestId('chat-ledger-reads')).toHaveLength(1));
    const transcript = view.container.querySelector('.tch-transcript');
    expect(transcript).not.toBeNull();
    expect(transcript!.querySelectorAll('[data-testid="chat-entity-chip"]')).toHaveLength(0);
  });

  it('draws the `about` subject as a chip on the conversation header', async () => {
    /* The fixture thread carries `aboutId` (the fixture channel), which is
       what makes this observable at all — a fixture with no subject would let
       a header that never draws the relation look correct. */
    /* The DEMO thread, named rather than defaulted: this case is about the
       transcript's own chip census, and it must not silently change meaning if
       the port's default list ever widens again. */
    const { port } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
    const view = render(
      <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} onOpenEntity={vi.fn()} />,
    );
    const relation = await waitFor(() => view.getByTestId('chat-about-relation'));
    expect(relation.textContent).toContain('about');
    expect(within(relation).getByTestId('chat-entity-chip')).toBeTruthy();
    /* It is INSIDE the header and not in the transcript: the subject is a fact
       about the conversation, not about any one turn in it. */
    expect(relation.closest('.tch-conversation__head')).not.toBeNull();
  });
});
