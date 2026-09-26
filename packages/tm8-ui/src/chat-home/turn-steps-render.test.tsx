// @vitest-environment jsdom
/**
 * THE AGENT'S TURN, RENDERED — one test per defect the L3 audit found, plus
 * the 150-call fixture the lane's acceptance names. Every part shape here is
 * the one the Claude runtime actually writes (measured on the live node):
 * `tool_call(running)` → `tool_result` → `tool_call(completed|error)`, text
 * between most batches, and `error` + `done` when a turn dies mid-call.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { TurnParts } from './TurnParts';
import { STEP_TAIL } from './TurnSteps';
import type { ChatTurnPart } from './types';

afterEach(cleanup);

const TASK = '019f0000-0000-7000-8000-0000000000a1';
const DOC = '019f0000-0000-7000-8000-0000000000a2';

/** A tool call exactly as the runtime stores it. `outcome` omitted ⇒ still running. */
function call(
  seq: number,
  id: string,
  name: string,
  args: unknown,
  outcome?: { result: unknown; isError?: boolean; terminal?: boolean },
): ChatTurnPart[] {
  const parts: ChatTurnPart[] = [{ seq, kind: 'tool_call', toolCallId: id, name, args, state: 'running' }];
  if (!outcome) return parts;
  parts.push({
    seq: seq + 1,
    kind: 'tool_result',
    toolCallId: id,
    content: outcome.result,
    ...(outcome.isError ? { isError: true } : {}),
  });
  if (outcome.terminal !== false) {
    parts.push({
      seq: seq + 2,
      kind: 'tool_call',
      toolCallId: id,
      name,
      args,
      state: outcome.isError ? 'error' : 'completed',
    });
  }
  return parts;
}

const lines = (root: HTMLElement) => within(root).queryAllByTestId('chat-step-line');
const states = (root: HTMLElement) => lines(root).map((li) => li.dataset.state);

describe('a running call is visible from its first part (L1 → L3 repro)', () => {
  it('draws a live step line before any result lands', () => {
    /* Before: `TurnParts` returned null for a plain call with no ledger line,
       so a slow call (a spawn, a shell command) was invisible for its whole
       run — the "nothing on screen" Subhang reported. */
    const view = render(
      <TurnParts parts={call(0, 'c1', 'mcp__tm8__tm8', { operation: 'entities.list', query: { kind: 'task' } })} />,
    );
    const [line] = lines(view.container);
    expect(line?.dataset.state).toBe('running');
    expect(line?.textContent).toContain('Reading tasks…');
    // Human words only (R8).
    expect(view.container.textContent).not.toContain('tm8');
    expect(view.container.textContent).not.toContain('entities.list');
  });

  it('resolves the running line IN PLACE when the result lands (D7)', () => {
    const running = call(0, 'c1', 'Bash', { command: 'make', description: 'Build the app' });
    const view = render(<TurnParts parts={running} />);
    const node = lines(view.container)[0]!;
    expect(node.dataset.state).toBe('running');

    view.rerender(<TurnParts parts={call(0, 'c1', 'Bash', { command: 'make', description: 'Build the app' }, { result: 'ok' })} />);
    const after = lines(view.container)[0]!;
    expect(after).toBe(node); // same DOM node — no re-add, no re-animated entrance
    expect(after.dataset.state).toBe('completed');
    expect(after.textContent).toContain('Ran a shell command');
  });
});

