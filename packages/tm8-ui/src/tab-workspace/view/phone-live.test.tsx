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
import { commandForDevice, sharedInstallCommand } from './PhoneLive';
import { normalizeRepo } from './WebTest';
import type { ScreenSignal } from '../../terminal';

const sent: string[] = [];
const sentAt: number[] = [];
let backlog = 0;
let lastClose: { code: number; reason: string; at: number } | null = null;
/*
 * A fake test node behind the terminal, doing what jm-install does: it takes the
 * header, keeps numbered lines in order (skipping resends and anything past a
 * gap), confirms its count with the OSC the phone waits for, and answers '?'.
 */
const node = { on: false, header: false, kept: [] as string[], lose: 0, said: '' };
const ack = () => window.setTimeout(() => outputHandlers.forEach((h) => h('term-1', `\x1b]7777;tm8ack=${node.kept.length}\x07`)), 0);
function receive(data: string) {
  if (!node.on) return;
  if (node.lose > 0) {
    node.lose -= 1;
    return;
  }
  for (const line of data.split('\r').filter(Boolean)) {
    if (!node.header) node.header = true;
    else if (line === 'END') window.setTimeout(() => outputHandlers.forEach((h) => h('term-1', node.said || '\x1b[32m✔\x1b[0m saved \x1b[2mbuilds/x.apk\x1b[0m\r\n')), 0);
    else if (line === '?') ack();
    else {
      const [idx, b64] = line.split(':');
      if (b64 !== undefined && Number(idx) === node.kept.length) node.kept.push(b64);
    }
  }
  ack();
}
const signalTo: Record<string, (signal: ScreenSignal) => void> = {};
const outputHandlers: Array<(id: string, data: string) => void> = [];

