/**
 * The Home icon rail's composition — and specifically the `chat` ROW.
 *
 * Task 01a070c4 (2026-09-05) moved the chat entity list's door: it was a top
 * tab (shipped menu revision 22 / migration 180) and it is now a rail row. The
 * tab's removal is pinned in `menu.test.ts`, `shell/menu-resolve.test.ts` and
 * the server's `menu-seeder-parity.pg.test.ts`; THIS file pins the other half,
 * because a lane that deleted the tab and forgot the row would leave the chat
 * list with no door at all and every one of those three suites would stay
 * green about it.
 */
import { describe, expect, it } from 'vitest';
import { collectionKinds } from './registry';
import { homeRailGroups, homeRootKinds, isHomeRootKind } from './home-rail';

describe('the Home icon rail', () => {
  it('LEADS the Work group with `chat` — the door the top tab used to be', () => {
    const work = homeRailGroups().find((group) => group.id === 'work');
    expect(work).toBeTruthy();
    expect(work?.kinds[0]?.kind).toBe('chat');
    // The row a viewer can actually read: collapsed the rail keeps the word
    // beneath the mark (#269), and `labelPlural` is that word.
    expect(work?.kinds[0]?.labelPlural).toBe('Chats');
  });

  it('places `chat` deliberately rather than leaving it under "More"', () => {
    // BEFORE this lane `chat` was in no spine group, so it fell into the
    // catch-all — a real row, but filed beside whatever custom kinds a space
    // happens to have. That state passes any "is chat somewhere in the rail"
    // check, which is why this asserts the negative directly.
    const more = homeRailGroups().find((group) => group.id === 'more');
    expect(more?.kinds.map((config) => config.kind) ?? []).not.toContain('chat');
  });

  it('offers `chat` to the kind switcher too — R4: the switcher IS the rail flattened', () => {
    expect(homeRootKinds().map((config) => config.kind)).toContain('chat');
    expect(isHomeRootKind('chat')).toBe(true);
    // The construction R4 rests on, asserted rather than assumed: one table
    // feeds both, so neither can drift from the other.
    expect(homeRootKinds()).toEqual(homeRailGroups().flatMap((group) => [...group.kinds]));
  });

  it('still lists every collection kind exactly once — the spine curates, it never gates (R3)', () => {
    // The guard against "fixing" the row by hand-listing kinds: adding `chat`
    // to a group must not drop it from, or duplicate it in, the population.
    const railed = homeRailGroups().flatMap((group) => group.kinds.map((config) => config.kind));
    expect([...railed].sort()).toEqual(collectionKinds().map((config) => config.kind).sort());
    expect(new Set(railed).size).toBe(railed.length);
  });
});
