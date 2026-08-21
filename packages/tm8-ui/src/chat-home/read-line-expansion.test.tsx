// @vitest-environment jsdom
/**
 * THE COUNTED READ LINE EXPANDS IN PLACE (S3b, task 01a023fb-03f9).
 *
 * `Read 1 doc, 1 task` is a sentence with a tree behind it: activating the
 * line expands, inline, the shared `LedgerTree` filtered to THAT turn's reads
 * — one turn, reads only. Collapse state is local to the line, so two turns'
 * lines never share it and a re-render never leaks one turn's expansion into
 * another.
 *
 * The bans stay banned (no-tool-boxes.test.tsx pins them; these cases restate
 * the two the expansion could newly violate): the expanded view renders NO
 * tool name and NO payload dump — the ledger says what happened to the graph,
 * never which tool was called (R8). And the toggle is a BUTTON with
 * aria-expanded, not a <details> — the details ban guards the payload-dump
 * shape and the read line must not resurrect it.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import { TurnParts } from './TurnParts';
import type { ChatTurnPart } from './types';

const TASK_ID = '019f0000-0000-7000-8000-000000000021';
const DOC_ID = '019f0000-0000-7000-8000-000000000022';

function read(seq: number, id: string, kind: string, title: string): ChatTurnPart[] {
  return [
    { seq, kind: 'tool_call', toolCallId: `t${seq}`, name: 'tm8_read', args: { id }, state: 'completed' },
    {
      seq: seq + 1,
      kind: 'tool_result',
      toolCallId: `t${seq}`,
      content: { items: [{ id, kind, title }] },
    },
  ];
}

const PARTS: ChatTurnPart[] = [
  ...read(0, TASK_ID, 'task', 'Unblock the storage lane'),
  ...read(2, DOC_ID, 'doc', 'Launch checklist'),
];

describe('the read line is an expandable toggle', () => {
  it('renders collapsed as a button with aria-expanded=false and no tree', () => {
    const view = render(<TurnParts parts={PARTS} />);
    const line = view.getByTestId('chat-ledger-reads');

    /* The press has a destination now — the expansion — so the honesty rule
       that kept S3's line a span is what makes S3b's a button. */
    expect(line.tagName).toBe('BUTTON');
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByTestId('chat-ledger-readtree')).toBeNull();
  });

  it('expands in place to the tree scoped to this turn, and collapses again', () => {
    const view = render(<TurnParts parts={PARTS} />);
    const line = view.getByTestId('chat-ledger-reads');

    fireEvent.click(line);
    expect(line.getAttribute('aria-expanded')).toBe('true');
    /* aria-controls points at the region only while it exists. */
    const region = view.getByTestId('chat-ledger-readtree');
    expect(line.getAttribute('aria-controls')).toBe(region.id);
    /* The turn's reads are IN the expansion — both of them, by title. */
    expect(within(region).getByText('Unblock the storage lane')).toBeTruthy();
    expect(within(region).getByText('Launch checklist')).toBeTruthy();

    fireEvent.click(line);
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByTestId('chat-ledger-readtree')).toBeNull();
  });

  it('keeps collapse state local to the line — two turns, two independent toggles', () => {
    /* Two TurnParts mounts model two turns in a thread. Expanding one must
       not expand — or collapse — the other. (RenderResult queries search the
       whole document, so each mount is queried through its own container.) */
    const a = within(render(<TurnParts parts={PARTS} />).container);
    const b = within(render(<TurnParts parts={read(0, DOC_ID, 'doc', 'Launch checklist')} />).container);

    fireEvent.click(a.getByTestId('chat-ledger-reads'));
    expect(a.getByTestId('chat-ledger-readtree')).toBeTruthy();
    expect(b.getByTestId('chat-ledger-reads').getAttribute('aria-expanded')).toBe('false');
    expect(b.queryByTestId('chat-ledger-readtree')).toBeNull();
  });

  it('leaks no tool name, no payload and no details element into the expansion (R8)', () => {
    const view = render(<TurnParts parts={PARTS} />);
    fireEvent.click(view.getByTestId('chat-ledger-reads'));

    expect(view.container.textContent).not.toContain('tm8_read');
    expect(view.container.querySelectorAll('pre')).toHaveLength(0);
    /* No thinking part in these fixtures, so ANY details element here would
       be the expansion smuggling the banned shape back in. */
    expect(view.container.querySelectorAll('details')).toHaveLength(0);
  });

  it('opens entities from the expansion through the SAME handler as every ledger line', () => {
    const onOpenEntity = vi.fn();
    const view = render(<TurnParts parts={PARTS} onOpenEntity={onOpenEntity} />);
    fireEvent.click(view.getByTestId('chat-ledger-reads'));

    const region = view.getByTestId('chat-ledger-readtree');
    fireEvent.click(within(region).getByText('Unblock the storage lane'));
    expect(onOpenEntity).toHaveBeenCalledWith(TASK_ID);
  });

  it('stays expandable with NO open handler — view-only, and rows fall to spans', () => {
    /* The expansion is the button's destination, so the toggle is live even
       on a host that cannot navigate; the ROWS inside follow the span/button
       split instead of dying with the host. */
    const view = render(<TurnParts parts={PARTS} />);
    fireEvent.click(view.getByTestId('chat-ledger-reads'));

    const region = view.getByTestId('chat-ledger-readtree');
    const title = within(region).getByText('Unblock the storage lane');
    expect(title.closest('button')).toBeNull();
  });
});
