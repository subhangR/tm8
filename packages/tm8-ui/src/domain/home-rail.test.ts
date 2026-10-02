/**
 * The Home icon rail's composition.
 *
 * Task 01a070c4 (2026-09-05) moved the chat entity list's door: it was a top
 * tab (shipped menu revision 22 / migration 180) and it is now a rail row. The
 * tab's removal is pinned in `menu.test.ts`, `shell/menu-resolve.test.ts` and
 * the server's `menu-seeder-parity.pg.test.ts`; THIS file pins the other half,
 * because a lane that deleted the tab and forgot the row would leave the chat
 * list with no door at all and every one of those three suites would stay
 * green about it.
 *
 * Task 01a0ada5 (2026-09-17) re-cut the spine from three groups to seven and
 * withheld one kind. Both halves are pinned here, and for the same reason: the
 * rail is the ONLY door to most of these populations, so "it still renders"
 * is not the property worth asserting — WHICH rows, in WHICH order, under
 * WHICH heading is.
 *
 * Task 01a0e036 (owner ruling 2026-09-27) ended the withholding: Home lists
 * EVERY kind. The four formerly withheld kinds sit in an eighth group, Setup,
 * and the assertions below pin that no kind is gated any more.
 */
import { describe, expect, it } from 'vitest';
import { collectionKinds } from './registry';
import {
  homeRailGroups,
  homeRootKinds,
  isHomeRootKind,
} from './home-rail';

const kindsOf = (id: string) =>
  homeRailGroups().find((group) => group.id === id)?.kinds.map((config) => config.kind);

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
    // BEFORE that lane `chat` was in no spine group, so it fell into the
    // catch-all — a real row, but filed beside whatever custom kinds a space
    // happens to have. That state passes any "is chat somewhere in the rail"
    // check, which is why this asserts the negative directly.
    expect(kindsOf('more') ?? []).not.toContain('chat');
  });

  it('offers `chat` to the kind switcher too — R4: the switcher IS the rail flattened', () => {
    expect(homeRootKinds().map((config) => config.kind)).toContain('chat');
    expect(isHomeRootKind('chat')).toBe(true);
    // The construction R4 rests on, asserted rather than assumed: one table
    // feeds both, so neither can drift from the other.
    expect(homeRootKinds()).toEqual(homeRailGroups().flatMap((group) => [...group.kinds]));
  });

  /*
   * THE 01a0ada5 SPINE, GROUP BY GROUP.
   *
   * Asserted as exact arrays rather than "contains", because every defect this
   * ruling named survives a containment check: nine kinds under one "Work"
   * label contains all four of the Work group's kinds, and a rail that lists
   * `commit` somewhere contains `commit`. The complaint was never about
   * membership — it was that the ORDER and the HEADINGS carried no meaning.
   */
  it('cuts eight groups, in the ruled order, each under its own heading', () => {
    expect(homeRailGroups().map((group) => [group.id, group.label])).toEqual([
      ['work', 'Work'],
      ['agents', 'Agents'],
      ['content', 'Content'],
      ['structure', 'Structure'],
      ['people', 'People'],
      ['code', 'Code'],
      ['setup', 'Setup'],
      ['beta', 'Beta'],
    ]);
  });

  it('seats each group exactly as ruled', () => {
    expect(kindsOf('work')).toEqual(['chat', 'story', 'task', 'work_session', 'form', 'project']);
    expect(kindsOf('agents')).toEqual(['team_member', 'skill', 'memory']);
    expect(kindsOf('content')).toEqual(['doc', 'drawing', 'artifact', 'file']);
    expect(kindsOf('structure')).toEqual(['collection', 'graph']);
    expect(kindsOf('people')).toEqual(['member', 'channel']);
    expect(kindsOf('code')).toEqual(['commit', 'pull_request', 'worktree']);
    expect(kindsOf('setup')).toEqual(['interaction_profile', 'credential', 'space_link', 'server']);
    expect(kindsOf('beta')).toEqual(['loop', 'spell', 'container']);
  });

  it('leaves NOTHING in the catch-all — the spine now names every shipped kind', () => {
    /*
     * "More" is the honest home for a kind the spine forgot, and it stays in
     * the code for the next kind somebody adds to the registry. But a shipped
     * rail that USES it is a rail with an unclassified tail, which is the
     * state this ruling ended. Adding a registry kind without seating it here
     * fails this assertion, which is the point: the failure is the reminder.
     */
    expect(homeRailGroups().map((group) => group.id)).not.toContain('more');
  });

  it('every group draws a heading, short enough for the 72px collapsed rail', () => {
    // The rail is collapsed BY DEFAULT, and `HomeRail` draws the eyebrow at
    // both widths so the headings are not invisible in the state most viewers
    // see. A label long enough to ellipsise there is a label that failed.
    for (const group of homeRailGroups()) {
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.label.length).toBeLessThanOrEqual(9);
    }
  });

  /*
   * NOTHING WITHHELD (task 01a0e036). Until 2026-09-27 four kinds were kept
   * off every root surface; the owner ruled Home shows every kind.
   */
  it.each(['interaction_profile', 'credential', 'space_link', 'server'])(
    'offers `%s` on every root surface — rail, switcher, and a selectable root',
    (kind) => {
      const railed = homeRailGroups().flatMap((group) => group.kinds.map((config) => config.kind));
      expect(railed).toContain(kind);
      expect(homeRootKinds().map((config) => config.kind)).toContain(kind);
      // Selectable too: a stored root or a hand-typed `k/` route opens its list
      // instead of falling back to the default root.
      expect(isHomeRootKind(kind)).toBe(true);
    },
  );

  it('lists every collection kind exactly once — no kind is gated', () => {
    // The guard against "fixing" a group by hand-listing kinds: re-cutting the
    // spine must not drop a kind from, or duplicate it in, the population (R3).
    const railed = homeRailGroups().flatMap((group) => group.kinds.map((config) => config.kind));
    const expected = collectionKinds().map((config) => config.kind);
    expect([...railed].sort()).toEqual([...expected].sort());
    expect(new Set(railed).size).toBe(railed.length);
  });
});
