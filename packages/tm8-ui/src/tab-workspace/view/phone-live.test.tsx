// @vitest-environment jsdom
/**
 * PHONE LIVE: the strip's 📱 pops a phone up, starts a terminal for the viewer
 * inside it and types the test command — only one the viewer pressed Start on.
 */
import { forwardRef, useImperativeHandle } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { EntityDetail } from '@tm8/contract';
import { ActionStrip, EmbeddedWorkspace, EntityChromeContext, embeddedTab, useEmbeddedRuntime, useEntityChromeValue } from '../embed';
import type { WorkspaceGateHandles } from './context';
import { commandForDevice } from './PhoneLive';

const sent: string[] = [];
const outputHandlers: Array<(id: string, data: string) => void> = [];

vi.mock('../../terminal', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isLiveTerminalEnabled: () => true,
  LiveTerminal: forwardRef<{ send(data: string): void }, { sessionId: string; live?: boolean }>(function FakeTerminal({ sessionId, live }, ref) {
    useImperativeHandle(ref, () => ({ send: (data: string) => sent.push(`${sessionId}:${data}`) }));
    return <div data-testid="fake-terminal" data-live={String(live)}>{sessionId}</div>;
  }),
}));
vi.mock('../../terminal/pty/ptyTransport.js', () => ({
  ptyTransport: {
    onOutput: (handler: (id: string, data: string) => void) => {
      outputHandlers.push(handler);
      return () => outputHandlers.splice(outputHandlers.indexOf(handler), 1);
    },
  },
}));

const COMMAND = '/w/bin/jm-live iphone shopping';

function task(description: string): EntityDetail {
  return {
    id: 'task-1',
    kind: 'task',
    spaceId: 'space-phone',
    title: 'App tests',
    category: 'active',
    content: { description },
    counters: { messages: 0 },
    deletedAt: null,
  } as unknown as EntityDetail;
}

let started = 0;
const startTerminal = vi.fn(async () => ({ entity: { id: `term-${++started}` } }));
const terminate = vi.fn(async () => ({}));
const query = vi.fn(async (_input: unknown) => ({ page: { items: [] as unknown[] } }));
const dispatch = vi.fn(async (_input: { subjectId: string; note: string }) => ({ taskId: 'task-1', dispatcherSpawned: true }));

function gateFor(d: EntityDetail, others: Record<string, EntityDetail> = {}) {
  return {
    data: {
      detailOf: (id: string) => others[id] ?? d,
      messagesOf: () => undefined,
      reconcileCommand: () => undefined,
      refetchDetail: () => undefined,
      seam: { query, commands: { startTerminal, terminate, dispatch } },
    },
  } as unknown as WorkspaceGateHandles;
}

function Strip({ d, others }: { d: EntityDetail; others?: Record<string, EntityDetail> }) {
  const runtime = useEmbeddedRuntime('viewer-phone', 'space-phone');
  const chrome = useEntityChromeValue(null);
  const tab = embeddedTab(runtime, d.id, d.kind);
  return (
    <EmbeddedWorkspace runtime={runtime} gate={gateFor(d, others)}>
      <EntityChromeContext.Provider value={chrome}>
        <ActionStrip tab={tab} />
      </EntityChromeContext.Provider>
    </EmbeddedWorkspace>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  sent.length = 0;
  outputHandlers.length = 0;
  started = 0;
  startTerminal.mockClear();
  terminate.mockClear();
  dispatch.mockClear();
  query.mockClear();
  query.mockImplementation(async () => ({ page: { items: [] } }));
});
afterEach(cleanup);

describe('commandForDevice', () => {
  it('swaps the device word, and leaves a command without one alone', () => {
    expect(commandForDevice(COMMAND, 'android')).toBe('/w/bin/jm-live android shopping');
    expect(commandForDevice('/w/bin/jm-live pixel', 'iphone')).toBe('/w/bin/jm-live iphone');
    expect(commandForDevice('npm test', 'android')).toBe('npm test');
  });
});

