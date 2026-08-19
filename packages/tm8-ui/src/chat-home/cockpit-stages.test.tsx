// @vitest-environment jsdom
/**
 * THE COCKPIT'S NON-ENTITY STAGES, mounted.
 *
 * The panes have their own suites; this one pins the MOUNT — the part where a
 * stage, an entity and the conversation all want region B and only one may
 * have it. The failure modes here are structural rather than cosmetic: two
 * panes stacked silently, a transcript unmounted mid-stream, or a way back
 * that is not on screen.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatModelOption } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

/** A space with NO conversations: the screen's genuine new-thread state, which
 *  is where the composer is centred and therefore the only place the
 *  dock-down FLIP can be wrong. Passing `routeThreadId: null` to the ordinary
 *  fixture is not enough — it auto-selects the thread that exists. */
function mountEmpty(over: Partial<Parameters<typeof ChatHomeScreen>[0]> = {}) {
  const { port } = createChatHomeFixturePort([]);
  return render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} {...over} />);
}

function mount(over: Partial<Parameters<typeof ChatHomeScreen>[0]> = {}) {
  const { port } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
  return render(
    <ChatHomeScreen
      port={port}
      spaceId={SPACE_ID}
      models={MODELS}
      routeThreadId={CHAT_HOME_FIXTURE_THREAD.summary.rootId}
      {...over}
    />,
  );
}

describe('the stage tabs', () => {
  it('are absent without a host verb — the tray never draws a dead control', async () => {
    mount();
    await screen.findByTestId('chat-entity-tray');
    expect(screen.queryByText('Fleet')).toBeNull();
  });

  it('ask the HOST to change the address rather than swapping locally', async () => {
    const onStageChange = vi.fn();
    mount({ onStageChange });
    fireEvent.click(await screen.findByText('Fleet'));
    expect(onStageChange).toHaveBeenCalledWith('fleet');
    // Nothing rendered yet: the stage follows the address coming back down,
    // so Back and a reload land on the same screen the click produced.
    expect(screen.queryByTestId('cockpit-fleet')).toBeNull();
  });
});

describe('region B has exactly one occupant', () => {
  it('the fleet renders in the transcript’s berth', async () => {
    mount({ stage: 'fleet', onStageChange: vi.fn() });
    await screen.findByTestId('cockpit-fleet');
    expect(screen.getByTestId('tch-center-override')).toBeTruthy();
  });

  it('the graph renders there too, and only one at a time', async () => {
    mount({ stage: 'graph', onStageChange: vi.fn() });
    await screen.findByTestId('cockpit-graph');
    expect(screen.queryByTestId('cockpit-fleet')).toBeNull();
  });

  it('AN ENTITY WINS. A host that hands both gets the entity, never both stacked', async () => {
    mount({
      stage: 'fleet',
      onStageChange: vi.fn(),
      centerOverride: <div data-testid="host-entity-panel" />,
    });
    await screen.findByTestId('host-entity-panel');
    expect(screen.queryByTestId('cockpit-fleet')).toBeNull();
  });

  it('THE TRANSCRIPT IS HIDDEN, NOT UNMOUNTED — a streaming thread survives a stage', async () => {
    const { container } = mount({ stage: 'graph', onStageChange: vi.fn() });
    await screen.findByTestId('cockpit-graph');
    const transcript = container.querySelector('.tch-transcript');
    expect(transcript).not.toBeNull();
    expect(transcript?.getAttribute('hidden')).not.toBeNull();
  });
});

describe('the conversation header belongs to the conversation', () => {
  /**
   * User report 2026-08-19 (task 01a017d3): `New conversation · Work with your
   * graph from one place` was printed directly above a running terminal. The
   * header names the OPEN THREAD; while an entity panel or a stage holds
   * region B the open thread is not what is on screen, so the header captions
   * a surface it has nothing to do with — and spends 56px doing it, on the one
   * surface (a terminal) where vertical space is the whole point.
   */
  it('is drawn while the conversation itself is in the berth', async () => {
    const { container } = mount();
    await screen.findByTestId('chat-entity-tray');
    expect(container.querySelector('.tch-conversation__head')).not.toBeNull();
  });

  it('is NOT drawn over a host entity panel', async () => {
    const { container } = mount({ centerOverride: <div data-testid="host-entity-panel" /> });
    await screen.findByTestId('host-entity-panel');
    expect(container.querySelector('.tch-conversation__head')).toBeNull();
  });

  it('is NOT drawn over a stage either — same reason, different occupant', async () => {
    const { container } = mount({ stage: 'fleet', onStageChange: vi.fn() });
    await screen.findByTestId('cockpit-fleet');
    expect(container.querySelector('.tch-conversation__head')).toBeNull();
  });

  it('comes BACK when the berth returns to the conversation', async () => {
    const { port } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
    const screenWith = (centre: boolean) => (
      <ChatHomeScreen
        port={port}
        spaceId={SPACE_ID}
        models={MODELS}
        routeThreadId={CHAT_HOME_FIXTURE_THREAD.summary.rootId}
        {...(centre ? { centerOverride: <div data-testid="host-entity-panel" /> } : {})}
      />
    );
    const { container, rerender } = render(screenWith(true));
    await screen.findByTestId('host-entity-panel');
    expect(container.querySelector('.tch-conversation__head')).toBeNull();

    rerender(screenWith(false));
    await waitFor(() => expect(container.querySelector('.tch-conversation__head')).not.toBeNull());
  });
});

