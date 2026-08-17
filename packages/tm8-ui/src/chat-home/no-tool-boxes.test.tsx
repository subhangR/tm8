// @vitest-environment jsdom
/**
 * THERE ARE NO TOOL CALL BOXES IN THE TRANSCRIPT.
 *
 * A turn that read nine entities used to draw nine bordered cards, each
 * announcing `tm8_read` and offering its own Input/Result payload dump. They
 * were the most visually dominant thing on the screen and said the least, and
 * they buried the three things a reader comes for: the prose, the entities and
 * the graph.
 *
 * The rule is now absolute for PLAIN tool calls — they render nothing of their
 * own. What they touched survives as chips, because that is the part with
 * meaning, and the chips are DEDUPED ACROSS THE WHOLE TURN so nine reads of
 * four entities are four chips and not nine rows.
 *
 * `explain_*` / `doc_*` / `artifact_create` are deliberately NOT covered by
 * that rule: their payload IS the content (a diagram, an excerpt, a file), so
 * the card stays. What they lost is only the tool chrome — the tool-name
 * header and the raw "Tool details" dump — because a rule kept only where it
 * is easy to keep is not a rule.
 *
 * These cases exist because the defect is INVISIBLE TO EVERY OTHER TEST: a
 * reinstated box breaks nothing, renders fine, and passes the suite. Only an
 * explicit ban can see it.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import { TurnParts } from './TurnParts';
import type { ChatTurnPart } from './types';

const TASK_ID = '019f0000-0000-7000-8000-000000000021';
const DOC_ID = '019f0000-0000-7000-8000-000000000022';

function call(seq: number, id: string, name = 'tm8_read', args: unknown = { id }): ChatTurnPart[] {
  return [
    { seq, kind: 'tool_call', toolCallId: `t${seq}`, name, args, state: 'completed' },
    {
      seq: seq + 1,
      kind: 'tool_result',
      toolCallId: `t${seq}`,
      content: { items: [{ id, kind: 'task', title: `Entity ${id.slice(-2)}` }] },
    },
  ];
}

describe('a plain tool call draws nothing of its own', () => {
  it('renders no card, no tool name, no payload disclosure', () => {
    const view = render(<TurnParts parts={call(0, TASK_ID)} />);

    expect(view.queryByTestId('chat-tool-card')).toBeNull();
    // The tool's NAME is the thing the reader kept being shown and never asked
    // for. It must not survive anywhere in the rendered turn.
    expect(view.container.textContent).not.toContain('tm8_read');
    // Nor the payload disclosures the card carried.
    expect(view.container.querySelectorAll('details')).toHaveLength(0);
    expect(view.container.querySelectorAll('pre')).toHaveLength(0);
  });

  it('keeps the chips — one row, deduped across every call in the turn', () => {
    /* THE POINT OF THE WHOLE CHANGE. Four calls, but only two distinct
       entities between them, so the turn shows two chips in ONE row — not
       four rows, and not four chips. */
    const parts = [
      ...call(0, TASK_ID),
      ...call(2, DOC_ID),
      ...call(4, TASK_ID),
      ...call(6, DOC_ID),
    ];
    const view = render(<TurnParts parts={parts} onOpenEntity={vi.fn()} />);

    const rows = view.getAllByTestId('chat-touched-entities');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getAllByTestId('chat-entity-chip')).toHaveLength(2);
  });

  it('draws no empty row when the calls touched nothing', () => {
    /* An entity-less call (a build, a search that matched nothing) must leave
       NO trace at all. An empty bordered row would be the box coming back
       under another name. */
    const parts: ChatTurnPart[] = [
      { seq: 0, kind: 'tool_call', toolCallId: 't1', name: 'repo_bash', args: {}, state: 'completed' },
      { seq: 1, kind: 'tool_result', toolCallId: 't1', content: { ok: true } },
    ];
    const view = render(<TurnParts parts={parts} />);
    expect(view.queryByTestId('chat-touched-entities')).toBeNull();
  });

  it('still shows the answer and the usage the turn produced', () => {
    // Removing the boxes must not remove the transcript.
    const parts: ChatTurnPart[] = [
      { seq: 0, kind: 'text', text: 'Three lanes, no shared files.' },
      ...call(1, TASK_ID),
      { seq: 3, kind: 'usage', usage: { input_tokens: 10, output_tokens: 5 } },
    ];
    const view = render(<TurnParts parts={parts} />);
    expect(view.getByTestId('chat-turn-text').textContent).toContain('Three lanes');
    expect(view.getByTestId('chat-usage-card')).toBeTruthy();
    expect(view.getByTestId('chat-touched-entities')).toBeTruthy();
  });
});

describe('an entity chip is a button only where the press can land', () => {
  /* Carried over from the tool-card file this replaces: the rule survived the
     box that used to host it. `EntityChip` renders an inert badge with no
     handler and a real button with one, so a host that cannot navigate must
     pass NOTHING — `MobileShell`'s `() => undefined` defeated exactly that and
     made every chip on a phone a live-looking button that ate the press. */
  it('is a real button when the host can open entities', () => {
    const onOpenEntity = vi.fn();
    const view = render(<TurnParts parts={call(0, TASK_ID)} onOpenEntity={onOpenEntity} />);
    const chip = view.getByTestId('chat-entity-chip');

    expect(chip.tagName).toBe('BUTTON');
    fireEvent.click(chip);
    expect(onOpenEntity).toHaveBeenCalledWith(TASK_ID);
  });

  it('is an inert badge when the host cannot — no button, no dead press', () => {
    const view = render(<TurnParts parts={call(0, TASK_ID)} />);
    const chip = view.getByTestId('chat-entity-chip');

    expect(chip.tagName).toBe('SPAN');
    expect(view.queryByRole('button')).toBeNull();
  });
});
