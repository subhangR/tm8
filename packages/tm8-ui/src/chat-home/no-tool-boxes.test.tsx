// @vitest-environment jsdom
/**
 * THERE ARE NO TOOL CALL BOXES IN THE TRANSCRIPT — and now, no chips either.
 *
 * A turn that read nine entities used to draw nine bordered cards, each
 * announcing `tm8_read` and offering its own Input/Result payload dump. The
 * first revision folded them to one deduped chip row. This revision replaces
 * the chips with the LEDGER (design 01a023e1, ruling 1): what a turn did to
 * the graph, as sentences —
 *
 *   Read 3 tasks, 4 docs        ← ONE counted line per turn
 *   Task 1 Created              ← one line per create, tree-indented
 *   Task 1  in_progress → done  ← one line per transition
 *
 * WHAT IS DELIBERATELY KEPT from the original ruling, as assertions: no
 * bordered card, no tool NAME anywhere in the rendered turn, no payload
 * disclosures (`<details>`), no payload dumps (`<pre>`). A reinstated box
 * breaks nothing and passes every other suite — only an explicit ban can see
 * it. WHAT IS DELIBERATELY REVERSED: "a plain call draws nothing of its own" —
 * plain calls now draw ledger lines, and the chip row is gone.
 *
 * `explain_*` / `doc_*` / `artifact_create` remain exempt: their payload IS
 * the content, so their card stays (minus tool chrome), exactly as before.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import { TurnParts } from './TurnParts';
import type { ChatTurnPart } from './types';

const TASK_ID = '019f0000-0000-7000-8000-000000000021';
const DOC_ID = '019f0000-0000-7000-8000-000000000022';
const CHILD_ID = '019f0000-0000-7000-8000-000000000023';

let seq = 0;
function call(
  args: unknown,
  result: unknown,
  name = 'mcp__tm8__tm8_read',
): ChatTurnPart[] {
  const toolCallId = `t${(seq += 1)}`;
  return [
    { seq: (seq += 1), kind: 'tool_call', toolCallId, name, args, state: 'completed' },
    { seq: (seq += 1), kind: 'tool_result', toolCallId, content: result },
  ];
}

const read = (id: string, kind = 'task') =>
  call({ operation: 'entities.get', params: { id } }, {
    entity: { id, kind, title: `Entity ${id.slice(-2)}` },
  });

const create = (id: string, parentId: string | null = null) =>
  call(
    { operation: 'entities.create', body: { kind: 'task', title: `Task ${id.slice(-2)}`, parentId } },
    { entity: { id, kind: 'task', title: `Task ${id.slice(-2)}` } },
    'mcp__tm8__tm8_act',
  );

describe('a plain tool call draws its ledger line and nothing else', () => {
  it('renders no card, no tool name, no payload disclosure, no dump', () => {
    const view = render(<TurnParts parts={read(TASK_ID)} />);

    expect(view.queryByTestId('chat-tool-card')).toBeNull();
    // The tool's NAME is the thing the reader kept being shown and never asked
    // for. It must not survive anywhere in the rendered turn (graph-seeds R8).
    expect(view.container.textContent).not.toContain('tm8_read');
    expect(view.container.textContent).not.toContain('tm8_act');
    // Nor the payload disclosures and dumps the card carried.
    expect(view.container.querySelectorAll('details')).toHaveLength(0);
    expect(view.container.querySelectorAll('pre')).toHaveLength(0);
  });

  it('folds every read in the turn to ONE counted line, deduped by id', () => {
    /* THE POINT OF THE CHANGE. Four reads, two distinct entities, two kinds —
       one sentence, exact counts, no chips, no rows. */
    const parts = [
      ...read(TASK_ID),
      ...read(DOC_ID, 'doc'),
      ...read(TASK_ID),
      ...read(DOC_ID, 'doc'),
    ];
    const view = render(<TurnParts parts={parts} />);

    const lines = view.getAllByTestId('chat-ledger-reads');
    expect(lines).toHaveLength(1);
    // Ties order alphabetically (readCountPairs: count desc, then kind).
    expect(lines[0]!.textContent).toBe('Read 1 doc, 1 task');
    expect(view.queryByTestId('chat-touched-entities')).toBeNull();
  });

  it('draws one create line per created entity, indented under an in-thread parent', () => {
    const parts = [...create(TASK_ID), ...create(CHILD_ID, TASK_ID)];
    const view = render(<TurnParts parts={parts} />);

    const lines = view.getAllByTestId('chat-ledger-create');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.textContent).toContain('Created');
    // The child indents under the parent created earlier in the same thread.
    expect(lines[0]!.style.paddingLeft).toBe('0px');
    expect(lines[1]!.style.paddingLeft).toBe('16px');
  });

  it('draws a transition line, one-sided when the prior status was never read here', () => {
    const parts = [
      ...call(
        { operation: 'entities.commands.work', params: { id: TASK_ID }, body: { status: 'working' } },
        { ok: true },
        'mcp__tm8__tm8_act',
      ),
    ];
    const view = render(<TurnParts parts={parts} />);

    const line = view.getByTestId('chat-ledger-transition');
    // An invented left side would be a lie about history; absence is honest.
    expect(line.textContent).toContain('→ working');
    expect(line.textContent).not.toMatch(/\w+ → working/);
  });

  it('fills the from-side when the entity was read earlier in the same fold', () => {
    const parts = [
      ...call({ operation: 'entities.get', params: { id: TASK_ID } }, {
        entity: { id: TASK_ID, kind: 'task', title: 'T', state: { kind: 'task', status: 'working' } },
      }),
      ...call(
        { operation: 'entities.commands.complete', params: { id: TASK_ID }, body: { expectedVersion: 1 } },
        { ok: true },
        'mcp__tm8__tm8_act',
      ),
    ];
    const view = render(<TurnParts parts={parts} />);
    expect(view.getByTestId('chat-ledger-transition').textContent).toContain('working → done');
  });

  it('draws no line at all when the calls touched nothing', () => {
    /* An entity-less call (a build, a search that matched nothing) must leave
       NO trace. An empty ledger row would be the box coming back under
       another name. */
    const parts: ChatTurnPart[] = [
      { seq: 0, kind: 'tool_call', toolCallId: 'tb', name: 'repo_bash', args: {}, state: 'completed' },
      { seq: 1, kind: 'tool_result', toolCallId: 'tb', content: { ok: true } },
    ];
    const view = render(<TurnParts parts={parts} />);
    expect(view.queryByTestId('chat-ledger-reads')).toBeNull();
    expect(view.queryByTestId('chat-ledger-create')).toBeNull();
    expect(view.queryByTestId('chat-ledger-transition')).toBeNull();
  });

  it('still shows the answer and the usage the turn produced', () => {
    // Removing the boxes must not remove the transcript.
    const parts: ChatTurnPart[] = [
      { seq: (seq += 1), kind: 'text', text: 'Three lanes, no shared files.' },
      ...read(TASK_ID),
      { seq: (seq += 1), kind: 'usage', usage: { input_tokens: 10, output_tokens: 5 } },
    ];
    const view = render(<TurnParts parts={parts} />);
    expect(view.getByTestId('chat-turn-text').textContent).toContain('Three lanes');
    expect(view.getByTestId('chat-usage-card')).toBeTruthy();
    expect(view.getByTestId('chat-ledger-reads')).toBeTruthy();
  });
});

describe('a ledger line is a button only where the press can land', () => {
  /* Carried over from the chip row this replaces, which carried it over from
     the tool card before that: the rule keeps surviving its hosts. A create
     line with a handler opens the entity — EVERY kind identically, the host
     decides where it lands; without one it is a span, never a dead button. */
  it('opens the entity when the host can', () => {
    const onOpenEntity = vi.fn();
    const view = render(<TurnParts parts={create(TASK_ID)} onOpenEntity={onOpenEntity} />);
    const line = view.getByTestId('chat-ledger-create');
    const opener = within(line).getByRole('button');

    fireEvent.click(opener);
    expect(onOpenEntity).toHaveBeenCalledWith(TASK_ID);
  });

  it('is inert when the host cannot — no button, no dead press', () => {
    const view = render(<TurnParts parts={create(TASK_ID)} />);
    expect(view.getByTestId('chat-ledger-create')).toBeTruthy();
    expect(view.queryByRole('button')).toBeNull();
  });
});
