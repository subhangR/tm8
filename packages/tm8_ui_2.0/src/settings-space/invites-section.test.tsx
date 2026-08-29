// @vitest-environment jsdom
/**
 * T2-1c INVITES — the layout pass (SECTION-CONTRACT, 2026-08-16).
 *
 * `settings.test.tsx` already holds this section's BEHAVIOUR: what create
 * sends, that owner is not an offerable role, that unread ≠ empty. This file
 * holds the things the layout pass changed, and each `it` names a defect that
 * was measured in Chrome before it was written rather than a preference.
 *
 * WHAT NO TEST HERE CAN SEE. jsdom loads no stylesheets, so nothing below
 * asserts a colour, a width or a wrap — those were verified by screenshot at
 * 1508×882 and 900×600 (SECTION-CONTRACT §8) and the numbers are in the PR.
 * What IS assertable is the STRUCTURE those rules hang off: one frame, one
 * scroller, a state word per row, a copy target for the code.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvitesPanel } from './InviteFrames';
import type { SpaceInviteView } from '@tm8/contract';

afterEach(cleanup);

const LIVE: SpaceInviteView = {
  id: 'inv-1',
  code: 'inv_live01',
  role: 'member',
  maxUses: 5,
  uses: 1,
  expiresAt: null,
  revoked: false,
};
/** Budget spent, never revoked — the state that used to be invisible. */
const SPENT: SpaceInviteView = {
  id: 'inv-2',
  code: 'inv_spent1',
  role: 'admin',
  maxUses: 1,
  uses: 1,
  expiresAt: '2026-09-14T10:00:00.000Z',
  revoked: false,
};
const REVOKED: SpaceInviteView = {
  id: 'inv-3',
  code: 'inv_dead01',
  role: 'member',
  maxUses: 25,
  uses: 3,
  expiresAt: null,
  revoked: true,
};

const ALL = [LIVE, SPENT, REVOKED];

describe('the invites section is built on the section frame', () => {
  it('renders exactly one .set-section and exactly one scroller', () => {
    const { container } = render(<InvitesPanel invites={ALL} onCreate={async () => undefined} />);
    // Before: the panel returned a FRAGMENT — head, form and scroller landed
    // as three loose children of `.set-body`, so there was no `.set-section`
    // at all and the shell's flex column was load-bearing by accident.
    expect(container.querySelectorAll('.set-section')).toHaveLength(1);
    expect(container.querySelectorAll('.set-section__scroll')).toHaveLength(1);
    // SECTION-CONTRACT §3: the create form belongs INSIDE the one scroller.
    // It was fixed above it and took 128px of a 407px pane at 900×600.
    const scroll = screen.getByTestId('invites-body');
    expect(scroll.querySelector('.set-invites__form')).toBeTruthy();
    expect(scroll.querySelectorAll('[style*="overflow"]')).toHaveLength(0);
  });

  it('the head carries the tally, so the three counts are legible without scrolling', () => {
    render(<InvitesPanel invites={ALL} />);
    expect(screen.getByTestId('invite-tally').textContent).toBe('1 live · 1 used up · 1 revoked');
  });

  it('an unread list shows NO tally — a count would be a number nobody measured', () => {
    render(<InvitesPanel />);
    expect(screen.queryByTestId('invite-tally')).toBeNull();
    // And the unread block still draws the distinction it always drew.
    const absent = screen.getByTestId('invites-absent').textContent ?? '';
    expect(absent).toMatch(/has not been read/);
    expect(absent).toMatch(/unread, not a measured empty/);
    // The state a viewer is USUALLY in should tell them what to do about it.
    expect(absent).toMatch(/tm8 space invite list/);
  });
});