describe('the composer belongs to the conversation too', () => {
  /**
   * Same report, other half. With the head gone the panel was still wrapped
   * from below: the tray AND `Reply in this thread…` kept the bottom berth,
   * ~200px of chat chrome under a running terminal — addressed to a thread
   * that is not what is on screen, and inset to `min(760px, 100% - 32px)`
   * under a full-bleed panel so the two read as unrelated surfaces.
   *
   * THE TRAY STAYS (2026-08-18 Cockpit ruling): it is the way back, and one
   * row of tabs is the cheapest form of it. So these assert a PAIR — composer
   * gone, tray present — because either alone is a different bug: dropping
   * both strands you on the panel, dropping neither is the report.
   */
  const composer = (container: HTMLElement) =>
    container.querySelector('textarea[aria-label="Message the chat agent"]');

  it('is drawn while the conversation itself is in the berth', async () => {
    const { container } = mount();
    await screen.findByTestId('chat-entity-tray');
    expect(composer(container)).not.toBeNull();
  });

  it('stands down over a host entity panel — and the tray stays as the way back', async () => {
    const onShowChat = vi.fn();
    const { container } = mount({
      centerOverride: <div data-testid="host-entity-panel" />,
      onStageChange: vi.fn(),
      onShowChat,
    });
    await screen.findByTestId('host-entity-panel');
    expect(composer(container)).toBeNull();
    expect(screen.getByTestId('chat-entity-tray')).toBeTruthy();
    // The way back is a CONTROL, not just a row: click it and the host is asked
    // for the chat. A tray drawn without its ⌂ tab would pass a mere presence
    // check and still strand you on the panel.
    const back = container.querySelector<HTMLButtonElement>('.tch-tray__chat');
    expect(back).not.toBeNull();
    fireEvent.click(back!);
    expect(onShowChat).toHaveBeenCalled();
  });

  it('stands down over a stage too — same reason, different occupant', async () => {
    const { container } = mount({ stage: 'fleet', onStageChange: vi.fn() });
    await screen.findByTestId('cockpit-fleet');
    expect(composer(container)).toBeNull();
    expect(screen.getByTestId('chat-entity-tray')).toBeTruthy();
  });

  it('the berth goes full-bleed, so the tray is not inset under a full-width panel', async () => {
    const { container } = mount({
      centerOverride: <div data-testid="host-entity-panel" />,
      onStageChange: vi.fn(),
    });
    await screen.findByTestId('host-entity-panel');
    // jsdom rasterizes nothing; the ATTRIBUTE is the contract the stylesheet
    // keys on (`.tch-composer-wrap[data-chrome='tray']`), so pin that.
    expect(container.querySelector('.tch-composer-wrap')?.getAttribute('data-chrome')).toBe('tray');
  });

  it('comes BACK when the berth returns to the conversation', async () => {
    const { port } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
    const screenWith = (centre: boolean) => (
      <ChatHomeScreen
        port={port}
        spaceId={SPACE_ID}
        models={MODELS}
        routeThreadId={CHAT_HOME_FIXTURE_THREAD.summary.rootId}
        onStageChange={vi.fn()}
        {...(centre ? { centerOverride: <div data-testid="host-entity-panel" /> } : {})}
      />
    );
    const { container, rerender } = render(screenWith(true));
    await screen.findByTestId('host-entity-panel');
    expect(composer(container)).toBeNull();

    rerender(screenWith(false));
    await waitFor(() => expect(composer(container)).not.toBeNull());
    expect(container.querySelector('.tch-composer-wrap')?.getAttribute('data-chrome')).toBeNull();
  });
});