describe('the phone button', () => {
  it('blinks green while the task streams a test', () => {
    const view = render(<Strip d={task(`Testing.\nlive: ${COMMAND}`)} />);
    expect(view.getByTestId('tws-phone-live').getAttribute('data-live')).toBe('true');
    cleanup();
    const quiet = render(<Strip d={task('Testing.')} />);
    expect(quiet.getByTestId('tws-phone-live').getAttribute('data-live')).toBeNull();
  });

  it('the first time, shows the task command and runs nothing until Start', async () => {
    const view = render(<Strip d={task(`live: ${COMMAND}`)} />);
    fireEvent.click(view.getByTestId('tws-phone-live'));
    const dialog = view.getByTestId('phone-live');
    expect(view.getByTestId('phone-live-command').textContent).toBe(COMMAND);
    expect(dialog.textContent).toContain('From the task');
    expect(startTerminal).not.toHaveBeenCalled();

    fireEvent.click(view.getByTestId('phone-live-start'));
    await waitFor(() => expect(view.getByTestId('fake-terminal').textContent).toBe('term-1'));
    expect(window.localStorage.getItem('tm8.phoneLive.trusted')).toBe(COMMAND);
    act(() => outputHandlers.forEach((h) => h('term-1', '$ ')));
    await waitFor(() => expect(sent).toEqual([`term-1:clear; ${COMMAND}\r`]));
  });

  it('once confirmed, starts at once; Android restarts as Android; closing ends the terminal', async () => {
    window.localStorage.setItem('tm8.phoneLive.trusted', COMMAND);
    const view = render(<Strip d={task(`live: ${COMMAND}`)} />);
    fireEvent.click(view.getByTestId('tws-phone-live'));
    await waitFor(() => expect(view.getByTestId('fake-terminal').textContent).toBe('term-1'));
    act(() => outputHandlers.forEach((h) => h('term-1', '$ ')));
    await waitFor(() => expect(sent).toHaveLength(1));

    fireEvent.click(view.getByTestId('phone-live-android'));
    await waitFor(() => expect(view.getByTestId('fake-terminal').textContent).toBe('term-2'));
    expect(terminate).toHaveBeenCalledWith('term-1', expect.objectContaining({ force: true }));
    act(() => outputHandlers.forEach((h) => h('term-2', '$ ')));
    await waitFor(() => expect(sent[1]).toBe('term-2:clear; /w/bin/jm-live android shopping\r'));

    fireEvent.click(view.getByTestId('phone-live-close'));
    expect(view.queryByTestId('phone-live')).toBeNull();
    expect(terminate).toHaveBeenCalledWith('term-2', expect.objectContaining({ force: true }));
  });

  it('never runs a remembered command the task does not carry, and drops the old free-text one', () => {
    window.localStorage.setItem('tm8.phoneLive.command', 'check the login journey');
    window.localStorage.setItem('tm8.phoneLive.trusted', COMMAND);
    const view = render(<Strip d={task('Testing.')} />);
    fireEvent.click(view.getByTestId('tws-phone-live'));
    expect(view.getByTestId('phone-live-empty')).toBeTruthy();
    expect(view.queryByTestId('phone-live-command')).toBeNull();
    expect(startTerminal).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('tm8.phoneLive.command')).toBeNull();
  });

  it('pops up by itself on a running test, view-only, and closing leaves the agent terminal running', () => {
    const AGENT = '01a1415b-7663-7de8-9f14-1fd8cf826883';
    const view = render(<Strip d={task(`Testing.\nlive-terminal: ${AGENT} android`)} />);
    expect(view.getByTestId('tws-phone-live').getAttribute('data-live')).toBe('true');
    const screen = view.getByTestId('fake-terminal');
    expect(screen.textContent).toBe(AGENT);
    expect(screen.getAttribute('data-live')).toBe('false');
    expect(view.getByTestId('phone-live-watching').textContent).toContain('Test running');
    expect(view.getByTestId('phone-live').textContent).toContain('Pixel 9 Pro');
    expect(startTerminal).not.toHaveBeenCalled();

    fireEvent.click(view.getByTestId('phone-live-close'));
    expect(view.queryByTestId('phone-live')).toBeNull();
    expect(terminate).not.toHaveBeenCalled();

    cleanup();
    const again = render(<Strip d={task(`live-terminal: ${AGENT}`)} />);
    expect(again.queryByTestId('phone-live')).toBeNull();
    fireEvent.click(again.getByTestId('tws-phone-live'));
    expect(again.getByTestId('fake-terminal').textContent).toBe(AGENT);
  });

  it('writes and runs the viewer\'s cases in the phone: the words go in as one base64 line, only when asked', async () => {
    const ASK = '/w/bin/jm-ask iphone';
    const view = render(<Strip d={task(`App tests.\nlive-ask: ${ASK}\nlive-app: tharakeshua/app_jo`)} />);
    fireEvent.click(view.getByTestId('tws-phone-live'));
    expect(view.getByTestId('phone-live-app').textContent).toContain('tharakeshua/app_jo');
    const words = 'Search "wood sage"; rm -rf ~';
    fireEvent.change(view.getByTestId('phone-live-ask'), { target: { value: words } });
    fireEvent.click(view.getByTestId('phone-live-ask-send'));
    await waitFor(() => expect(view.getByTestId('fake-terminal').textContent).toBe('term-1'));
    act(() => outputHandlers.forEach((h) => h('term-1', '$ ')));
    await waitFor(() => expect(sent).toEqual([`term-1:clear; ${ASK}\r`]));
    act(() => outputHandlers.forEach((h) => h('term-1', 'Write & run tests\r\n')));
    expect(sent).toHaveLength(1);
    act(() => outputHandlers.forEach((h) => h('term-1', 'READY-FOR-')));
    act(() => outputHandlers.forEach((h) => h('term-1', 'CASES\r\n')));
    const line = Buffer.from(words, 'utf8').toString('base64');
    await waitFor(() => expect(sent).toEqual([`term-1:clear; ${ASK}\r`, `term-1:${line}\r`]));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('explore & deep test sends an empty line, which the runner takes as "explore on your own"', async () => {
    const ASK = '/w/bin/jm-ask iphone';
    const view = render(<Strip d={task(`live-ask: ${ASK}`)} />);
    fireEvent.click(view.getByTestId('tws-phone-live'));
    fireEvent.click(view.getByTestId('phone-live-explore'));
    await waitFor(() => expect(view.getByTestId('fake-terminal').textContent).toBe('term-1'));
    act(() => outputHandlers.forEach((h) => h('term-1', '$ ')));
    await waitFor(() => expect(sent).toEqual([`term-1:clear; ${ASK}\r`]));
    act(() => outputHandlers.forEach((h) => h('term-1', 'READY-FOR-CASES\r\n')));
    await waitFor(() => expect(sent).toEqual([`term-1:clear; ${ASK}\r`, 'term-1:\r']));
  });

  it('remembers the app task for the space, and says so when none is connected', () => {
    const view = render(<Strip d={task('Testing.')} />);
    fireEvent.click(view.getByTestId('tws-phone-live'));
    expect(view.getByTestId('phone-live-ask-none')).toBeTruthy();
    expect((view.getByTestId('phone-live-ask-send') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const app = render(<Strip d={task('live-ask: /w/bin/jm-ask iphone')} />);
    fireEvent.click(app.getByTestId('tws-phone-live'));
    expect(window.localStorage.getItem('tm8.phoneLive.appTask:space-phone')).toBe('task-1');
  });

  it('finds the space\'s app task by itself, and shows the test an agent runs on it', async () => {
    const AGENT = '01a1415b-7663-7de8-9f14-1fd8cf826883';
    const app = { ...task(`Jo Malone.\nlive-app: tharakeshua/app_jo\nlive-ask: /w/bin/jm-ask iphone\nlive-terminal: ${AGENT} iphone`), id: 'app-task' } as EntityDetail;
    query.mockImplementation(async () => ({
      page: { items: [{ id: 'other', excerpt: 'Nothing here.' }, { id: 'app-task', excerpt: 'Jo Malone. live-app: tharakeshua/app_jo live-ask: /w/bin/jm-ask iphone' }] },
    }));
    const view = render(<Strip d={task('Some other task.')} others={{ 'app-task': app }} />);
    fireEvent.click(view.getByTestId('tws-phone-live'));
    await waitFor(() => expect(view.getByTestId('phone-live-app').textContent).toContain('tharakeshua/app_jo'));
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['task'], filters: { axes: { type: ['test'] } } }));
    expect(window.localStorage.getItem('tm8.phoneLive.appTask:space-phone')).toBe('app-task');
    expect(view.getByTestId('fake-terminal').textContent).toBe(AGENT);
    expect(view.getByTestId('fake-terminal').getAttribute('data-live')).toBe('false');
    expect(startTerminal).not.toHaveBeenCalled();
  });
});
