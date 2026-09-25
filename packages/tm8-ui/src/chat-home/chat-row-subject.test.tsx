// @vitest-environment jsdom
/**
 * Entity chat §3.6 — the global Chats list shows each chat's SUBJECT as an
 * "about ‹title›" chip that opens the subject.
 *
 * A separate file on purpose: sibling lanes are editing ChatHomeScreen's own
 * suites, and a new file cannot conflict.
 */
import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatModelOption, ChatThreadDetail } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];
const WITH_SUBJECT = '019f0000-0000-7000-8000-000000000010' as EntityId;
const BARE = '019f0000-0000-7000-8000-00000000001f' as EntityId;
const SUBJECT = '019f0000-0000-7000-8000-0000000000a1' as EntityId;

function threads(): ChatThreadDetail[] {
  const about = structuredClone(CHAT_HOME_FIXTURE_THREAD);
  about.summary = {
    ...about.summary,
    rootId: WITH_SUBJECT,
    aboutId: SUBJECT,
    about: { id: SUBJECT, kind: 'task', title: 'Ship the launch' },
    title: 'Plan the launch sequence',
  };
  const bare = structuredClone(CHAT_HOME_FIXTURE_THREAD);
  bare.summary = {
    ...bare.summary,
    rootId: BARE,
    aboutId: null,
    about: null,
    title: 'Draft the release note',
    updatedAt: '2026-08-13T09:00:00.000Z',
  };
  return [about, bare];
}

describe('Chats list — each chat shows its subject (§3.6)', () => {
  it('draws "about ‹title›" on the row that has a subject, and nothing on the row that does not', async () => {
    const { port } = createChatHomeFixturePort(threads());
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.container.querySelectorAll('.tch-thread')).toHaveLength(2));

    const subjectRows = view.getAllByTestId('chat-row-with-subject');
    expect(subjectRows).toHaveLength(1);
    const row = subjectRows[0]!;
    expect(row.querySelector('.tch-thread__title')?.textContent).toContain('Plan the launch sequence');
    const about = row.querySelector('[data-testid="chat-row-about"]');
    expect(about?.textContent).toContain('about');
    expect(about?.textContent).toContain('Ship the launch');

    // The bare chat's row is the plain button, with no subject line anywhere near it.
    const bareTitle = [...view.container.querySelectorAll('.tch-thread__title')]
      .find((el) => el.textContent?.includes('Draft the release note'));
    expect(bareTitle?.closest('[data-testid="chat-row-with-subject"]')).toBeNull();
    expect(view.getAllByTestId('chat-row-about')).toHaveLength(1);
  });

  it('the chip opens the SUBJECT — not the chat — and is not nested inside the row button', async () => {
    const onOpenEntity = vi.fn();
    const onThreadSelected = vi.fn();
    const { port } = createChatHomeFixturePort(threads());
    const view = render(
      <ChatHomeScreen
        port={port}
        spaceId={SPACE_ID}
        models={MODELS}
        onOpenEntity={onOpenEntity}
        onThreadSelected={onThreadSelected}
      />,
    );
    const about = await view.findByTestId('chat-row-about');
    const chip = about.querySelector('button[data-testid="chat-entity-chip"]') as HTMLButtonElement;
    expect(chip).not.toBeNull();
    // A button cannot nest a button: the chip is the row button's SIBLING.
    expect(chip.closest('.tch-thread')).toBeNull();

    onThreadSelected.mockClear();
    fireEvent.click(chip);
    expect(onOpenEntity).toHaveBeenCalledWith(SUBJECT);
    expect(onThreadSelected).not.toHaveBeenCalled();
  });
});