describe('the three states of one code are each named', () => {
  it('live, used-up and revoked each render their own state word', () => {
    render(<InvitesPanel invites={ALL} onRevoke={async () => undefined} />);
    // The defect: a used-up invite differed from a live one only by a trailing
    // " · used up" inside a 9px grey meta line, and a revoked one was the same
    // row at opacity .7. Opacity is not a state.
    expect(screen.getByTestId('invite-state-live').textContent).toBe('live');
    expect(screen.getByTestId('invite-state-spent').textContent).toBe('used up');
    expect(screen.getByTestId('invite-state-revoked').textContent).toBe('revoked');
    // Three distinct classes, so the stylesheet can give them three tones off
    // the functional ramp rather than three shades of the same grey.
    expect(document.querySelectorAll('.set-invites__state--live')).toHaveLength(1);
    expect(document.querySelectorAll('.set-invites__state--spent')).toHaveLength(1);
    expect(document.querySelectorAll('.set-invites__state--revoked')).toHaveLength(1);
  });

  it('a used-up row stops advertising an expiry that no longer means anything', () => {
    render(<InvitesPanel origin="https://node.example" invites={[SPENT]} />);
    const row = screen.getByTestId('invite-row').textContent ?? '';
    expect(row).toMatch(/its 1 use is spent, so it joins nobody else/);
    // The deadline is a fact about a code that could still be redeemed.
    expect(row).not.toMatch(/expires 2026-09-14/);
  });

  it('the groups are ordered live → used up → revoked, so the actionable rows are first', () => {
    render(<InvitesPanel invites={[REVOKED, SPENT, LIVE]} />);
    const words = [...document.querySelectorAll('.set-invites__state')].map((n) => n.textContent);
    expect(words).toEqual(['live', 'used up', 'revoked']);
  });

  it('a read list with rows but none live says so, and does NOT claim it carries none', () => {
    render(<InvitesPanel invites={[SPENT, REVOKED]} />);
    // Distinct from `invites-none-active`: "everything here is dead" and "this
    // space has never minted one" are different facts about a read list.
    expect(screen.getByTestId('invites-none-live').textContent).toMatch(/used up or revoked/);
    expect(screen.queryByTestId('invites-none-active')).toBeNull();
  });
});

describe('the code is copyable, not just the link', () => {
  it('copies the CODE from the code control and the URL from the link control', async () => {
    const written: string[] = [];
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: {
        writeText: async (t: string) => {
          written.push(t);
        },
      },
    });

    render(<InvitesPanel origin="https://node.example" invites={[LIVE]} />);

    // The code was a `<span>`: the one artefact on this screen whose whole
    // purpose is to leave it could only be taken away by dragging across an
    // 11px monospace string. `tm8 space invite redeem <code>` wants the CODE.
    fireEvent.click(screen.getByTestId('invite-copy-code'));
    await screen.findByText('✓ copied');
    expect(written).toEqual(['inv_live01']);

    fireEvent.click(screen.getByTestId('invite-copy'));
    await screen.findByText('✓ copied');
    expect(written[1]).toBe('https://node.example/join/inv_live01');

    vi.unstubAllGlobals();
  });

  it('a revoked code is NOT offered as a copy target', () => {
    render(<InvitesPanel invites={[REVOKED]} />);
    // Handing somebody a string that `redeem_invite` refuses with 42501 would
    // be handing them a thing that only looks like a capability. The code is
    // still SHOWN — that is how a stale link gets identified — just not armed.
    expect(document.body.textContent).toMatch(/inv_dead01/);
    expect(screen.queryByTestId('invite-copy-code')).toBeNull();
    expect(screen.queryByTestId('invite-copy')).toBeNull();
  });
});

describe('the create form is grouped, and its affordance is a real one', () => {
  it('every field carries a visible label, not only an aria-label', () => {
    render(<InvitesPanel invites={[]} onCreate={async () => undefined} />);
    // Before: a bare row of three selects. The only way to learn the middle
    // one meant "how many people may use it" was to open it.
    const labels = [...document.querySelectorAll('.set-invites__label')].map((n) => n.textContent);
    expect(labels).toEqual(['Role', 'Uses', 'Expiry']);
    for (const id of ['invite-role', 'invite-uses', 'invite-expiry']) {
      expect(screen.getByTestId(id).closest('label')).toBeTruthy();
    }
  });

  it('the live create button wears the brass chip, not `.set-refuse--block`', () => {
    render(<InvitesPanel invites={[]} onCreate={async () => undefined} />);
    const go = screen.getByTestId('invite-create');
    // THE INVERSION THIS FIXES. `.set-refuse--block` sets only `display:block;
    // width:100%` — no fill — so the WORKING button rendered as raw browser
    // chrome while the refused variant inherited honesty.css's brass chip. The
    // refused state looked better designed than the affirmative one.
    expect(go.className).toBe('set-chip');
    expect(go.closest('.set-refuse--block')).toBeNull();
  });

  it('with no create handler the control is still present and still refused — R7', () => {
    render(<InvitesPanel invites={[]} />);
    const refused = screen.getByRole('button', { name: 'create invite link' });
    expect(refused.getAttribute('aria-disabled')).toBe('true');
    // Unavailable ≠ invisible: the reason travels in the DOM, not a tooltip.
    expect(document.body.textContent).toMatch(/needs admin or owner/);
  });
});