describe('a call is never stuck at running', () => {
  it('is settled once its RESULT lands, even before the terminal record', () => {
    /* The runtime writes the result, THEN a second tool_call with the terminal
       state. A stream cut between the two left the call pulsing forever with
       its result already stored. */
    const parts = call(0, 'c1', 'Read', { file_path: '/r/a.ts' }, { result: 'x', terminal: false });
    const view = render(<TurnParts parts={parts} />);
    expect(states(view.container)).toEqual(['completed']);
    expect(view.container.querySelector('[data-state="running"]')).toBeNull();
  });

  it('reads STOPPED when its turn ended without it — pinned under the collapsed header', () => {
    /* Measured live: 2 of 3 long turns ended `…C C E D` — the runtime died with
       a call in flight, and that call's stored state is `running` forever. */
    const parts: ChatTurnPart[] = [
      ...call(0, 'c1', 'Read', { file_path: '/r/a.ts' }, { result: 'x' }),
      ...call(3, 'c2', 'mcp__tm8__tm8_read', { operation: 'entities.list', query: { kind: 'task' } }),
      { seq: 4, kind: 'error', message: 'runtime ended without done' },
      { seq: 5, kind: 'done' },
    ];
    const view = render(<TurnParts parts={parts} />);
    // The turn ended: its run collapses (D8), and nothing pulses.
    expect(view.getByTestId('chat-steps-head').getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('[data-state="running"]')).toBeNull();
    const pinned = lines(view.container);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.dataset.state).toBe('stopped');
    expect(pinned[0]!.textContent).toContain('Stopped while reading tasks');
    // The turn's own failure still shows, once, as the alert it always was.
    expect(view.getByRole('alert').textContent).toContain('runtime ended without done');
  });

  it('keeps a call LIVE when the same message continued after an earlier done', () => {
    // Seen live: `…C C E D x C R C…` — a continued turn appends after its done.
    const parts: ChatTurnPart[] = [
      ...call(0, 'c1', 'Bash', { command: 'a' }),
      { seq: 1, kind: 'done' },
      { seq: 2, kind: 'text', text: 'Picking up where I left off.' },
      ...call(3, 'c2', 'Bash', { command: 'b' }),
    ];
    const view = render(<TurnParts parts={parts} />);
    const runs = view.getAllByTestId('chat-steps');
    expect(states(runs[0]!)).toEqual(['stopped']);
    expect(states(runs[1]!)).toEqual(['running']);
  });

  it('honours the host saying the turn is over', () => {
    // A turn the server never closed (process died): the thread is idle.
    const view = render(<TurnParts parts={call(0, 'c1', 'Bash', { command: 'a' })} settled />);
    expect(states(view.container)).toEqual(['stopped']);
  });
});

