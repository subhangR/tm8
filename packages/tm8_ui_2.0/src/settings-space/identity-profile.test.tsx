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
  refusalField,
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

/**
 * THE LAYOUT PASS (SECTION-CONTRACT.md, 2026-08-16). jsdom loads no
 * stylesheets, so none of this can assert a pixel — what it CAN hold is the
 * structure the pixels were measured off, so a later edit that reintroduces
 * the bug fails here rather than on someone's screen.
 *
 * Measured in real Chrome at 1508×882 and 900×600 before committing:
 *   - `.set-section__measure` present, 860px content box (was: absent, and the
 *     globalId explainer ran to 883px on the reporter's display).
 *   - longest prose line 388px (was 883px).
 *   - form height 497px in idle, dirty, saving AND saved — identical, so the
 *     confirmation does not move the button (was: `Saved …` mounted above it).
 *   - the save button is on screen at 900×600 without scrolling.
 */
describe('the section is laid out to the contract', () => {
  const render1 = () =>
    render(<IdentityProfileSection identity={EMPTY_IDENTITY} spaceId="sp-1" onSave={() => Promise.resolve(view())} />);

  it('renders SectionFrame: one head, exactly ONE scroller, and the measure on', () => {
    const { container } = render1();
    expect(container.querySelectorAll('.set-section__head')).toHaveLength(1);
    expect(container.querySelectorAll('.set-section__scroll')).toHaveLength(1);
    // A form is prose-plus-controls, so the measure stays on. Its absence was
    // the 883px line.
    expect(container.querySelectorAll('.set-section__measure')).toHaveLength(1);
    screen.getByTestId('account-body');
  });

  it('states the absence through the shared SectionAbsent, inside the frame', () => {
    const { container } = render(
      <IdentityProfileSection identity={null} spaceId="sp-1" onSave={() => Promise.resolve(view())} />,
    );
    // The head must survive the absence — a section that loses its title reads
    // as a blank pane rather than a section with nothing in it.
    expect(container.querySelectorAll('.set-section__head')).toHaveLength(1);
    expect(container.querySelector('.set-absent')).not.toBeNull();
    screen.getByTestId('profile-absent');
  });

  it('explanatory prose comes BEFORE the field it explains, not after it', () => {
    const { container } = render1();
    const note = screen.getByText(GLOBAL_ID_EXPLAINER);
    const input = screen.getByTestId('profile-global-id');
    // DOCUMENT_POSITION_FOLLOWING: the input comes after the explainer.
    expect(note.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and it is group prose, not a caption hung under the box.
    expect(note.className).toContain('set-account__group-note');
    expect(container.querySelectorAll('.set-account__group')).toHaveLength(2);
  });

  it('the four save states share ONE reserved status line — the confirmation adds no element', async () => {
    const { container } = render1();
    const count = () => container.querySelectorAll('.set-account__status').length;
    const actionsChildren = () => container.querySelector('.set-account__actions')!.childElementCount;

    expect(count()).toBe(1); // idle: mounted and empty, holding its own height
    expect(container.querySelector('.set-account__status')!.textContent).toBe('');
    const idleChildren = actionsChildren();

    fireEvent.change(screen.getByTestId('profile-display-name'), { target: { value: 'Ada Osei' } });
    expect(container.querySelector('.set-account__status')!.textContent).toBe('Unsaved changes.');
    expect(count()).toBe(1);

    fireEvent.click(screen.getByTestId('profile-save'));
    await screen.findByTestId('profile-saved');
    expect(count()).toBe(1);
    // The row gained no sibling: this is the assertion that the button did not
    // move when the confirmation arrived.
    expect(actionsChildren()).toBe(idleChildren);
    expect(screen.getByTestId('profile-saved').className).toContain('set-account__status');
  });

  it('the save label does not change width mid-save; the disabled state carries the phase', async () => {
    let settle: (v: IdentityProfileView) => void = () => {};
    render(
      <IdentityProfileSection
        identity={EMPTY_IDENTITY}
        spaceId="sp-1"
        onSave={() => new Promise<IdentityProfileView>((res) => (settle = res))}
      />,
    );
    const button = screen.getByTestId('profile-save');
    const label = button.textContent;
    fireEvent.change(screen.getByTestId('profile-display-name'), { target: { value: 'Ada Osei' } });
    fireEvent.click(button);
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true));
    expect(button.textContent).toBe(label);
    expect(screen.getByText('Saving…').className).toContain('set-account__status');
    settle(view());
    await screen.findByTestId('profile-saved');
  });

  it('an edit retires the previous verdict — a stale "Saved" never outlives its value', async () => {
    render1();
    fireEvent.change(screen.getByTestId('profile-display-name'), { target: { value: 'Ada Osei' } });
    fireEvent.click(screen.getByTestId('profile-save'));
    await screen.findByTestId('profile-saved');
    fireEvent.change(screen.getByTestId('profile-display-name'), { target: { value: 'Ada Osei II' } });
    expect(screen.queryByTestId('profile-saved')).toBeNull();
  });
});

describe('a refusal renders beside the field it concerns', () => {
  it('routes by the field the server names', () => {
    expect(refusalField('conflict: global id already bound')).toBe('globalId');
    expect(refusalField('globalId is already taken')).toBe('globalId');
    expect(refusalField('global_id conflict')).toBe('globalId');
    expect(refusalField('rate limited, try again')).toBe('form');
  });

  it('the client-side globalId refusal renders INSIDE the globalId field', async () => {
    render(
      <IdentityProfileSection identity={EMPTY_IDENTITY} spaceId="sp-1" onSave={() => Promise.resolve(view())} />,
    );
    const input = screen.getByTestId('profile-global-id');
    fireEvent.change(input, { target: { value: 'not-an-id' } });
    fireEvent.click(screen.getByTestId('profile-save'));
    const problem = await screen.findByTestId('profile-problem');
    expect(input.closest('.set-account__field')!.contains(problem)).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('a server refusal naming the global id renders there too, not at the foot of the form', async () => {
    render(
      <IdentityProfileSection
        identity={EMPTY_IDENTITY}
        spaceId="sp-1"
        onSave={() => Promise.reject(new Error('conflict: global id already bound'))}
      />,
    );
    const input = screen.getByTestId('profile-global-id');
    fireEvent.change(input, { target: { value: 'google:12345' } });
    fireEvent.click(screen.getByTestId('profile-save'));
    const refusal = await screen.findByTestId('profile-refused');
    expect(input.closest('.set-account__field')!.contains(refusal)).toBe(true);
    expect(document.querySelector('.set-account__actions')!.contains(refusal)).toBe(false);
  });

  it('a refusal about no field at all belongs to the form, beside the button', async () => {
    render(
      <IdentityProfileSection
        identity={EMPTY_IDENTITY}
        spaceId="sp-1"
        onSave={() => Promise.reject(new Error('the node is read-only right now'))}
      />,
    );
    fireEvent.change(screen.getByTestId('profile-display-name'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByTestId('profile-save'));
    const refusal = await screen.findByTestId('profile-refused');
    expect(document.querySelector('.set-account__actions')!.contains(refusal)).toBe(true);
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
