// @vitest-environment jsdom
/**
 * PR-G: a human creates a tool, runs it from its page and reads the outcome in
 * the run history — through the fixture seam (createToolFixture), with the
 * page mounted the way the workspace mounts it: Run gets its session opener
 * from ToolLaunchProvider, not from an explicit prop.
 *
 * Depends on PR-A (ToolPort.create, the launch-provider mount) and PR-B (run
 * history table, output drawer). Runs list newest-first; assertions sort
 * explicitly by run id.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toolStarterNamed, type EntityDetail, type ToolRun, type ToolView } from '@tm8/contract';
import { fixtureDetails, sessionStale } from '../fixtures';
import { ToolBody } from './ToolBody';
import { ToolLaunchProvider } from './context';
import { ToolCreateControl } from './ToolCreateControl';
import { createToolFixture, fixtureTool } from './fixture';
import type { ToolPort } from './port';

vi.mock('./SourceEditor', () => ({ SourceEditor: ({ value, onChange, readOnly }: { value: string; onChange(value: string): void; readOnly?: boolean }) => <textarea aria-label="Source" value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} /> }));
afterEach(cleanup);

const detailFor = (tool: ToolView) => ({ ...fixtureDetails[sessionStale.id]!, id: tool.id, version: tool.version,
  state: { kind: 'tool', name: tool.definition.name, runtime: tool.definition.runtime, inputCount: tool.definition.inputs.length, tm8Access: tool.definition.tm8Access },
  content: { kind: 'tool', definition: tool.definition } }) as EntityDetail;
const byId = (runs: ToolRun[]) => [...runs].sort((a, b) => a.id.localeCompare(b.id));
const openPage = (tool: ToolView, port: ToolPort, open: (id: string) => void) =>
  render(<ToolLaunchProvider open={open}><ToolBody detail={detailFor(tool)} port={port} /></ToolLaunchProvider>);

async function runFromPage(value: string, input = 'url') {
  fireEvent.click(await screen.findByRole('button', { name: 'Run' }));
  await waitFor(() => expect(screen.queryByText('Checking source changes…')).toBeNull());
  fireEvent.change(screen.getByRole('textbox', { name: input }), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Run tool' }));
}

describe('tool page run → history (workspace-mounted)', () => {
  it('enables Run from the launch provider alone and opens the keep-open session', async () => {
    const { port } = createToolFixture(); port.run = vi.fn(port.run); const open = vi.fn();
    openPage(fixtureTool, port, open);
    const run = await screen.findByRole('button', { name: 'Run' });
    expect(run.hasAttribute('disabled')).toBe(false);
    expect(run.getAttribute('title')).not.toBe('A terminal host is unavailable in this view.');
    await runFromPage('https://ok.example.test');
    await waitFor(() => expect(port.run).toHaveBeenCalledWith(expect.objectContaining({ toolId: fixtureTool.id, expectedVersion: fixtureTool.version, keepOpen: true, inputs: expect.objectContaining({ url: 'https://ok.example.test' }) })));
    await waitFor(() => expect(open).toHaveBeenCalledWith(expect.any(String)));
  });

  it('lists each finished run with its exit outcome; a row reopens its session and shows its saved output', async () => {
    const fixture = createToolFixture(); const open = vi.fn();
    openPage(fixtureTool, fixture.port, open);
    await runFromPage('https://ok.example.test');
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    await runFromPage('https://missing.example.test');
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    const [first, second] = open.mock.calls.map(([id]) => id as string);
    fixture.finish(first!, 'exited', 0, 'OK 200 https://ok.example.test\r\n'); fixture.finish(second!, 'exited', 1, 'FAIL 404 https://missing.example.test\r\n');

    const stored = byId((await fixture.port.history(fixtureTool.id)).items);
    expect(stored.map(run => [run.id, run.state, run.exitCode, run.inputs.url])).toEqual([
      [first, 'exited', 0, 'https://ok.example.test'], [second, 'exited', 1, 'https://missing.example.test']]);

    // Reopen the page: history is read on mount, newest first.
    cleanup(); open.mockClear(); openPage(fixtureTool, fixture.port, open);
    const history = await screen.findByRole('region', { name: 'Run history' });
    await waitFor(() => expect(within(history).getByText('Exited 0')).toBeTruthy());
    expect(within(history).getByText('Exited 1')).toBeTruthy();
    expect(within(history).queryByText('No runs yet.')).toBeNull();
    const rows = within(history).getAllByRole('row').slice(1);
    expect(rows.map(row => row.getAttribute('data-run-id'))).toEqual([second, first]);

    const terminals = within(history).getAllByRole('button', { name: /^Open terminal for / });
    expect(terminals).toHaveLength(2);
    terminals.forEach(button => expect(button.hasAttribute('disabled')).toBe(false));
    fireEvent.click(within(rows[1]!).getByRole('button', { name: /^Open terminal for / }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(first);

    // The output drawer reads the tail of the run it was opened for, fresh.
    fireEvent.click(within(rows[0]!).getByRole('button', { name: /^Output of / }));
    const drawer = await screen.findByRole('dialog', { name: 'Run output' });
    await waitFor(() => expect(within(drawer).getByLabelText('Saved output').textContent).toContain('FAIL 404 https://missing.example.test'));
    expect(within(drawer).getByText('Exited 1')).toBeTruthy();
  });

  it('creates a tool from a starter in the New tool form, runs it and reads it back in history', async () => {
    const fixture = createToolFixture(); const port = fixture.port; port.create = vi.fn(port.create);
    const onCreated = vi.fn(); const open = vi.fn();
    const starter = toolStarterNamed('url-check')!;
    render(<ToolCreateControl spaceId={fixtureTool.spaceId} port={port} label="New tool" onCreated={onCreated} />);
    fireEvent.click(screen.getByRole('button', { name: 'New tool' }));
    const dialog = screen.getByRole('dialog', { name: 'New tool' });
    fireEvent.change(within(dialog).getByLabelText('Start from a starter'), { target: { value: 'url-check' } });
    // The starter fills the form; the fixture's space already holds a url-check, so this copy gets its own name.
    expect((within(dialog).getByLabelText('Source') as HTMLTextAreaElement).value).toBe(starter.source);
    fireEvent.change(within(dialog).getByLabelText('Name', { exact: true }), { target: { value: 'site-check' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create tool' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(port.create).toHaveBeenCalledWith(fixtureTool.spaceId, expect.objectContaining({ name: 'site-check', runtime: 'bash', source: starter.source }));
    const created = (onCreated.mock.calls[0]![0] as { tool: ToolView }).tool;
    expect(created).toMatchObject({ version: 1, definition: { name: 'site-check' } });

    cleanup(); openPage(created, port, open);
    await runFromPage('https://ok.example.test', 'urls');
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const sessionId = open.mock.calls[0]![0] as string;
    fixture.finish(sessionId, 'exited', 0, 'OK 200 https://ok.example.test\r\n');
    expect(byId((await port.history(created.id)).items).find(run => run.id === sessionId)).toMatchObject({ state: 'exited', exitCode: 0, inputs: expect.objectContaining({ urls: 'https://ok.example.test' }) });

    cleanup(); open.mockClear(); openPage(created, port, open);
    const history = await screen.findByRole('region', { name: 'Run history' });
    await waitFor(() => expect(within(history).getByText('Exited 0')).toBeTruthy());
    expect(within(history).getAllByRole('button', { name: /^Open terminal for / })).toHaveLength(1);
  });
});
