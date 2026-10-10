// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { EntityDetail, ToolRun } from '@tm8/contract';
import { fixtureDetails, sessionStale } from '../fixtures';
import { TerminalBody } from '../panels/bodies/TerminalBody';
import { fixtureTool } from './fixture';
import { toolTabCloseEffect } from './close-tabs';
import type { EffectEvent, WorkspaceState } from '../tab-workspace/runtime/types';

vi.mock('../terminal/LiveTerminal', () => ({ LiveTerminal: ({ sessionId, live }: { sessionId: string; live: boolean }) => <textarea aria-label="Interactive shell" data-session-id={sessionId} data-live={live} /> }));
vi.mock('../terminal/liveTerminalFlag', () => ({ isLiveTerminalEnabled: () => true }));
afterEach(cleanup);
const run: ToolRun = { id: sessionStale.id, spaceId: fixtureTool.spaceId, toolId: fixtureTool.id, toolVersion: 1, sourceSha256: fixtureTool.sourceSha256, inputs: {}, state: 'running', keepOpen: true, exitCode: null, startedAt: '2026-10-10T12:00:00Z', exitedAt: null, outputTail: '', parentSessionId: null };
function detailWith(next: ToolRun): EntityDetail {
  const original = fixtureDetails[sessionStale.id]!;
  if (original.state.kind !== 'work_session') throw new Error('Expected session fixture');
  return { ...original, state: { ...original.state, sessionKind: 'tool', status: 'running', toolRun: next } };
}
describe('tool result is separate from terminal liveness', () => {
  it.each([['exited', 0, 'Exited 0'], ['exited', 3, 'Exited 3'], ['timed_out', null, 'Timed out'], ['killed', null, 'Killed']] as const)('keeps the same interactive shell after %s %s', (state, exitCode, label) => {
    const rendered = render(<TerminalBody detail={detailWith(run)} liveness="live" />);
    const shell = screen.getByRole('textbox', { name: 'Interactive shell' });
    fireEvent.change(shell, { target: { value: 'pwd\n' } });
    rendered.rerender(<TerminalBody detail={detailWith({ ...run, state, exitCode })} liveness="live" />);
    expect(screen.getByText(label)).toBeTruthy(); expect(screen.getByRole('textbox', { name: 'Interactive shell' })).toBe(shell);
    expect((shell as HTMLTextAreaElement).value).toBe('pwd\n');
    expect(screen.getByText('The shell stays open until you close this tab.')).toBeTruthy();
  });
});
describe('explicit tool tab closure', () => {
  const tab = { id: 'tab', type: 'entity', entityId: run.id, kind: 'work_session' };
  const event = (source: EffectEvent['env']['source'], next: Record<string, unknown> = {}): EffectEvent => ({ env: { command: 'workspace.tabs.close', args: { tabId: 'tab' }, source }, prev: { tabs: { tab } } as unknown as WorkspaceState, next: { tabs: next } as unknown as WorkspaceState } as EffectEvent);
  it('terminates a live keep-open shell when its last tab closes, including after a tool exit', () => {
    const terminate = vi.fn(async () => {});
    const effect = toolTabCloseEffect({ detailOf: () => detailWith({ ...run, state: 'exited', exitCode: 0 }), terminate, onError: vi.fn() });
    effect(event('click')); expect(terminate).toHaveBeenCalledWith(run.id);
  });
  it('does not terminate on a system view change, if another tab remains, or for a normal session', () => {
    const terminate = vi.fn(async () => {});
    const effect = toolTabCloseEffect({ detailOf: () => detailWith(run), terminate, onError: vi.fn() });
    effect(event('system')); effect(event('click', { other: { ...tab, id: 'other' } }));
    toolTabCloseEffect({ detailOf: () => fixtureDetails[sessionStale.id]!, terminate, onError: vi.fn() })(event('click'));
    expect(terminate).not.toHaveBeenCalled();
  });
  it('reports a failed termination so the user can reopen and stop the session', async () => {
    const error = new Error('permission denied'), onError = vi.fn();
    toolTabCloseEffect({ detailOf: () => detailWith(run), terminate: async () => { throw error; }, onError })(event('click'));
    await Promise.resolve(); expect(onError).toHaveBeenCalledWith(error);
  });
});
