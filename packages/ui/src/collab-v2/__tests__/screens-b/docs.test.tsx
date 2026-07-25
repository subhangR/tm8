/**
 * Docs screen — the chapter tree drives the reader, and the reader's margin is
 * the doc's own thread.
 *
 * The seed gives a 4-doc tree (Collab V2 Spec → Entity Graph · UI Contract ·
 * Rollout Notes), the spec at v4 with a margin note from Mira. Everything
 * asserted here is read back from the facade rather than hard-coded, so the
 * test tracks the seed instead of duplicating it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { DocsScreen } from '../../screens/docs';
import type { MockFacade } from '../../mock';
import { createFacade, renderWith, resetStores, screenProps } from './helpers';

let facade: MockFacade;

beforeEach(() => { resetStores(); facade = createFacade(); });
afterEach(() => { cleanup(); resetStores(); });

const reader = (): HTMLElement => document.querySelector('.cv2-docs__reader') as HTMLElement;
const rail = (): HTMLElement => document.querySelector('.cv2-docs__rail') as HTMLElement;
const messageRows = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-cv2-msg]'));

/** The reader's own title, not the markdown body's leading heading. */
const readerTitle = (): string | undefined =>
  (reader().querySelector('.cv2-full__title') as HTMLElement | null)?.textContent ?? undefined;

async function renderDocs() {
  const harness = screenProps(facade);
  const view = renderWith(facade, <DocsScreen {...harness.props} />);
  await screen.findByTestId('docs-screen');
  return { ...harness, view };
}

/** Chapters load lazily, the way any hierarchy tree does — open the root. */
async function expandRoot(): Promise<void> {
  fireEvent.click(await within(rail()).findByRole('button', { name: /expand Collab V2 Spec/i }));
  await within(rail()).findByText('Entity Graph');
}

describe('Docs screen', () => {
  it('renders the chapter tree beside the Z4 reader, rooted on the spec', async () => {
    await renderDocs();

    // The tree sidebar is a CollectionView in tree layout over the doc kind.
    await waitFor(() => expect(within(rail()).getByRole('tree')).toBeTruthy());
    expect(within(rail()).getByText('Collab V2 Spec')).toBeTruthy();

    // The reader is EntityFullView's registry-selected `reader` layout.
    const full = await waitFor(() => {
      const el = reader().querySelector('.cv2-full') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(full.dataset.layout).toBe('reader');
    expect(readerTitle()).toBe('Collab V2 Spec');
  });

  it('swaps the reader and the margin thread anchor when another doc is picked', async () => {
    await renderDocs();

    // The spec's margin note is anchored on the spec doc.
    await waitFor(() => expect(messageRows().length).toBeGreaterThan(0));
    expect(screen.getByText(/two-signal staleness model/)).toBeTruthy();

    // Pick a chapter with no discussion of its own.
    await expandRoot();
    fireEvent.click(within(rail()).getByText('Entity Graph'));

    await waitFor(() => expect(readerTitle()).toBe('Entity Graph'));
    // The margin re-anchored: the spec's note is gone with the spec.
    await waitFor(() => expect(screen.queryByText(/two-signal staleness model/)).toBeNull());
  });

  it('lists the version history of the doc being read', async () => {
    await renderDocs();
    const history = await facade.getVersions(facade.ids.docSpec);
    expect(history.items.length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole('button', { name: /History/i }));

    const panel = await screen.findByLabelText('Version history');
    await waitFor(() => {
      for (const row of history.items) {
        expect(within(panel).getByText(`v${row.version}`)).toBeTruthy();
      }
    });
    // The version in the reader is marked as the one you're looking at.
    const spec = await facade.getEntity(facade.ids.docSpec);
    expect(within(panel).getByText('reading').closest('li')?.textContent)
      .toContain(`v${spec.version}`);
  });

  it('splits to a child doc and moves the selection onto it', async () => {
    await renderDocs();
    const before = await facade.getHierarchy(facade.ids.docSpec);

    fireEvent.click(screen.getByRole('button', { name: /Split to child doc/i }));

    await waitFor(() => expect(readerTitle()).toBe('Untitled chapter'));
    const after = await facade.getHierarchy(facade.ids.docSpec);
    expect(after.children.items.length).toBe(before.children.items.length + 1);
    expect(after.children.items.map((c) => c.title)).toContain('Untitled chapter');
  });

  it('opens the doc being read as a Z3 panel on request', async () => {
    const { opened } = await renderDocs();
    fireEvent.click(screen.getByRole('button', { name: /As panel/i }));
    expect(opened).toEqual([facade.ids.docSpec]);
  });
});