describe('the dock-down flip (visual lane handoff note)', () => {
  /**
   * `data-empty` centres the greeting + composer as one invitation on an empty
   * thread. It used to key on `centerOverride == null`; a stage arrives by a
   * different route, so if that predicate had not been re-pointed a stage
   * would have rendered UNDER a centred composer. The note asked for this path
   * to be tested rather than assumed, which is the right instinct: it is a
   * layout attribute, and jsdom will happily agree it is present while the
   * page looks wrong.
   */
  it('a stage occupying the berth un-centres the composer', async () => {
    const { container } = mount({ stage: 'fleet', onStageChange: vi.fn() });
    await screen.findByTestId('cockpit-fleet');
    expect(container.querySelector('.tch-conversation')?.getAttribute('data-empty')).toBeNull();
  });

  /**
   * VISUAL LANE'S LAST ASK, and the reason it was worth asking: the empty
   * thread is the ONLY state where the composer is centred, so it is the only
   * state the dock-down FLIP can be wrong in — and it is reachable by URL
   * (`/home/chat?stage=fleet` with no thread), not just by clicking.
   */
  it('a stage on an EMPTY thread renders, and suppresses the centred composer', async () => {
    const { container } = mountEmpty({ stage: 'fleet', onStageChange: vi.fn() });
    // The pane renders with no thread at all and says so in words.
    await screen.findByTestId('cockpit-fleet');
    expect(screen.getByText(/has not delegated anything yet/)).toBeTruthy();
    // …and the composer is NOT centred underneath it.
    expect(container.querySelector('.tch-conversation')?.getAttribute('data-empty')).toBeNull();
  });

  it('leaving a stage on an empty thread re-centres it, WITHOUT replaying the flip', async () => {
    /* The FLIP belongs to the first send. Replaying it on stage exit would
       animate a journey the composer never made. It is guarded by keying the
       effect on "is the composer centred" and playing only when a centred
       composer stops being centred BECAUSE the thread started — so a stage
       coming and going leaves no transform behind. */
    const { port } = createChatHomeFixturePort([]);
    const screenWith = (stage: 'fleet' | null) => (
      <ChatHomeScreen
        port={port}
        spaceId={SPACE_ID}
        models={MODELS}
        stage={stage}
        onStageChange={vi.fn()}
      />
    );
    const { container, rerender } = render(screenWith('fleet'));
    await screen.findByTestId('cockpit-fleet');
    const wrap = container.querySelector('.tch-composer-wrap') as HTMLElement;

    rerender(screenWith(null));
    await waitFor(() =>
      expect(container.querySelector('.tch-conversation')?.getAttribute('data-empty')).toBe('true'),
    );
    // No inverted start was committed, so nothing is mid-journey.
    expect(wrap.style.transform).toBe('');
    expect(wrap.style.transition).toBe('');
  });

  it('and a host entity does the same, as it always did', async () => {
    const { container } = mount({ centerOverride: <div data-testid="host-entity-panel" /> });
    await screen.findByTestId('host-entity-panel');
    expect(container.querySelector('.tch-conversation')?.getAttribute('data-empty')).toBeNull();
  });
});

describe('the way back is always on screen', () => {
  it('Esc leaves a stage by NAVIGATING, not by resetting local state', async () => {
    /* A stage is addressed. Clearing it locally would leave the URL pointing
       at a stage the viewer just dismissed, and Back would walk into it. */
    const onStageChange = vi.fn();
    const onShowChat = vi.fn();
    const { container } = mount({ stage: 'fleet', onStageChange, onShowChat });
    await screen.findByTestId('cockpit-fleet');
    fireEvent.keyDown(container.querySelector('.tch-conversation')!, { key: 'Escape' });
    expect(onStageChange).toHaveBeenCalledWith(null);
    expect(onShowChat).not.toHaveBeenCalled();
  });

  it('Esc over a HOST entity still uses the host’s own way back', async () => {
    const onStageChange = vi.fn();
    const onShowChat = vi.fn();
    const { container } = mount({
      onStageChange,
      onShowChat,
      centerOverride: <div data-testid="host-entity-panel" />,
    });
    await screen.findByTestId('host-entity-panel');
    fireEvent.keyDown(container.querySelector('.tch-conversation')!, { key: 'Escape' });
    expect(onShowChat).toHaveBeenCalled();
    expect(onStageChange).not.toHaveBeenCalled();
  });
});

describe('the retired inline graph', () => {
  it('is gone from the transcript — the graph is a stage, not a strip', async () => {
    mount();
    await waitFor(() => expect(screen.queryByTestId('chat-thinking')).toBeNull());
    // The strip's own testid and the fullscreen dialog's both die with it.
    expect(screen.queryByTestId('chat-entity-graph')).toBeNull();
    expect(screen.queryByTestId('chat-entity-graph-fullscreen')).toBeNull();
  });
});
