// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CollabError, type EntityDetail, type ToolRun } from '@tm8/contract';
import { fixtureDetails, sessionStale } from '../fixtures';
import { ToolBody } from './ToolBody';
import { RUN_POLL_MS, RunHistory, useToolRuns } from './RunHistory';
import { createToolFixture, fixtureTool } from './fixture';
import type { ToolPort } from './port';

vi.mock('./SourceEditor', () => ({ SourceEditor: ({ value }: { value: string }) => <textarea aria-label="Source" value={value} readOnly /> }));
afterEach(cleanup);
const detail = { ...fixtureDetails[sessionStale.id]!, id: fixtureTool.id, version: fixtureTool.version, state: { kind: 'tool', name: fixtureTool.definition.name, runtime: 'bash', inputCount: 5, tm8Access: 'none' }, content: { kind: 'tool', definition: fixtureTool.definition } } as EntityDetail;

const ada = { id: '00000000-0000-4000-8000-0000000000a1', kind: 'member' as const, displayName: 'Ada', isAgent: false };
const scout = { id: '00000000-0000-4000-8000-0000000000a2', kind: 'member' as const, displayName: 'Scout', isAgent: true };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function run(overrides: Partial<ToolRun> & { id: string }): ToolRun {
  return { spaceId: fixtureTool.spaceId, toolId: fixtureTool.id, toolVersion: 1, sourceSha256: 'a'.repeat(64), inputs: {}, state: 'exited', keepOpen: false, exitCode: 0,
    startedAt: '2026-10-10T12:00:00Z', exitedAt: '2026-10-10T12:00:03Z', outputTail: '', parentSessionId: null, invoker: ada, triggeredBy: null, ...overrides };
}
type Page = { items: ToolRun[]; nextCursor: string | null };
/** The fixture port, answering history from fixed pages keyed by cursor. */
function historyPort(pages: Record<string, Page>): ToolPort {
  const { port } = createToolFixture();
  port.history = vi.fn(async (_toolId: string, cursor?: string | null) => structuredClone(pages[cursor ?? 'first']!));
  return port;
}
/** The page's hook and table alone, without the rest of the tool page. */
function Harness({ port, onOpenSession, onOutput = () => {}, onVersion }: { port: ToolPort; onOpenSession?: (id: string) => void; onOutput?(run: ToolRun): void; onVersion?(run: ToolRun): void }) {
  const runs = useToolRuns(port, fixtureTool.id, 0);
  return <RunHistory runs={runs} onOpenSession={onOpenSession} onOutput={onOutput} onVersion={onVersion} />;
}
const bodyRows = (region: HTMLElement) => within(region).getAllByRole('row').slice(1);

