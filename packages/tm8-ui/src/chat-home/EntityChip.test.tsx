// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { resetChatEntityResolutionCache, type ChatEntityResolver } from './EntityChip';
import { extractEntityRefs, truncateEntityId } from './entity-refs';
import { createChatHomeFixturePort } from './fixtures';
import { TurnParts } from './TurnParts';
import type { ChatModelOption, ChatTurnPart } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

const TASK_ID = '019f0000-0000-7000-8000-000000000021';
const BARE_ID = '019f0000-0000-7000-8000-000000000022';

function toolParts(result: unknown, args: unknown = {}): ChatTurnPart[] {
  return [
    { seq: 0, kind: 'tool_call', toolCallId: 't1', name: 'tm8_read', args, state: 'completed' },
    { seq: 1, kind: 'tool_result', toolCallId: 't1', content: result },
  ];
}

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

describe('EntityChip in the transcript', () => {
  it('renders title and kind from a tool result and opens the entity on click', () => {
    const onOpenEntity = vi.fn();
    const view = render(
      <TurnParts
        parts={toolParts({ items: [{ id: TASK_ID, kind: 'task', title: 'Unblock the storage lane' }] })}
        onOpenEntity={onOpenEntity}
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
    const view = render(
      <TurnParts parts={toolParts({ blockerId: BARE_ID })} resolveEntity={resolve} />,
    );
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
      <TurnParts
        parts={toolParts({ blockerId: BARE_ID })}
        resolveEntity={resolve}
        onOpenEntity={onOpenEntity}
      />,
    );
    const chip = view.getByTestId('chat-entity-chip');
    await waitFor(() => expect(chip.getAttribute('data-resolved')).toBe('unresolved'));
    expect(chip.textContent).toContain(truncateEntityId(BARE_ID));
    fireEvent.click(chip);
    expect(onOpenEntity).toHaveBeenCalledWith(BARE_ID);
  });

  it('renders chips from the fixture thread inside ChatHomeScreen', async () => {
    const { port } = createChatHomeFixturePort();
    const onOpenEntity = vi.fn();
    const view = render(
      <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} onOpenEntity={onOpenEntity} />,
    );
    await waitFor(() => expect(view.getAllByTestId('chat-entity-chip')).toHaveLength(2));
    fireEvent.click(view.getByText('Unblock the storage lane'));
    expect(onOpenEntity).toHaveBeenCalledWith(TASK_ID);
  });
});
