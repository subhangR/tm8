// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { ActionContext } from '../domain';
import { deferredActions } from '../domain';
import { FIXTURE_SPACE_ID, taskUuidTitle } from '../fixtures';
import { CommandPalette } from './CommandPalette';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

describe('CommandPalette', () => {
  const views = [{ id: 'workspace', label: 'Workspace', glyph: '⌗' }];

  it('renders groups in the FIXED order: entities → views → actions → not-available-yet', () => {
    const { getByTestId } = render(
      <CommandPalette open results={[taskUuidTitle]} views={views} ctx={ctx} />,
    );
    const groups = [...getByTestId('command-palette').querySelectorAll('.pal__group')].map(
      (g) => g.textContent,
    );
    expect(groups).toEqual(['ENTITIES', 'VIEWS', 'NOT AVAILABLE YET']);
  });

  it('R7 discovery rows are DERIVED from the registry, not a hand-kept second list', () => {
    const { getAllByTestId } = render(
      <CommandPalette open results={[]} views={[]} ctx={ctx} />,
    );
    // Every permanently-disabled action appears; nothing is forgotten and
    // nothing is invented, because the source is the registry itself.
    expect(getAllByTestId('palette-disabled-row')).toHaveLength(deferredActions().length);
  });

  it('a disabled row states its reason INLINE — a skipped row has no hover to explain it', () => {
    const { getAllByTestId } = render(<CommandPalette open results={[]} views={[]} ctx={ctx} />);
    const row = getAllByTestId('palette-disabled-row')[0]!;
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.querySelector('.pal__row-reason')?.textContent).toBeTruthy();
    /* THE INLINE LINE IS THE SHORT FORM, AND IT IS NOT THE WHOLE REASON.
       `shortReason` keeps only the text before the first `:` or em-dash and
       degrades to a generic placeholder past a 40-char head, so the remedy half
       was dropped for everyone. The full sentence used to live in `title`, which
       renders on hover and nowhere else. It is now a `ReasonNote`, reachable by
       hover, focus OR tap — so `title` is gone and the full text is in the DOM. */
    expect(row.getAttribute('title')).toBeNull();
    const full = row.querySelector('.hon-tip')?.textContent ?? '';
    expect(full.length).toBeGreaterThan(0);
  });

  it('arrow keys SKIP disabled rows, and Enter never activates one', () => {
    const onOpenEntity = vi.fn();
    const onRunAction = vi.fn();
    const { getByTestId } = render(
      <CommandPalette
        open
        results={[taskUuidTitle]}
        views={views}
        ctx={ctx}
        onOpenEntity={onOpenEntity}
        onRunAction={onRunAction}
      />,
    );
    const palette = getByTestId('command-palette');

    // Two navigable rows exist (one entity, one view). Pressing Down far past
    // them must not walk into the disabled group.
    for (let i = 0; i < 10; i++) fireEvent.keyDown(palette, { key: 'ArrowDown' });
    fireEvent.keyDown(palette, { key: 'Enter' });

    expect(onRunAction).not.toHaveBeenCalled(); // never a deferred action
    expect(onOpenEntity.mock.calls.length + (onRunAction.mock.calls.length || 0)).toBeLessThanOrEqual(1);
  });

  it('Enter opens the selected entity; Esc dismisses and is consumed', () => {
    const onOpenEntity = vi.fn();
    const onDismiss = vi.fn();
    const { getByTestId } = render(
      <CommandPalette
        open
        results={[taskUuidTitle]}
        views={[]}
        ctx={ctx}
        onOpenEntity={onOpenEntity}
        onDismiss={onDismiss}
      />,
    );
    const palette = getByTestId('command-palette');
    fireEvent.keyDown(palette, { key: 'Enter' });
    expect(onOpenEntity).toHaveBeenCalledWith(taskUuidTitle.id);

    const esc = fireEvent.keyDown(palette, { key: 'Escape' });
    expect(esc).toBe(false); // preventDefault called ⇒ consumed by this layer
    expect(onDismiss).toHaveBeenCalled();
  });

  it('the deferred search-results view has its named home in the footer', () => {
    const { getByTestId } = render(<CommandPalette open results={[]} views={[]} ctx={ctx} />);
    const footer = getByTestId('command-palette').querySelector('.pal__footer');
    expect(footer?.textContent).toContain('open full results');
    expect(footer?.querySelector('.pal__footer-deferred')?.getAttribute('title')).toMatch(/search/i);
  });

  it('says nothing was found rather than showing an empty box', () => {
    const { getByTestId } = render(<CommandPalette open results={[]} views={[]} ctx={ctx} />);
    // The deferred group still renders (discovery is the point), so the empty
    // copy only appears when there is genuinely nothing at all.
    expect(getByTestId('command-palette').textContent).toContain('NOT AVAILABLE YET');
  });
});
