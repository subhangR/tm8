// @vitest-environment jsdom
/**
 * T2-1b — THE LAYOUT PASS, ASSERTED.
 *
 * `settings.test.tsx` holds this section's BEHAVIOUR (which control is refused
 * for which viewer, whose handle is real, what the server's refusal says) and
 * none of that moved. This file holds the LAYOUT, which is what the 2026-08-16
 * pass changed.
 *
 * WHAT JSDOM CAN AND CANNOT HOLD, stated up front because the difference is
 * the reason two of these assertions read the stylesheet as text.
 *
 * jsdom has no layout engine and loads no stylesheet, so it cannot see a
 * height, a column edge, or an overflow — the four defects this pass fixed were
 * all of that kind and were all measured in real Chrome instead
 * (SECTION-CONTRACT.md §8; the numbers are in `members-section.css`'s header
 * and in the PR). What jsdom CAN hold is the STRUCTURE that produces them —
 * that the frame is the shared one, that the table is full-bleed while the
 * prose is measured, that the error line is a row of the grid rather than a
 * cell in it — plus, for the two fixes that live purely in CSS, that the rule
 * carrying the fix is still in the file. A rule asserted by text is a weak
 * test; it is still stronger than deleting the only control that would notice
 * the 241px coming back.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import {
  AGENTS_ARE_NOT_MEMBERS,
  MembersSection,
  ROLES_LEGEND,
  SOLO_SPACE_NOTE,
  longAge,
  roleLegendRows,
} from './MembersSection';
import { absTime, relTime } from '../kit';
import { memberRoles } from './port';
import { specimenMembers } from './specimen';
import type { IdentityView } from '../data/seam';

afterEach(cleanup);

const NOW = Date.parse('2026-07-29T04:00:00.000Z');

const IDENTITY: IdentityView = {
  identityId: 'id-ada',
  accountId: 'acc-ada',
  username: 'ada',
  displayName: 'Ada Osei',
  avatar: null,
  email: null,
  globalId: null,
  isNodeAdmin: false,
  isOwner: true,
  status: 'active',
  actingAs: null,
  memberships: [{ spaceId: 'specimen-space', memberId: 'm-ada', role: 'owner' }],
};

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'members-section.css'),
  'utf8',
);

function renderMembers(count = 3) {
  return render(
    <MembersSection
      members={specimenMembers(NOW).slice(0, count)}
      identity={IDENTITY}
      onInvite={() => {}}
      onRoleChange={async () => undefined}
    />,
  );
}

describe('T2-1b — the section frame', () => {
  it('is the SHARED frame, with exactly one scroller and the heading in its head', () => {
    const { container } = renderMembers();
    expect(container.querySelectorAll('.set-section__scroll')).toHaveLength(1);
    expect(container.querySelector('.set-section__title')?.textContent).toBe('Members & roles');
    // The hand-rolled head this section used to carry is gone: the title is
    // `SectionFrame`'s, so it cannot drift from the other eleven again.
    expect(container.querySelectorAll('.set-section__head')).toHaveLength(1);
  });

  it('puts Invite in the head, where it cannot scroll away from the rows', () => {
    const { container } = renderMembers();
    expect(container.querySelector('.set-section__head .set-chip')).not.toBeNull();
    expect(container.querySelector('.set-section__scroll .set-chip')).toBeNull();
  });

  it('takes a heading from the host, and falls back to the section word', () => {
    const { container } = render(
      <MembersSection members={[]} identity={IDENTITY} heading="Members & roles (staging)" />,
    );
    expect(container.querySelector('.set-section__title')?.textContent).toBe(
      'Members & roles (staging)',
    );
  });
});

describe('T2-1b — two treatments in one body', () => {
  /**
   * THE INTERESTING PART OF THIS SECTION. The rows are a table and must span
   * the card so their hairline reads as a table rule; the legend under them is
   * prose and must not. `SectionFrame` can only do one of those at a time, so
   * the body opts OUT of both (`measure={false} pad={false}`) and the prose
   * carries its own measure.
   */
  it('the body is full-bleed — SectionFrame adds neither measure nor pad', () => {
    const { container } = renderMembers();
    const inner = container.querySelector('.set-section__scroll')?.firstElementChild;
    expect(inner?.className).toBe('');
  });

  it('every row carries its own gutter, so the hairline reaches the card edge', () => {
    // The rule the row is drawn against, since jsdom will not compute it.
    expect(CSS).toMatch(/\.set-members__row,\s*\n\s*\.set-members__head\s*\{[\s\S]*?padding: 0 var\(--set-gutter\)/);
  });

  it('the prose below the rows IS measured, and no prose escapes the wrapper', () => {
    const { container } = renderMembers();
    const measured = container.querySelector('.set-members__measure');
    expect(measured).not.toBeNull();
    // Measured at 866px before this wrapper existed — over --set-measure (860).
    expect(CSS).toMatch(/\.set-members__measure\s*\{[\s\S]*?max-width: var\(--set-measure\)/);
    for (const prose of Array.from(container.querySelectorAll('.set-prose'))) {
      expect(measured!.contains(prose)).toBe(true);
    }
  });
});

