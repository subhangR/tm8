// @vitest-environment jsdom
/**
 * THE ATTACH PALETTE (task 01a0cfb0), end to end in the UI:
 *   · the chip row is the task registry row, in the ruled order;
 *   · a chip's picker searches THE SERVER by kind and title, through the real
 *     port over a real fixture seam, not a filter over a recent page;
 *   · a candidate is verified before the edge (its kind, not the anchor, not
 *     already linked), and the edge written has the row's type and direction;
 *   · "＋ New …" only where the row allows it AND the host can do it;
 *   · linked entities become tiles in the strip, with the ＋ Attach chip first.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CollectionQuery, CreateEdgeInput, CreateEntityInput, EntityDetail, EntitySummary } from '@tm8/contract';

import { AttachPalette } from './AttachPalette';
import { AttachmentStrip } from './AttachmentStrip';
import { paletteLinks, stripLinks } from './palette';
import { attachmentsPortFromSeam, PALETTE_SEARCH_LIMIT } from './port';
import { createFixtureSeam, FIXTURE_SPACE_ID } from '../data';
import { getKind, type AttachPaletteRow } from '../domain';
import { fixtureDetails, taskUuidTitle } from '../fixtures';

const ROWS = getKind('task').panel.attachPalette ?? [];
const ANCHOR = 'task-anchor-1';

function rowOf(kind: string): AttachPaletteRow {
  const row = ROWS.find((candidate) => candidate.kind === kind);
  if (!row) throw new Error(`no palette row for ${kind}`);
  return row;
}

function summary(id: string, kind: string, title: string): EntitySummary {
  const base = fixtureDetails[taskUuidTitle.id]!;
  return { ...base.state, id, kind, title } as unknown as EntitySummary;
}

afterEach(() => vi.useRealTimers());

describe('the registry declares the palette', () => {
  it('is the ruled order, with the ruled link types', () => {
    expect(ROWS.map((row) => row.label)).toEqual([
      'Memories', 'Drawings', 'Docs', 'Artifacts', 'Skills', 'Teammates', 'Sessions',
    ]);
    expect(ROWS.map((row) => [row.kind, row.edgeType, row.direction])).toEqual([
      ['memory', 'remembers', 'outgoing'],
      ['drawing', 'attached_to', 'incoming'],
      ['doc', 'attached_to', 'incoming'],
      ['artifact', 'attached_to', 'incoming'],
      ['skill', 'equips', 'outgoing'],
      ['team_member', 'relates_to', 'outgoing'],
      ['work_session', 'relates_to', 'outgoing'],
    ]);
    // Memory, drawing and doc may be created from the picker; the rest are pick-only.
    expect(ROWS.filter((row) => row.create).map((row) => row.kind)).toEqual(['memory', 'drawing', 'doc']);
  });
});

function renderPalette(over: Partial<React.ComponentProps<typeof AttachPalette>> = {}) {
  const search = vi.fn(async (_kind: string, _text: string): Promise<EntitySummary[]> => []);
  const link = vi.fn(async () => {});
  const onLinked = vi.fn();
  const utils = render(
    <AttachPalette
      anchorId={ANCHOR}
      rows={ROWS}
      linkedIds={new Set()}
      search={search}
      link={link}
      onLinked={onLinked}
      attachChip={<button type="button" data-testid="attach-chip">＋ Attach</button>}
      {...over}
    />,
  );
  return { ...utils, search: (over.search as typeof search) ?? search, link: (over.link as typeof link) ?? link, onLinked };
}

function chip(kind: string) {
  return screen.getAllByTestId('attach-palette-chip').find((el) => el.dataset.kind === kind)!;
}

describe('the chip row', () => {
  it('puts ＋ Attach first, then one chip per row', () => {
    renderPalette();
    const palette = screen.getByTestId('attach-palette');
    const buttons = within(palette).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      '＋ Attach', 'Memories', 'Drawings', 'Docs', 'Artifacts', 'Skills', 'Teammates', 'Sessions',
    ]);
  });

  it('disables every chip WITH the reason when linking is refused', () => {
    const { search } = renderPalette({ refusal: 'Read-only here.' });
    fireEvent.click(chip('doc'));
    expect(chip('doc').getAttribute('aria-disabled')).toBe('true');
    expect(chip('doc').title).toBe('Read-only here.');
    expect(screen.queryByTestId('attach-palette-picker')).toBeNull();
    expect(search).not.toHaveBeenCalled();
  });
});

describe('the picker', () => {
  it('asks the server for its one kind, then by the typed title', async () => {
    const { search } = renderPalette();
    fireEvent.click(chip('doc'));
    await waitFor(() => expect(search).toHaveBeenCalledWith('doc', ''));
    fireEvent.change(screen.getByTestId('attach-palette-search'), { target: { value: 'design' } });
    await waitFor(() => expect(search).toHaveBeenCalledWith('doc', 'design'));
    expect(screen.getByTestId('attach-palette-empty').textContent).toContain('design');
  });

  it('shows only candidates that pass the check: right kind, not the anchor, not linked', async () => {
    const search = vi.fn(async () => [
      summary('doc-1', 'doc', 'Design notes'),
      summary('doc-2', 'doc', 'Already here'),
      summary(ANCHOR, 'doc', 'The anchor itself'),
      summary('task-9', 'task', 'Wrong kind'),
    ]);
    renderPalette({ search, linkedIds: new Set(['doc-2']) });
    fireEvent.click(chip('doc'));
    await waitFor(() => expect(screen.getAllByTestId('attach-palette-option')).toHaveLength(1));
    expect(screen.getByTestId('attach-palette-option').textContent).toContain('Design notes');
  });

  it('links a pick with the row, closes and asks for a refetch', async () => {
    const peer = summary('mem-1', 'memory', 'tokens.css is verbatim');
    const search = vi.fn(async () => [peer]);
    const { link, onLinked } = renderPalette({ search });
    fireEvent.click(chip('memory'));
    fireEvent.click(await screen.findByTestId('attach-palette-option'));
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
    expect(link).toHaveBeenCalledWith(rowOf('memory'), peer);
    expect(screen.queryByTestId('attach-palette-picker')).toBeNull();
  });

  it('picks with the keyboard and closes on Escape', async () => {
    const search = vi.fn(async () => [
      summary('tm-1', 'team_member', 'Ada'),
      summary('tm-2', 'team_member', 'Grace'),
    ]);
    const { link } = renderPalette({ search });
    fireEvent.click(chip('team_member'));
    await screen.findAllByTestId('attach-palette-option');
    const input = screen.getByTestId('attach-palette-search');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(link).toHaveBeenCalledTimes(1));
    expect((link.mock.calls[0] as unknown as [AttachPaletteRow, EntitySummary])[1].id).toBe('tm-2');

    fireEvent.click(chip('work_session'));
    fireEvent.keyDown(await screen.findByTestId('attach-palette-search'), { key: 'Escape' });
    expect(screen.queryByTestId('attach-palette-picker')).toBeNull();
  });

  it('says why a refused link failed, from a closed vocabulary, and stays open', async () => {
    const search = vi.fn(async () => [summary('sk-1', 'skill', 'refactor')]);
    const link = vi.fn(async () => {
      throw Object.assign(new Error('edge type equips does not accept /secret/path'), { code: 'invalid_input' });
    });
    renderPalette({ search, link });
    fireEvent.click(chip('skill'));
    fireEvent.click(await screen.findByTestId('attach-palette-option'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The node does not accept this link for this kind.');
    expect(screen.getByTestId('attach-palette-picker')).toBeTruthy();
  });

  it('offers ＋ New only where the row allows it and the host can do it', async () => {
    const create = vi.fn(async (_title: string) => {});
    const createFor = vi.fn((row: AttachPaletteRow) => (row.kind === 'skill' || row.kind === 'doc' ? create : undefined));
    const { onLinked } = renderPalette({ createFor });

    // Skills are pick-only by the registry, whatever the host would offer.
    fireEvent.click(chip('skill'));
    await screen.findByTestId('attach-palette-picker');
    expect(screen.queryByTestId('attach-palette-new')).toBeNull();

    // Drawings may be created, but this host cannot: no control.
    fireEvent.click(chip('drawing'));
    await screen.findByTestId('attach-palette-picker');
    expect(screen.queryByTestId('attach-palette-new')).toBeNull();

    // Docs: allowed and wired, and the typed text is the title.
    fireEvent.click(chip('doc'));
    fireEvent.change(await screen.findByTestId('attach-palette-search'), { target: { value: 'Design notes ' } });
    const make = screen.getByTestId('attach-palette-new');
    expect(make.textContent).toContain('New doc');
    fireEvent.click(make);
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith('Design notes');
  });
});

// ---------------------------------------------------------------------------

function detailWith(edges: Array<{ id: string; type: string; out: boolean; peer: EntitySummary }>): EntityDetail {
  const base = fixtureDetails[taskUuidTitle.id]!;
  const self = summary(base.id, 'task', 'the anchor');
  const group = (out: boolean) => {
    const byType = new Map<string, Array<{ id: string; source: EntitySummary; target: EntitySummary }>>();
    for (const e of edges.filter((edge) => edge.out === out)) {
      const list = byType.get(e.type) ?? [];
      list.push({ id: e.id, source: out ? self : e.peer, target: out ? e.peer : self });
      byType.set(e.type, list);
    }
    return [...byType].map(([type, list]) => ({ type, edges: list, total: list.length }));
  };
  return {
    ...base,
    connections: { ...base.connections, outgoing: group(true), incoming: group(false) },
  } as unknown as EntityDetail;
}

describe('what the palette has linked', () => {
  const doc = summary('doc-1', 'doc', 'Design notes');
  const mem = summary('mem-1', 'memory', 'tokens.css is verbatim');
  const session = summary('ws-1', 'work_session', 'a run');
  const blockedTask = summary('task-2', 'task', 'a related task');
  const detail = detailWith([
    { id: 'e-doc', type: 'attached_to', out: false, peer: doc },
    { id: 'e-mem', type: 'remembers', out: true, peer: mem },
    { id: 'e-ws', type: 'relates_to', out: true, peer: session },
    // relates_to to a kind with no palette row stays in LINKED, not a tile.
    { id: 'e-task', type: 'relates_to', out: true, peer: blockedTask },
    // Wrong direction for the doc row: a doc the task points AT is not attached.
    { id: 'e-doc-out', type: 'attached_to', out: true, peer: summary('doc-3', 'doc', 'x') },
  ]);

  it('matches edge type, direction and peer kind', () => {
    expect(paletteLinks(detail, ROWS).map((link) => link.edgeId)).toEqual(['e-mem', 'e-doc', 'e-ws']);
  });

  it('leaves the edge types a block owns to that block', () => {
    const tiles = stripLinks(paletteLinks(detail, ROWS), getKind('task').panel.blocks);
    expect(tiles.map((link) => link.edgeId)).toEqual(['e-doc', 'e-ws']);
  });
});

describe('the strip with a palette', () => {
  const doc = summary('doc-1', 'doc', 'Design notes');
  const links = [{ edgeId: 'e-doc', row: rowOf('doc'), peer: doc }];

  it('moves ＋ Attach into the palette and draws linked entities as tiles', async () => {
    const onOpenEntity = vi.fn();
    const onDetach = vi.fn(async () => {});
    const onDetached = vi.fn();
    render(
      <AttachmentStrip
        anchorId={ANCHOR as never}
        files={[]}
        startUpload={(() => ({})) as never}
        linked={links}
        onOpenEntity={onOpenEntity}
        onDetach={onDetach}
        onDetached={onDetached}
        palette={(attachChip) => <div data-testid="palette-host">{attachChip}</div>}
      />,
    );
    const add = screen.getByTestId('attachment-add');
    expect(screen.getByTestId('palette-host').contains(add)).toBe(true);
    expect(add.textContent).toBe('＋Attach');

    const tile = screen.getByTestId('attachment-entity');
    expect(tile.dataset.kind).toBe('doc');
    fireEvent.click(within(tile).getByRole('button', { name: 'Open Design notes' }));
    expect(onOpenEntity).toHaveBeenCalledWith('doc-1');
    fireEvent.click(screen.getByTestId('attachment-entity-remove'));
    await waitFor(() => expect(onDetached).toHaveBeenCalledTimes(1));
    expect(onDetach).toHaveBeenCalledWith('e-doc');
  });

  it('without a palette, the strip is unchanged', () => {
    render(<AttachmentStrip anchorId={ANCHOR as never} files={[]} startUpload={(() => ({})) as never} />);
    expect(screen.getByTestId('attachment-strip').dataset.idle).toBe('true');
    expect(screen.queryByTestId('attachment-entity')).toBeNull();
  });
});

describe('the port reaches the node through a real seam', () => {
  it('searches by kind and title on the server, bounded', async () => {
    const seam = createFixtureSeam();
    const seen: CollectionQuery[] = [];
    const spied = { ...seam, query: async (q: CollectionQuery) => { seen.push(q); return seam.query(q); } };
    const port = attachmentsPortFromSeam(spied as never, FIXTURE_SPACE_ID);
    await port.search!('doc', 'design');
    await port.search!('doc', '   ');
    expect(seen[0]).toMatchObject({ kinds: ['doc'], filters: { titleContains: 'design' }, limit: PALETTE_SEARCH_LIMIT });
    // Blank text is "most recent", not a filter the server would reject.
    expect(seen[1]!.filters?.titleContains).toBeUndefined();
  });

  it('links with createEdge, and creates-and-attaches in one command', async () => {
    const seam = createFixtureSeam();
    const edges: CreateEdgeInput[] = [];
    const creates: CreateEntityInput[] = [];
    const spied = {
      ...seam,
      commands: {
        ...seam.commands,
        createEdge: async (input: CreateEdgeInput) => { edges.push(input); return seam.commands.createEdge(input); },
        createEntity: async (input: CreateEntityInput) => { creates.push(input); return seam.commands.createEntity(input); },
      },
    };
    const port = attachmentsPortFromSeam(spied as never, FIXTURE_SPACE_ID);
    const task = taskUuidTitle.id;
    const peer = fixtureDetails[taskUuidTitle.id]!.connections.outgoing[0]!.edges[0]!.target.id;
    await act(async () => {
      await port.link!({ srcId: task, dstId: peer, type: 'relates_to' }).catch(() => {});
      await port.createAttached!('doc', task, 'Design notes', 'attached_to');
    });
    // What the node is asked for; whether the fixture accepts a duplicate
    // edge is not the question here.
    expect(edges[0]).toMatchObject({ srcId: task, dstId: peer, type: 'relates_to' });
    expect(creates[0]).toMatchObject({ kind: 'doc', attachTo: { entityId: task, edgeType: 'attached_to' } });
    expect((creates[0] as { parentId?: unknown }).parentId).toBeUndefined();
  });
});
