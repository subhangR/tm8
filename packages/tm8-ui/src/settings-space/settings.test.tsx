// @vitest-environment jsdom
/**
 * T2 half A — the frames, asserted at LINK LEVEL.
 *
 * The bar this suite enforces, in the user's own program order: every control
 * the canvas draws must EXIST and must either work through the real seam or
 * render disabled-with-reason. ZERO SILENT VOIDS. Fidelity is a later pass's
 * job and nothing here asserts a pixel.
 *
 * Two sweeps carry most of the weight, and both are written as CLASS checks
 * rather than instance checks — the R5 lesson that five dead verbs were one
 * class, invisible while each was inspected alone:
 *
 *   1. EVERY nav destination renders a body with content. Seven of the
 *      oracle's eight nav rows have no drawn body; the failure mode is a nav
 *      row that leads to a blank pane.
 *   2. EVERY enabled control on every frame is on a short, named allowlist of
 *      verbs that genuinely work client-side. Anything else must be
 *      `aria-disabled` with a reason in the DOM.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { resolveMenu } from '../shell/menu-resolve';
import { InvitesPanel, RedeemLanding } from './InviteFrames';
import { MembersSection } from './MembersSection';
import { MenuEditor } from './MenuEditor';
import { SettingsShell } from './SettingsShell';
import { ALL_SETTINGS_REASONS } from './reasons';
import { SPECIMEN_INVITES, SPECIMEN_REDEEM, specimenMembers } from './specimen';
import { SETTINGS_SECTIONS, type SettingsSectionId } from './types';
import type { SettingsPort } from './port';
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

function fakePort(over: Partial<SettingsPort> = {}): SettingsPort {
  return {
    loadSpace: async () => ({
      id: 'specimen-space' as never,
      name: 'atelier',
      description: 'the workshop space',
      memberCount: 3,
      unreadTotal: 0,
      githubRepo: null,
      createdAt: '2026-01-04T09:00:00.000Z',
    }),
    loadMembers: async () => specimenMembers(NOW),
    loadIdentity: async () => IDENTITY,
    loadMenu: async () => resolveMenu(null),
    ...over,
  };
}

/**
 * The verbs that genuinely work on this surface. Anything enabled and not on
 * this list is either a live control that silently does nothing (the R5
 * defect) or a verb somebody wired without saying so.
 */
const LIVE_VERBS = [
  /^Profile$/,
  /^Members & roles$/,
  /^Invites$/,
  /^Task axes$/,
  /^Linked projects$/,
  /^Menu$/,
  /^Custom kinds$/,
  // Agent credentials: the NAV ROW only. Live for the `Your profile` reason,
  // not the `Models` one — the four `credentials.*` operations are real
  // executors on the seam, so every control the injected section draws
  // performs its act completely. The section body itself is owned by
  // `settings-credentials/` and is not injected in this file's renders, so the
  // shell shows its honest not-mounted state here and this sweep sees no
  // control from it.
  /^Agent credentials$/,
  /^Danger zone$/,
  /^＋ Invite$/,
  /^discard$/,
  /^reorder .* — alt\+arrow to move$/,
  /^rename /,
  /^remove /,
  /^＋ view ref$/,
  /^＋ kind ref$/,
  /^＋ group$/,
  /^＋ add child$/,
  /^add group$/,
  /^cancel$/,
  /^add to group$/,
  /^new group name$/,
  /^Your name$/,
  // Your profile (067): the nav row plus the FOUR live controls — live
  // because `identity.profile.update` is a real executor in seam.commands
  // (Amendment 4), the first write this surface has ever been allowed.
  /^Your profile$/,
  /^Display name$/,
  /^Avatar URL$/,
  /^Global id$/,
  /^Save profile$/,
  // Models: the nav row plus every control in the section. Live for a DIFFERENT
  // reason than `Your profile` — not because the seam gained a verb, but because
  // this catalog is browser-local and never asks the seam anything. The guard's
  // rule is "no enabled control promises an act it cannot do", and each of these
  // performs its act completely. The section states its per-browser scope in its
  // own body, which is where that limit belongs.
  /^Models$/,
  /^Model id$/,
  /^Display label$/,
  /^Agent tool$/,
  /^＋ Add model$/,
  /^Edit /,
  /^Hide /,
  /^Delete /,
  /^Reset /,
  /^reset all \(\d+\)$/,
  /^Label for /,
  /^Note for /,
  /^Save$/,
  /^Cancel$/,
];

