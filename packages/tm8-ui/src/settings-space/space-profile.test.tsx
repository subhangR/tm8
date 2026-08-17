// @vitest-environment jsdom
/**
 * PROFILE (the space's) — the four defects the 2026-08-16 layout pass fixed,
 * each held by an assertion that fails if it comes back.
 *
 * WHAT THESE TESTS CANNOT SEE, stated so nobody reads more into a green run
 * than is there: jsdom applies no stylesheet, so nothing here measures a
 * pixel, a colour or a gutter. The 18px misalignment that started this was
 * measured in real Chrome (SECTION-CONTRACT.md §8; numbers in
 * `space-profile.css`). What jsdom CAN hold is the DOM-level *cause* of each
 * defect — the self-padding block, the raw ISO string, the ambiguous dash, the
 * inline style — and that is what each test below pins.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SpaceSummary } from '@tm8/contract';
import { shortDate } from '../kit';
import { ProfileSection } from './ProfileSection';

const SPACE: SpaceSummary = {
  id: 'spc_01j9x2k4m7q8r3v5w6y7z8a9b0',
  name: 'atelier',
  description: 'the workshop space',
  memberCount: 3,
  unreadTotal: 0,
  githubRepo: null,
  createdAt: '2026-01-04T09:00:00.000Z',
};

const draw = (space: SpaceSummary | null) =>
  render(<ProfileSection space={space} heading="Profile" />);

describe('Profile — the space profile', () => {
  /**
   * THE GUTTER DEFECT, held at its cause. `.set-stack` carries
   * `padding: 12px var(--set-gutter)` and `SectionFrame`'s `.set-section__pad`
   * carries the same gutter again, so a body built from the stack sat one
   * whole gutter right of its own section title — measured in Chrome at
   * 900x600: title x=196, first body label x=214.
   *
   * The rule is "the frame owns the only gutter", and the way that rule breaks
   * is a self-padding block getting nested back inside the padded body. So
   * that is what is asserted, rather than a computed padding jsdom would
   * report as '' either way.
   */
  it('adds no second gutter inside the frame’s padded body', () => {
    const { container } = draw(SPACE);
    const padded = container.querySelector('.set-section__pad');
    expect(padded).toBeTruthy();
    expect(padded!.querySelector('.set-stack')).toBeNull();
    expect(container.querySelector('.set-space-profile')).toBeTruthy();
  });

  /** Same rule, same reason, for the absent state — `.set-absent` pads itself
   *  by 16px, which is both a second gutter AND a different one from the 18px
   *  the rest of the section lines up on. Neutralised by this section's own
   *  wrapper, since `settings.css` belongs to twelve lanes at once. */
  it('states an unresolved space, inside this section’s own wrapper', () => {
    const { container, getByTestId } = draw(null);
    expect(getByTestId('section-absent')).toBeTruthy();
    expect(container.querySelector('.set-space-profile__absent .set-absent')).toBeTruthy();
  });

  /**
   * THE RAW ISO DEFECT. `Created` rendered `space.createdAt` straight through:
   * `2026-01-04T09:00:00.000Z`, shown to a human. `kit/time.ts` is the app's
   * one formatter and its own header already forbids this — the section simply
   * was not going through it.
   */
  it('never shows a raw ISO timestamp, and keeps the exact instant on hover', () => {
    const { container } = draw(SPACE);
    expect(container.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(container.textContent).not.toContain(SPACE.createdAt);

    const created = [...container.querySelectorAll('.set-space-profile__k')].find((k) =>
      /created/i.test(k.textContent ?? ''),
    );
    const value = created?.nextElementSibling;
    expect(value?.textContent).toBe(shortDate(SPACE.createdAt));
    // The short form is only safe because the precise one is a hover away.
    expect(value?.getAttribute('title')).toBeTruthy();
  });

  /**
   * THE AMBIGUOUS DASH. An absent `githubRepo`/`description` rendered `—`,
   * which is exactly what a field whose value IS an em dash renders. Absence
   * now says a word and carries `data-unset`, so neither a person nor a test
   * can confuse the two.
   */
  it('distinguishes an empty field from a field containing a dash', () => {
    const { container } = draw({ ...SPACE, githubRepo: null, description: '' });
    const unset = container.querySelectorAll('[data-unset="true"]');
    // Both absent fields: the repo and the description.
    expect(unset).toHaveLength(2);
    for (const el of unset) expect(el.textContent).not.toBe('—');

    // And a space that genuinely IS named with a dash reads as content, with
    // nothing marked absent.
    const dashed = draw({ ...SPACE, githubRepo: '—', description: '—' });
    expect(dashed.container.querySelectorAll('[data-unset="true"]')).toHaveLength(0);
  });

  /**
   * THE FLAT LIST. Name and description were rows one and two of five
   * identical `.set-kv` pairs — the DTO's shape, not the space's identity.
   * They are now a heading and its prose, above the record rather than inside
   * it.
   */
  it('gives the space’s identity weight above the record fields', () => {
    const { container } = draw(SPACE);
    const name = container.querySelector('.set-space-profile__name');
    expect(name?.tagName).toBe('H3');
    expect(name?.textContent).toBe('atelier');
    expect(container.querySelector('.set-space-profile__about')?.textContent).toBe(
      'the workshop space',
    );

    // The record is a real description list, and the identity is not in it.
    const record = container.querySelector('dl.set-space-profile__record');
    expect(record).toBeTruthy();
    expect(record!.textContent).not.toContain('atelier');
    expect([...record!.querySelectorAll('dt')].map((d) => d.textContent)).toEqual([
      'Members',
      'Repo',
      'Created',
      'Space id',
    ]);
  });

  /** The one action was positioned by an inline `style={{ paddingTop: 8 }}`,
   *  which is the drift `SECTION-CONTRACT.md` §2 names by name. Nothing this
   *  section renders carries a style attribute now. */
  it('positions its refused action with a class, never an inline style', () => {
    const { container, getByRole } = draw(SPACE);
    expect(container.querySelectorAll('[style]')).toHaveLength(0);

    const action = getByRole('button', { name: 'edit space details' });
    expect(action.getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelector('.set-space-profile__actions')?.contains(action)).toBe(true);
  });

  /** `memberCount` rendered as a bare `3`, which needs its label to mean
   *  anything. It says what it counts. */
  it('counts members in words, and agrees with itself at one', () => {
    expect(draw(SPACE).container.textContent).toContain('3 members');
    const one = draw({ ...SPACE, memberCount: 1 }).container.textContent!;
    expect(one).toContain('1 member');
    expect(one).not.toContain('1 members');
  });
});
