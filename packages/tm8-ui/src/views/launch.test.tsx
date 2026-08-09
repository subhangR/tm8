// @vitest-environment jsdom
/**
 * Launch sheet — the D44/D51 anatomy and, more importantly, the THREE
 * OBLIGATIONS that ride with hosting it (A1a's findings).
 *
 * Two of those obligations fail SILENTLY when they are wrong: Esc quietly pops
 * the panel underneath, and an orphaned sheet keeps configuring a launch for a
 * panel that closed. Neither shows up in a test that does not open a sheet
 * first, which is exactly why they are pinned here.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, within } from '@testing-library/react';
import type { CredentialsStatusView, EntityId } from '@tm8/contract';
import { LaunchSheet } from './LaunchSheet';
import { useLaunchSheet } from './useLaunchSheet';
import { PanelStack } from '../shell/PanelStack';
import type { NavPort } from '../shell/nav-port';
import { teamMemberForge } from '../fixtures';
import { LAUNCH_CAPACITY, LAUNCH_PROFILES, LAUNCH_PROJECTS, LAUNCH_TEAMMATES } from './launch-fixtures';

const renderSheet = (props: Partial<React.ComponentProps<typeof LaunchSheet>> = {}) =>
  render(
    <div className="cv2-root">
      <LaunchSheet
        subjectId={'task-1' as EntityId}
        fromChip="◔ Run ▸"
        fromCaption="task pre-associated"
        teammates={LAUNCH_TEAMMATES}
        projects={LAUNCH_PROJECTS}
        profiles={LAUNCH_PROFILES}
        capacity={LAUNCH_CAPACITY}
        onLaunch={() => {}}
        onCancel={() => {}}
        {...props}
      />
    </div>,
  );

function credentialStatus(input: {
  store?: 'present' | 'absent';
  connected?: boolean;
  login?: string | null;
} = {}): CredentialsStatusView {
  return {
    providers: [{
      provider: 'github',
      connected: input.connected ?? false,
      login: input.login ?? null,
      authMethod: null,
      status: input.connected ? 'active' : null,
      connectedAt: null,
      lastVerifiedAt: null,
    }],
    gitCredentialStore: input.store ?? 'present',
  };
}

describe('OBLIGATION 1 — Esc must not pop the panel under an open sheet', () => {
  const makeNav = (stack: string[]): NavPort & { popped: number } => {
    const port = {
      stack: stack as EntityId[],
      pinned: [] as EntityId[],
      popped: 0,
      push: () => {},
      pop() { port.popped += 1; },
      close: () => {},
      pin: () => ({ ok: true as const }),
      unpin: () => {},
      promote: () => {},
      applyNormalization: () => {},
    };
    return port;
  };

  it('pops normally when NO modal is declared', () => {
    const nav = makeNav(['a']);
    render(<PanelStack nav={nav} renderPanel={(id) => <span>{id}</span>} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav.popped).toBe(1); // control: the listener works at all
  });

  it('does NOT pop when the sheet declares itself modal', () => {
    // Without this guard the viewer presses Esc to dismiss a launch they were
    // configuring and silently loses the panel behind it — the "Esc is broken"
    // shape. The keyboard contract cannot detect an UNDECLARED modal.
    const nav = makeNav(['a']);
    render(
      <PanelStack nav={nav} renderPanel={(id) => <span>{id}</span>} isKeyboardOwnedAbove={() => true} />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav.popped).toBe(0);
  });
});

describe('OBLIGATION 2 — the sheet never outlives its subject', () => {
  it('clears when the subject stops being hosted', () => {
    const { result, rerender } = renderHook(
      ({ hosted }: { hosted: EntityId[] }) => useLaunchSheet({ hostedIds: hosted }),
      { initialProps: { hosted: ['t1'] as EntityId[] } },
    );
    result.current.open('t1' as EntityId);
    rerender({ hosted: ['t1'] as EntityId[] });
    expect(result.current.subjectId).toBe('t1');

    // The subject leaves — by ANY route: pop, close, promote, or a hydration
    // nobody dispatched. Keying on membership covers all of them.
    rerender({ hosted: [] as EntityId[] });
    expect(result.current.subjectId).toBeNull();
  });

  it('reports modal-open only while a subject is set', () => {
    const { result, rerender } = renderHook(
      ({ hosted }: { hosted: EntityId[] }) => useLaunchSheet({ hostedIds: hosted }),
      { initialProps: { hosted: ['t1'] as EntityId[] } },
    );
    expect(result.current.isModalOpen()).toBe(false);
    result.current.open('t1' as EntityId);
    rerender({ hosted: ['t1'] as EntityId[] });
    expect(result.current.isModalOpen()).toBe(true);
  });

  it('declares modalDepth to a real keyboard controller when one is installed', () => {
    const setKeyboardContext = vi.fn();
    const { result, rerender } = renderHook(() =>
      useLaunchSheet({ hostedIds: ['t1'] as EntityId[], setKeyboardContext }),
    );
    result.current.open('t1' as EntityId);
    expect(setKeyboardContext).toHaveBeenCalledWith({ modalDepth: 1 });
    rerender();
    result.current.close();
    expect(setKeyboardContext).toHaveBeenLastCalledWith({ modalDepth: 0 });
  });
});

describe('ESC — both halves, which is the point', () => {
  it('CLOSES the sheet, and does NOT pop the panel behind it', () => {
    // The prevention half was built and tested; the ACTING half was not, so
    // Escape was swallowed while the header said "esc closes". One test pins
    // both: dismissal happens AND the fall-through stays prevented. Neither
    // half can regress without failing here.
    const onCancel = vi.fn();
    const nav = {
      stack: ['behind'] as EntityId[],
      pinned: [] as EntityId[],
      popped: 0,
      push: () => {},
      pop() { (nav as { popped: number }).popped += 1; },
      close: () => {},
      pin: () => ({ ok: true as const }),
      unpin: () => {},
      promote: () => {},
      applyNormalization: () => {},
    };
    render(
      <div className="cv2-root">
        <PanelStack nav={nav} renderPanel={(id) => <span>{id}</span>} isKeyboardOwnedAbove={() => true} />
        <LaunchSheet
          subjectId={'task-1' as EntityId}
          fromChip="◔ Run ▸"
          fromCaption="ctx"
          teammates={LAUNCH_TEAMMATES}
          projects={LAUNCH_PROJECTS}
          profiles={LAUNCH_PROFILES}
          capacity={LAUNCH_CAPACITY}
          onLaunch={() => {}}
          onCancel={onCancel}
        />
      </div>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);  // the ACTING half
    expect(nav.popped).toBe(0);                 // the PREVENTING half
  });

  it('the header does not advertise a dismissal the sheet lacks', () => {
    // The defect was discoverable from the copy alone: the header said
    // "esc closes" while nothing listened.
    const onCancel = vi.fn();
    const { container } = renderSheet({ onCancel });
    expect(container.textContent).toContain('esc closes');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('the teammate picker scales to an UNBOUNDED roster', () => {
  const manyTeammates = Array.from({ length: 8 }, (_, i) => ({
    id: `ent-tm-${i}`,
    name: ['forge', 'scout', 'lint', 'probe', 'draft', 'zeta', 'quill', 'sable'][i] ?? `tm-${i}`,
    initial: 'T',
    model: 'claude-sonnet-5',
    agentTool: 'claude-code',
    owner: '@ada',
  }));

  it('hides the filter while the roster fits on screen whole', () => {
    // Two teammates: a search box would be pure friction.
    const { queryByTestId } = renderSheet();
    expect(queryByTestId('launch-teammate-search')).toBeNull();
  });

  it('filters the roster by name', () => {
    const { getByTestId, container } = renderSheet({ teammates: manyTeammates });
    const search = getByTestId('launch-teammate-search');
    expect(container.querySelectorAll('.ls__roster [role="radio"]')).toHaveLength(8);

    fireEvent.change(search, { target: { value: 'zeta' } });
    const rows = [...container.querySelectorAll('.ls__roster [role="radio"]')];
    // zeta plus the SELECTED teammate (forge), which is never hidden — the
    // persona a launch will run as must stay visible at commit time.
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('forge'),
      expect.stringContaining('zeta'),
    ]);
    expect(rows[0]?.getAttribute('aria-checked')).toBe('true');
  });

  it('states that a non-matching filter KEEPS the selection', () => {
    const { getByTestId, getByRole, container } = renderSheet({ teammates: manyTeammates });
    fireEvent.change(getByTestId('launch-teammate-search'), { target: { value: 'nobody-here' } });
    expect(getByRole('status').textContent).toContain('the current selection is kept');
    // The selected row itself is still drawn, so the empty state never reads
    // as "nothing is selected".
    const rows = [...container.querySelectorAll('.ls__roster [role="radio"]')];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute('aria-checked')).toBe('true');
  });

  it('a pick made through the filter reaches the submitted config', () => {
    const onLaunch = vi.fn();
    const { getByTestId, getByText, container } = renderSheet({ teammates: manyTeammates, onLaunch });
    fireEvent.change(getByTestId('launch-teammate-search'), { target: { value: 'quill' } });
    const quill = [...container.querySelectorAll('.ls__roster [role="radio"]')].find((r) =>
      r.textContent?.includes('quill'),
    ) as HTMLElement;
    fireEvent.click(quill);
    fireEvent.click(getByText('Launch ▸'));
    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ teamMemberId: 'ent-tm-6' }));
  });
});

describe('the sheet anatomy (T5-5 / D51)', () => {
  it('renders the complete launch configuration with an explicit model control', () => {
    const { container, getByTestId } = renderSheet();
    const eyebrows = [...container.querySelectorAll('.ls__body .ls__eyebrow')].map((n) => n.textContent);
    // ORDER IS THE ASSERTION (user ruling 2026-08-09): the important
    // configuration — teammate, then model / reasoning effort / permission
    // mode — sits at the TOP; directory, session mode and profile follow.
    expect(eyebrows).toEqual([
      'TEAMMATE',
      'CONFIGURATION',
      'WORKING DIRECTORY',
      'SESSION MODE',
      'INTERACTION PROFILE',
    ]);
    expect(container.textContent).toContain('claude-sonnet-5 · claude-code · owned by @ada');
    expect(getByTestId('launch-model')).toBeInstanceOf(HTMLSelectElement);
  });

  it('renders the untrusted project DISABLED-WITH-REASON and still reachable (L6/D28)', () => {
    const { getByTitle } = renderSheet();
    const row = getByTitle("untrusted — can't host sessions · trust it in Node settings ↗");
    expect(row.getAttribute('aria-disabled')).toBe('true');
    // Never natively disabled: a reason you cannot focus is no reason at all.
    expect((row as HTMLButtonElement).disabled).toBe(false);
    row.focus();
    expect(document.activeElement).toBe(row);
  });

  it('refuses draft and retired profiles with a reason naming the mechanism (D51)', () => {
    const { getByText, container } = renderSheet();
    fireEvent.click(getByText('change ▾'));
    const picker = container.querySelector('.ls__picker') as HTMLElement;
    const refused = [...picker.querySelectorAll('[aria-disabled="true"]')];
    expect(refused).toHaveLength(2); // the draft and the retired one
    expect(within(picker).getByText(/draft — not activated yet/)).toBeTruthy();
    expect(within(picker).getByText(/retired — kept for sessions already pinned/)).toBeTruthy();
  });

  it('always exposes the real Core Chat node default and an honest empty profile state', () => {
    const onLaunch = vi.fn();
    const { getAllByText, getByRole, getByText } = renderSheet({ profiles: [], onLaunch });
    const change = getByRole('button', { name: 'Change interaction profile' });

    expect(change.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(change);
    expect(change.getAttribute('aria-expanded')).toBe('true');
    expect(getByRole('radio', { name: /Core Chat — node default/ }).getAttribute('aria-checked')).toBe('true');
    expect(getByText('No authored profiles yet. Core Chat remains available.')).toBeTruthy();
    expect(getAllByText(/Terminal \+ Chat · starts in Chat/).length).toBeGreaterThanOrEqual(2);

    fireEvent.click(getByText('Launch ▸'));
    const submitted = onLaunch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(submitted).not.toHaveProperty('interactionProfileId');
  });

  it('labels authored profile options with their Chat surfaces and initial surface', () => {
    const { getAllByText, getByRole, getByText } = renderSheet();
    fireEvent.click(getByRole('button', { name: 'Change interaction profile' }));

    expect(getByRole('radio', { name: /Use resolved default — standard-agent v2/ })).toBeTruthy();
    const profile = getByRole('radio', { name: /house-style/ });
    expect(profile.textContent).toContain('Terminal + Chat');
    expect(profile.textContent).toContain('starts in Chat');
    expect(getAllByText(/Terminal \+ Chat · starts in Chat/).length).toBeGreaterThanOrEqual(2);
    fireEvent.click(profile);
    expect(getByText('house-style')).toBeTruthy();
  });

  it('shows the resolution chain with BRASS on the winner (D51 + D53)', () => {
    const { container } = renderSheet();
    const won = container.querySelectorAll('.ls__step--won');
    expect(won).toHaveLength(1);
    // forge carries a default, so the teammate step wins over space/server.
    expect(won[0]?.textContent).toBe('teammate default');
    expect(container.textContent).toContain("resolved from forge's default");
  });

  it('states the pinned-forever law BEFORE the commit control (T2-4 / D51)', () => {
    const { container } = renderSheet();
    const pinned = container.querySelector('.ls__pinned') as HTMLElement;
    const launch = container.querySelector('.ls__launch') as HTMLElement;
    expect(pinned.textContent).toContain('pinned at launch — immutable');
    // DOM order is the guarantee: the caption is read before the button is
    // reached, which is the whole point of "the caption says so before you
    // commit".
    expect(pinned.compareDocumentPosition(launch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders a refusal IN the sheet, not as a toast (T5-5)', () => {
    const { getByRole } = renderSheet({
      refusal: { cause: 'spawn refused — no free slots', detail: 'Nothing was started; your picks are kept right here.' },
    });
    const alert = getByRole('alert');
    expect(alert.textContent).toContain('spawn refused — no free slots');
    expect(alert.textContent).toContain('Nothing was started');
  });

  it('locks every commit and dismiss path while the spawn request is unsettled', () => {
    const onLaunch = vi.fn();
    const onCancel = vi.fn();
    const { getByRole, getByText } = renderSheet({ launching: true, onLaunch, onCancel });

    const launch = getByRole('button', { name: 'Launching…' });
    const cancel = getByRole('button', { name: 'Cancel' });
    const close = getByRole('button', { name: 'Close launch sheet' });
    expect(launch).toHaveProperty('disabled', true);
    expect(launch.getAttribute('aria-busy')).toBe('true');
    expect(cancel).toHaveProperty('disabled', true);
    expect(close).toHaveProperty('disabled', true);

    fireEvent.click(launch);
    fireEvent.click(cancel);
    fireEvent.click(close);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onLaunch).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(getByText('Launching…')).toBeTruthy();
  });

  it('states node capacity before commitment', () => {
    const { container } = renderSheet();
    expect(container.querySelector('.ls__capacity')?.textContent).toContain('8 slots, 3 in use');
  });

  it('submits one typed working-directory target and the full tool configuration', () => {
    const onLaunch = vi.fn();
    const { getByText } = renderSheet({ onLaunch });
    fireEvent.click(getByText('Launch ▸'));
    expect(onLaunch).toHaveBeenCalledWith(
      // Asserted against the ENTITY FIXTURE's own id, not a literal (A1c's
      // stronger version). A literal agrees with whatever the view-model holds
      // and with the seam never — it pins internal consistency rather than the
      // thing that has to be true, which is that the id RESOLVES. Coupled this
      // way, a future rename fails here instead of silently re-breaking spawn.
      expect.objectContaining({
        subjectId: 'task-1',
        teamMemberId: teamMemberForge.id,
        target: { kind: 'project', projectId: 'pj-tm8ui' },
        agentToolId: 'claude-code',
        model: 'claude-sonnet-5',
        mode: 'worker',
      }),
    );
  });

  it('exposes and submits a concrete model choice in Full Options', () => {
    const onLaunch = vi.fn();
    const { getByTestId, getByText } = renderSheet({ onLaunch });
    fireEvent.change(getByTestId('launch-model'), { target: { value: 'claude-opus-5' } });
    fireEvent.click(getByText('Launch ▸'));
    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({
      agentToolId: 'claude-code',
      model: 'claude-opus-5',
      target: { kind: 'project', projectId: 'pj-tm8ui' },
    }));
  });

  it('keeps model, reasoning effort and permission mode ABOVE the fold sections', () => {
    // DOM order is the guarantee, as in the pinned-caption test: the three
    // controls the user reaches for most precede the directory picker, the
    // session-mode row and the profile section.
    const { container, getByTestId } = renderSheet();
    const directory = [...container.querySelectorAll('.ls__eyebrow')].find(
      (n) => n.textContent === 'WORKING DIRECTORY',
    ) as HTMLElement;
    for (const id of ['launch-model', 'launch-reasoning-effort', 'launch-access-mode', 'launch-credential-source']) {
      const control = getByTestId(id);
      expect(control.compareDocumentPosition(directory) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // Session mode moved DOWN — a topology choice most launches never touch.
    const mode = getByTestId('launch-mode');
    expect(directory.compareDocumentPosition(mode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('sends a credential source ONLY when one was explicitly chosen', () => {
    // Auto is the ABSENCE of the field, not a third value: an explicit
    // 'member' refuses the launch for an unconnected member, so the sheet
    // merely being opened must never pin one.
    const onLaunch = vi.fn();
    const { getByTestId, getByText } = renderSheet({ onLaunch });
    fireEvent.click(getByText('Launch ▸'));
    expect(onLaunch.mock.calls[0]?.[0]).not.toHaveProperty('credentialSource');

    fireEvent.change(getByTestId('launch-credential-source'), { target: { value: 'member' } });
    fireEvent.click(getByText('Launch ▸'));
    expect(onLaunch.mock.calls[1]?.[0]).toMatchObject({ credentialSource: 'member' });

    fireEvent.change(getByTestId('launch-credential-source'), { target: { value: 'node' } });
    fireEvent.click(getByText('Launch ▸'));
    expect(onLaunch.mock.calls[2]?.[0]).toMatchObject({ credentialSource: 'node' });
  });

  it('shows the configured GitHub login and how the selected source treats it', async () => {
    const loadCredentialStatus = vi.fn(async () => credentialStatus({
      connected: true,
      login: 'octocat',
    }));
    const { findByTestId, getByTestId } = renderSheet({ loadCredentialStatus });
    const identity = await findByTestId('launch-github-identity');

    expect(identity.textContent).toContain('@octocat');
    expect(identity.textContent).toContain('wins in Auto');
    expect(getByTestId('launch-credential-source').textContent).toContain('GitHub @octocat');

    fireEvent.change(getByTestId('launch-credential-source'), { target: { value: 'member' } });
    expect(identity.textContent).toContain('isolated to your member account');
    fireEvent.change(getByTestId('launch-credential-source'), { target: { value: 'node' } });
    expect(identity.textContent).toContain('your @octocat connection is not injected');
  });

  it('distinguishes measured no-login from an unmeasurable GitHub store', async () => {
    const measured = renderSheet({
      loadCredentialStatus: async () => credentialStatus({ store: 'present', connected: false }),
    });
    const measuredIdentity = await measured.findByTestId('launch-github-identity');
    fireEvent.change(measured.getByTestId('launch-credential-source'), { target: { value: 'member' } });
    expect(measuredIdentity.textContent).toContain('none · node fallback is blocked');
    measured.unmount();

    const unknown = renderSheet({
      loadCredentialStatus: async () => credentialStatus({ store: 'absent', connected: false }),
    });
    expect((await unknown.findByTestId('launch-github-identity')).textContent)
      .toContain('GitHub identity unknown');
    expect(unknown.queryByText(/no personal GitHub connection/)).toBeNull();
  });

  it('sends only an explicit active profile selection', () => {
    const onLaunch = vi.fn();
    const { getByText } = renderSheet({ onLaunch });
    fireEvent.click(getByText('change ▾'));
    fireEvent.click(getByText('house-style'));
    fireEvent.click(getByText('Launch ▸'));
    expect(onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ interactionProfileId: 'pf-house' }),
    );
  });

});
