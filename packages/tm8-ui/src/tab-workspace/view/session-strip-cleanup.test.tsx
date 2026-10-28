// @vitest-environment jsdom
/**
 * THE SESSION'S STRIP, CLEANED UP (task 01a181e2, option B): Terminal,
 * Transcript and Changes stand in the strip and the other views open from
 * "More views"; Run and the phone and website testers live in ⋯; the side
 * column reads Messages, Chat, Links.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { EntityDetail } from '@tm8/contract';
import { WorkSessionContent } from '../../panels/bodies/WorkSessionContent';
import { ActionStrip, EmbeddedWorkspace, EntityChromeContext, embeddedTab, useEmbeddedRuntime, useEntityChromeValue } from '../embed';
import type { WorkspaceGateHandles } from './context';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  window.localStorage.clear();
});

function stripSlot(): HTMLElement {
  const strip = document.createElement('div');
  strip.className = 'tws-astrip';
  const slot = document.createElement('div');
  strip.appendChild(slot);
  document.body.appendChild(strip);
  return slot;
}

function Session({ slot }: { slot: HTMLElement }) {
  return (
    <WorkSessionContent
      sessionId="session-strip-1"
      profile={null}
      switchSlot={slot}
      terminal={<div>native terminal</div>}
      transcript={<div>agent transcript</div>}
      debug={<div>debug journal</div>}
      git={<div>git rail</div>}
      graph={<div>graph canvas</div>}
    />
  );
}

describe('the session view switch in the action strip', () => {
  it('stands Terminal, Transcript and Changes, and keeps the rest behind More views', () => {
    const slot = stripSlot();
    render(<Session slot={slot} />);
    const tabs = within(slot).getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['Terminal', 'Transcript', 'Changes', 'More views']);

    fireEvent.click(within(slot).getByTestId('work-session-more-views'));
    const menu = within(slot).getByRole('menu', { name: 'More views' });
    expect(within(menu).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['Git', 'Debug', 'Graph', 'Launch context']);

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Git' }));
    expect(within(slot).queryByRole('menu')).toBeNull();
    expect(screen.getByTestId('work-session-content').dataset.surface).toBe('git');
    const more = within(slot).getByTestId('work-session-more-views');
    expect(more.getAttribute('aria-selected')).toBe('true');
    expect(more.getAttribute('aria-label')).toBe('Git (more views)');

    fireEvent.click(within(slot).getByRole('tab', { name: 'Terminal' }));
    expect(more.getAttribute('aria-selected')).toBe('false');
    expect(more.getAttribute('aria-label')).toBe('More views');
  });

  it('keeps every view as its own tab outside the strip', () => {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    render(<Session slot={slot} />);
    expect(within(slot).getAllByRole('tab')).toHaveLength(7);
    expect(within(slot).queryByTestId('work-session-more-views')).toBeNull();
  });
});

const SPACE = 'space-session-strip';
const VIEWER = 'viewer-session-strip';

function detail(id: string, kind: string): EntityDetail {
  return { id, kind, title: id, counters: {}, deletedAt: null } as unknown as EntityDetail;
}

const gate = {
  data: {
    detailOf: (id: string) => detail(id, id.startsWith('task') ? 'task' : 'work_session'),
    messagesOf: () => undefined,
    seam: { commands: {} },
  },
} as unknown as WorkspaceGateHandles;

function Strip({ id, kind }: { id: string; kind: string }) {
  const runtime = useEmbeddedRuntime(VIEWER, SPACE);
  const chrome = useEntityChromeValue(null);
  const tab = embeddedTab(runtime, id, kind);
  return (
    <EmbeddedWorkspace runtime={runtime} gate={gate}>
      <EntityChromeContext.Provider value={chrome}>
        <ActionStrip tab={tab} />
      </EntityChromeContext.Provider>
    </EmbeddedWorkspace>
  );
}

describe('the session action strip', () => {
  it('keeps the phone and website testers and Run in ⋯', () => {
    const view = render(<Strip id="session-1" kind="work_session" />);
    expect(view.queryByTestId('tws-phone-live')).toBeNull();
    expect(view.queryByTestId('tws-web-test')).toBeNull();
    expect(view.queryByTestId('tws-astrip-common')).toBeNull();

    fireEvent.click(view.getByTestId('tws-more'));
    const menu = view.getByTestId('tws-more-menu');
    expect(within(menu).getByTestId('tws-astrip-common')).toBeTruthy();
    fireEvent.click(within(menu).getByTestId('tws-menu-web'));
    expect(view.queryByTestId('tws-more-menu')).toBeNull();
    expect(screen.getByTestId('web-test-none')).toBeTruthy();
  });

  it('leaves them in the strip for a task', () => {
    const view = render(<Strip id="task-1" kind="task" />);
    expect(view.getByTestId('tws-phone-live')).toBeTruthy();
    expect(view.getByTestId('tws-web-test')).toBeTruthy();
    expect(view.getByTestId('tws-astrip-common')).toBeTruthy();
  });

  it('orders the side column Messages, Chat, Links', () => {
    const view = render(<Strip id="task-1" kind="task" />);
    const side = view.getByTestId('tws-astrip-side');
    expect([...side.querySelectorAll('button')].map((b) => b.getAttribute('data-testid'))).toEqual([
      'tws-section-messages',
      'tws-chat-toggle',
      'tws-section-connections',
    ]);
  });
});
