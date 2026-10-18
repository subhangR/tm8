// @vitest-environment jsdom
/**
 * THE PHONE CARD HOLDS ONLY THE FIELD AND THE FOOT (t-clean-composer, chat v2
 * mockup 01a14cba).
 *
 * Screen-level, over the fixture port, inside the phone's surface provider:
 * staged files, enabled-skill pills and a Coordinator's team chip are ABSENT
 * from the card there, listed in the ＋ sheet as "Attached to this message · N"
 * with a ✕ each, and N is the badge on ＋. The desktop arrangement is pinned
 * beside it so the phone change cannot leak.
 */
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult, EntityId } from '@tm8/contract';
import type { FileUploadTask, UploadedFile } from '../../files/upload';
import { MobileSurfaceProvider } from '../../mobile';
import { ChatHomeScreen } from '../ChatHomeScreen';
import { createChatHomeFixturePort } from '../fixtures';
import type { ChatHomePort, ChatModelOption, ChatTeammateOption } from '../types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic', agentTool: 'claude-code', efforts: ['low', 'high'] },
];
const TEAMMATES: ChatTeammateOption[] = [
  { id: '019f0000-0000-7000-8000-00000000a001' as EntityId, label: 'Builder', mode: 'worker', permissionMode: null },
  { id: '019f0000-0000-7000-8000-00000000a002' as EntityId, label: 'Conductor', mode: 'coordinator', permissionMode: 'acceptEdits' },
];
const SKILLS = [{ id: 'skill-7', display: 'triage', meta: 'sort the inbox' }];

function stubTask() {
  let resolve!: (uploaded: UploadedFile) => void;
  const task: FileUploadTask = {
    result: new Promise<UploadedFile>((res) => { resolve = res; }),
    cancel: vi.fn(),
  };
  return { task, resolve };
}

async function openNewChat(phone: boolean) {
  const { port } = createChatHomeFixturePort();
  const { task, resolve } = stubTask();
  const screen = (
    <ChatHomeScreen
      port={{ ...port, listTeammates: async () => TEAMMATES } as ChatHomePort}
      spaceId={SPACE_ID}
      models={MODELS}
      skillOptions={SKILLS}
      attach={() => task}
      newMutationId={(p) => `${p}:t`}
    />
  );
  const sheetHost = document.createElement('div');
  document.body.appendChild(sheetHost);
  const view = render(phone ? <MobileSurfaceProvider sheetHost={sheetHost}>{screen}</MobileSurfaceProvider> : screen);
  await waitFor(() => expect(view.getByRole('button', { name: /new chat/i })).toBeTruthy());
  fireEvent.click(view.getByRole('button', { name: /new chat/i }));
  await waitFor(() => expect(view.getByLabelText('Chat model')).toBeTruthy());
  return { view, resolve, sheetHost };
}

const card = (view: ReturnType<typeof render>) => view.container.querySelector('.tch-composer')!;
const toolbarOf = (view: ReturnType<typeof render>) =>
  [...card(view).querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label')!);

function stageFile(view: ReturnType<typeof render>) {
  const file = new File(['x'], 'screenshot-drawer.png', { type: 'image/png' });
  fireEvent.drop(view.getByLabelText('Message the chat agent'), {
    dataTransfer: { files: [file], items: [], types: ['Files'] },
  });
}

describe('the phone composer card is clean', () => {
  afterEach(() => { cleanup(); localStorage.clear(); document.body.innerHTML = ''; });

  it('the foot is ＋ · settings · model · send — no team chip and no pills in the card', async () => {
    const { view } = await openNewChat(true);
    expect(toolbarOf(view)).toEqual(['Add to this turn', 'Chat settings', 'Chat model', 'Send']);
    expect(view.queryByTestId('tch-turnpills')).toBeNull();
  });

  it('an enabled skill and a staged file live in the ＋ sheet, counted on ＋', async () => {
    const { view, sheetHost } = await openNewChat(true);
    stageFile(view);
    // Staged, but not drawn inside the card.
    expect(card(view).querySelector('.ri-attachments__list')).toBeNull();
    expect(view.getByTestId('tch-add-badge').textContent).toBe('1');

    fireEvent.click(view.getByTestId('tch-add'));
    const sheet = within(sheetHost);
    expect(sheet.getByText('Attached to this message · 1')).toBeTruthy();
    expect(sheet.getByText('screenshot-drawer.png')).toBeTruthy();
    expect(sheet.getByText('uploading…')).toBeTruthy();

    // Skill: a tile that opens the checklist in place, and lands in the list.
    fireEvent.click(sheet.getByTestId('tch-add-skills'));
    fireEvent.click(sheet.getByTestId('tch-add-skill-skill-7'));
    expect(sheet.getByText('Attached to this message · 2')).toBeTruthy();
    expect(sheet.getByText('/triage')).toBeTruthy();
    expect(view.getByTestId('tch-add-badge').textContent).toBe('2');
    expect(view.queryByTestId('tch-turnpills')).toBeNull();

    // ✕ removes from the message.
    fireEvent.click(sheet.getByRole('button', { name: 'Remove /triage' }));
    expect(sheet.getByText('Attached to this message · 1')).toBeTruthy();
    fireEvent.click(sheet.getByRole('button', { name: 'Cancel uploading screenshot-drawer.png' }));
    expect(sheet.queryByText(/Attached to this message/)).toBeNull();
    expect(view.queryByTestId('tch-add-badge')).toBeNull();
  });

  it('the Add grid is the mockup’s tiles; Team opens the Coordinator team in place', async () => {
    const { view, sheetHost } = await openNewChat(true);
    fireEvent.click(view.getByTestId('tch-add'));
    const sheet = within(sheetHost);
    const tiles = [...sheetHost.querySelectorAll('.tch-addsheet__tile')].map((t) => t.textContent);
    expect(tiles.slice(0, 5)).toEqual(['📷Photo', '📎File', '#Entity', '⚡Skill', '👥Team']);
    // Entity is honestly absent: disabled, with its reason.
    expect(sheet.getByTestId('tch-add-entity').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(sheet.getByTestId('tch-add-team'));
    expect(sheet.getByTestId('tch-add-view-team')).toBeTruthy();
    expect(sheet.getByTestId('tch-team-picker')).toBeTruthy();
    fireEvent.click(sheet.getByRole('button', { name: /Coordinator team/ }));
    expect(sheetHost.querySelector('.tch-addsheet__grid')).toBeTruthy();
  });

  it('desktop is unchanged: team chip in the foot, pills beside ＋, chips in the card', async () => {
    const { view, resolve } = await openNewChat(false);
    expect(toolbarOf(view)).toEqual(['Add to this turn', 'Chat settings', 'Coordinator team', 'Chat model', 'Send']);
    stageFile(view);
    expect(card(view).querySelector('.ri-attachments__list')).toBeTruthy();
    fireEvent.click(view.getByTestId('tch-add'));
    expect(view.getByTestId('tch-add-menu')).toBeTruthy();
    expect(view.queryByTestId('tch-add-body')).toBeNull();
    fireEvent.click(view.getByTestId('tch-add-skill-skill-7'));
    expect(view.getByTestId('tch-turnpills')).toBeTruthy();
    expect(view.getByTestId('tch-add-badge').textContent).toBe('1');
    await act(async () => {
      resolve({ fileEntityId: 'f-1', name: 'x', mime: 'image/png', sizeBytes: 1, maxSizeBytes: 9, result: {} as CommandResult });
    });
  });
});