describe('run history table', () => {
  it('shows started, duration, result, invoker, version and keep-open per run, labelling human, agent and loop invokers', async () => {
    const port = historyPort({ first: { items: [
      run({ id: id(13), triggeredBy: { id: id(90), title: 'Nightly check' } }),
      run({ id: id(12), parentSessionId: id(80), invoker: scout, exitCode: 1 }),
      run({ id: id(11), keepOpen: true, startedAt: '2026-10-10T12:00:00Z', exitedAt: '2026-10-10T12:03:04Z' }),
    ], nextCursor: null } });
    render(<Harness port={port} onOpenSession={vi.fn()} onVersion={vi.fn()} />);
    const region = await screen.findByRole('region', { name: 'Run history' });
    expect(within(region).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Started', 'Duration', 'Result', 'Invoker', 'Version', 'Keep open', 'Actions']);
    const rows = bodyRows(region);
    expect(rows.map(row => row.getAttribute('data-run-id'))).toEqual([id(13), id(12), id(11)]);
    expect(within(rows[0]!).getByText('Loop · Nightly check').closest('td')?.getAttribute('data-invoker')).toBe('loop');
    expect(within(rows[1]!).getByText('Agent · Scout').closest('td')?.getAttribute('data-invoker')).toBe('agent');
    expect(within(rows[2]!).getByText('Ada').closest('td')?.getAttribute('data-invoker')).toBe('human');
    expect(within(rows[0]!).getByText('3s')).toBeTruthy();
    expect(within(rows[2]!).getByText('3m 4s')).toBeTruthy();
    expect(within(rows[0]!).getByText('Exited 0')).toBeTruthy();
    expect(within(rows[1]!).getByText('Exited 1')).toBeTruthy();
    expect(within(rows[0]!).getByRole('button', { name: 'v1' }).title).toBe('Show version 1 in Versions');
    expect(within(rows[0]!).getByText('aaaaaaaa').title).toBe(`source sha256 ${'a'.repeat(64)}`);
    expect(within(rows[0]!).getAllByRole('cell')[5]!.textContent).toBe('No');
    expect(within(rows[2]!).getAllByRole('cell')[5]!.textContent).toBe('Yes');
    expect(within(rows[0]!).getByRole('time').getAttribute('datetime')).toBe('2026-10-10T12:00:00.000Z');
  });
  it('opens a run’s terminal and its output from the row, and pages older runs on request only', async () => {
    const port = historyPort({ first: { items: [run({ id: id(12) }), run({ id: id(11) })], nextCursor: 'older' }, older: { items: [run({ id: id(10) })], nextCursor: null } });
    const open = vi.fn(), output = vi.fn();
    render(<Harness port={port} onOpenSession={open} onOutput={output} />);
    const region = await screen.findByRole('region', { name: 'Run history' });
    fireEvent.click(within(bodyRows(region)[0]!).getByRole('button', { name: /^Open terminal for/ }));
    expect(open).toHaveBeenCalledWith(id(12));
    fireEvent.click(within(bodyRows(region)[1]!).getByRole('button', { name: /^Output of/ }));
    expect(output).toHaveBeenCalledWith(expect.objectContaining({ id: id(11) }));
    expect(port.history).toHaveBeenCalledTimes(1);
    fireEvent.click(within(region).getByRole('button', { name: 'More runs' }));
    await waitFor(() => expect(bodyRows(region)).toHaveLength(3));
    expect(port.history).toHaveBeenLastCalledWith(fixtureTool.id, 'older');
    expect(bodyRows(region)[2]!.getAttribute('data-run-id')).toBe(id(10));
    expect(within(region).queryByRole('button', { name: 'More runs' })).toBeNull();
  });
  it('keeps Open terminal disabled without a terminal host and says why', async () => {
    render(<Harness port={historyPort({ first: { items: [run({ id: id(11) })], nextCursor: null } })} />);
    const button = await screen.findByRole('button', { name: /^Open terminal for/ });
    expect(button).toHaveProperty('disabled', true);
    expect(button.title).toBe('A terminal host is unavailable in this view.');
  });
  it('polls a running row until its outcome lands', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const running = run({ id: id(11), state: 'running', exitCode: null, exitedAt: null });
      const port = historyPort({ first: { items: [running], nextCursor: null } });
      port.runGet = vi.fn(async () => ({ ...running, state: 'exited' as const, exitCode: 0, exitedAt: '2026-10-10T12:00:03Z' }));
      render(<Harness port={port} />);
      await screen.findByText('Running');
      vi.advanceTimersByTime(RUN_POLL_MS);
      await screen.findByText('Exited 0');
      expect(port.runGet).toHaveBeenCalledWith(id(11));
    } finally { vi.useRealTimers(); }
  });
  it('shows a history failure in the server’s words with its code, and retries', async () => {
    const { port } = createToolFixture();
    port.history = vi.fn(async () => { throw new CollabError('forbidden', 'You may not read this tool.'); });
    render(<Harness port={port} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load. You may not read this tool.');
    expect(alert.textContent).toContain('forbidden');
    fireEvent.click(screen.getByRole('button', { name: 'Retry history' }));
    await waitFor(() => expect(port.history).toHaveBeenCalledTimes(2));
  });
});