describe('failures are shown, once, where they happened', () => {
  const failing = (): ChatTurnPart[] => [
    ...call(0, 'c1', 'Bash', { command: 'bun test', description: 'Run the tests' }, { result: 'Exit code 1\nFAIL x', isError: true }),
    ...call(3, 'c2', 'Bash', { command: 'bun test', description: 'Run the tests' }, { result: 'ok' }),
    { seq: 6, kind: 'done' },
  ];

  it('draws an errline with the reason, and counts the failure in the header', () => {
    /* Before: an isError result on a plain call drew nothing at all. */
    const view = render(<TurnParts parts={failing()} />);
    const errline = view.getByTestId('chat-step-errline');
    expect(errline.textContent).toContain('Running a shell command failed: Exit code 1');
    // A later identical call succeeded (D13).
    expect(errline.textContent).toContain('The agent retried');
    expect(view.getByTestId('chat-steps-head').textContent).toContain('· 1 failed');
    // Collapsed, the ✕ is NOT pinned a second time under the header (D19).
    expect(view.container.querySelector('[data-state="error"]')).toBeNull();
  });

  it('shows the ✕ line in the list, in seq order, once expanded', () => {
    const view = render(<TurnParts parts={failing()} />);
    fireEvent.click(view.getByTestId('chat-steps-head'));
    expect(states(view.container)).toEqual(['error', 'completed']);
    expect(lines(view.container)[0]!.textContent).toContain('Exit code 1');
  });

  it('claims no retry when the later call acted on a DIFFERENT target', () => {
    /* Review finding: a target-less signature matched ANY later call of the
       same operation, so a failed create of “Alpha” read as retried by a
       create of “Beta”. A failure must never hide behind a retry it was not. */
    const create = (title: string) => ({ operation: 'entities.create', body: { kind: 'task', title } });
    const parts: ChatTurnPart[] = [
      ...call(0, 'c1', 'mcp__tm8__tm8_act', create('Alpha'), { result: 'parent not found', isError: true }),
      ...call(3, 'c2', 'mcp__tm8__tm8_act', create('Beta'), { result: { entity: { id: TASK, kind: 'task', title: 'Beta' } } }),
      ...call(6, 'c3', 'Grep', { pattern: 'aaa' }, { result: 'no match', isError: true }),
      ...call(9, 'c4', 'Grep', { pattern: 'bbb' }, { result: 'x' }),
      ...call(12, 'c5', 'mcp__acme__frobnicate', {}, { result: 'boom', isError: true }),
      ...call(15, 'c6', 'mcp__acme__frobnicate', {}, { result: 'ok' }),
      { seq: 18, kind: 'done' },
    ];
    const view = render(<TurnParts parts={parts} />);
    const errlines = view.getAllByTestId('chat-step-errline');
    expect(errlines).toHaveLength(3);
    for (const line of errlines) expect(line.textContent).not.toContain('retried');
    // The same create, retried, still says so.
    cleanup();
    const retried = render(
      <TurnParts
        parts={[
          ...call(0, 'c1', 'mcp__tm8__tm8_act', create('Alpha'), { result: 'parent not found', isError: true }),
          ...call(3, 'c2', 'mcp__tm8__tm8_act', create('Alpha'), { result: { entity: { id: TASK, kind: 'task', title: 'Alpha' } } }),
        ]}
      />,
    );
    expect(retried.getByTestId('chat-step-errline').textContent).toContain('The agent retried');
  });

  it('claims no retry when a search in the same path looked for something ELSE', () => {
    /* #877 review, item 6: `path` outranked `pattern` in the signature, so a
       failed Grep and a later Grep for a different pattern in the SAME path
       matched, and the failure read as retried. */
    const view = render(
      <TurnParts
        parts={[
          ...call(0, 'c1', 'Grep', { pattern: 'aaa', path: 'src' }, { result: 'no match', isError: true }),
          ...call(3, 'c2', 'Grep', { pattern: 'bbb', path: 'src' }, { result: 'x' }),
          { seq: 6, kind: 'done' },
        ]}
      />,
    );
    expect(view.getByTestId('chat-step-errline').textContent).not.toContain('retried');
    // The same search in the same path, retried, still says so.
    cleanup();
    const retried = render(
      <TurnParts
        parts={[
          ...call(0, 'c1', 'Grep', { pattern: 'aaa', path: 'src' }, { result: 'no match', isError: true }),
          ...call(3, 'c2', 'Grep', { pattern: 'aaa', path: 'src' }, { result: 'x' }),
          { seq: 6, kind: 'done' },
        ]}
      />,
    );
    expect(retried.getByTestId('chat-step-errline').textContent).toContain('The agent retried');
  });

  it('claims no retry when the same-target retry ALSO failed', () => {
    const parts: ChatTurnPart[] = [
      ...call(0, 'c1', 'Bash', { command: 'bun test' }, { result: 'Exit code 1', isError: true }),
      ...call(3, 'c2', 'Bash', { command: 'bun test' }, { result: 'Exit code 1', isError: true }),
      { seq: 6, kind: 'done' },
    ];
    const view = render(<TurnParts parts={parts} />);
    for (const line of view.getAllByTestId('chat-step-errline')) expect(line.textContent).not.toContain('retried');
  });

  it('does not claim a retry that never happened', () => {
    const parts: ChatTurnPart[] = [
      ...call(0, 'c1', 'mcp__tm8__tm8_act', { operation: 'entities.commands.complete', params: { id: TASK } }, {
        result: [{ type: 'text', text: '{"error":{"message":"version conflict"}}' }],
        isError: true,
      }),
      { seq: 3, kind: 'done' },
    ];
    const view = render(<TurnParts parts={parts} />);
    const errline = view.getByTestId('chat-step-errline');
    expect(errline.textContent).toContain('failed: version conflict');
    expect(errline.textContent).not.toContain('retried');
  });
});

