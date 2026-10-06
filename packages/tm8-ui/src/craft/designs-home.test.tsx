// @vitest-environment jsdom
/**
 * THE DESIGNS HOME (Craft → Designs, item 9) and its doors (item 14).
 *
 *  · the grid: one card per design, page-kind marks in page order (folding
 *    past the cap), `N pages · N chats`, edited-ago, the running dot;
 *  · ONE empty state, and a no-match line that is not a second one;
 *  · + New design creates through the source and opens the new design;
 *  · the seam source reads designs (page kinds ride the summary) and counts chats by subject;
 *  · every door into Craft resolves to bare `/craft` — the home.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { EntityId, EntitySummary, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { routeViewOf } from '../domain';
import { build, defaultRoute } from '../routes/codec';
import { CARD_PAGE_MARKS, DesignsHome } from './DesignsHome';
import { designsSourceFromSeam, fixtureDesignsSource, type DesignsSource } from './designs-source';

afterEach(() => cleanup());

const NOW = Date.parse('2026-10-06T12:00:00Z');
const id = (n: number) => `019f98a0-aaaa-bbbb-cccc-${String(n).padStart(12, '0')}` as EntityId;

function seeded() {
  return fixtureDesignsSource([
    {
      id: id(1),
      title: 'Pricing launch',
      pages: [{ kind: 'graph' }, { kind: 'doc' }, { kind: 'artifact' }],
      chatCount: 2,
      activityAt: '2026-10-06T11:55:00Z',
      running: true,
    },
    { id: id(2), title: 'Passkeys', pages: [{ kind: 'graph' }], chatCount: 1, activityAt: '2026-10-04T12:00:00Z' },
  ]);
}

describe('the Designs home grid', () => {
  it('draws one card per design: marks, title, counts, edited-ago, running dot', async () => {
    const view = render(<DesignsHome source={seeded()} onOpenDesign={() => {}} now={NOW} />);
    await waitFor(() => expect(view.getAllByTestId('dsh-card')).toHaveLength(2));
    const [first, second] = view.getAllByTestId('dsh-card');

    expect([...first!.querySelectorAll('[data-kind]')].map((el) => el.getAttribute('data-kind'))).toEqual([
      'graph',
      'doc',
      'artifact',
    ]);
    expect(first!.textContent).toContain('Pricing launch');
    expect(first!.querySelector('[data-testid="dsh-card-meta"]')!.textContent).toBe('3 pages · 2 chats');
    expect(first!.textContent).toContain('edited 5m ago');
    expect(first!.querySelector('[data-testid="dsh-card-live"]')).not.toBeNull();

    /* Singulars read as singulars, and no dot without a live session. */
    expect(second!.querySelector('[data-testid="dsh-card-meta"]')!.textContent).toBe('1 page · 1 chat');
    expect(second!.querySelector('[data-testid="dsh-card-live"]')).toBeNull();
    expect(view.getByTestId('dsh-find')).toBeTruthy();
    expect(view.queryByTestId('dsh-empty')).toBeNull();
  });

  it('folds page marks past the cap into +N', async () => {
    const pages = Array.from({ length: CARD_PAGE_MARKS + 3 }, () => ({ kind: 'doc' as const }));
    const source = fixtureDesignsSource([{ id: id(3), title: 'Big', pages }]);
    const view = render(<DesignsHome source={source} onOpenDesign={() => {}} now={NOW} />);
    await waitFor(() => view.getByTestId('dsh-card'));
    const marks = view.getByTestId('dsh-card-pages');
    expect(marks.querySelectorAll('[data-kind]')).toHaveLength(CARD_PAGE_MARKS);
    expect(marks.textContent).toContain('+3');
  });

  it('shows ONE empty state for a space with no designs, with no search box', async () => {
    const view = render(<DesignsHome source={fixtureDesignsSource()} onOpenDesign={() => {}} />);
    await waitFor(() => view.getByTestId('dsh-empty'));
    expect(view.getAllByTestId('dsh-empty')).toHaveLength(1);
    expect(view.queryByTestId('dsh-grid')).toBeNull();
    expect(view.queryByTestId('dsh-find')).toBeNull();
  });

  it('filters by title; a search that matches nothing is one quiet line', async () => {
    const view = render(<DesignsHome source={seeded()} onOpenDesign={() => {}} now={NOW} />);
    await waitFor(() => expect(view.getAllByTestId('dsh-card')).toHaveLength(2));
    fireEvent.change(view.getByTestId('dsh-find'), { target: { value: 'pass' } });
    expect(view.getAllByTestId('dsh-card')).toHaveLength(1);
    expect(view.getByTestId('dsh-card').textContent).toContain('Passkeys');
    fireEvent.change(view.getByTestId('dsh-find'), { target: { value: 'zzz' } });
    expect(view.getByTestId('dsh-no-match').textContent).toContain('zzz');
    expect(view.queryByTestId('dsh-empty')).toBeNull();
  });

  it('says so when the list cannot load, and retries', async () => {
    const list = vi.fn<DesignsSource['list']>().mockRejectedValueOnce(new Error('down')).mockResolvedValue([]);
    const source: DesignsSource = { list, create: vi.fn(), subscribe: () => () => {} };
    const view = render(<DesignsHome source={source} onOpenDesign={() => {}} />);
    await waitFor(() => view.getByTestId('dsh-error'));
    fireEvent.click(view.getByText('Try again'));
    await waitFor(() => view.getByTestId('dsh-empty'));
  });

  it('opens a design from its card', async () => {
    const onOpen = vi.fn();
    const view = render(<DesignsHome source={seeded()} onOpenDesign={onOpen} now={NOW} />);
    await waitFor(() => expect(view.getAllByTestId('dsh-card')).toHaveLength(2));
    fireEvent.click(view.getAllByTestId('dsh-card')[1]!);
    expect(onOpen).toHaveBeenCalledWith(id(2));
  });

  it('+ New design creates the entity and navigates into it', async () => {
    const source = fixtureDesignsSource();
    const onOpen = vi.fn();
    const view = render(<DesignsHome source={source} onOpenDesign={onOpen} />);
    await waitFor(() => view.getByTestId('dsh-empty'));
    fireEvent.click(view.getByTestId('dsh-new'));
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    const created = onOpen.mock.calls[0]![0] as EntityId;
    expect(source.designs.map((d) => d.id)).toEqual([created]);
    expect(source.designs[0]!.title).toBe('Untitled design');
  });

  it('reports a failed create and stays on the home', async () => {
    const onNotice = vi.fn();
    const onOpen = vi.fn();
    const source: DesignsSource = {
      list: async () => [],
      create: async () => {
        throw new Error('kind design is not known');
      },
      subscribe: () => () => {},
    };
    const view = render(<DesignsHome source={source} onOpenDesign={onOpen} onNotice={onNotice} />);
    await waitFor(() => view.getByTestId('dsh-empty'));
    fireEvent.click(view.getByTestId('dsh-empty-new'));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith('kind design is not known'));
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('the seam-backed designs source', () => {
  const SPACE = 'space-1' as SpaceId;
  function summary(over: Partial<EntitySummary> & Pick<EntitySummary, 'id' | 'kind'>): EntitySummary {
    return {
      spaceId: SPACE,
      title: 'Row',
      parentId: null,
      position: 0,
      visibility: 'space',
      version: 1,
      activityAt: '2026-10-06T00:00:00Z',
      createdAt: '2026-10-06T00:00:00Z',
      updatedAt: '2026-10-06T00:00:00Z',
      deletedAt: null,
      createdBy: { id: 'm', kind: 'member', displayName: 'M' },
      counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
      state: {},
      badges: {},
      ...over,
    } as unknown as EntitySummary;
  }

  it('reads designs, counts chats by subject and reads each card’s page kinds off its summary', async () => {
    const design = summary({
      id: id(10),
      kind: 'design' as EntitySummary['kind'],
      title: 'Launch',
      state: { kind: 'design', pageCount: 2, pageKinds: ['doc', 'graph'] } as unknown as EntitySummary['state'],
      badges: { workingActors: [{}] } as unknown as EntitySummary['badges'],
    });
    const chats = [
      summary({ id: id(20), kind: 'chat', state: { about: { id: id(10) } } as unknown as EntitySummary['state'] }),
      summary({ id: id(21), kind: 'chat', state: { about: { id: id(10) } } as unknown as EntitySummary['state'] }),
      summary({ id: id(22), kind: 'chat', state: { about: null } as unknown as EntitySummary['state'] }),
    ];
    const query = vi.fn(async (input: { kinds?: string[] }) => ({
      page: { items: input.kinds?.[0] === 'design' ? [design] : chats },
    }));
    /* The summary carries the page kinds (304): no design page, so no detail read. */
    const entity = vi.fn();
    const createEntity = vi.fn(async () => ({ entity: { id: id(40) } }));
    const seam = { query, entity, commands: { createEntity }, onEvent: () => () => {} } as unknown as Seam;

    const source = designsSourceFromSeam(seam, SPACE);
    expect(await source.list()).toEqual([
      {
        id: id(10),
        title: 'Launch',
        pageKinds: ['doc', 'graph'],
        pageCount: 2,
        chatCount: 2,
        activityAt: '2026-10-06T00:00:00Z',
        running: true,
      },
    ]);

    expect(entity).not.toHaveBeenCalled();

    expect(await source.create('Untitled design')).toBe(id(40));
    expect(createEntity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'design', title: 'Untitled design', spaceId: SPACE }));
  });
});

