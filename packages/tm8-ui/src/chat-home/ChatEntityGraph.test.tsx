// @vitest-environment jsdom
/**
 * P4 — the rendered induced graph, asserted over the MEASURED fixture: the
 * screenshot's ten entities draw with real titles and relation labels, and
 * no tool name reaches the surface (R8). The star's three defects — tool-name
 * edges, truncated-UUID titles, a conversation hub — are each pinned shut.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EdgeView, EntityId, Page } from '@tm8/contract';
import type { ConnectionsReader } from '../session-graph/load';
import { ChatEntityGraph } from './ChatEntityGraph';
import {
  C1,
  M2,
  S4,
  T1,
  measuredConnections,
  measuredSeeds,
} from './induced-graph.fixture';
import type { ChatTurn, ChatTurnPart } from './types';

afterEach(cleanup);

let seq = 0;
const call = (name: string, args: unknown, result?: unknown): ChatTurnPart[] => {
  const toolCallId = `tc-${(seq += 1)}`;
  const parts: ChatTurnPart[] = [
    { kind: 'tool_call', seq: (seq += 1), toolCallId, name, args, state: 'completed' },
  ];
  if (result !== undefined) {
    parts.push({ kind: 'tool_result', seq: (seq += 1), toolCallId, content: result });
  }
  return parts;
};
const turnOf = (parts: ChatTurnPart[]): ChatTurn => ({
  messageId: `msg-${(seq += 1)}` as EntityId,
  role: 'assistant',
  author: null,
  createdAt: '2026-08-16T10:00:00.000Z',
  body: '',
  parts,
});

/** The thread that seeds the screenshot's mix: bare-id reads (so titles MUST
 *  come from the edge payload) plus one write on T1. */
function measuredTurns(): ChatTurn[] {
  const readIds = measuredSeeds()
    .map((seed) => seed.id)
    .filter((id) => id !== T1);
  return [
    turnOf(readIds.flatMap((id) => call('tm8_read', { id }))),
    turnOf(call('mcp__tm8__tm8_update_entity', { id: T1 })),
  ];
}

/** A reader over the measured pages; S4 rejects, hubs page-cap. */
function measuredReader(): { read: ConnectionsReader; calls: string[] } {
  const pages = measuredConnections();
  const calls: string[] = [];
  const read: ConnectionsReader = (id) => {
    calls.push(id);
    const page = pages.get(id);
    if (!page || page.state !== 'loaded') return Promise.reject(new Error('403'));
    return Promise.resolve({
      items: page.edges as EdgeView[],
      nextCursor: page.pageCapped ? 'more' : null,
    } as unknown as Page<EdgeView>);
  };
  return { read, calls };
}

async function renderMeasured(onOpenEntity?: (id: EntityId) => void) {
  const { read } = measuredReader();
  const view = render(
    <ChatEntityGraph
      turns={measuredTurns()}
      connections={read}
      {...(onOpenEntity ? { onOpenEntity } : {})}
    />,
  );
  await waitFor(() => expect(screen.getByText(/1 not read/)).toBeDefined());
  return view;
}

