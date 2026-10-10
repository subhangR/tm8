// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EntityDetail } from '@tm8/contract';
import { fixtureDetails, sessionStale } from '../fixtures';
import { ToolBody } from './ToolBody';
import { RunDialog } from './RunDialog';
import { fixtureTool, createToolFixture } from './fixture';
import { UI_ACCESS_REFUSAL } from './values';

vi.mock('./SourceEditor', () => ({ SourceEditor: ({ value, onChange, readOnly }: { value: string; onChange(value: string): void; readOnly?: boolean }) => <textarea aria-label="Source" value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} /> }));
afterEach(cleanup);
const detail = { ...fixtureDetails[sessionStale.id]!, id: fixtureTool.id, version: fixtureTool.version, state: { kind: 'tool', name: fixtureTool.definition.name, runtime: 'bash', inputCount: 5, tm8Access: 'none' }, content: { kind: 'tool', definition: fixtureTool.definition } } as EntityDetail;

describe('tool definition and configuration', () => {
  it('saves Python source and an edited input definition through the versioned operation', async () => {
    const { port } = createToolFixture(); port.update = vi.fn(port.update);
    render(<ToolBody detail={detail} port={port} onOpenSession={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit tool' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Runtime' }), { target: { value: 'python' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Source' }), { target: { value: 'print("hello")\n' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Input 1 name' }), { target: { value: 'target' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tool' }));
    await waitFor(() => expect(port.update).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }), expect.objectContaining({ runtime: 'python', source: 'print("hello")\n', inputs: expect.arrayContaining([expect.objectContaining({ name: 'target', type: 'string' })]) })));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Tool definition' })).toBeNull());
  });
  it('stores typed configuration and clears a secret entry, showing only its key hint', async () => {
    const { port } = createToolFixture(); port.setConfig = vi.fn(port.setConfig); port.setSecret = vi.fn(port.setSecret);
    render(<ToolBody detail={detail} port={port} onOpenSession={vi.fn()} />);
    const limit = await screen.findByRole('spinbutton', { name: 'Configured limit' });
    fireEvent.change(limit, { target: { value: '7' } }); fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    await waitFor(() => expect(port.setConfig).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }), 'limit', 7));
    await waitFor(() => expect(screen.getByText('Version 2')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Set secret for token' }));
    const secret = 'private-token-abcd'; fireEvent.change(screen.getByLabelText('Secret for token'), { target: { value: secret } });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(() => expect(port.setSecret).toHaveBeenCalledWith(expect.objectContaining({ version: 2 }), 'token', secret));
    expect(await screen.findByText('Secret set · …abcd')).toBeTruthy();
    expect(screen.queryByDisplayValue(secret)).toBeNull(); expect(document.body.textContent).not.toContain(secret);
  });
  it('offers no secret write control to an agent', async () => {
    render(<ToolBody detail={detail} port={createToolFixture(fixtureTool, { setSecret: false }).port} />);
    expect(await screen.findByText('Only a human can set secrets.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set secret for token' })).toBeNull();
  });
});
describe('generated Run form', () => {
  it('prefills config and defaults, names a source editor, and opens a keep-open session', async () => {
    const { port } = createToolFixture(); port.run = vi.fn(port.run); port.sourceChange = vi.fn(async () => ({ changedBy: 'Ada' }));
    const open = vi.fn(), close = vi.fn(); render(<RunDialog tool={fixtureTool} port={port} onClose={close} onOpenSession={open} />);
    expect(await screen.findByText('Source changed since your last run, by Ada.')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'url' }) as HTMLInputElement).value).toBe('https://example.test');
    expect((screen.getByRole('spinbutton', { name: 'limit' }) as HTMLInputElement).value).toBe('20');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'limit' }), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run tool' }));
    await waitFor(() => expect(port.run).toHaveBeenCalledWith(expect.objectContaining({ keepOpen: true, inputs: { url: 'https://example.test', limit: 8, verbose: false, state: 'open' } })));
    await waitFor(() => expect(open).toHaveBeenCalledWith(expect.any(String))); expect(close).toHaveBeenCalled();
  });
  it.each(['read', 'write'] as const)('refuses %s API access with an explanation and makes no run request', async tm8Access => {
    const { port } = createToolFixture(); port.run = vi.fn(port.run);
    render(<RunDialog tool={{ ...fixtureTool, definition: { ...fixtureTool.definition, tm8Access } }} port={port} onClose={vi.fn()} onOpenSession={vi.fn()} />);
    expect(screen.getByText(UI_ACCESS_REFUSAL)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Checking source changes…')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Run tool' })); expect(port.run).not.toHaveBeenCalled();
  });
  it('refuses a missing required secret, without sending input values', async () => {
    const tool = structuredClone(fixtureTool); tool.definition.inputs.find(input => input.name === 'token')!.required = true;
    const { port } = createToolFixture(tool); port.run = vi.fn(port.run);
    render(<RunDialog tool={tool} port={port} onClose={vi.fn()} onOpenSession={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('Checking source changes…')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Run tool' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'token: set a secret or provide one for this run.'); expect(port.run).not.toHaveBeenCalled();
  });
  it('clears an ephemeral secret and uses the separate request field without storing it', async () => {
    const { port } = createToolFixture(); port.run = vi.fn(port.run);
    render(<RunDialog tool={fixtureTool} port={port} onClose={vi.fn()} onOpenSession={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('Checking source changes…')).toBeNull());
    fireEvent.change(screen.getByLabelText('token'), { target: { value: 'one-run-secret' } }); fireEvent.click(screen.getByRole('button', { name: 'Run tool' }));
    await waitFor(() => expect(port.run).toHaveBeenCalledWith(expect.objectContaining({ secrets: { token: 'one-run-secret' }, inputs: expect.not.objectContaining({ token: expect.anything() }) })));
    expect(screen.queryByDisplayValue('one-run-secret')).toBeNull();
    const [request] = (port.run as ReturnType<typeof vi.fn>).mock.calls[0]!; const run = await port.runGet((await port.run(request)).sessionId); expect(JSON.stringify(run)).not.toContain('one-run-secret');
  });
  it('blocks launch if the source-change check fails', async () => {
    const { port } = createToolFixture(); port.sourceChange = vi.fn(async () => { throw new Error('source changed'); }); port.run = vi.fn(port.run);
    render(<RunDialog tool={fixtureTool} port={port} onClose={vi.fn()} onOpenSession={vi.fn()} />);
    await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: 'Run tool' })); expect(port.run).not.toHaveBeenCalled();
  });
});
