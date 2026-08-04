// @vitest-environment jsdom
/**
 * YOUR PROFILE — the identity-display editor (067 / Identity v2).
 *
 * Two layers under test, deliberately:
 *   1. The COMPONENT: empty-first rendering (every row is NULL today),
 *      client-side globalId validation that reads as a sentence, and a save
 *      that sends ONLY changed fields.
 *   2. The PORT against a REAL fixture seam (port-seam.test.tsx's law): a
 *      profile written through `port.updateProfile` must come BACK out of
 *      `seam.identity()` — no spies proving call shape and nothing else.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { IdentityProfileView } from '@tm8/contract';
import { createFixtureSeam } from '../data';
import type { IdentityView } from '../data/seam';
import { settingsPortFromSeam } from './port';
import {
  GLOBAL_ID_EXPLAINER,
  IdentityProfileSection,
  globalIdProblem,
} from './IdentityProfileSection';

const EMPTY_IDENTITY: IdentityView = {
  identityId: 'id-ada',
  accountId: 'acc-ada',
  username: 'ada',
  displayName: null,
  avatar: null,
  email: null,
  globalId: null,
  isNodeAdmin: false,
  isOwner: true,
  status: 'active',
  actingAs: null,
  memberships: [{ spaceId: 'sp-1', memberId: 'm-ada', role: 'owner' }],
};

function view(over: Partial<IdentityProfileView> = {}): IdentityProfileView {
  return {
    identityId: 'id-ada',
    displayName: null,
    avatar: null,
    email: null,
    globalId: null,
    ...over,
  };
}

describe('globalIdProblem — the constraint as a sentence', () => {
  it('accepts issuer:subject', () => {
    expect(globalIdProblem('google:12345')).toBeNull();
  });
  it.each(['nocolon', 'two:colons ok?  no spaces', ' google:1', 'google: ', ':x', 'g g:1'])(
    'refuses %j with a readable message, not a constraint error',
    (bad) => {
      expect(globalIdProblem(bad)).toMatch(/globalId/);
    },
  );
  it('refuses too-short and too-long', () => {
    expect(globalIdProblem('a:')).not.toBeNull();
    expect(globalIdProblem(`g:${'x'.repeat(220)}`)).toMatch(/200/);
  });
});

describe('IdentityProfileSection — empty is the normal state', () => {
  it('renders the honest absence when identity could not be read', () => {
    render(<IdentityProfileSection identity={null} spaceId="sp-1" onSave={() => Promise.resolve(view())} />);
    screen.getByTestId('profile-absent');
  });

  it('renders all-NULL profile with "not set" placeholders and a monogram, no img', () => {
    const { container } = render(
      <IdentityProfileSection identity={EMPTY_IDENTITY} spaceId="sp-1" onSave={() => Promise.resolve(view())} />,
    );
    expect(screen.getByTestId<HTMLInputElement>('profile-display-name').placeholder).toBe('not set');
    expect(screen.getByTestId<HTMLInputElement>('profile-global-id').placeholder).toContain('not set');
    // Preview falls back to the username and the monogram — no image element.
    expect(screen.getByTestId('profile-preview').textContent).toContain('ada');
    expect(container.querySelector('.kit-avatar__img')).toBeNull();
  });

  it('explains what globalId is — display only, never permissions', () => {
    render(
      <IdentityProfileSection identity={EMPTY_IDENTITY} spaceId="sp-1" onSave={() => Promise.resolve(view())} />,
    );
    screen.getByText(GLOBAL_ID_EXPLAINER);
    expect(GLOBAL_ID_EXPLAINER).toMatch(/not a login/);
    expect(GLOBAL_ID_EXPLAINER).toMatch(/never used to decide\s+permissions/);
  });

  it('refuses a malformed globalId BEFORE the wire and never calls onSave', async () => {
    const onSave = vi.fn(() => Promise.resolve(view()));
    render(<IdentityProfileSection identity={EMPTY_IDENTITY} spaceId="sp-1" onSave={onSave} />);
    fireEvent.change(screen.getByTestId('profile-global-id'), { target: { value: 'not-an-id' } });
    fireEvent.click(screen.getByTestId('profile-save'));
    await screen.findByTestId('profile-problem');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves ONLY the changed fields and reports success', async () => {
    const onSave = vi.fn((input: unknown) =>
      Promise.resolve(view({ displayName: 'Ada Osei', globalId: 'google:12345' })),
    );
    const onSaved = vi.fn();
    render(
      <IdentityProfileSection identity={EMPTY_IDENTITY} spaceId="sp-1" onSave={onSave} onSaved={onSaved} />,
    );
    fireEvent.change(screen.getByTestId('profile-display-name'), { target: { value: 'Ada Osei' } });
    fireEvent.change(screen.getByTestId('profile-global-id'), { target: { value: 'google:12345' } });
    fireEvent.click(screen.getByTestId('profile-save'));
    await screen.findByTestId('profile-saved');
    expect(onSave).toHaveBeenCalledWith({ displayName: 'Ada Osei', globalId: 'google:12345' });
    expect(onSaved).toHaveBeenCalled();
  });

  it('a no-change save is refused locally — nothing to write, nothing sent', async () => {
    const onSave = vi.fn(() => Promise.resolve(view()));
    render(<IdentityProfileSection identity={EMPTY_IDENTITY} spaceId="sp-1" onSave={onSave} />);
    fireEvent.click(screen.getByTestId('profile-save'));
    await screen.findByTestId('profile-problem');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('a server refusal renders as a visible refusal, not a silent nothing', async () => {
    const onSave = vi.fn(() => Promise.reject(new Error('conflict: global id already bound')));
    render(<IdentityProfileSection identity={EMPTY_IDENTITY} spaceId="sp-1" onSave={onSave} />);
    fireEvent.change(screen.getByTestId('profile-display-name'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByTestId('profile-save'));
    const refusal = await screen.findByTestId('profile-refused');
    expect(refusal.textContent).toContain('conflict: global id already bound');
  });

  it('previews the avatar URL through the shared Avatar (fallback machinery included)', () => {
    const withAvatar = { ...EMPTY_IDENTITY, avatar: 'https://example.test/ada.png' };
    const { container } = render(
      <IdentityProfileSection identity={withAvatar} spaceId="sp-1" onSave={() => Promise.resolve(view())} />,
    );
    expect(
      container.querySelector('.kit-avatar__img')?.getAttribute('src'),
    ).toBe('https://example.test/ada.png');
  });
});

describe('the port writes a real profile through a real seam', () => {
  it('updateProfile round-trips: identity() answers with what was written', async () => {
    const seam = createFixtureSeam();
    const spaces = await seam.spaces();
    const port = settingsPortFromSeam(seam, spaces[0].id);

    const written = await port.updateProfile({
      displayName: 'Ada Osei',
      avatar: 'https://example.test/ada.png',
      globalId: 'google:12345',
    });
    expect(written.globalId).toBe('google:12345');

    const identity = await port.loadIdentity();
    expect(identity.displayName).toBe('Ada Osei');
    expect(identity.avatar).toBe('https://example.test/ada.png');
    expect(identity.globalId).toBe('google:12345');
  });

  it('the seam refuses the malformed globalId the DB constraint would refuse', async () => {
    const seam = createFixtureSeam();
    const spaces = await seam.spaces();
    const port = settingsPortFromSeam(seam, spaces[0].id);
    await expect(port.updateProfile({ globalId: 'no colon here' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});
