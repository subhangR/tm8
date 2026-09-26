// @vitest-environment jsdom
/**
 * WHICH TOOL CALLS A TURN SHOWS, AND WHEN — one test per rule R1–R8 of doc
 * 01a0ddb5 (task 01a0ddad), as Subhang signed them off: one header per
 * turn (R2), one toggle for every run (R3), only the current run open while
 * live (R4), no failure ever counted as recovered (R5), identical failures
 * folded (R6), a turn-ending failure always on screen (R7), no ids in a
 * reason (R8).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { TurnParts } from './TurnParts';
import { toolStepError } from './turn-steps';
import type { ChatTurnPart } from './types';

afterEach(cleanup);

const TASK = '019f0000-0000-7000-8000-0000000000a1';
const MEMBER = '01a06301-ea31-75e5-913c-22df253ae11a';

/** A tool call as the runtime stores it. `outcome` omitted ⇒ still running. */
function call(
  seq: number,
  id: string,
  name: string,
  args: unknown,
  outcome?: { result: unknown; isError?: boolean },
): ChatTurnPart[] {
  const parts: ChatTurnPart[] = [{ seq, kind: 'tool_call', toolCallId: id, name, args, state: 'running' }];
  if (!outcome) return parts;
  return [
    ...parts,
    { seq: seq + 1, kind: 'tool_result', toolCallId: id, content: outcome.result, ...(outcome.isError ? { isError: true } : {}) },
    { seq: seq + 2, kind: 'tool_call', toolCallId: id, name, args, state: outcome.isError ? 'error' : 'completed' },
  ];
}

const bash = (seq: number, id: string, command: string, outcome?: { result: unknown; isError?: boolean }) =>
  call(seq, id, 'Bash', { command, description: `Run ${command}` }, outcome);

/** Three runs split by the agent's text; `live` leaves the last call running. */
function threeRuns(live: boolean): ChatTurnPart[] {
  return [
    ...bash(0, 'a1', 'a', { result: 'ok' }),
    ...bash(3, 'a2', 'b', { result: 'ok' }),
    { seq: 6, kind: 'text', text: 'First look done.' },
    ...bash(7, 'b1', 'c', { result: 'ok' }),
    { seq: 10, kind: 'text', text: 'Checking one more thing.' },
    ...(live
      ? bash(11, 'c1', 'd')
      : [...bash(11, 'c1', 'd', { result: 'ok' }), { seq: 14, kind: 'text' as const, text: 'Done.' }, { seq: 15, kind: 'done' as const }]),
  ];
}

const heads = (root: HTMLElement) => within(root).queryAllByTestId('chat-steps-head');
const stepLines = (root: HTMLElement) => within(root).queryAllByTestId('chat-step-line');
const errlines = (root: HTMLElement) => within(root).queryAllByTestId('chat-step-errline').map((el) => el.textContent);

describe('R1 · outcomes are always visible', () => {
  it('keeps a created card on screen when the settled turn folds its steps', () => {
    const view = render(
      <TurnParts
        parts={[
          ...call(0, 'w1', 'mcp__tm8__tm8_act', { operation: 'entities.create', body: { kind: 'task', title: 'Ship it' } }, {
            result: { entity: { id: TASK, kind: 'task', title: 'Ship it' } },
          }),
          { seq: 3, kind: 'done' },
        ]}
      />,
    );
    expect(heads(view.container)[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('.tch-ledger')?.textContent).toContain('Ship it');
  });
});

describe('R2 · one summary line per settled turn', () => {
  it('folds every run into ONE header on the first run, counting them all', () => {
    const view = render(<TurnParts parts={threeRuns(false)} />);
    const [head, ...rest] = heads(view.container);
    expect(rest).toHaveLength(0);
    expect(head!.getAttribute('aria-expanded')).toBe('false');
    expect(head!.textContent).toMatch(/^4 steps · ran 4 commands/);
    expect(view.getAllByTestId('chat-steps')[0]!.contains(head!)).toBe(true);
    expect(stepLines(view.container)).toHaveLength(0);
  });
});

describe('R3 · one affordance per turn', () => {
  it('opens every run’s list with one press, and closes them all with the next', () => {
    const view = render(<TurnParts parts={threeRuns(false)} />);
    const head = view.getByTestId('chat-steps-head');
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    const runs = view.getAllByTestId('chat-steps');
    expect(runs.map((run) => stepLines(run).length > 0)).toEqual([true, true, true]);
    fireEvent.click(head);
    expect(stepLines(view.container)).toHaveLength(0);
  });
});

describe('R4 · while live, only the current run is open', () => {
  it('folds the runs the agent wrote past into the header and keeps the current one open', () => {
    const view = render(<TurnParts parts={threeRuns(true)} />);
    expect(heads(view.container)).toHaveLength(1);
    expect(view.getByTestId('chat-steps-head').textContent).toMatch(/^4 steps/);
    const runs = view.getAllByTestId('chat-steps');
    const last = runs[runs.length - 1]!;
    expect(stepLines(last).at(-1)?.dataset.state).toBe('running');
    // Only the current run draws step lines.
    expect(stepLines(view.container).every((line) => last.contains(line))).toBe(true);
  });
});

describe('R5 · no failure counts as recovered (signed off: "never")', () => {
  it('keeps the red line of a failure the next call retried, and counts it', () => {
    const view = render(
      <TurnParts
        parts={[
          ...bash(0, 'c1', 'bun test', { result: 'Exit code 1', isError: true }),
          ...bash(3, 'c2', 'bun test', { result: 'ok' }),
          { seq: 6, kind: 'text', text: 'Green now.' },
          { seq: 7, kind: 'done' },
        ]}
      />,
    );
    expect(errlines(view.container)).toEqual([expect.stringContaining('Running a shell command failed: Exit code 1')]);
    expect(view.getByTestId('chat-steps-head').textContent).toContain('· 1 failed');
  });
});

describe('R6 · repeated identical failures fold', () => {
  it('draws one line with a count for the same action and reason', () => {
    const resume = (seq: number, id: string) =>
      call(seq, id, 'mcp__tm8__tm8_act', { operation: 'sessions.resume', params: { id: `s${id}` } }, {
        result: `team member ${MEMBER} not found in this space`,
        isError: true,
      });
    const view = render(
      <TurnParts parts={[...resume(0, '1'), ...resume(3, '2'), ...resume(6, '3'), { seq: 9, kind: 'text', text: 'Hm.' }, { seq: 10, kind: 'done' }]} />,
    );
    const lines = errlines(view.container);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/failed 3 times: team member not found in this space/);
    expect(view.getByTestId('chat-steps-head').textContent).toContain('· 3 failed');
  });
});

describe('R7 · a failure that ended the turn is never hidden', () => {
  it('shows the last failure and the turn alert when the turn failed', () => {
    const view = render(
      <TurnParts
        parts={[
          ...bash(0, 'c1', 'make', { result: 'Exit code 2', isError: true }),
          { seq: 3, kind: 'error', message: 'runtime exited' },
          { seq: 4, kind: 'done' },
        ]}
      />,
    );
    expect(errlines(view.container)).toEqual([expect.stringContaining('failed: Exit code 2')]);
    expect(view.getByRole('alert').textContent).toContain('runtime exited');
  });
});

describe('R8 · failure reasons never carry ids', () => {
  it('drops ids, and the words they leave dangling', () => {
    expect(toolStepError(`team member ${MEMBER} not found in this space`)).toBe('team member not found in this space');
    expect(toolStepError(`no such entity: ${TASK}`)).toBe('no such entity');
    expect(toolStepError('Exit code 1')).toBe('Exit code 1');
  });
});