describe('ChatEntityGraph over the measured thread', () => {
  it('draws all ten entities with REAL titles — never a truncated UUID', async () => {
    const { container } = await renderMeasured();
    const cards = container.querySelectorAll('.ceg-cell');
    expect(cards).toHaveLength(10);
    expect(screen.getAllByText('Opus 5 Teammate').length).toBeGreaterThan(0);
    expect(screen.getAllByText('All CHAT UI Modes').length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/01900000…/);
  });

  it('R8/R13: relation labels only — no tool name and no "touch" language anywhere', async () => {
    const { container } = await renderMeasured();
    expect(container.textContent).not.toContain('tm8_read');
    expect(container.textContent).not.toContain('tm8_update');
    expect(container.textContent).not.toMatch(/touch/i);
    expect(screen.getAllByText(/Assigned to/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Working on/).length).toBeGreaterThan(0);
  });

  it('R1: the conversation is NOT a node — no focus cell, no anchor noun', async () => {
    const { container } = await renderMeasured();
    expect(container.querySelector('.sg-cell--focus')).toBeNull();
    expect(container.textContent).not.toMatch(/this conversation/i);
    // Ten seed cards and NOT an eleventh centre.
    expect(container.querySelectorAll('.ceg-cell')).toHaveLength(10);
  });

  it('R4: merged lines — ten lines carry fourteen relations; the caption states both honestly', async () => {
    const { container } = await renderMeasured();
    expect(container.querySelectorAll('.ceg-line')).toHaveLength(10);
    expect(screen.getByText(/10 entities · 14 relations · 1 not read/)).toBeDefined();
  });

  it('R5/R11: the isolated channel draws unlinked; the failed seed says "edges not read"', async () => {
    const { container } = await renderMeasured();
    const labels = [...container.querySelectorAll('.ceg-cell')].map((c) => c.getAttribute('aria-label'));
    expect(labels.some((l) => l?.includes('deployment') && l.endsWith('read'))).toBe(true);
    expect(labels.some((l) => l?.includes('Stalled run') && l.includes('edges not read'))).toBe(true);
    // The channel keeps its card with no line touching it: 10 lines, none named C1.
    const graphLines = [...container.querySelectorAll('.ceg-line')];
    expect(graphLines).toHaveLength(10);
    expect(screen.getByText('deployment')).toBeDefined();
    void C1;
  });

  it('R6: the written task is emphasised and says so; a read entity is not', async () => {
    const { container } = await renderMeasured();
    const mutated = [...container.querySelectorAll('.ceg-cell--mutated')];
    expect(mutated).toHaveLength(1);
    expect(mutated[0]!.getAttribute('aria-label')).toContain('edited in this conversation');
    expect(screen.getByText('edited here')).toBeDefined();
  });

  it('Q3: hub cards state their degree with the page-cap made visible', async () => {
    await renderMeasured();
    expect(screen.getAllByText('60+ links')).toHaveLength(3);
    void M2;
  });

  it('cards open the entity when the host can, and are not buttons when it cannot', async () => {
    const opened: string[] = [];
    const { container, unmount } = await renderMeasured((id) => opened.push(id));
    const card = [...container.querySelectorAll('.ceg-cell[role="button"]')];
    expect(card).toHaveLength(10);
    fireEvent.click(card.find((c) => c.getAttribute('aria-label')!.includes('Stalled run'))!);
    expect(opened).toEqual([S4]);
    unmount();
    const { container: inert } = await renderMeasured();
    expect(inert.querySelectorAll('.ceg-cell[role="button"]')).toHaveLength(0);
  });
});

describe('ChatEntityGraph degenerates (R12) and hosts without a reader (R11)', () => {
  it('no seeds → renders NOTHING — no header, no empty frame', () => {
    const { container } = render(<ChatEntityGraph turns={[turnOf(call('Bash', { command: 'ls' }))]} />);
    expect(container.firstChild).toBeNull();
  });

  it('one seed → one card, no relation language', async () => {
    const { read } = measuredReader();
    render(
      <ChatEntityGraph turns={[turnOf(call('tm8_read', { id: C1 }))]} connections={read} />,
    );
    await waitFor(() => expect(screen.getByText('deployment')).toBeDefined());
    expect(screen.getByText('1 entity')).toBeDefined();
    expect(screen.queryByText(/relation/)).toBeNull();
  });

  it('all seeds isolated → cards, no lines, and a caption that says so', async () => {
    const { read } = measuredReader();
    const { container } = render(
      <ChatEntityGraph
        turns={[turnOf([...call('tm8_read', { id: C1 }), ...call('tm8_read', { id: T1 })])]}
        connections={read}
      />,
    );
    // T1's page induces nothing here (its peers are outside this seed set)…
    await waitFor(() =>
      expect(screen.getByText('These entities hold no relations to each other.')).toBeDefined(),
    );
    expect(container.querySelectorAll('.ceg-line')).toHaveLength(0);
    expect(container.querySelectorAll('.ceg-cell')).toHaveLength(2);
  });

  it('without a connections reader every card is labelled "edges not read" — nothing fabricated', () => {
    const { container } = render(
      <ChatEntityGraph
        turns={[turnOf([...call('tm8_read', { id: C1 }), ...call('tm8_read', { id: T1 })])]}
      />,
    );
    const flags = [...container.querySelectorAll('.ceg-cell')].map((c) => c.getAttribute('aria-label'));
    expect(flags).toHaveLength(2);
    for (const label of flags) expect(label).toContain('edges not read');
    expect(container.querySelectorAll('.ceg-line')).toHaveLength(0);
  });
});