describe('T2-1b — the right-hand cluster', () => {
  it('names its columns, so the age is not a bare “3w”', () => {
    renderMembers();
    const head = screen.getByTestId('members-colhead');
    expect(head.getAttribute('aria-hidden')).toBe('true');
    expect([...head.querySelectorAll('.set-members__col')].map((c) => c.textContent)).toEqual([
      'Member',
      'Role',
      'Active',
    ]);
  });

  it('the age spells itself out for a pointer and for a screen reader', () => {
    renderMembers();
    const when = screen.getAllByTestId('member-when')[0]!;
    // The visible cell keeps the oracle's coarse ladder…
    expect(when.textContent).toMatch(/^(now|\d+[mhdw])$/);
    // …and is never the only thing on offer: the accessible name says what it
    // measures and reveals the exact instant behind it.
    expect(when.getAttribute('aria-label')).toMatch(/^last active .+ — .+/);
    expect(when.getAttribute('title')).toBe(when.getAttribute('aria-label'));
  });

  it('the spelled-out age goes through kit/time, not through a second formatter', () => {
    // `kit/timestamp.test.tsx` fails the package on a hand-rolled relative
    // label, and it caught the first draft of `longAge`. Pinned here so the
    // reason this reads the way it does survives the next edit.
    const iso = new Date(NOW - 4 * 60_000).toISOString();
    expect(longAge(iso, NOW)).toBe(`last active ${relTime(iso, NOW)} — ${absTime(iso)}`);
    expect(longAge(iso, NOW)).toContain('4m ago');
  });

  it('longAge never dresses an unparseable stamp as a measurement', () => {
    expect(longAge('not-a-date', NOW)).toBe('last active: not recorded');
  });

  it('the three controls are one column each, in a fixed order', () => {
    renderMembers();
    for (const row of screen.getAllByTestId('member-row')) {
      const cells = [...row.querySelectorAll('.set-members__cell')].map((c) => c.className);
      expect(cells).toEqual([
        'set-members__cell set-members__cell--role',
        'set-members__cell set-members__cell--when',
        'set-members__cell set-members__cell--x',
      ]);
      // One control per role cell, whichever of the three forms it takes —
      // that is what lets the column have a single left and right edge.
      expect(row.querySelectorAll('.set-members__cell--role > *:not([hidden])')).toHaveLength(1);
    }
  });

  it('gives every control in the cluster ONE height, so the rows share a baseline', () => {
    // Measured before: the locked owner pill was 18px and the live select 20px,
    // and the rows were 43/45/45. Both are `--set-members-ctl-h` now (24px),
    // measured 24/24/24 and rows 40/40/40 in Chrome.
    expect(CSS).toMatch(/--set-members-ctl-h:\s*24px/);
    expect(CSS).toMatch(/\.set-members__cell\s*\{[\s\S]*?height: var\(--set-members-ctl-h\)/);
  });
});

describe('T2-1b — the refusal has to be READABLE', () => {
  /**
   * THE 241px. `.hon-tip` is `position: absolute; left: 0; max-width: 260px`,
   * and the two controls carrying one sit at the row's right edge — so in
   * Chrome the remove ✕'s reason rendered 240px PAST the card's right edge,
   * taking 241px of horizontal scroll with it. A refusal you cannot read is
   * the one thing this treatment exists to prevent.
   *
   * After the flip, measured at both 1508×882 and 900×600: the tip's right
   * edge is 19px INSIDE the card and the scroller's horizontal overflow is 0.
   */
  it('opens the row’s tooltips leftwards, so they stay inside the card', () => {
    expect(CSS).toMatch(/\.set-members__row \.hon-tip\s*\{[\s\S]*?right: 0/);
  });

  it('the reason is in the DOM for both refused controls, not only on hover', () => {
    render(<MembersSection members={specimenMembers(NOW)} identity={IDENTITY} />);
    const row = screen.getAllByTestId('member-row')[1]!;
    const remove = within(row).getByRole('button', { name: 'remove Noa Lindqvist' });
    // aria-describedby, resolvable — a reason a screen reader cannot reach is
    // not a reason.
    const described = document.getElementById(remove.getAttribute('aria-describedby')!);
    expect(described?.textContent).toMatch(/attribution target of everything they authored/);
    const role = within(row).getByRole('button', { name: /^role: / });
    expect(
      document.getElementById(role.getAttribute('aria-describedby')!)?.textContent,
    ).toMatch(/needs admin or owner here/);
  });

  it('the server’s refusal is a row of the grid, not a fifth thing on the line', () => {
    // It used to be a flex sibling of the controls, so a sentence competed
    // with them for one line. `grid-column: 1 / -1` gives it its own.
    expect(CSS).toMatch(/\.set-members__error\s*\{[\s\S]*?grid-column: 1 \/ -1/);
  });
});

describe('T2-1b — the legend is a definition list, derived from the oracle', () => {
  it('the parsed rows rebuild L88 byte-for-byte', () => {
    const rebuilt = `${roleLegendRows()
      .map((r) => `${r.role} — ${r.what}`)
      .join(' · ')}. ${AGENTS_ARE_NOT_MEMBERS}`;
    expect(rebuilt).toBe(ROLES_LEGEND);
    // And it really is the oracle's sentence, not something that agrees with
    // itself: pinned verbatim so a reworded legend fails here rather than
    // quietly becoming the new truth.
    expect(ROLES_LEGEND).toBe(
      'owner — everything + transfer/delete · admin — settings, members, trust · member — create/edit entities, run agents · viewer — read-only. Agents are teammates, not members; they hold no role and appear only in Teammates.',
    );
  });

  it('renders four definitions, one per line', () => {
    const { container } = renderMembers();
    const rows = [...container.querySelectorAll('.set-members__legend-row')];
    expect(rows).toHaveLength(4);
    expect(rows[0]!.textContent).toBe('ownereverything + transfer/delete');
  });

  it('greys the role this build cannot store, using the registry’s own vocabulary', () => {
    const { container } = renderMembers();
    const absent = [...container.querySelectorAll('.set-members__legend-role--absent')].map(
      (e) => e.textContent,
    );
    // Whatever the registry does NOT carry — one word today, and if the
    // vocabulary ever gains `viewer` this goes to zero without an edit here.
    expect(absent).toEqual(roleLegendRows().map((r) => r.role).filter((r) => !memberRoles().includes(r)));
    expect(absent.length).toBeGreaterThan(0);
  });
});

describe('T2-1b — the states a real space actually renders', () => {
  it('one member is not an empty state, and says why nothing moves', () => {
    renderMembers(1);
    expect(screen.getAllByTestId('member-row')).toHaveLength(1);
    expect(screen.getByTestId('members-solo').textContent).toBe(SOLO_SPACE_NOTE);
  });

  it('three members get no solo note', () => {
    renderMembers(3);
    expect(screen.queryByTestId('members-solo')).toBeNull();
  });

  it('zero rows is a real SectionAbsent, and the legend still explains the words', () => {
    const { container } = render(<MembersSection members={[]} identity={IDENTITY} />);
    // The shared absence block from `SectionFrame`, not a hand-rolled copy.
    expect(screen.getByTestId('members-absent').className).toBe('set-absent');
    expect(screen.getByTestId('members-absent').textContent).toMatch(/measured empty/);
    expect(screen.queryByTestId('members-colhead')).toBeNull();
    expect(container.querySelectorAll('.set-members__legend-row')).toHaveLength(4);
  });
});
