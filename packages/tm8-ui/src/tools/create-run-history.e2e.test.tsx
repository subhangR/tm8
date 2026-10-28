// @vitest-environment jsdom
/**
 * PR-G: a human creates a tool, runs it from its page and reads the outcome in
 * the run history — through the fixture seam (createToolFixture), with the
 * page mounted the way the workspace mounts it: Run gets its session opener
 * from ToolLaunchProvider, not from an explicit prop.
 *
 * Depends on PR-A (ToolPort.create and the launch-provider wiring) and PR-B
 * (run history table). The create case is skipped until PR-A's port lands.
 * Runs list newest-first after PR-B; assertions sort explicitly by run id.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { EntityDetail, ToolDefinition, ToolRun, ToolView } from '@tm8/contract';
import { fixtureDetails, sessionStale } from '../fixtures';
import { ToolBody } from './ToolBody';
import { ToolLaunchProvider } from './context';
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

async function runFromPage(url: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Run' }));
  await waitFor(() => expect(screen.queryByText('Checking source changes…')).toBeNull());
  fireEvent.change(screen.getByRole('textbox', { name: 'url' }), { target: { value: url } });
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

  it('lists each finished run with its exit outcome, and a history row reopens its session', async () => {
    const fixture = createToolFixture(); const open = vi.fn();
    openPage(fixtureTool, fixture.port, open);
    await runFromPage('https://ok.example.test');
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    await runFromPage('https://missing.example.test');
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    const [first, second] = open.mock.calls.map(([id]) => id as string);
    fixture.finish(first!, 'exited', 0); fixture.finish(second!, 'exited', 1);

    const stored = byId((await fixture.port.history(fixtureTool.id)).items);
    expect(stored.map(run => [run.id, run.state, run.exitCode, run.inputs.url])).toEqual([
      [first, 'exited', 0, 'https://ok.example.test'], [second, 'exited', 1, 'https://missing.example.test']]);

    // Reopen the page: history is read on mount.
    cleanup(); open.mockClear(); openPage(fixtureTool, fixture.port, open);
    const history = await screen.findByRole('region', { name: 'Run history' });
    await waitFor(() => expect(within(history).getByText('Exited 0')).toBeTruthy());
    expect(within(history).getByText('Exited 1')).toBeTruthy();
    expect(within(history).queryByText('No runs yet.')).toBeNull();
    const rows = within(history).getAllByRole('button').filter(button => /· v1$/.test(button.textContent ?? ''));
    expect(rows).toHaveLength(2);
    rows.forEach(row => expect(row.hasAttribute('disabled')).toBe(false));
    fireEvent.click(rows[0]!);
    expect(open).toHaveBeenCalledTimes(1);
    expect([first, second]).toContain(open.mock.calls[0]![0]);
  });

  type CreatingPort = ToolPort & { create?(spaceId: string, definition: ToolDefinition): Promise<ToolView> };
  const creating = createToolFixture().port as CreatingPort;
  it.skipIf(typeof creating.create !== 'function')('creates a tool, runs it and reads it back in history (needs PR-A port.create)', async () => {
    const fixture = createToolFixture(); const port = fixture.port as CreatingPort; const open = vi.fn();
    const definition: ToolDefinition = { ...fixtureTool.definition, name: 'prg-created', description: 'Created by the PR-G e2e test.' };
    const created = await port.create!(fixtureTool.spaceId, definition);
    expect(created).toMatchObject({ version: 1, definition: { name: 'prg-created' } });
    openPage(created, port, open);
    await runFromPage('https://ok.example.test');
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const sessionId = open.mock.calls[0]![0] as string;
    fixture.finish(sessionId, 'exited', 0);
    const runs = byId((await port.history(created.id)).items);
    expect(runs.find(run => run.id === sessionId)).toMatchObject({ state: 'exited', exitCode: 0 });
    // TODO(PR-A merged): drive creation through the New-tab / Tools-list form instead of port.create.
    // TODO(PR-B merged): assert the run history table row, output drawer and last-run chip.
  });
});