describe('order and interleaving', () => {
  const interleaved = (): ChatTurnPart[] => [
    { seq: 0, kind: 'text', text: 'Looking at the build first.' },
    ...call(1, 'c1', 'Bash', { command: 'a' }, { result: 'ok' }),
    { seq: 4, kind: 'thinking', text: 'The build is fine; check the tests.' },
    ...call(5, 'c2', 'Read', { file_path: '/r/x.test.ts' }, { result: 'x' }),
    { seq: 8, kind: 'text', text: 'Now the tests.' },
    ...call(9, 'c3', 'Grep', { pattern: 'describe' }, { result: 'x' }),
  ];

  it('renders runs and text in seq order, one step block per run', () => {
    const view = render(<TurnParts parts={interleaved()} />);
    const order = [...view.container.querySelectorAll('[data-testid="chat-turn-text"], [data-testid="chat-steps"]')]
      .map((el) => (el.getAttribute('data-testid') === 'chat-steps' ? 'steps' : el.textContent?.trim()));
    expect(order).toEqual(['Looking at the build first.', 'steps', 'Now the tests.', 'steps']);
  });

  it('is the same transcript however the parts array arrives', () => {
    const shuffled = [...interleaved()].reverse();
    // `useId` values differ between mounts; everything else must not.
    const html = (parts: ChatTurnPart[]) =>
      render(<TurnParts parts={parts} />).container.innerHTML.replace(/_r_[a-z0-9]+_/g, 'ID');
    const a = html(interleaved());
    cleanup();
    expect(html(shuffled)).toBe(a);
  });

  it('folds thinking between steps into a quiet Thought line, not a step', () => {
    const view = render(<TurnParts parts={interleaved()} />);
    const firstRun = view.getAllByTestId('chat-steps')[0]!;
    expect(within(firstRun).getByTestId('chat-steps-head').textContent).toMatch(/^2 steps/);
    const thought = within(firstRun).getByTestId('chat-step-thought');
    expect(thought.textContent).toContain('Thought');
    expect(thought.textContent).not.toContain('check the tests');
    fireEvent.click(within(thought).getByRole('button'));
    expect(thought.textContent).toContain('The build is fine; check the tests.');
    // No standalone "Thinking" disclosure for a thought that sits among steps.
    expect(view.container.querySelectorAll('details')).toHaveLength(0);
  });

  it('keeps a thought with no step beside it as the standalone disclosure', () => {
    const view = render(
      <TurnParts parts={[{ seq: 0, kind: 'thinking', text: 'Hmm.' }, { seq: 1, kind: 'text', text: 'Answer.' }]} />,
    );
    expect(view.container.querySelectorAll('details.tch-thinking')).toHaveLength(1);
    expect(view.queryByTestId('chat-steps')).toBeNull();
  });

  it('draws the run’s outcomes ABOVE its step block, and the block last (D15 §5)', () => {
    const parts: ChatTurnPart[] = [
      ...call(0, 'c1', 'mcp__tm8__tm8_act', { operation: 'entities.create', body: { kind: 'task', title: 'Ship it' } }, {
        result: { entity: { id: TASK, kind: 'task', title: 'Ship it' } },
      }),
      ...call(3, 'c2', 'Bash', { command: 'a' }, { result: 'x', isError: true }),
    ];
    const view = render(<TurnParts parts={parts} />);
    const kids = [...view.container.querySelector('.tch-parts')!.children].map((el) => el.getAttribute('data-testid') ?? el.className);
    expect(kids).toEqual(['tch-ledger', 'chat-step-errline', 'chat-steps']);
  });
});

describe('writes never fold; reads and commands do (D15 §4)', () => {
  it('keeps each create its own line, and folds settled reads into a counted line', () => {
    const parts: ChatTurnPart[] = [
      ...call(0, 'r1', 'Read', { file_path: '/r/a.ts' }, { result: 'x' }),
      ...call(3, 'r2', 'Read', { file_path: '/r/b.ts' }, { result: 'x' }),
      ...call(6, 'r3', 'Read', { file_path: '/r/c.ts' }, { result: 'x' }),
      ...call(9, 'w1', 'mcp__tm8__tm8_act', { operation: 'entities.create', body: { kind: 'task', title: 'One' } }, { result: {} }),
      ...call(12, 'w2', 'mcp__tm8__tm8_act', { operation: 'entities.create', body: { kind: 'task', title: 'Two' } }, { result: {} }),
    ];
    const view = render(<TurnParts parts={parts} />);
    const texts = lines(view.container).map((li) => li.textContent);
    expect(texts).toEqual([
      expect.stringContaining('Read 3 files'),
      expect.stringContaining('Created task “One”'),
      expect.stringContaining('Created task “Two”'),
    ]);
    expect(view.getByTestId('chat-steps-head').textContent).toMatch(/^5 steps · read 3 files, created 2 tasks/);
  });
});

/* ── THE 150-CALL TURN ─────────────────────────────────────────────────── */

/**
 * A long agent turn, shaped like the live ones: file reads, shell commands,
 * code searches and graph reads in a repeating mix, a failure every 50 calls,
 * and NO narration between them — the worst case for a wall.
 */