describe('top-level designs only', () => {
  it('a design that is a page of another is reached through its parent, not listed', async () => {
    const source = fixtureDesignsSource([
      { id: id(1), title: 'Pricing launch', pages: [{ kind: 'graph' }, { kind: 'design', id: id(2) }] },
      { id: id(2), title: 'Backend', pages: [{ kind: 'graph' }] },
    ]);
    const view = render(<DesignsHome source={source} onOpenDesign={() => {}} now={NOW} />);
    await waitFor(() => view.getByText('Pricing launch'));
    expect(view.queryByText('Backend')).toBeNull();
  });

  it('the seam source reads a detail only for designs that hold a design page, and drops their nested designs', async () => {
    const design = (n: number, title: string, pageKinds: string[]) =>
      ({
        id: id(n),
        kind: 'design',
        title,
        activityAt: '2026-10-06T00:00:00Z',
        state: { kind: 'design', pageCount: pageKinds.length, pageKinds },
        badges: {},
      }) as unknown as EntitySummary;
    const parent = design(10, 'Pricing launch', ['graph', 'design']);
    const nested = design(11, 'Backend', ['graph']);
    const plain = design(12, 'Passkeys', ['doc']);
    const query = vi.fn(async (input: { kinds?: string[] }) => ({
      page: { items: input.kinds?.[0] === 'design' ? [parent, nested, plain] : [] },
    }));
    const entity = vi.fn(async () => ({
      content: { description: '', pages: [{ id: id(30), kind: 'graph' }, { id: id(11), kind: 'design' }] },
    }));
    const seam = { query, entity, commands: {}, onEvent: () => () => {} } as unknown as Seam;

    const cards = await designsSourceFromSeam(seam, 'space-1' as SpaceId).list();
    expect(cards.map((card) => card.title)).toEqual(['Pricing launch', 'Passkeys']);
    expect(cards[0]!.pageKinds).toEqual(['graph', 'design']);
    expect(entity).toHaveBeenCalledTimes(1);
    expect(entity).toHaveBeenCalledWith(id(10));
  });
});

describe('the doors into Craft land on the home (item 14)', () => {
  it('the Craft view target — the view selector and the Workspace rail tool — is bare /craft', () => {
    const view = routeViewOf({ type: 'view', ref: 'craft' });
    expect(view).toStrictEqual({ view: 'craft' });
    const SPACE = '019f98a0-1111-2222-3333-444455556666' as SpaceId;
    expect(build(defaultRoute(SPACE, view!)).hash).toBe(`#/s/${SPACE}/craft`);
  });
});