function sweepEnabledControls(root: HTMLElement) {
  const offenders: string[] = [];
  const controls = root.querySelectorAll('button, [role="button"], input, select');
  for (const el of Array.from(controls)) {
    const disabled =
      (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
    if (disabled) continue;
    const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
    if (!LIVE_VERBS.some((re) => re.test(name))) offenders.push(name || '(unnamed control)');
  }
  return offenders;
}

// ---------------------------------------------------------------------------

describe('the GAP ledger', () => {
  it('every reason names a cause and a remedy', () => {
    expect(ALL_SETTINGS_REASONS.length).toBeGreaterThan(10);
    for (const r of ALL_SETTINGS_REASONS) {
      expect(r.cause.length, `cause too thin: ${r.cause}`).toBeGreaterThan(10);
      expect(r.remedy, `no remedy for: ${r.cause}`).toBeTruthy();
      expect(r.remedy!.length).toBeGreaterThan(15);
    }
  });
});

describe('T2-1a — the settings shell has no dead nav row', () => {
  it('every one of the eight destinations renders a body with content', async () => {
    const { container } = render(<SettingsShell port={fakePort()} />);
    await screen.findByText('Members & roles', { selector: '.set-section__title' });

    for (const section of SETTINGS_SECTIONS) {
      fireEvent.click(screen.getByRole('button', { name: section.label }));
      const body = container.querySelector('.set-body') as HTMLElement;
      const text = (body.textContent ?? '').trim();
      // THE assertion this suite exists for: a nav row that leads nowhere.
      expect(text.length, `section '${section.id}' rendered an empty body`).toBeGreaterThan(40);
    }
  });

  it('an externally-owned section says so instead of rendering blank', async () => {
    render(<SettingsShell port={fakePort()} />);
    await screen.findByText('Members & roles', { selector: '.set-section__title' });
    fireEvent.click(screen.getByRole('button', { name: 'Linked projects' }));
    expect(screen.getByTestId('section-absent').textContent).toMatch(/not mounted|another module/i);
  });

  it('an injected section body wins over the placeholder', async () => {
    const sections: Partial<Record<SettingsSectionId, React.ReactNode>> = {
      projects: <p>half B lives here</p>,
    };
    render(<SettingsShell port={fakePort()} sections={sections} />);
    await screen.findByText('Members & roles', { selector: '.set-section__title' });
    fireEvent.click(screen.getByRole('button', { name: 'Linked projects' }));
    expect(screen.getByText('half B lives here')).toBeTruthy();
  });

  it('one failing read does not blank the other three sections', async () => {
    const port = fakePort({ loadMembers: async () => Promise.reject(new Error('boom')) });
    render(<SettingsShell port={port} />);
    await screen.findByTestId('settings-load-error');
    // Profile still has its real facts even though the members read died.
    fireEvent.click(screen.getByRole('button', { name: 'Profile' }));
    expect(screen.getByText('atelier')).toBeTruthy();
  });

  it('Profile shows only what SpaceSummary carries, and refuses editing', async () => {
    render(<SettingsShell port={fakePort()} />);
    await screen.findByText('Members & roles', { selector: '.set-section__title' });
    fireEvent.click(screen.getByRole('button', { name: 'Profile' }));
    expect(screen.getByText('the workshop space')).toBeTruthy();
    const edit = screen.getByRole('button', { name: 'edit space details' });
    expect(edit.getAttribute('aria-disabled')).toBe('true');
  });

  it('Danger zone shows both irreversible acts, both refused', async () => {
    render(<SettingsShell port={fakePort()} />);
    await screen.findByText('Members & roles', { selector: '.set-section__title' });
    fireEvent.click(screen.getByRole('button', { name: 'Danger zone' }));
    for (const name of ['transfer ownership', 'delete this space']) {
      expect(screen.getByRole('button', { name }).getAttribute('aria-disabled')).toBe('true');
    }
  });

  it('no enabled control on the whole shell promises an act the seam cannot do', async () => {
    const { container } = render(<SettingsShell port={fakePort()} />);
    await screen.findByText('Members & roles', { selector: '.set-section__title' });
    for (const section of SETTINGS_SECTIONS) {
      fireEvent.click(screen.getByRole('button', { name: section.label }));
      expect(sweepEnabledControls(container), `on section '${section.id}'`).toEqual([]);
    }
  });
});

describe('T2-1b — members & roles', () => {
  function renderMembers() {
    return render(
      <MembersSection members={specimenMembers(NOW)} identity={IDENTITY} onInvite={() => {}} />,
    );
  }

  it('renders one row per member with its role', () => {
    renderMembers();
    const rows = screen.getAllByTestId('member-row');
    expect(rows).toHaveLength(3);
    // Scoped to the role pill: the refusal REASON also contains the word
    // "owner", and a loose matcher here would pass on the reason instead.
    expect(within(rows[0]).getByText(/owner/, { selector: '.set-role' })).toBeTruthy();
    expect(within(rows[1]).getByText(/admin/, { selector: '.set-role' })).toBeTruthy();
  });

  it('the owner role is LOCKED and the others are refused — never a live select', () => {
    renderMembers();
    const owner = screen.getByRole('button', { name: /role: owner \(locked\)/ });
    expect(owner.getAttribute('aria-disabled')).toBe('true');
    const other = screen.getByRole('button', { name: 'change role from admin' });
    expect(other.getAttribute('aria-disabled')).toBe('true');
    // The reason is IN THE DOM, not only on hover — a reason a screen reader
    // cannot reach is not a reason.
    expect(document.body.textContent).toMatch(/PatchEntityInput/);
  });

  it('self-removal carries the oracle’s own reason, others carry the seam gap', () => {
    renderMembers();
    expect(screen.getByRole('button', { name: 'remove yourself' })).toBeTruthy();
    expect(document.body.textContent).toMatch(/transfer ownership first/);
    expect(screen.getByRole('button', { name: 'remove Noa Lindqvist' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('the handle is REAL for the viewer and hollow for everyone else', () => {
    renderMembers();
    expect(screen.getByText('@ada')).toBeTruthy();
    // Two hollow handles — never a slugged guess like "@noa-lindqvist".
    expect(screen.getAllByText('@—')).toHaveLength(2);
    expect(document.body.textContent).toMatch(/carry no username in this build/);
  });

  it('states that the legend’s fourth role is not representable', () => {
    renderMembers();
    expect(document.body.textContent).toMatch(/viewer is described above but not representable/);
  });

  it('a measured-empty members list says it was measured', () => {
    render(<MembersSection members={[]} identity={IDENTITY} />);
    expect(screen.getByTestId('members-absent').textContent).toMatch(/measured empty/);
  });
});

describe('T2-1c — invites', () => {
  it('PRODUCT renders no invite rows at all, and says why', () => {
    render(<InvitesPanel />);
    expect(screen.queryAllByTestId('invite-row')).toHaveLength(0);
    const absent = screen.getByTestId('invites-absent').textContent ?? '';
    expect(absent).toMatch(/no invite/i);
    expect(absent).toMatch(/missing capability, not a missing wire/);
  });

  it('every invite control exists and every one is refused', () => {
    const { container } = render(<InvitesPanel />);
    expect(screen.getByRole('button', { name: 'create invite link' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(sweepEnabledControls(container)).toEqual([]);
  });

  it('the specimen list renders active and revoked, with the audit row struck through', () => {
    const { container } = render(<InvitesPanel specimen={SPECIMEN_INVITES} />);
    expect(screen.getAllByTestId('invite-row')).toHaveLength(3);
    expect(container.querySelectorAll('.set-invite--revoked')).toHaveLength(1);
    expect(document.body.textContent).toMatch(/joins via it now fail/);
    // Revoked rows keep the audit trail and lose the actions.
    expect(screen.queryByRole('button', { name: 'copy i-30bb' })).toBeNull();
  });
});

describe('T2-1d — redeem landing', () => {
  it('the valid card offers a live name field and a refused join', () => {
    render(<RedeemLanding {...SPECIMEN_REDEEM} />);
    expect(screen.getByTestId('redeem-valid')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'join as member' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    const field = screen.getByLabelText('Your name') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Sam' } });
    expect(field.getAttribute('aria-disabled')).toBeNull();
  });

  it('all three dead states render, and NONE leaks space content', () => {
    for (const state of ['expired', 'revoked', 'used-up'] as const) {
      cleanup();
      render(<RedeemLanding {...SPECIMEN_REDEEM} state={state} />);
      const card = screen.getByTestId(`redeem-${state}`);
      const text = card.textContent ?? '';
      expect(text).toMatch(/ask @ada for a new link/);
      // T4's permission-lost rule: a stranger with a dead link learns nothing.
      expect(text).not.toMatch(/atelier/);
      expect(text).not.toMatch(/3 members/);
      expect(text).not.toMatch(/dockyard/);
    }
  });

  it('omits facts the host did not supply rather than inventing them', () => {
    render(<RedeemLanding spaceName="atelier" invitedBy="@ada" />);
    const text = screen.getByTestId('redeem-valid').textContent ?? '';
    expect(text).toMatch(/@ada invited you/);
    expect(text).not.toMatch(/members/);
    // `node "…"` — not the bare word, which the footnote "your account on this
    // node" legitimately contains.
    expect(text).not.toMatch(/node \u201c/);
  });
});

describe('T2-3 — the menu editor', () => {
  const MENU = resolveMenu(null);

  it('Save is ALWAYS refused, and the reason names the seam ruling', () => {
    render(<MenuEditor menu={MENU} spaceName="atelier" />);
    const save = screen.getByRole('button', { name: 'save menu' });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(document.body.textContent).toMatch(/spaces\.menu\.update/);
  });

  it('the preview mirrors the draft, and a keyboard reorder moves it', () => {
    render(<MenuEditor menu={MENU} spaceName="atelier" />);
    const preview = () => screen.getByTestId('menu-preview').textContent ?? '';
    const before = preview();
    expect(before).toMatch(/Dashboard/);

    // Projects, not Dashboard: revision 5 left Home with a SINGLE item, and
    // moving the only row in a group is correctly a no-op — which would make
    // this test assert that a reorder does nothing.
    const grip = screen.getByRole('button', { name: /reorder Projects/ });
    fireEvent.keyDown(grip, { key: 'ArrowDown', altKey: true });
    expect(preview()).not.toBe(before);
    // The preview footer must now say the change is unsaved.
    expect(document.body.textContent).toMatch(/unsaved changes — preview only/);
  });

  it('discard is dead until there is something to discard, then restores', () => {
    render(<MenuEditor menu={MENU} spaceName="atelier" />);
    const discard = screen.getByRole('button', { name: 'discard' }) as HTMLButtonElement;
    expect(discard.disabled).toBe(true);

    fireEvent.keyDown(screen.getByRole('button', { name: /reorder Projects/ }), {
      key: 'ArrowDown',
      altKey: true,
    });
    expect((screen.getByRole('button', { name: 'discard' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'discard' }));
    expect((screen.getByRole('button', { name: 'discard' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renaming a group commits on ⏎ and cancels on esc', () => {
    render(<MenuEditor menu={MENU} spaceName="atelier" />);
    fireEvent.click(screen.getByRole('button', { name: 'rename Workspace' }));
    const input = screen.getByLabelText('rename Workspace') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'LIBRARY' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('menu-preview').textContent).toMatch(/LIBRARY/);
  });

  it('removing the Settings row REPORTS the refusal instead of silently blocking', () => {
    render(<MenuEditor menu={MENU} spaceName="atelier" />);
    fireEvent.click(screen.getByRole('button', { name: 'remove group Settings' }));
    expect(screen.getByTestId('menu-issue').textContent).toMatch(/Settings row is gone/);
  });

  /**
   * Was: "refused, because the set is exhausted". Menu revision 5 (user ruling
   * 2026-08-01) took Feed, Inbox and Channels off the rail without taking any
   * of them out of `MenuViewRef`, so the picker has refs to offer and the
   * control is LIVE. That is the editor-side proof that those views were
   * unrouted rather than deleted — a viewer who wants one back can put it back.
   */
  it('“＋ view ref” is LIVE, offering the refs revision 5 freed', () => {
    render(<MenuEditor menu={MENU} spaceName="atelier" />);
    const add = screen.getByRole('button', { name: '＋ view ref' });
    expect(add.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(add);
    const options = screen.getAllByRole('button').filter((b) => b.className === 'set-add');
    const labels = options.map((b) => (b.textContent ?? '').trim());
    expect(labels.some((l) => /Feed/i.test(l))).toBe(true);
    expect(labels.some((l) => /Inbox/i.test(l))).toBe(true);
  });

  it('“＋ kind ref” is LIVE, and adding one lands in the preview', () => {
    render(<MenuEditor menu={MENU} spaceName="atelier" />);
    fireEvent.click(screen.getByRole('button', { name: '＋ kind ref' }));
    const options = screen.getAllByRole('button').filter((b) => /^[^＋]/.test(b.textContent ?? ''));
    const pick = options.find((b) => (b.textContent ?? '').trim().length > 2 && b.className === 'set-add');
    expect(pick, 'the picker must offer at least one kind').toBeTruthy();
    const label = (pick!.textContent ?? '').trim().split(' ').slice(1).join(' ');
    fireEvent.click(pick!);
    expect(screen.getByTestId('menu-preview').textContent).toMatch(new RegExp(label));
  });

  it('the child cap control states its own numbers when full', () => {
    render(<MenuEditor menu={MENU} spaceName="atelier" />);
    // Workspace ships 4 of 8 children, so the live control is offered first.
    expect(screen.getByRole('button', { name: '＋ add child' })).toBeTruthy();
    for (let i = 0; i < 8; i += 1) {
      const live = screen.queryByRole('button', { name: '＋ add child' });
      if (!live) break;
      fireEvent.click(live);
    }
    const capped = screen.getByRole('button', { name: 'add child' });
    expect(capped.getAttribute('aria-disabled')).toBe('true');
    expect(capped.textContent).toMatch(/this row has 8 of 8/);
  });

  it('the conflict panel appears only when a NEWER revision is known', () => {
    const { rerender } = render(<MenuEditor menu={MENU} />);
    expect(screen.queryByTestId('menu-conflict')).toBeNull();
    rerender(<MenuEditor menu={MENU} conflictRevision={MENU.config.revision + 1} conflictBy="@noa" />);
    const panel = screen.getByTestId('menu-conflict');
    expect(panel.textContent).toMatch(/@noa/);
    expect(panel.textContent).toMatch(new RegExp(`v${MENU.config.revision + 1}`));
    // Reload has no executor either — refused, not a dead click.
    expect(
      screen.getByRole('button', { name: `reload v${MENU.config.revision + 1}` }).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('the version-locked state makes the whole editor read-only', () => {
    const { container } = render(<MenuEditor menu={MENU} versionLocked />);
    expect(screen.getByTestId('menu-version-lock')).toBeTruthy();
    for (const btn of Array.from(container.querySelectorAll('button'))) {
      const name = (btn.getAttribute('aria-label') ?? btn.textContent ?? '').trim();
      if (name === 'discard') continue; // discard of nothing is already disabled
      if (btn.getAttribute('aria-disabled') === 'true') continue;
      expect(btn.disabled, `'${name}' is still live under a version lock`).toBe(true);
    }
  });

  it('the preview footer says WHERE the menu came from when nothing is unsaved', () => {
    render(<MenuEditor menu={MENU} />);
    expect(document.body.textContent).toMatch(/no saved menu — showing the shipped default/);
  });
});