function longTurn(calls: number, options: { live: boolean }): ChatTurnPart[] {
  const parts: ChatTurnPart[] = [{ seq: 0, kind: 'text', text: 'Auditing every chat file.' }];
  let seq = 1;
  for (let i = 0; i < calls; i += 1) {
    const last = i === calls - 1;
    const pick = i % 4;
    const name = pick === 0 ? 'Read' : pick === 1 ? 'Bash' : pick === 2 ? 'Grep' : 'mcp__tm8__tm8_read';
    const args =
      pick === 0 ? { file_path: `/repo/src/file-${i}.ts` }
        : pick === 1 ? { command: `check ${i}`, description: `Check step ${i}` }
          : pick === 2 ? { pattern: `needle${i}` }
            : { operation: 'entities.get', params: { id: TASK } };
    const failed = i % 50 === 49;
    if (last && options.live) {
      parts.push(...call(seq, `c${i}`, name, args));
      seq += 1;
    } else {
      parts.push(...call(seq, `c${i}`, name, args, {
        result: pick === 3 ? { entity: { id: TASK, kind: 'task', title: 'The task' } } : failed ? 'Exit code 1' : 'ok',
        isError: failed,
      }));
      seq += 3;
    }
  }
  if (!options.live) {
    parts.push({ seq, kind: 'text', text: 'All 150 checked.' });
    parts.push({ seq: seq + 1, kind: 'done' });
  }
  return parts;
}

describe('a 150-tool-call turn is scannable', () => {
  it('settled: ONE header line with the count, collapsible, failures counted', () => {
    const view = render(<TurnParts parts={longTurn(150, { live: false })} />);
    const head = view.getByTestId('chat-steps-head');
    expect(view.getAllByTestId('chat-steps')).toHaveLength(1);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    // Exactly the top TWO verb groups (D15 §1), then the failure count.
    const sentence = head.cloneNode(true) as HTMLElement;
    sentence.querySelectorAll('[aria-hidden]').forEach((el) => el.remove());
    expect(sentence.textContent).toBe('150 steps · read 38 files, ran 38 commands · 3 failed');
    // Collapsed: no step lines at all — just the header, and the three errlines.
    expect(lines(view.container)).toHaveLength(0);
    expect(view.getAllByTestId('chat-step-errline')).toHaveLength(3);
    // The answer is still there, after the block.
    expect(view.getAllByTestId('chat-turn-text').map((t) => t.textContent?.trim())).toContain('All 150 checked.');
  });

  it('expands to the latest five lines, with the rest behind one "earlier" button', () => {
    expect(STEP_TAIL).toBe(5); // D15 §2 — pinned, not read back from the constant
    const view = render(<TurnParts parts={longTurn(150, { live: false })} />);
    fireEvent.click(view.getByTestId('chat-steps-head'));
    expect(lines(view.container)).toHaveLength(STEP_TAIL);
    const earlier = view.getByTestId('chat-steps-earlier');
    const hidden = Number(/Show (\d+) earlier steps/.exec(earlier.textContent ?? '')?.[1]);
    const shown = lines(view.container).reduce((n, li) => n + Number(li.dataset.count), 0);
    expect(hidden + shown).toBe(150);

    fireEvent.click(earlier);
    // The button is gone; focus follows the steps it revealed, not <body>.
    expect(document.activeElement).toBe(view.container.querySelector('.tch-steps__list'));
    const all = lines(view.container);
    expect(all.reduce((n, li) => n + Number(li.dataset.count), 0)).toBe(150);
    // The four categories alternate, so nothing folds here — but no line is a
    // tool name or a raw command (the agent's own description is the detail).
    expect(view.container.textContent).not.toMatch(/tm8_read|Grep|Bash|check \d/);
    expect(view.container.textContent).toContain('Check step 1');
  });

  it('live: the block is open, the running step is the LAST line, and the tail stays five lines', () => {
    const view = render(<TurnParts parts={longTurn(150, { live: true })} />);
    const head = view.getByTestId('chat-steps-head');
    expect(head.getAttribute('aria-expanded')).toBe('true');
    const shown = lines(view.container);
    expect(shown).toHaveLength(STEP_TAIL);
    expect(shown[shown.length - 1]!.dataset.state).toBe('running');
    // Call #149 is a shell command (the mix cycles read, shell, search, graph).
    expect(shown[shown.length - 1]!.textContent).toContain('Running a shell command…');
    // Not a live region: the status row below the conversation is the only
    // thing that announces (D15 §2).
    expect(view.getByTestId('chat-steps').closest('[aria-live]')).toBeNull();
  });

  it('folds a stretch of settled reads into one counted line', () => {
    const parts: ChatTurnPart[] = [];
    for (let i = 0; i < 150; i += 1) {
      parts.push(...call(i * 3, `r${i}`, 'Read', { file_path: `/repo/f${i}.ts` }, { result: 'x' }));
    }
    parts.push({ seq: 1000, kind: 'done' });
    const view = render(<TurnParts parts={parts} />);
    fireEvent.click(view.getByTestId('chat-steps-head'));
    const shown = lines(view.container);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.textContent).toContain('Read 150 files');
    expect(view.getByTestId('chat-steps-head').textContent).toMatch(/^150 steps · read 150 files/);
  });
});

