import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Thread } from '../../subsystems/thread';
import { Composer } from '../../subsystems/thread/Composer';
import {
  ChannelTaggingProvider,
  type ChannelTagTarget,
  type ChannelTaggingController,
} from '../../subsystems/thread/tags';
import type { MockFacade } from '../../mock';
import { createFacade, renderWith, resetStores } from './helpers';

const forge: ChannelTagTarget = {
  id: 'tm-forge',
  display: 'Forge',
  group: 'Team members',
  meta: 'starts a session when sent',
  route: { kind: 'spawn-team-member', teamMemberId: 'tm-forge' },
  mention: { entityId: 'tm-forge', kind: 'team_member', display: 'Forge' },
};

const forgeSession: ChannelTagTarget = {
  id: 'ws-forge',
  display: 'Forge current session',
  group: 'Work sessions',
  meta: 'running · Forge',
  route: { kind: 'existing-session', sessionId: 'ws-forge' },
};

let facade: MockFacade;

beforeEach(() => { resetStores(); facade = createFacade(); });
afterEach(() => { cleanup(); resetStores(); });

async function chooseSuggestion(label: string): Promise<void> {
  const list = await screen.findByRole('listbox', { name: 'Suggested mentions' });
  const option = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (candidate) => candidate.querySelector('.cv2-tag-option__name')?.textContent === label,
  );
  expect(option).toBeTruthy();
  fireEvent.mouseDown(option!);
  fireEvent.click(option!);
}

function typeMention(input: HTMLElement, value: string): void {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  (input as HTMLTextAreaElement).setSelectionRange(value.length, value.length);
  fireEvent.select(input);
}

describe('Channel @Tag composer', () => {
  it('shows grouped teammate/session choices and derives the selected destination', async () => {
    const onSubmit = vi.fn(async () => undefined);
    renderWith(facade, (
      <Composer
        anchorId={facade.ids.chBuild}
        spaceId="space-1"
        candidates={[]}
        tagTargets={[forge, forgeSession]}
        onSubmit={onSubmit}
      />
    ));

    const input = screen.getByRole('textbox');
    typeMention(input, '@Forg');

    expect(await screen.findByText('Team members')).toBeTruthy();
    expect(screen.getByText('Work sessions')).toBeTruthy();
    expect(screen.getByText('starts a session when sent')).toBeTruthy();
    expect(screen.getByText('running · Forge')).toBeTruthy();

    await chooseSuggestion('Forge');
    fireEvent.change(input, { target: { value: `${(input as HTMLTextAreaElement).value} please review` } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      selectedTagTargetIds: ['tm-forge'],
      mentions: [{ entityId: 'tm-forge', kind: 'team_member', display: 'Forge' }],
    }));
  });

  it('keeps the draft visible when tagged delivery rejects', async () => {
    renderWith(facade, (
      <Composer
        anchorId={facade.ids.chBuild}
        candidates={[]}
        onSubmit={async () => { throw new Error('session cap reached'); }}
      />
    ));

    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('session cap reached');
    expect(input.value).toBe('keep this draft');
  });
});

describe('Channel @Tag thread routing', () => {
  it('routes a top-level tag through the controller without a duplicate facade post', async () => {
    let finishLoad!: (targets: ChannelTagTarget[]) => void;
    const controller: ChannelTaggingController = {
      loadTargets: vi.fn(() => new Promise((resolve) => { finishLoad = resolve; })),
      send: vi.fn(async () => ({ anchorIds: [facade.ids.chBuild, 'ws-new'], spawnedSessionIds: ['ws-new'] })),
    };
    const facadePost = vi.spyOn(facade, 'postMessage');
    renderWith(facade, (
      <ChannelTaggingProvider controller={controller}>
        <Thread anchorId={facade.ids.chBuild} variant="feed" />
      </ChannelTaggingProvider>
    ));

    await waitFor(() => expect(document.querySelectorAll('[data-cv2-msg]').length).toBeGreaterThan(0));
    await waitFor(() => expect(controller.loadTargets).toHaveBeenCalled());
    await act(async () => { finishLoad([forge]); });
    const input = screen.getByRole('textbox');
    // Selection UX is covered above; feed the markup that selection produces
    // here so this test stays focused on Thread's command routing seam.
    fireEvent.change(input, { target: { value: '@[Forge](tm-forge) ship it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(controller.send).toHaveBeenCalledTimes(1));
    expect(controller.send).toHaveBeenCalledWith(expect.objectContaining({
      spaceId: expect.any(String),
      channelId: facade.ids.chBuild,
      selectedTagIds: ['tm-forge'],
      mentionIds: ['tm-forge'],
    }));
    expect(facadePost).not.toHaveBeenCalled();
  });

  it('does not offer session destinations inside a reply', async () => {
    let finishLoad!: (targets: ChannelTagTarget[]) => void;
    const controller: ChannelTaggingController = {
      loadTargets: vi.fn(() => new Promise((resolve) => { finishLoad = resolve; })),
      send: vi.fn(),
    };
    renderWith(facade, (
      <ChannelTaggingProvider controller={controller}>
        <Thread anchorId={facade.ids.chBuild} variant="feed" />
      </ChannelTaggingProvider>
    ));

    const rows = await waitFor(() => {
      const found = Array.from(document.querySelectorAll<HTMLElement>('[data-cv2-msg]'));
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    await waitFor(() => expect(controller.loadTargets).toHaveBeenCalled());
    await act(async () => { finishLoad([forgeSession]); });
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Reply' }));
    typeMention(screen.getByRole('textbox'), '@Forge current');

    expect(document.querySelector('.cv2-tag-option')).toBeNull();
    expect(controller.send).not.toHaveBeenCalled();
  });
});
