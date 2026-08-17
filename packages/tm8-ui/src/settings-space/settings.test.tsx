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
    // Amendment 11 (114). The invite READ rejects by default, which is not
    // laziness: it is what a plain member gets, because `spaces.invites.list`
    // is admin-only. The shell must render that as "not read" without counting
    // it as a failed settings read, and the default here is what proves it.
    loadInvites: async () => Promise.reject(new Error('space admin required')),
    setMemberRole: async () => ({ patches: [] }) as never,
    createInvite: async () => ({
      id: 'inv-fake', code: 'inv_fake', role: 'member', maxUses: 1, uses: 0,
      expiresAt: null, revoked: false,
    }),
    revokeInvite: async () => ({
      id: 'inv-fake', code: 'inv_fake', role: 'member', maxUses: 1, uses: 0,
      expiresAt: null, revoked: true,
    }),
    updateProfile: async () => ({
      identityId: IDENTITY.identityId, displayName: IDENTITY.displayName,
      avatar: IDENTITY.avatar, email: IDENTITY.email, globalId: IDENTITY.globalId,
    }),
    // W2 — the axis registry. Seeded with the node's own seed so the section
    // renders real rows; the writes echo a plausible row back.
    loadAxes: async () => [
      {
        id: 'axis-type', spaceId: 'specimen-space' as never, name: 'type',
        axisValues: ['default', 'code', 'design', 'review', 'test'],
        kind: 'default' as const, position: 0,
      },
    ],
    createAxis: async (input) => ({
      id: 'axis-new', spaceId: 'specimen-space' as never, name: input.name,
      axisValues: input.axisValues, kind: input.kind, position: input.position,
    }),
    updateAxis: async (axisId, input) => ({
      id: axisId, spaceId: 'specimen-space' as never, name: input.name,
      axisValues: input.axisValues, kind: input.kind, position: input.position,
    }),
    deleteAxis: async (axisId) => ({ axisId }),
    tasksUsingAxis: async () => [],
    // W4 — the workflow registry. Empty is a measured "no rules defined";
    // the section still draws one editor per `type` axis value above.
    loadWorkflows: async () => [],
    upsertWorkflow: async (input) => ({
      id: 'workflow-fake', spaceId: 'specimen-space' as never,
      typeValue: input.typeValue, statuses: input.statuses,
    }),
    deleteWorkflow: async (workflowId) => ({ workflowId }),
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
  // The touch reorder path. Live for exactly the reason the grip beside them is:
  // they move the DRAFT, which is a real act this seam performs — Save is the
  // refused verb here, not the reorder. They exist because HTML5 drag-and-drop
  // fires no events from a finger and alt+arrow needs an alt key, so without
  // them reordering the menu was impossible on a touch device.
  /^move .+ (up|down)$/,
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
  // Task axes (W2): live because `spaces.taskAxes.create|update|delete` are
  // real catalog ops the seam now carries verbs for — the AXES_UNREADABLE
  // refusal these replaced was measured false. The default axis's delete is
  // NOT here: it renders disabled-with-reason (016's refusal, kept by the
  // amended ruling).
  /^axis name$/,
  /^axis values, comma separated$/,
  /^edit$/,
  /^delete$/,
  /^Create axis$/,
  /^Save axis$/,
  // Workflows (W4): the nav row plus every live control in the section —
  // live because `spaces.taskWorkflows.upsert|delete` are real catalog ops
  // (132) the seam carries verbs for. The STRUCTURAL checkboxes
  // ({open,working,done}) are NOT here: they render disabled with the schema
  // reason, exactly as the default axis's delete renders next door.
  /^Workflows$/,
  /^.+ allows .+$/,
  /^Save workflow for /,
  /^remove workflow for /,
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
  // Invites (109 + seam Amendment 11): the nav row plus every control in the
  // section. Live for the SAME reason as `Your profile` and not the `Models`
  // one — `spaces.invites.create` / `.revoke` are real executors on the seam
  // now, so each of these performs its act completely.
  //
  // Worth being precise about what changed, because this list is the record:
  // the invite family was never a missing NODE capability. `create_invite` and
  // `w2_revoke_invite` have been in `007_rpc_catalog.sql` since W1. It was a
  // missing SEAM verb, and `reasons.ts` reported the stronger claim because a
  // screen cannot tell the two apart from where it stands.
  /^invite role$/,
  /^invite use budget$/,
  /^invite expiry$/,
  /^Create invite link$/,
  /^Creating…$/,
  /^copy the join link for /,
  /^revoke inv_/,
  // Members & roles: the live role select, one per editable row. Named for the
  // person it acts on, so an offender in this sweep says whose row it was.
  /^role for /,
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

  /**
   * SUPERSEDED BY 114, and worth saying what it used to assert: "the owner role
   * is LOCKED and the others are refused — never a live select", with the
   * reason text pinned to `/PatchEntityInput/`. That was correct while no
   * membership verb existed. `spaces.members.updateRole` exists now, so the
   * question is no longer "is every control refused" but "is the RIGHT control
   * refused for the RIGHT viewer" — which is a stronger property and is what
   * the three tests below assert.
   */
  it('with no write handler every role renders locked, never a dead select', () => {
    render(<MembersSection members={specimenMembers(NOW)} identity={IDENTITY} />);
    expect(screen.queryAllByTestId('member-role-select')).toHaveLength(0);
    for (const row of screen.getAllByTestId('member-row')) {
      const control = within(row).getByRole('button', { name: /^role: / });
      expect(control.getAttribute('aria-disabled')).toBe('true');
    }
    // The reason reaches the DOM, not only a hover title.
    expect(document.body.textContent).toMatch(/needs admin or owner here/);
  });

  it('an owner gets a live select on every row, including their own', () => {
    render(
      <MembersSection
        members={specimenMembers(NOW)}
        identity={IDENTITY}
        onRoleChange={async () => undefined}
      />,
    );
    // Three rows, three selects: the viewer is the owner here, so nothing is
    // locked — R2's lock is about who is asking, not about which row it is.
    expect(screen.getAllByTestId('member-role-select')).toHaveLength(3);
  });

  it('the last owner cannot be demoted, and the option says which one it is', () => {
    render(
      <MembersSection
        members={specimenMembers(NOW)}
        identity={IDENTITY}
        onRoleChange={async () => undefined}
      />,
    );
    const ownerRow = screen.getAllByTestId('member-row')[0]!;
    const select = within(ownerRow).getByTestId('member-role-select');
    const disabled = [...select.querySelectorAll('option')].filter((o) => o.disabled);
    // Both non-owner options are closed off, because demoting the sole owner
    // would leave the space with none — R3, stated before the click rather
    // than returned as a 42501 after it.
    expect(disabled.map((o) => o.textContent)).toEqual([
      'admin — the only owner',
      'member — the only owner',
    ]);
  });

  it('the write failure is shown in the server’s own words, beside the row', async () => {
    render(
      <MembersSection
        members={specimenMembers(NOW)}
        identity={IDENTITY}
        onRoleChange={async () => {
          throw new Error('a space must keep at least one owner: promote a successor first');
        }}
      />,
    );
    const row = screen.getAllByTestId('member-row')[1]!;
    fireEvent.change(within(row).getByTestId('member-role-select'), { target: { value: 'member' } });
    // Verbatim, not rewritten to "Failed": the sentence is the only part that
    // tells the reader what to do next.
    const alert = await screen.findByTestId('member-role-error');
    expect(alert.textContent).toMatch(/promote a successor first/);
  });

  it('self-removal carries the oracle’s own reason, others carry the seam gap', () => {
    renderMembers();
    expect(screen.getByRole('button', { name: 'remove yourself' })).toBeTruthy();
    expect(document.body.textContent).toMatch(/transfer ownership first/);
    expect(screen.getByRole('button', { name: 'remove Noa Lindqvist' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    // 114 upgraded this reason from a ruling to a measured fact: the member row
    // is the attribution target of everything that person authored, so it
    // cannot be deleted at all.
    expect(document.body.textContent).toMatch(/attribution target of everything they authored/);
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
  /**
   * SUPERSEDED BY 114. This block used to assert "PRODUCT renders no invite
   * rows at all, and says why", pinning the reason text to "missing
   * capability, not a missing wire" — a claim that was half wrong when it was
   * written: the node had `create_invite` and `w2_revoke_invite` in
   * `007_rpc_catalog.sql` the whole time, and only the SEAM was missing. The
   * tests below assert the wired behaviour, and the first one keeps the part
   * that still matters: unread and empty are different answers.
   */
  it('an unread invite list says it is unread, not that there are none', () => {
    render(<InvitesPanel />);
    expect(screen.queryAllByTestId('invite-row')).toHaveLength(0);
    const absent = screen.getByTestId('invites-absent').textContent ?? '';
    expect(absent).toMatch(/has not been read/);
    // The distinction, stated: a plain member's admin-only read rejects, and
    // that is not the same fact as "this space has no invitations".
    expect(absent).toMatch(/unread, not a measured empty/);
  });

  it('a measured-empty list says it was measured', () => {
    render(<InvitesPanel invites={[]} />);
    expect(screen.getByTestId('invites-none-active').textContent).toMatch(/read and carries none/);
  });

  it('with no write handlers every invite control renders refused', () => {
    const { container } = render(<InvitesPanel invites={[]} />);
    expect(screen.getByRole('button', { name: 'create invite link' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(sweepEnabledControls(container)).toEqual([]);
  });

  it('creating an invite sends the role, the budget and a resolved expiry', async () => {
    const calls: unknown[] = [];
    render(
      <InvitesPanel
        invites={[]}
        onCreate={async (input) => {
          calls.push(input);
        }}
      />,
    );
    fireEvent.change(screen.getByTestId('invite-uses'), { target: { value: '5' } });
    fireEvent.change(screen.getByTestId('invite-expiry'), { target: { value: '7' } });
    fireEvent.click(screen.getByTestId('invite-create'));
    await screen.findByTestId('invite-create');

    expect(calls).toHaveLength(1);
    const sent = calls[0] as { role: string; maxUses: number; expiresAt: string | null };
    // The default is the LEAST privileged role: an invitation grants the
    // smallest thing that works, and widening it is one click away.
    expect(sent.role).toBe('member');
    expect(sent.maxUses).toBe(5);
    // Resolved to an absolute instant HERE, at click time — not sent as "7
    // days" for the server to resolve against a different clock.
    expect(Number.isNaN(Date.parse(sent.expiresAt!))).toBe(false);
  });

  it('the role select offers every role except owner — 114 R4', () => {
    render(<InvitesPanel invites={[]} onCreate={async () => undefined} />);
    const options = [...screen.getByTestId('invite-role').querySelectorAll('option')];
    expect(options.map((o) => o.getAttribute('value'))).toEqual(['admin', 'member']);
    // A code travels out of band, so it is worth what the channel it was sent
    // over is worth. Ownership is not something a forwarded link may confer.
    expect(options.some((o) => o.getAttribute('value') === 'owner')).toBe(false);
  });

  it('a live row offers the join link and a real revoke; a revoked row keeps its code', () => {
    const revoked: string[] = [];
    render(
      <InvitesPanel
        origin="https://node.example"
        invites={[
          { id: 'inv-1', code: 'inv_live', role: 'admin', maxUses: 5, uses: 1, expiresAt: null, revoked: false },
          { id: 'inv-2', code: 'inv_dead', role: 'member', maxUses: 1, uses: 0, expiresAt: null, revoked: true },
        ]}
        onRevoke={async (id) => {
          revoked.push(id);
        }}
      />,
    );
    // The link is built from the CURRENT origin, so the sender copies a URL the
    // recipient can actually reach.
    expect(document.body.textContent).toMatch(/https:\/\/node\.example\/join\/inv_live/);
    fireEvent.click(screen.getByTestId('invite-revoke'));
    expect(revoked).toEqual(['inv-1']);

    // The dead row keeps its code, struck through: `redeem_invite` refuses it
    // with 42501, so showing it discloses nothing — and it is the only way
    // somebody holding a link that stopped working can tell which link it was.
    expect(document.body.textContent).toMatch(/inv_dead/);
    expect(screen.queryByRole('button', { name: 'revoke inv_dead' })).toBeNull();
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
  /* The ROW-BEARING fixture: revision 17's shipped default is five railless
     single-view groups, so reorder/rename/caret cases exercise a
     server-authored config that still carries rows — the editor must keep
     editing those. */
  const ROWED = resolveMenu({
    schemaVersion: 1,
    revision: 16,
    groups: [
      { id: 'chats', label: 'Collab', items: [{ type: 'view', ref: 'dashboard' }] },
      {
        id: 'workspace',
        label: 'Work',
        items: [
          {
            type: 'view',
            ref: 'workspace',
            children: [
              { type: 'kind', ref: 'task' },
              { type: 'kind', ref: 'work_session' },
              { type: 'kind', ref: 'doc' },
              { type: 'kind', ref: 'team_member' },
              { type: 'kind', ref: 'memory' },
              { type: 'kind', ref: 'artifact' },
              { type: 'kind', ref: 'loop' },
              { type: 'kind', ref: 'file' },
            ],
          },
          { type: 'kind', ref: 'project' },
          { type: 'kind', ref: 'pull_request' },
          { type: 'kind', ref: 'worktree' },
          { type: 'view', ref: 'git' },
        ],
      },
      {
        id: 'channels',
        label: 'Channels',
        items: [
          { type: 'kind', ref: 'channel' },
          { type: 'view', ref: 'messages' },
        ],
      },
      { id: 'settings', label: 'Settings', items: [{ type: 'view', ref: 'settings' }] },
    ],
  } as never);

  it('Save is ALWAYS refused, and the reason names the seam ruling', () => {
    render(<MenuEditor menu={MENU} spaceName="atelier" />);
    const save = screen.getByRole('button', { name: 'save menu' });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(document.body.textContent).toMatch(/spaces\.menu\.update/);
  });

  it('the preview mirrors the draft, and a keyboard reorder moves it', () => {
    render(<MenuEditor menu={ROWED} spaceName="atelier" />);
    const preview = () => screen.getByTestId('menu-preview').textContent ?? '';
    const before = preview();
    expect(before).toMatch(/Messages/);

    // Messages, not Home: Home ships a SINGLE item, and moving the only row
    // in a group is correctly a no-op — which would make this test assert
    // that a reorder does nothing. Chats has two rows (revision 11).
    const grip = screen.getByRole('button', { name: /reorder Messages/ });
    /* Up, not down: Messages is the LAST row of Chats, and moving the last
       row down is correctly a no-op. */
    fireEvent.keyDown(grip, { key: 'ArrowUp', altKey: true });
    expect(preview()).not.toBe(before);
    // The preview footer must now say the change is unsaved.
    expect(document.body.textContent).toMatch(/unsaved changes — preview only/);
  });

  it('THE TOUCH PATH: a plain click on the move button reorders, with no drag and no alt key', () => {
    /* This is the only reorder path a finger has. The rows use HTML5
       drag-and-drop, which fires NO events from a touch gesture, and the grip's
       fallback is alt+arrow, which needs an alt key — so before these buttons
       existed, reordering this menu was impossible on a touch device rather than
       merely awkward.

       A plain `click` is deliberately what is asserted: it is the one event a
       tap reliably produces on every touch platform, which is the whole reason
       this is a button and not a touch-drag implementation. No `altKey`, no
       `dragstart`, no pointer sequence. */
    render(<MenuEditor menu={ROWED} spaceName="atelier" />);
    const preview = () => screen.getByTestId('menu-preview').textContent ?? '';
    const before = preview();

    // Messages is the LAST row of Chats, so UP is the direction that moves.
    fireEvent.click(screen.getByRole('button', { name: 'move Messages up' }));

    expect(preview()).not.toBe(before);
    expect(document.body.textContent).toMatch(/unsaved changes — preview only/);
  });

  it('the move buttons name the row without colliding with the grip', () => {
    /* The grip and the two move buttons sit in one wrapper and all three name
       the same row. If the move buttons had been called "Move reorder Messages
       up" — the shape you get from reusing the grip's phrase — then every
       existing `getByRole(/reorder Messages/)` query in this file would match
       three controls and fail as ambiguous. The names are kept disjoint on
       purpose. */
    render(<MenuEditor menu={ROWED} spaceName="atelier" />);
    expect(screen.getByRole('button', { name: /reorder Messages/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'move Messages up' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'move Messages down' })).toBeTruthy();
  });

  it('discard is dead until there is something to discard, then restores', () => {
    render(<MenuEditor menu={ROWED} spaceName="atelier" />);
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
    render(<MenuEditor menu={ROWED} spaceName="atelier" />);
    // Revision 12: the group label is "Work" (the tab name).
    fireEvent.click(screen.getByRole('button', { name: 'rename Work' }));
    const input = screen.getByLabelText('rename Work') as HTMLInputElement;
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
  it('“＋ view ref” is LIVE, offering the refs the default leaves free', () => {
    render(<MenuEditor menu={MENU} spaceName="atelier" />);
    const add = screen.getByRole('button', { name: '＋ view ref' });
    expect(add.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(add);
    const options = screen.getAllByRole('button').filter((b) => b.className === 'set-add');
    const labels = options.map((b) => (b.textContent ?? '').trim());
    expect(labels.some((l) => /Feed/i.test(l))).toBe(true);
    // Inbox REJOINED the free set with revision 11: its rail row retired for
    // the top-bar bell, so the picker offers it again — the editor-side proof
    // that the bell move unrouted the screen rather than deleting it.
    expect(labels.some((l) => /Channels/i.test(l))).toBe(true);
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
    render(<MenuEditor menu={ROWED} spaceName="atelier" />);
    // The Workspace caret ships at the frozen 8-child cap, so ITS control is
    // honest about being unavailable from the first render. (The Code caret
    // ships with three children, so a LIVE add-child legitimately exists
    // elsewhere on the screen since revision 11 — the assertion is about the
    // full row stating its numbers, not about the control class.)
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