describe('reconnects and streaming', () => {
  it('draws ONE usage card even if a turn holds two usage parts', () => {
    /* The render guard. The state path that produced two — a reconnect gap
       missed the usage delta, the done frame put a stand-in at max+1, and the
       next snapshot brought the stored one at its real seq — is closed in
       `turn-model` ("one usage part per turn"). This keeps the screen honest
       should any other path ever hand it two. */
    const parts: ChatTurnPart[] = [
      { seq: 0, kind: 'text', text: 'Done.' },
      { seq: 1, kind: 'usage', usage: { input_tokens: 10, output_tokens: 5 } },
      { seq: 2, kind: 'done' },
      { seq: 3, kind: 'usage', usage: { input_tokens: 10, output_tokens: 5 }, synthetic: true },
    ];
    const view = render(<TurnParts parts={parts} />);
    expect(view.getAllByTestId('chat-usage-card')).toHaveLength(1);
  });

  it('does not remount settled text while the turn streams below it', () => {
    /* `Markdown` builds a fresh link component every render, so an unmemoised
       text block remounted its links on EVERY delta: hover lost, a selection
       across a link collapsed, keyboard focus on one dropped. */
    const first: ChatTurnPart[] = [{ seq: 0, kind: 'text', text: 'See [the plan](https://example.com/plan).' }];
    const view = render(<TurnParts parts={first} />);
    const link = view.container.querySelector('a')!;
    link.focus();
    expect(document.activeElement).toBe(link);

    view.rerender(<TurnParts parts={[...first, ...call(1, 'c1', 'Bash', { command: 'a' })]} />);
    expect(view.container.querySelector('a')).toBe(link);
    expect(document.activeElement).toBe(link);
  });
});

describe('doc tools (D17)', () => {
  it('draws a settled doc_update as a quiet edit line that opens the doc', () => {
    const opened: string[] = [];
    const parts: ChatTurnPart[] = [
      ...call(0, 'c1', 'mcp__tm8__doc_update', { docId: DOC, expectedVersion: 2, title: 'Runbook', body: '#' }, { result: {} }),
    ];
    const view = render(<TurnParts parts={parts} onOpenEntity={(id) => opened.push(id)} />);
    const edit = view.getByTestId('chat-doc-edit');
    expect(edit.textContent).toContain('Edited');
    expect(edit.textContent).toContain('Runbook');
    fireEvent.click(within(edit).getByRole('button', { name: 'Runbook' }));
    expect(opened).toEqual([DOC]);
    expect(lines(view.container)[0]!.textContent).toContain('Edited “Runbook”');
  });

  it('draws a running doc_create as a step line only — no card', () => {
    const view = render(<TurnParts parts={call(0, 'c1', 'mcp__tm8__doc_create', { title: 'Plan', body: '#' })} />);
    expect(lines(view.container)[0]!.textContent).toContain('Creating doc “Plan”…');
    expect(view.queryByTestId('chat-explanation-card')).toBeNull();
    expect(view.queryByTestId('chat-doc-edit')).toBeNull();
  });

  it('draws no edit line for a doc_update that failed', () => {
    const parts = call(0, 'c1', 'mcp__tm8__doc_update', { docId: DOC, body: '#' }, { result: 'conflict', isError: true });
    const view = render(<TurnParts parts={parts} />);
    expect(view.queryByTestId('chat-doc-edit')).toBeNull();
    expect(view.getByTestId('chat-step-errline')).toBeTruthy();
  });
});

describe('the step block stylesheet', () => {
  it('lets its buttons inherit the transcript font (jsdom loads no CSS)', () => {
    /* Review finding: a <button> does not inherit `font`, so the header and
       the "earlier" control rendered in the UA's system-ui while the lines
       under them used the transcript's face. */
    const css = readFileSync(`${process.cwd()}/src/chat-home/turn-steps.css`, 'utf8');
    for (const selector of ['.tch-steps__head {', '.tch-steps__earlier {']) {
      const start = css.indexOf(selector);
      expect(start).toBeGreaterThanOrEqual(0);
      const block = css.slice(start, css.indexOf('}', start));
      expect(block).toMatch(/\bfont: inherit;/);
    }
  });
});
