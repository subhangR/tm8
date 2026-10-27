// @vitest-environment jsdom
/**
 * Task t-topbar: the phone chat screen draws NO top bar. The ☰ floats over the
 * transcript and carries a request waiting on you as its dot; every other
 * phone screen keeps the header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { SpaceId } from '@tm8/contract';
import { MobileShell } from './MobileShell';
import { useGateData, type GateData } from './useGateData';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { AttentionApiProvider, type AttentionApi } from '../attention';
import type { MenuTarget } from '../shell';
import type { DetailReasons } from '../panels';

vi.mock('../chat-home/ChatHomeSurface', () => ({
  ChatHomeSurface: () => <div data-testid="stub-chat-surface" />,
}));

const SLOW_GATE_MS = 30_000;

const REASONS: DetailReasons = {
  presenceHollow: 'Presence isn’t measured yet.',
  versionHistory: 'Version history isn’t available yet.',
  provenanceHollow: 'Authorship provenance isn’t available yet.',
  shareUnavailable: 'Sharing into a session isn’t available yet.',
  withdrawUnavailable: 'Withdrawing a handoff isn’t available yet.',
};

const CHAT: MenuTarget = { type: 'view', ref: 'dashboard' };
const TASKS: MenuTarget = { type: 'kind', ref: 'task' };

/** Only what the shell reads off the api on the chat screen. */
function attentionWith(mine: number): AttentionApi {
  return { counts: () => ({ mine, all: mine }), queue: () => [] } as unknown as AttentionApi;
}

function PhoneHost({ target }: { target: MenuTarget }) {
  const data = useGateData({ leftKind: 'task', rightKind: 'work_session', seam: createFixtureSeam() });
  return (
    <MobileShell
      data={data as GateData & { pull?: (id: string) => void }}
      spaceId={(data.spaceId ?? 'sp-atelier') as SpaceId}
      activeTarget={target}
      navigateTo={() => {}}
      openEntity={null}
      reasons={REASONS}
      onNotice={() => {}}
      nodeKey="local"
    />
  );
}

beforeEach(() => {
  resetNav();
  screenStackStore.getState().clearAll();
  window.localStorage.clear();
  window.location.hash = '';
});
afterEach(cleanup);

describe('phone chat screen: no top bar (t-topbar)', () => {
  it('draws no header; the ☰ floats over the screen', async () => {
    const view = render(<PhoneHost target={CHAT} />);
    await view.findByTestId('stub-chat-surface', undefined, { timeout: SLOW_GATE_MS });
    const frame = view.container.querySelector('.mobile-frame')!;
    expect(frame.querySelector('.mobile-frame__header')).toBeNull();
    expect(frame.hasAttribute('data-headless')).toBe(true);
    const menu = view.getByTestId('mobile-drawer-menu');
    expect(menu.classList.contains('mobile-float-menu')).toBe(true);
    expect(menu.closest('.mobile-frame__content')).toBeNull();
  }, SLOW_GATE_MS);

  it('a request waiting on you is the ☰’s dot', async () => {
    const view = render(
      <AttentionApiProvider api={attentionWith(2)}>
        <PhoneHost target={CHAT} />
      </AttentionApiProvider>,
    );
    await view.findByTestId('stub-chat-surface', undefined, { timeout: SLOW_GATE_MS });
    const menu = view.getByTestId('mobile-drawer-menu');
    expect(menu.querySelector('.mobile-header__dot[data-tone="wait"]')).not.toBeNull();
    expect(menu.getAttribute('aria-label')).toContain('2 need you');
    expect(view.queryByTestId('attention-phone-button')).toBeNull();
  }, SLOW_GATE_MS);

  it('every other screen keeps the header, with the ☰ in it', async () => {
    const view = render(<PhoneHost target={TASKS} />);
    await waitFor(() => expect(view.getAllByTestId('phone-list-row').length).toBeGreaterThan(0), { timeout: SLOW_GATE_MS });
    const header = view.container.querySelector('.mobile-frame__header');
    expect(header).not.toBeNull();
    expect(view.container.querySelector('.mobile-frame')!.hasAttribute('data-headless')).toBe(false);
    const menu = view.getByTestId('mobile-drawer-menu');
    expect(header!.contains(menu)).toBe(true);
    expect(menu.classList.contains('mobile-float-menu')).toBe(false);
  }, SLOW_GATE_MS);
});
