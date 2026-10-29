// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CollabError, type EntityDetail } from '@tm8/contract';
import { fixtureDetails, sessionStale } from '../fixtures';
import { ToolBody } from './ToolBody';
import { RunDialog } from './RunDialog';
import { createToolFixture, fixtureTool } from './fixture';
import { toolErrorOf } from './errors';

vi.mock('./SourceEditor', () => ({ SourceEditor: ({ value }: { value: string }) => <textarea aria-label="Source" value={value} readOnly /> }));
afterEach(cleanup);
const detail = { ...fixtureDetails[sessionStale.id]!, id: fixtureTool.id, version: fixtureTool.version, state: { kind: 'tool', name: fixtureTool.definition.name, runtime: 'bash', inputCount: 5, tm8Access: 'none' }, content: { kind: 'tool', definition: fixtureTool.definition } } as EntityDetail;
const settled = () => waitFor(() => expect(screen.queryByText('Checking source changes…')).toBeNull());

describe('run dialog refusals', () => {
  it.each([
    ['limit_exceeded', 'Tool session cap reached.', 'Tool sessions are capped at 8 live per member; close a keep-open shell with session terminate and retry.'],
    ['invalid_input', 'Check the inputs.', 'Missing required inputs: repo, key'],
    ['forbidden', 'Not allowed.', 'Tool credential is unavailable to this invoker'],
    ['upstream_unavailable', 'The tool could not start.', 'Tool launch failed'],
    ['version_conflict', 'The tool changed.', 'Tool version 1 is stale; reload and run version 2'],
  ] as const)('shows the server’s %s message verbatim with its code', async (code, title, message) => {
    const { port } = createToolFixture();
    port.run = vi.fn(async () => { throw new CollabError(code, message); });
    const onRunError = vi.fn(), open = vi.fn(), close = vi.fn();
    render(<RunDialog tool={fixtureTool} port={port} onClose={close} onOpenSession={open} onRunError={onRunError} />);
    await settled();
    fireEvent.click(screen.getByRole('button', { name: 'Run tool' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(`${title} ${message} ${code}`);
    expect(open).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    expect(onRunError).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Run tool' })).toHaveProperty('disabled', false);
  });
  it('falls back to a plain title for a failure without a taxonomy code, keeping its message', async () => {
    const { port } = createToolFixture();
    port.run = vi.fn(async () => { throw new Error('socket hang up'); });
    render(<RunDialog tool={fixtureTool} port={port} onClose={vi.fn()} onOpenSession={vi.fn()} />);
    await settled();
    fireEvent.click(screen.getByRole('button', { name: 'Run tool' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The run was refused. socket hang up');
  });
});

describe('configuration refusals', () => {
  it('shows a config refusal in the server’s words with its code', async () => {
    const { port } = createToolFixture();
    port.setConfig = vi.fn(async () => { throw new CollabError('invalid_input', 'limit: maximum 200'); });
    render(<ToolBody detail={detail} port={port} onOpenSession={vi.fn()} />);
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'Configured limit' }), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That value was refused. limit: maximum 200 invalid_input');
  });
  it('shows a secret refusal with its code and never the typed value, even when the message echoes it', async () => {
    const { port } = createToolFixture();
    const secret = 'private-token-abcd';
    port.setSecret = vi.fn(async () => { throw new CollabError('forbidden', `Credential ${secret} may not be bound by this account`); });
    render(<ToolBody detail={detail} port={port} onOpenSession={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set secret for token' }));
    fireEvent.change(screen.getByLabelText('Secret for token'), { target: { value: secret } });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The secret was not changed. Credential •••• may not be bound by this account forbidden');
    expect(document.body.textContent).not.toContain(secret);
    expect(screen.queryByDisplayValue(secret)).toBeNull();
  });
  it('maps the failure once, outside any component', () => {
    expect(toolErrorOf(new CollabError('limit_exceeded', 'cap'), 'run')).toEqual({ code: 'limit_exceeded', title: 'Tool session cap reached.', message: 'cap' });
    expect(toolErrorOf(new CollabError('not_found', 'gone'), 'config')).toEqual({ code: 'not_found', title: 'Configuration could not be saved.', message: 'gone' });
    expect(toolErrorOf('weird', 'load')).toEqual({ code: null, title: 'Could not load.', message: 'The request could not be completed.' });
    expect(toolErrorOf(new Error('value s3cret leaked'), 'secret', 's3cret').message).toBe('value •••• leaked');
  });
});