describe('tool page: last run and output', () => {
  const launch = (port: ToolPort, clientMutationId: string) => port.run({ toolId: fixtureTool.id, expectedVersion: 1, clientMutationId, keepOpen: true, inputs: { url: 'https://example.test' } });
  it('says Never run before the first run', async () => {
    render(<ToolBody detail={detail} port={createToolFixture().port} onOpenSession={vi.fn()} />);
    expect((await screen.findByTestId('tool-last-run')).textContent).toBe('Never run');
  });
  it('shows the newest run as the last-run chip, opens it, and the Output drawer shows the saved, redacted tail', async () => {
    const fixture = createToolFixture(); const { port } = fixture;
    const first = await launch(port, 'first'); fixture.finish(first.sessionId, 'exited', 0, 'OK 200 https://example.test\n');
    const second = await launch(port, 'second'); fixture.finish(second.sessionId, 'exited', 1, 'curl: (22) [credential-redacted]\n');
    const open = vi.fn();
    render(<ToolBody detail={detail} port={port} onOpenSession={open} />);
    const chip = await screen.findByTestId('tool-last-run');
    await waitFor(() => expect(chip.textContent).toContain('Exited 1'));
    expect(chip.textContent).toContain('Last run');
    fireEvent.click(chip);
    expect(open).toHaveBeenCalledWith(second.sessionId);
    const region = screen.getByRole('region', { name: 'Run history' });
    await waitFor(() => expect(bodyRows(region).map(row => row.getAttribute('data-run-id'))).toEqual([second.sessionId, first.sessionId]));
    fireEvent.click(within(bodyRows(region)[0]!).getByRole('button', { name: /^Output of/ }));
    const drawer = await screen.findByRole('dialog', { name: 'Run output' });
    expect((await within(drawer).findByLabelText('Saved output')).textContent).toBe('curl: (22) [credential-redacted]\n');
    expect(within(drawer).getByText('Exited 1')).toBeTruthy();
    expect(within(drawer).getByText('v1')).toBeTruthy();
    expect(within(drawer).getByText('a'.repeat(64))).toBeTruthy();
    expect(within(drawer).getByText(/The last 64 KiB, with secrets redacted/)).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Open terminal' }));
    expect(open).toHaveBeenLastCalledWith(second.sessionId);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Run output' })).toBeNull());
  });
  it('tells the reader a running run has no saved output yet and offers the terminal', async () => {
    const fixture = createToolFixture(); const { port } = fixture;
    const started = await launch(port, 'running');
    render(<ToolBody detail={detail} port={port} onOpenSession={vi.fn()} />);
    const region = await screen.findByRole('region', { name: 'Run history' });
    await waitFor(() => expect(bodyRows(region)).toHaveLength(1));
    fireEvent.click(within(region).getByRole('button', { name: /^Output of/ }));
    const drawer = await screen.findByRole('dialog', { name: 'Run output' });
    expect((await within(drawer).findByRole('status')).textContent).toContain('This run is still going.');
    expect(within(drawer).queryByLabelText('Saved output')).toBeNull();
    fixture.finish(started.sessionId, 'exited', 0, 'done\n');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Refresh' }));
    expect((await within(drawer).findByLabelText('Saved output')).textContent).toBe('done\n');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Run output' })).toBeNull());
  });
  it('opens the last run in the output drawer when no terminal host is available', async () => {
    const fixture = createToolFixture(); const { port } = fixture;
    const only = await launch(port, 'only'); fixture.finish(only.sessionId, 'timed_out', null, 'slow\n');
    render(<ToolBody detail={detail} port={port} />);
    const chip = await screen.findByTestId('tool-last-run');
    await waitFor(() => expect(chip.textContent).toContain('Timed out'));
    fireEvent.click(chip);
    const drawer = await screen.findByRole('dialog', { name: 'Run output' });
    expect((await within(drawer).findByLabelText('Saved output')).textContent).toBe('slow\n');
    expect(within(drawer).queryByRole('button', { name: 'Open terminal' })).toBeNull();
  });
});
