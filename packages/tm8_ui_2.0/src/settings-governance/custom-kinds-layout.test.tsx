// @vitest-environment jsdom
/**
 * THE LAYOUT CONTRACT for the `kinds` settings section — the half of
 * 2026-08-16's "settings page is fully fucked, not properly laid out" that a
 * DOM test can actually hold.
 *
 * WHAT IT CANNOT HOLD, said plainly so nobody reads a green run here as proof
 * of a layout: jsdom loads no stylesheets and runs no layout engine, so every
 * width, every wrap and every clip in this section was measured in real Chrome
 * per SECTION-CONTRACT.md §8, not here. At 1508x882 and at 900x600 the section
 * showed one scroller, zero clipped controls and `scrollWidth === clientWidth`
 * on the document; the numbers are in the PR body.
 *
 * WHAT IT DOES HOLD is the structural half, which is exactly what drifted
 * across twelve independently-transcribed sections: whether this one is a
 * SECTION at all, or still the review-board SCREEN it was written as.
 *
 * A separate file from `governance.test.tsx` on purpose. That file is shared
 * with the two sibling governance screens, which are being reworked in
 * parallel lanes right now; a new `describe` in it is a merge conflict with
 * two other seats for no benefit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import type { EntityKindDef } from '@tm8/contract';
import { CUSTOM_KINDS_HEADING, CustomKindsScreen } from './CustomKindsScreen';

afterEach(cleanup);

const mount = (kinds: readonly EntityKindDef[] = []) =>
  render(
    <div className="cv2-root">
      <CustomKindsScreen spaceLabel="space · atelier" kinds={{ phase: 'ready', value: kinds }} />
    </div>,
  );

const kindDef = (over: Partial<EntityKindDef>): EntityKindDef =>
  ({
    id: `k-${over.kind}`,
    kind: 'c:x',
    label: 'X',
    plural: 'Xs',
    icon: '◮',
    origin: 'custom',
    spaceId: 'space-1',
    fieldSchema: [],
    capabilities: {},
    createdAt: '2026-07-29T00:00:00Z',
    ...over,
  }) as EntityKindDef;

describe('the kinds section is a SECTION, not a screen', () => {
  it('renders the shell frame — one head with the heading, and exactly one scroller', () => {
    const { container } = mount();
    expect(container.querySelector('.set-section__title')?.textContent).toBe(
      CUSTOM_KINDS_HEADING,
    );
    // Exactly one. Zero means content runs under the card's `overflow: hidden`
    // and is unreachable on a short window; two nested means the outer takes
    // the overflow and the inner silently clips (SECTION-CONTRACT.md §3).
    expect(container.querySelectorAll('.set-section__scroll')).toHaveLength(1);
    expect(container.querySelectorAll('.set-section__head')).toHaveLength(1);
  });

  it('carries NO page frame of its own — the double-frame this section had', () => {
    const { container } = mount();
    // `.gov-screen` is the review-board frame: its own `padding` inside the
    // shell's own gutters, and three `flex: 1 1 340px` columns inside a card
    // that stops at 1080px less a 160px nav.
    expect(container.querySelector('.gov-screen')).toBeNull();
    expect(container.querySelector('.gov-col')).toBeNull();
    // …and the body it does render is inside the frame's scroller, not beside
    // it. A section that re-typed the divs would fail this.
    const scroll = container.querySelector('.set-section__scroll') as HTMLElement;
    expect(scroll.querySelector('[data-testid="custom-kinds-screen"]')).not.toBeNull();
  });

  it('states the empty case as a real absence, not a blank pane', () => {
    const { container } = mount();
    const absent = container.querySelector('[data-testid="section-absent-kinds"]');
    expect(absent).not.toBeNull();
    expect(absent!.querySelector('.set-absent__head')?.textContent).toContain(
      'no custom kinds',
    );
    // It says WHY, not only THAT — the core kinds are not missing, they are
    // deliberately not listed, and a reader who is not told that will look for
    // them.
    expect(absent!.querySelector('.set-absent__why')?.textContent).toContain('core kinds');
  });

  it('drops the absence the moment the space has a kind', () => {
    const { container } = mount([kindDef({ kind: 'c:incident' })]);
    expect(container.querySelector('[data-testid="section-absent-kinds"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="existing-kind-row"]')).toHaveLength(1);
  });

  it('groups its fields and NAMES the groups, in the a11y tree', () => {
    const { container, getAllByRole } = mount();
    const named = getAllByRole('group').map((g) =>
      container.querySelector(`[id="${g.getAttribute('aria-labelledby')}"]`)?.textContent,
    );
    // The flat run of every field the DTO happens to carry, grouped. Identity
    // and Schema are the two the brief asks for by name.
    expect(named).toContain('Identity');
    expect(named).toContain('Schema');
    expect(named.every(Boolean)).toBe(true);
  });

  it('does not scold a pristine form, and does scold a touched one', () => {
    const { container } = mount();
    // Nothing typed: `validateKindDraft` still reports an invalid draft (the
    // payload is withheld and the verdict counts the issues), but no field
    // wears a red error for something its reader has not done yet.
    expect(container.querySelectorAll('[data-testid="draft-issues"]')).toHaveLength(0);
    expect(container.querySelector('[data-testid="draft-verdict"]')?.textContent).toContain(
      'to fix',
    );

    // Type, then clear. `fireEvent.change` to the value the input already has
    // is a no-op in React, so an empty-to-empty change would never mark the
    // field touched and this assertion would pass for the wrong reason.
    const name = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'x' } });
    fireEvent.change(name, { target: { value: '' } });
    expect(
      container.querySelector('[data-testid="draft-issues"]')?.textContent,
    ).toContain('name');
  });

  it('gives the enum values a visible label, not a placeholder that vanishes', () => {
    const { container } = mount();
    fireEvent.click(within(container).getByText('＋ field'));
    const row = container.querySelector('[data-testid="field-row"]') as HTMLElement;
    fireEvent.change(row.querySelector('select') as HTMLElement, { target: { value: 'enum' } });

    const enumRow = container.querySelector('.set-kinds__enum') as HTMLElement;
    expect(enumRow).not.toBeNull();
    expect(enumRow.querySelector('.set-kinds__enum-label')?.textContent).toContain('·');
    // It is a SIBLING sub-row of the field row, not a sixth column only some
    // rows have — that column was what gave every row a different name-input
    // width and put the type/req/remove controls at three different x.
    expect(enumRow.parentElement).toBe(row);
  });
});
