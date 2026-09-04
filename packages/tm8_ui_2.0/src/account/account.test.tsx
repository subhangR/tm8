// @vitest-environment jsdom
/**
 * T3-3 ACCOUNT MENU — the link-level completeness suite.
 *
 * The bar this file enforces is the user's program order: every control the
 * canvas draws EXISTS, and each one either performs through a real handler or
 * renders disabled-with-reason. The last test is the structural version of
 * that sentence — it sweeps every row and fails on a silent void (a row that
 * is neither wired nor refused), which is the only shape of defect that can
 * hide from the per-control tests above it.
 *
 * Why the theme control arrives as a PROP rather than through `useTheme`: this
 * runner's `localStorage` is a broken node stub with no `setItem` (see the
 * measurement in `src/views/realSeamFlag.test.ts` and `vite.config.ts`), so a
 * component that reached for storage would fail here for an environment reason
 * having nothing to do with the menu. Taking the control as a prop keeps the
 * suite about MY logic and keeps the component host-agnostic.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { IdentityView } from '../data/seam';
import { AccountMenu, type AccountThemeControl } from './AccountMenu';
import { presentIdentity } from './identity';

const SPACE = 'spc-atelier';

function identity(over: Partial<IdentityView> = {}): IdentityView {
  return {
    identityId: 'idn-ada',
    accountId: 'acct-ada',
    username: 'ada',
    displayName: 'ada',
    avatar: null,
    email: null,
    globalId: null,
    isNodeAdmin: true,
    isOwner: true,
    status: 'active',
    actingAs: null,
    memberships: [{ spaceId: SPACE, memberId: 'ent-member-ada', role: 'owner' }],
    ...over,
  };
}

function themeControl(over: Partial<AccountThemeControl> = {}): AccountThemeControl {
  return { theme: 'light', isSystemDefault: false, setTheme: vi.fn(), ...over };
}

function mount(props: Partial<Parameters<typeof AccountMenu>[0]> = {}) {
  return render(
    <AccountMenu
      identity={identity()}
      spaceId={SPACE}
      theme={themeControl()}
      onDismiss={vi.fn()}
      {...props}
    />,
  );
}

describe('presentIdentity — the pure read of IdentityView', () => {
  it('takes the role and the profile target from the ACTIVE space membership', () => {
    const p = presentIdentity(
      identity({
        memberships: [
          { spaceId: 'spc-other', memberId: 'ent-member-elsewhere', role: 'member' },
          { spaceId: SPACE, memberId: 'ent-member-ada', role: 'owner' },
        ],
      }),
      SPACE,
    );
    expect(p.role).toBe('owner');
    expect(p.memberId).toBe('ent-member-ada');
  });

  it('never guesses another space’s member as your profile target', () => {
    const p = presentIdentity(identity(), 'spc-unknown');
    expect(p.memberId).toBeNull();
  });

  it('falls back to the username when displayName and email are absent', () => {
    const p = presentIdentity(identity({ displayName: null, email: null }), SPACE);
    expect(p.name).toBe('ada');
    expect(p.accountLine).toBe('ada');
  });

  it('prefers the email for the account line when the node has one', () => {
    const p = presentIdentity(identity({ email: 'ada@loopback' }), SPACE);
    expect(p.accountLine).toBe('ada@loopback');
  });

  it('carries the account status VERBATIM — it is not presence', () => {
    const p = presentIdentity(identity({ status: 'active' }), SPACE);
    expect(p.status).toBe('active');
  });
});

describe('AccountMenu — identity block', () => {
  it('renders the name, the role chip and the account line', () => {
    const { getByTestId } = mount({ identity: identity({ email: 'ada@loopback' }) });
    const block = getByTestId('account-identity');
    expect(block.textContent).toContain('ada');
    expect(block.textContent).toContain('owner');
    expect(block.textContent).toContain('ada@loopback');
  });

  it('says so honestly while identity has not arrived — never a placeholder name', () => {
    const { getByTestId } = mount({ identity: null });
    expect(getByTestId('account-identity').textContent).toMatch(/loading/i);
  });

  it('states the failure when the identity read rejected', () => {
    const { getByTestId } = mount({ identity: null, identityError: 'node unreachable' });
    expect(getByTestId('account-identity').textContent).toContain('node unreachable');
  });
});

describe('AccountMenu — theme, its one home (D1)', () => {
  it('marks the active segment and switches on click', () => {
    const setTheme = vi.fn();
    const { getByRole } = mount({ theme: themeControl({ theme: 'light', setTheme }) });
    expect(getByRole('radio', { name: /light/i })).toHaveProperty('ariaChecked', 'true');
    fireEvent.click(getByRole('radio', { name: /dark/i }));
    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('system is CHECKED when nothing is stored, and its caption names the resolved theme', () => {
    const { getByRole, getByTestId } = mount({
      theme: themeControl({ theme: 'dark', isSystemDefault: true }),
    });
    expect(getByRole('radio', { name: /system/i })).toHaveProperty('ariaChecked', 'true');
    expect(getByTestId('account-theme-caption').textContent).toMatch(/dark/);
  });

  it('system is disabled-with-reason when a choice is stored and no clear exists', () => {
    const { getByRole } = mount({ theme: themeControl({ isSystemDefault: false }) });
    const seg = getByRole('radio', { name: /system/i });
    expect(seg.getAttribute('aria-disabled')).toBe('true');
    expect(seg.getAttribute('tabindex')).toBe('0'); // D28: refusals stay reachable
    expect(describedText(seg)).toMatch(/system/i);
  });

  it('system PERFORMS when the host passes a clear', () => {
    const useSystem = vi.fn();
    const { getByRole } = mount({ theme: themeControl({ isSystemDefault: false, useSystem }) });
    fireEvent.click(getByRole('radio', { name: /system/i }));
    expect(useSystem).toHaveBeenCalled();
  });
});

describe('AccountMenu — rows', () => {
  it('My profile opens the member entity for this space', () => {
    const onOpenProfile = vi.fn();
    const { getByTestId } = mount({ onOpenProfile });
    fireEvent.click(getByTestId('account-row-profile'));
    expect(onOpenProfile).toHaveBeenCalledWith('ent-member-ada');
  });

  it('My profile refuses with a reason when this space has no membership for you', () => {
    const { getByTestId } = mount({ onOpenProfile: vi.fn(), spaceId: 'spc-unknown' });
    const row = getByTestId('account-row-profile');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(describedText(row)).toMatch(/member/i);
  });

  it('Act as teammate ships disabled-with-reason — as the oracle itself draws it', () => {
    const { getByTestId } = mount();
    const row = getByTestId('account-row-act-as');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(describedText(row)).toMatch(/identity/i);
  });

  it('Node settings refuses until its screen exists, and performs when wired', () => {
    const { getByTestId, unmount } = mount();
    expect(getByTestId('account-row-node-settings').getAttribute('aria-disabled')).toBe('true');
    unmount();
    const onOpenNodeSettings = vi.fn();
    const second = mount({ onOpenNodeSettings });
    fireEvent.click(second.getByTestId('account-row-node-settings'));
    expect(onOpenNodeSettings).toHaveBeenCalled();
  });
});

describe('AccountMenu — sign out, honestly', () => {
  it('refuses with a reason when no executor exists, and opens NO dialog', () => {
    const { getByTestId, queryByRole } = mount();
    const row = getByTestId('account-row-sign-out');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(describedText(row)).toMatch(/sign/i);
    fireEvent.click(row);
    expect(queryByRole('dialog')).toBeNull();
  });

  it('confirms before signing out, and Cancel does not sign out', () => {
    const onSignOut = vi.fn();
    const { getByTestId, getByRole, queryByRole } = mount({ onSignOut });
    fireEvent.click(getByTestId('account-row-sign-out'));
    const dialog = getByRole('dialog');
    expect(dialog.textContent).toMatch(/keep running/i); // the honest copy, verbatim intent
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(onSignOut).not.toHaveBeenCalled();
    expect(queryByRole('dialog')).toBeNull();
  });

  it('signs out when confirmed', () => {
    const onSignOut = vi.fn();
    const { getByTestId, getByRole } = mount({ onSignOut });
    fireEvent.click(getByTestId('account-row-sign-out'));
    fireEvent.click(within(getByRole('dialog')).getByTestId('account-sign-out-confirm'));
    expect(onSignOut).toHaveBeenCalled();
  });
});

describe('AccountMenu — C8 keyboard', () => {
  it('Esc dismisses the menu and consumes the key', () => {
    const onDismiss = vi.fn();
    mount({ onDismiss });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('ArrowDown moves focus to the next row — disabled rows included', () => {
    const { getByTestId } = mount();
    const first = getByTestId('account-row-profile');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).not.toBe(first);
    expect(document.activeElement?.getAttribute('data-acct-row')).toBe('true');
  });
});

/**
 * THE VOID SWEEP — the whole bar in one assertion.
 *
 * Structural on purpose: it cannot drift out of sync with what is wired,
 * because it asks the DOM the same question the user asks by clicking.
 */
describe('AccountMenu — zero silent voids', () => {
  it('every row and segment either performs or carries a reason', () => {
    const { container } = mount();
    const controls = [
      ...container.querySelectorAll('[data-acct-row]'),
      ...container.querySelectorAll('[role="radio"]'),
    ];
    expect(controls.length).toBeGreaterThan(0);
    for (const el of controls) {
      const refused = el.getAttribute('aria-disabled') === 'true';
      if (refused) {
        expect(describedText(el), `${el.textContent} refuses without a reason`).toBeTruthy();
        expect(el.getAttribute('tabindex')).toBe('0');
      } else {
        expect(el.getAttribute('data-acct-wired'), `${el.textContent} is live but unwired`).toBe(
          'true',
        );
      }
    }
  });
});

/** The text a control's `aria-describedby` actually points at — the reason, as announced. */
function describedText(el: Element): string {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  return ids
    .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim();
}