vi.mock('../../terminal', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isLiveTerminalEnabled: () => true,
  LiveTerminal: forwardRef<
    { send(data: string): void },
    { sessionId: string; live?: boolean; onScreenSignal?: (signal: ScreenSignal) => void }
  >(function FakeTerminal({ sessionId, live, onScreenSignal }, ref) {
    useImperativeHandle(ref, () => ({ send: (data: string) => (sentAt.push(performance.now()), sent.push(`${sessionId}:${data}`), receive(data)) }));
    if (onScreenSignal) signalTo[sessionId] = onScreenSignal;
    return <div data-testid="fake-terminal" data-live={String(live)}>{sessionId}</div>;
  }),
}));
vi.mock('../../terminal/pty/ptyTransport.js', () => ({
  ptyTransport: {
    inputBacklog: () => backlog,
    lastClose: () => lastClose,
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
      seam: { query, commands: { startTerminal, terminate, dispatch }, files: {} },
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
  sentAt.length = 0;
  backlog = 0;
  lastClose = null;
  Object.assign(node, { on: false, header: false, kept: [], lose: 0, said: '' });
  outputHandlers.length = 0;
  for (const id of Object.keys(signalTo)) delete signalTo[id];
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

const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64');
const userVar = (name: string, value: unknown): ScreenSignal => ({ type: 'var', name, base64: b64(value) });
const JPEG = '/9j/4AAQSkZJRgABAQ';

describe('what the screen shows', () => {
  it('draws the frame as an image, lists the cases as they run, then the report says why one failed', async () => {
    const ASK = '/w/bin/jm-ask iphone';
    const view = render(<Strip d={task(`live-ask: ${ASK}`)} />);
    fireEvent.click(view.getByTestId('tws-phone-live'));
    fireEvent.change(view.getByTestId('phone-live-ask'), { target: { value: 'Search works; cart badge' } });
    fireEvent.click(view.getByTestId('phone-live-ask-send'));
    await waitFor(() => expect(signalTo['term-1']).toBeTypeOf('function'));
    const emit = (signal: ScreenSignal) => act(() => signalTo['term-1']!(signal));
    emit({ type: 'frame', src: `data:image/jpeg;base64,${JPEG}` });
    expect(view.getByTestId('phone-live-frame').getAttribute('src')).toContain(JPEG);
    emit(userVar('tm8run', { title: 'Your cases', device: 'iPhone 16 Pro Max', run: 'live-1', planned: ['Search works', 'Cart badge'] }));
    emit(userVar('tm8step', { i: 0, name: 'Search works', state: 'run' }));
    let cases = view.getByTestId('phone-live-cases').querySelectorAll('li');
    expect([...cases].map((c) => c.getAttribute('data-state'))).toEqual(['run', 'planned']);
    emit(userVar('tm8step', { i: 0, name: 'Search works', state: 'ok', ms: 1200, file: '01-search.png' }));
    emit(userVar('tm8step', { i: 1, name: 'Cart badge', state: 'fail', ms: 20500, error: "locator.tap: Timeout 20000ms exceeded.\nwaiting for getByTestId('add-to-bag')" }));
    emit({ type: 'var', name: 'tm8shot.1', base64: JPEG });
    emit(userVar('tm8done', { passed: false, total: 2, failed: 1, ms: 21700 }));
    cases = view.getByTestId('phone-live-cases').querySelectorAll('li');
    expect([...cases].map((c) => c.getAttribute('data-state'))).toEqual(['ok', 'fail']);
    expect(view.getByTestId('phone-live-done').textContent).toContain('1 of 2 failed');

    fireEvent.click(view.getByTestId('phone-live-report'));
    const report = view.getByTestId('phone-live-report-view');
    const rows = view.getAllByTestId('phone-live-report-case');
    expect(rows[0]!.textContent).toContain('PASSED');
    expect(rows[1]!.textContent).toContain('FAILED');
    expect(rows[1]!.textContent).toContain('could not tap the element (add-to-bag)');
    expect(rows[1]!.querySelector('img')?.getAttribute('src')).toContain(JPEG);
    expect(report.textContent).toContain('runs/live-1/01-search.png');

    /* The report saves as a PDF and as a Word document. */
    const saved: Blob[] = [];
    const createObjectURL = vi.fn((b: Blob) => (saved.push(b), 'blob:report'));
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    fireEvent.click(view.getAllByTestId('phone-live-download-pdf')[0]!);
    fireEvent.click(view.getAllByTestId('phone-live-download-docx')[0]!);
    expect(saved.map((b) => b.type)).toEqual(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);

    /* A new screen (a clear) drops the stale frame. */
    emit({ type: 'clear' });
    expect(view.queryByTestId('phone-live-frame')).toBeNull();
  });
});

describe('testing an app build', () => {
  it('runs the task\'s install command and sends the file only when the runner asks, as base64 lines', async () => {
    const INSTALL = '/w/bin/jm-install android';
    const view = render(<Strip d={task(`live-ask: /w/bin/jm-ask iphone\nlive-install: ${INSTALL}`)} />);
    fireEvent.click(view.getByTestId('tws-phone-live'));
    const bytes = new Uint8Array([80, 75, 3, 4, 1, 2, 3]);
    const file = new File([bytes], 'shop.apk', { type: 'application/vnd.android.package-archive' });
    fireEvent.change(view.getByTestId('phone-live-build-input'), { target: { files: [file] } });
    await waitFor(() => expect(view.getByTestId('fake-terminal').textContent).toBe('term-1'));
    expect(view.getByTestId('phone-live-android').getAttribute('aria-checked')).toBe('true');
    act(() => outputHandlers.forEach((h) => h('term-1', '$ ')));
    await waitFor(() => expect(sent).toEqual([`term-1:clear; ${INSTALL}\r`]));
    node.on = true;
    act(() => outputHandlers.forEach((h) => h('term-1', 'READY-FOR-BUILD\r\n')));
    await waitFor(() => expect(sent.at(-1)).toBe('term-1:END\r'), { timeout: 2000 });
    expect(sent[1]).toBe(`term-1:${b64({ name: 'shop.apk', size: 7, v: 2 })}\r`);
    expect(sent[2]).toBe(`term-1:0:${Buffer.from(bytes).toString('base64')}\r`);
    await waitFor(() => expect(view.getByTestId('phone-live-upload').getAttribute('data-phase')).toBe('done'));
  });

  const startBuild = async (bytes: Uint8Array) => {
    const view = render(<Strip d={task('live-ask: /w/bin/jm-ask iphone\nlive-install: /w/bin/jm-install android')} />);
    fireEvent.click(view.getByTestId('tws-phone-live'));
    fireEvent.change(view.getByTestId('phone-live-build-input'), { target: { files: [new File([bytes], 'big.apk')] } });
    await waitFor(() => expect(view.getByTestId('fake-terminal').textContent).toBe('term-1'));
    act(() => outputHandlers.forEach((h) => h('term-1', '$ ')));
    await waitFor(() => expect(sent).toHaveLength(1));
    node.on = true;
    act(() => outputHandlers.forEach((h) => h('term-1', 'READY-FOR-BUILD\r\n')));
    return view;
  };
  const keptBytes = () => Buffer.concat(node.kept.map((l) => Buffer.from(l, 'base64')));

  it('sends a big build only as fast as the test node confirms it, and tracks it live to the end', async () => {
    const bytes = new Uint8Array(700 * 1024).map((_, i) => i % 251);
    const view = await startBuild(bytes);
    await waitFor(() => expect(view.getByTestId('phone-live-sending').textContent).toMatch(/of 0\.7 MB · \d+% .*min left/));
    await waitFor(() => expect(sent.at(-1)).toBe('term-1:END\r'), { timeout: 25_000 });
    /* Every rolling second stays under 288 KB of input (the server closes the terminal past 512 KB). */
    const frames = sent.map((d, k) => ({ at: sentAt[k]!, bytes: d.length - 'term-1:'.length }));
    for (const f of frames) expect(frames.filter((g) => g.at > f.at - 1000 && g.at <= f.at).reduce((t, g) => t + g.bytes, 0)).toBeLessThanOrEqual(288 * 1024);
    expect(keptBytes()).toEqual(Buffer.from(bytes));
    await waitFor(() => expect(view.getByTestId('phone-live-upload').getAttribute('data-phase')).toBe('done'));
    expect(view.getByTestId('phone-live-upload-log').textContent).toMatch(/Saved on the test node/);
  }, 30_000);

  it('rides out a dropped connection: logs why, resumes from what the node kept, and finishes', async () => {
    const bytes = new Uint8Array(120 * 1024).map((_, i) => (i * 7) % 253);
    const view = await startBuild(bytes);
    await waitFor(() => expect(node.kept.length).toBeGreaterThan(8));
    /* The connection drops and takes the frame in flight with it. */
    node.lose = 1;
    lastClose = { code: 1008, reason: 'input limit exceeded', at: Date.now() };
    backlog = -1;
    await waitFor(() => expect(view.getByTestId('phone-live-upload').getAttribute('data-phase')).toBe('reconnecting'));
    expect(view.getByTestId('phone-live-upload-log').textContent).toMatch(/Connection dropped at .*input limit exceeded, code 1008/);
    backlog = 0;
    await waitFor(() => expect(sent.at(-1)).toBe('term-1:END\r'), { timeout: 25_000 });
    expect(keptBytes()).toEqual(Buffer.from(bytes));
    expect(view.getByTestId('phone-live-upload-log').textContent).toMatch(/Reconnected\. Resuming from/);
    await waitFor(() => expect(view.getByTestId('phone-live-upload').getAttribute('data-phase')).toBe('done'));
  }, 30_000);

  it('shows what the test node said when the build did not arrive, and offers to try again', async () => {
    node.said = '\x1b[31mThe build did not arrive: received 5 bytes, expected 9\x1b[0m\r\n';
    const view = await startBuild(new Uint8Array(9));
    await waitFor(() => expect(view.getByTestId('phone-live-upload').getAttribute('data-phase')).toBe('failed'));
    expect(view.getByTestId('phone-live-upload-log').textContent).toMatch(/The test node said: received 5 bytes, expected 9/);
    fireEvent.click(view.getByTestId('phone-live-upload-retry'));
    await waitFor(() => expect(view.queryByTestId('phone-live-upload')).toBeNull());
  });

  it('installs any app\'s build through the shared installer when its task names none, keyed by the task id', () => {
    expect(sharedInstallCommand('01a14085-4ebd-71f0-a2dd-869b744f2300')).toBe('/home/tm8/prod-data/phone-tools/bin/phone-install android app-869b744f2300');
    expect(sharedInstallCommand(null)).toBe('/home/tm8/prod-data/phone-tools/bin/phone-install android uploads');
    const view = render(<Strip d={task('live-ask: /w/bin/jm-ask iphone')} />);
    fireEvent.click(view.getByTestId('tws-phone-live'));
    expect(view.getByTestId('phone-live-build-input')).toBeTruthy();
    expect(document.body.textContent).toContain('phone-install android app-');
  });

  it('lists every app in the space and lets the viewer pick which one the phone tests', async () => {
    query.mockImplementation(async () => ({
      page: {
        items: [
          { id: 'app-a', title: 'Shop A', excerpt: 'live-ask: /w/bin/a-ask iphone' },
          { id: 'app-b', title: 'Game B', excerpt: 'live-app: acme/game' },
          { id: 'other', title: 'Not an app', excerpt: 'Nothing here.' },
        ],
      },
    }));
    const view = render(<Strip d={task('Some other task.')} />);
    fireEvent.click(view.getByTestId('tws-phone-live'));
    const pick = (await waitFor(() => view.getByTestId('phone-live-app-pick'))) as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toEqual(['Shop A', 'Game B', 'Another app (builds only)']);
    expect(pick.value).toBe('app-a');
    fireEvent.change(pick, { target: { value: 'app-b' } });
    expect(window.localStorage.getItem('tm8.phoneLive.appTask:space-phone')).toBe('app-b');
  });
});

describe('the website tester', () => {
  it('takes a GitHub repository in the forms people paste, and nothing else', () => {
    expect(normalizeRepo('https://github.com/acme/shop')).toBe('https://github.com/acme/shop');
    expect(normalizeRepo('github.com/acme/shop.git')).toBe('https://github.com/acme/shop');
    expect(normalizeRepo('acme/shop')).toBe('https://github.com/acme/shop');
    expect(normalizeRepo('https://github.com/acme/shop/tree/main/web')).toBe('https://github.com/acme/shop');
    expect(normalizeRepo('https://gitlab.com/acme/shop')).toBeNull();
    expect(normalizeRepo('acme/shop; rm -rf ~')).toBeNull();
    expect(normalizeRepo('https://github.com/../x')).toBeNull();
  });

  it('runs the task\'s live-web command and sends the repo and cases as one base64 line when asked', async () => {
    const WEB = '/w/bin/web-test';
    const view = render(<Strip d={task(`Websites.\nlive-web: ${WEB}`)} />);
    fireEvent.click(view.getByTestId('tws-web-test'));
    expect(view.getByTestId('web-test')).toBeTruthy();
    expect((view.getByTestId('web-test-explore') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(view.getByTestId('web-test-repo'), { target: { value: 'gitlab.com/x/y' } });
    expect(view.getByTestId('web-test-repo-bad')).toBeTruthy();
    fireEvent.change(view.getByTestId('web-test-repo'), { target: { value: 'acme/shop' } });
    fireEvent.change(view.getByTestId('web-test-ask'), { target: { value: 'Add to cart; $(reboot)' } });
    fireEvent.click(view.getByTestId('web-test-send'));
    await waitFor(() => expect(view.getByTestId('fake-terminal').textContent).toBe('term-1'));
    act(() => outputHandlers.forEach((h) => h('term-1', '$ ')));
    await waitFor(() => expect(sent).toEqual([`term-1:clear; ${WEB}\r`]));
    act(() => outputHandlers.forEach((h) => h('term-1', 'READY-FOR-CASES\r\n')));
    const line = b64({ repo: 'https://github.com/acme/shop', cases: 'Add to cart; $(reboot)' });
    await waitFor(() => expect(sent).toEqual([`term-1:clear; ${WEB}\r`, `term-1:${line}\r`]));
    expect(window.localStorage.getItem('tm8.webTest.repo')).toBe('https://github.com/acme/shop');
  });

  it('says so when the space has no website test task', () => {
    const view = render(<Strip d={task('Nothing.')} />);
    fireEvent.click(view.getByTestId('tws-web-test'));
    expect(view.getByTestId('web-test-none')).toBeTruthy();
  });
});
