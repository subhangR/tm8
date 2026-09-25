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
import { act, fireEvent, render, renderHook, waitFor, within } from '@testing-library/react';
import type { CredentialsStatusView, EntityId } from '@tm8/contract';
import { LaunchSheet } from './LaunchSheet';
import { useLaunchSheet } from './useLaunchSheet';
import { PanelStack } from '../shell/PanelStack';
import type { NavPort } from '../shell/nav-port';
import { teamMemberForge } from '../fixtures';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import { LAUNCH_CAPACITY, LAUNCH_DEFAULTS, LAUNCH_MEMORIES, LAUNCH_PROFILES, LAUNCH_PROJECTS, LAUNCH_REFERENCE_CANDIDATES, LAUNCH_TEAMMATES } from './launch-fixtures';

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
    const { getByTestId, getByText, container } = renderSheet({ teammates: manyTeammates });
    fireEvent.change(getByTestId('launch-teammate-search'), { target: { value: 'nobody-here' } });
    expect(getByText(/the current selection is kept/).textContent).toContain('the current selection is kept');
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
      // F4 (#648): the equipped-skills preview sits beside memories, the other
      // thing the teammate wakes up knowing.
      'SKILLS',
      'MEMORIES',
      // I9: the task's references, the third selection group.
      'REFERENCES',
      // I7: this launch's per-group budget override, collapsed.
      'BUDGET FOR THIS LAUNCH',
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

  it.each(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])(
    'launches Astra with %s effort', (reasoningEffort) => {
      const onLaunch = vi.fn();
      const teammate = { ...LAUNCH_TEAMMATES[0]!, agentTool: 'codex', model: 'gpt-6-astra' };
      const { getByTestId, getByText } = renderSheet({ teammates: [teammate], onLaunch });
      fireEvent.change(getByTestId('launch-reasoning-effort'), { target: { value: reasoningEffort } });
      fireEvent.click(getByText('Launch ▸'));
      expect(onLaunch.mock.calls[0]?.[0]).toMatchObject({ model: 'gpt-6-astra', reasoningEffort });
    },
  );

  it('keeps model, reasoning effort and permission mode ABOVE the fold sections', () => {
    // DOM order is the guarantee, as in the pinned-caption test: the three
    // controls the user reaches for most precede the directory picker, the
    // session-mode row and the profile section.
    const { container, getByTestId } = renderSheet();
    const directory = [...container.querySelectorAll('.ls__eyebrow')].find(
      (n) => n.textContent === 'WORKING DIRECTORY',
    ) as HTMLElement;
    for (const id of [
      'launch-model',
      'launch-reasoning-effort',
      'launch-access-mode',
      'launch-agent-credential-source',
      'launch-github-credential-source',
    ]) {
      const control = getByTestId(id);
      expect(control.compareDocumentPosition(directory) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // Session mode moved DOWN — a topology choice most launches never touch.
    const mode = getByTestId('launch-mode');
    expect(directory.compareDocumentPosition(mode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('sends independent provider credential sources ONLY when explicitly chosen', () => {
    // Auto is the ABSENCE of each provider key, not a third value. Merely
    // opening the sheet must never couple the agent login to GitHub.
    const onLaunch = vi.fn();
    const { getByTestId, getByText } = renderSheet({ onLaunch });
    fireEvent.click(getByText('Launch ▸'));
    expect(onLaunch.mock.calls[0]?.[0]).not.toHaveProperty('credentialSources');

    fireEvent.change(getByTestId('launch-agent-credential-source'), { target: { value: 'node' } });
    fireEvent.click(getByText('Launch ▸'));
    expect(onLaunch.mock.calls[1]?.[0]).toMatchObject({ credentialSources: { anthropic: 'node' } });

    fireEvent.change(getByTestId('launch-github-credential-source'), { target: { value: 'member' } });
    fireEvent.click(getByText('Launch ▸'));
    expect(onLaunch.mock.calls[2]?.[0]).toMatchObject({
      credentialSources: { anthropic: 'node', github: 'member' },
    });
  });

  it('binds the agent dropdown to the selected provider without coupling GitHub', async () => {
    const onLaunch = vi.fn();
    const codex = {
      ...LAUNCH_TEAMMATES[0]!,
      agentTool: 'codex',
      model: 'gpt-5.6-sol',
    };
    const status: CredentialsStatusView = {
      providers: [
        {
          provider: 'openai', connected: true, login: 'member@example.com',
          authMethod: null, status: 'active', connectedAt: null, lastVerifiedAt: null,
        },
        {
          provider: 'github', connected: true, login: 'octocat',
          authMethod: null, status: 'active', connectedAt: null, lastVerifiedAt: null,
        },
      ],
      gitCredentialStore: 'present',
    };
    const { findByTestId, getByTestId, getByText } = renderSheet({
      teammates: [codex],
      loadCredentialStatus: async () => status,
      onLaunch,
    });

    expect(getByText('OpenAI credential')).toBeTruthy();
    expect(getByText('GitHub credential')).toBeTruthy();
    expect((await findByTestId('launch-agent-identity')).textContent).toContain('OpenAI');
    expect(getByTestId('launch-agent-credential-source').textContent)
      .toContain('My OpenAI · member@example.com');
    expect(getByTestId('launch-github-credential-source').textContent)
      .toContain('My GitHub · @octocat');

    fireEvent.change(getByTestId('launch-agent-credential-source'), { target: { value: 'node' } });
    fireEvent.change(getByTestId('launch-github-credential-source'), { target: { value: 'member' } });
    fireEvent.click(getByText('Launch ▸'));
    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({
      credentialSources: { openai: 'node', github: 'member' },
    }));
  });

  it('keeps Anthropic and OpenAI picks independent when the selected teammate changes', () => {
    const claude = {
      ...LAUNCH_TEAMMATES[0]!, id: 'tm-claude', name: 'claude-persona',
    };
    const codex = {
      ...LAUNCH_TEAMMATES[0]!, id: 'tm-codex', name: 'codex-persona',
      agentTool: 'codex', model: 'gpt-5.6-sol',
    };
    const { getByTestId, getByText } = renderSheet({ teammates: [claude, codex] });
    const source = getByTestId('launch-agent-credential-source') as HTMLSelectElement;

    fireEvent.change(source, { target: { value: 'node' } });
    expect(source.value).toBe('node');
    fireEvent.click(getByText('codex-persona'));
    expect(source.value).toBe('');
    fireEvent.change(source, { target: { value: 'member' } });
    expect(source.value).toBe('member');
    fireEvent.click(getByText('claude-persona'));
    expect(source.value).toBe('node');
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
    expect(getByTestId('launch-github-credential-source').textContent).toContain('GitHub · @octocat');

    fireEvent.change(getByTestId('launch-github-credential-source'), { target: { value: 'member' } });
    expect(identity.textContent).toContain('isolated to your member account');
    fireEvent.change(getByTestId('launch-github-credential-source'), { target: { value: 'node' } });
    expect(identity.textContent).toContain('your @octocat connection is not injected');
  });

  it('distinguishes measured no-login from an unmeasurable GitHub store', async () => {
    const measured = renderSheet({
      loadCredentialStatus: async () => credentialStatus({ store: 'present', connected: false }),
    });
    const measuredIdentity = await measured.findByTestId('launch-github-identity');
    fireEvent.change(measured.getByTestId('launch-github-credential-source'), { target: { value: 'member' } });
    expect(measuredIdentity.textContent).toContain('none · node fallback is blocked');
    measured.unmount();

    const unknown = renderSheet({
      loadCredentialStatus: async () => credentialStatus({ store: 'absent', connected: false }),
    });
    const unknownIdentity = await unknown.findByTestId('launch-github-identity');
    expect(unknownIdentity.textContent).toContain('GitHub identity unknown');
    expect(unknown.queryByText(/no personal GitHub connection/)).toBeNull();
    // Node selection does not depend on the per-member store whose absence is
    // unknown, so the chosen source remains stateable.
    fireEvent.change(unknown.getByTestId('launch-github-credential-source'), { target: { value: 'node' } });
    expect(unknownIdentity.textContent).toContain('node account');
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

// ---------------------------------------------------------------------------

/**
 * THE LAUNCH'S CONTEXT, PER GROUP (I9, design 01a0d348 §5.1–5.2).
 *
 * The defaults are PRE-TICKED and labelled "default"; unticking one is a
 * removal, stated as a diff; an addition comes from the space. PER-GROUP SEND:
 * an untouched group is omitted (its defaults load) with `selectionReasons`
 * saying why, an edited group is its exact set, and an untouched launch
 * carries NO `selection` at all.
 */
describe('the launch’s context groups: defaults pre-ticked, removals as a diff, per-group send', () => {
  const launchesOf = () => {
    const launches: Array<Record<string, unknown>> = [];
    return { launches, onLaunch: (config: unknown) => { launches.push(config as Record<string, unknown>); } };
  };
  const ALL_NOT_ASKED = { memories: 'not-asked', skills: 'not-asked', references: 'not-asked' };

  /* Groups start COLLAPSED (owner's pick): open all three to reach the rows. */
  const renderWithDefaults = async (props: Partial<React.ComponentProps<typeof LaunchSheet>> = {}) => {
    const load = vi.fn(async () => LAUNCH_DEFAULTS);
    const view = renderSheet({ loadLaunchDefaults: load, memories: LAUNCH_MEMORIES, referenceCandidates: LAUNCH_REFERENCE_CANDIDATES, ...props });
    await waitFor(() => expect(view.getByTestId('lsel-toggle-memories').textContent).not.toMatch(/reading/));
    for (const group of ['skills', 'memories', 'references']) fireEvent.click(view.getByTestId(`lsel-toggle-${group}`));
    return { ...view, load };
  };

  it('each group starts as ONE collapsed summary line — counts, then the diff', async () => {
    const view = renderSheet({ loadLaunchDefaults: async () => LAUNCH_DEFAULTS, memories: LAUNCH_MEMORIES });
    const toggle = await view.findByText('2 defaults');
    expect(toggle.closest('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByTestId('lsel-row-references-ent-doc-spec')).toBeNull();
    fireEvent.click(view.getByTestId('lsel-toggle-references'));
    fireEvent.click(view.getByTestId('lsel-row-references-ent-doc-spec'));
    expect(view.getByTestId('lsel-toggle-references').textContent).toMatch(/2 defaults · −1 default removed/);
    // Collapsing keeps the edit, and the line still says it.
    fireEvent.click(view.getByTestId('lsel-toggle-references'));
    expect(view.getByTestId('lsel-toggle-references').textContent).toMatch(/−1 default removed/);
  });

  it('keeps the harness view under Skills as a collapsed "How these load" disclosure', async () => {
    const loadSkillPreview = vi.fn(() => new Promise<never>(() => {}));
    const view = await renderWithDefaults({ loadSkillPreview });
    const how = view.getByTestId('launch-skills-how');
    expect(how.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByText('Loading skill preview…')).toBeNull();
    fireEvent.click(how);
    expect(view.getByText('Loading skill preview…')).toBeTruthy();
  });

  it('reads the defaults for the teammate and the subject', async () => {
    const { load } = await renderWithDefaults();
    expect(load).toHaveBeenCalledWith({ teamMemberId: 'ent-tm-forge', subjectId: 'task-1' });
  });

  it('shows every default pre-ticked and labelled default, in all three groups', async () => {
    const { getByTestId } = await renderWithDefaults();
    for (const testId of ['lsel-row-memories-ent-mem-tokens', 'lsel-row-skills-ent-sk-review', 'lsel-row-references-ent-doc-spec', 'lsel-row-references-ent-file-log']) {
      const row = getByTestId(testId);
      expect(row.getAttribute('aria-checked')).toBe('true');
      expect(within(row).getByText('default')).toBeTruthy();
    }
  });

  it('an untouched launch sends NO selection — only why each group kept its defaults', async () => {
    const { launches, onLaunch } = launchesOf();
    const { getByRole } = await renderWithDefaults({ onLaunch });
    fireEvent.click(getByRole('button', { name: /Launch/ }));
    expect('selection' in launches[0]!).toBe(false);
    expect('memoryIds' in launches[0]!).toBe(false);
    expect(launches[0]!.selectionReasons).toEqual(ALL_NOT_ASKED);
  });

  it('unticking a default is a visible removal, and ONLY that group goes as its exact set', async () => {
    const { launches, onLaunch } = launchesOf();
    const { getByRole, getByTestId } = await renderWithDefaults({ onLaunch });
    fireEvent.click(getByTestId('lsel-row-references-ent-file-log'));
    expect(getByTestId('lsel-toggle-references').textContent).toMatch(/2 defaults · −1 default removed/);
    const row = getByTestId('lsel-row-references-ent-file-log');
    expect(row.getAttribute('aria-checked')).toBe('false');
    expect(within(row).getByText('default · removed')).toBeTruthy();

    fireEvent.click(getByRole('button', { name: /Launch/ }));
    expect(launches[0]!.selection).toEqual({ referenceIds: ['ent-doc-spec'] });
    expect(launches[0]!.selectionReasons).toEqual({ memories: 'not-asked', skills: 'not-asked' });
  });

  it('adds from the space: defaults ∪ the addition, and the diff says +1', async () => {
    const { launches, onLaunch } = launchesOf();
    const view = await renderWithDefaults({ onLaunch });
    const group = view.getByTestId('lsel-group-memories');
    fireEvent.click(within(group).getByRole('button', { name: /add memories/ }));
    fireEvent.click(within(group).getByText('The fixture seam drops fields it does not know'));
    expect(view.getByTestId('lsel-toggle-memories').textContent).toMatch(/1 default · \+1 added/);
    fireEvent.click(view.getByRole('button', { name: /Launch/ }));
    expect(launches[0]!.selection).toEqual({ memoryIds: ['ent-mem-tokens', 'ent-mem-disputed'] });
    // The additive field is gone: the node refuses it beside `selection`.
    expect('memoryIds' in launches[0]!).toBe(false);
  });

  it('a References row shows kind, title and header text — "derived" unless authored — as plain text', async () => {
    const view = await renderWithDefaults();
    const spec = view.getByTestId('lsel-row-references-ent-doc-spec');
    expect(within(spec).getByText('Launch spec')).toBeTruthy();
    expect(spec.textContent).toMatch(/doc · linked to the task/);
    expect(within(spec).getByText('Read before touching the launch sheet')).toBeTruthy();
    expect(within(spec).queryByText('derived')).toBeNull();
    const log = view.getByTestId('lsel-row-references-ent-file-log');
    expect(log.textContent).toMatch(/file · attached to the task/);
    expect(within(log).getByText('derived')).toBeTruthy();
  });

  it('renders header text as TEXT, never markup (it is graph content)', async () => {
    const hostile = { ...LAUNCH_DEFAULTS, references: { items: [{ ...LAUNCH_DEFAULTS.references.items[0]!, headerText: '<img src=x onerror=alert(1)>' }], total: 1 } };
    const view = await renderWithDefaults({ loadLaunchDefaults: async () => hostile });
    const row = view.getByTestId('lsel-row-references-ent-doc-spec');
    expect(row.querySelector('img')).toBeNull();
    expect(row.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('says an add pool is UNKNOWN when it was never read, not empty', async () => {
    const view = await renderWithDefaults({ referenceCandidates: undefined });
    const group = view.getByTestId('lsel-group-references');
    fireEvent.click(within(group).getByRole('button', { name: /add references/ }));
    expect(within(group).getByText(/unknown, not empty/)).toBeTruthy();
  });

  it('a teammate change re-reads the defaults for the new teammate', async () => {
    const { load, getByText } = await renderWithDefaults();
    fireEvent.click(getByText('scout'));
    expect(load).toHaveBeenLastCalledWith({ teamMemberId: 'ent-tm-scout', subjectId: 'task-1' });
  });

  it('while an EDITED group’s defaults re-read, Launch waits and says why — the removal is never dropped', async () => {
    /* A teammate change re-reads the defaults. Until they land every group is
       locked and would be omitted, so a launch in that window would load the
       defaults the person just removed. Untouched groups never block. */
    const { launches, onLaunch } = launchesOf();
    let answer: (result: typeof LAUNCH_DEFAULTS) => void = () => {};
    const load = vi.fn((input: { teamMemberId: string }) => (input.teamMemberId === 'ent-tm-scout'
      ? new Promise<typeof LAUNCH_DEFAULTS>((resolve) => { answer = resolve; })
      : Promise.resolve(LAUNCH_DEFAULTS)));
    const view = await renderWithDefaults({ onLaunch, loadLaunchDefaults: load });
    const launch = () => view.getByRole('button', { name: /Launch/ }) as HTMLButtonElement;

    fireEvent.click(view.getByTestId('lsel-row-references-ent-file-log'));
    fireEvent.click(view.getByText('scout'));
    expect(launch().disabled).toBe(true);
    expect(view.getByTestId('launch-selection-wait').textContent).toMatch(/defaults.*edits to them are kept/);
    fireEvent.click(launch());
    expect(launches).toHaveLength(0);

    await act(async () => { answer(LAUNCH_DEFAULTS); });
    expect(launch().disabled).toBe(false);
    expect(view.queryByTestId('launch-selection-wait')).toBeNull();
    fireEvent.click(launch());
    expect(launches[0]!.teamMemberId).toBe('ent-tm-scout');
    expect(launches[0]!.selection).toEqual({ referenceIds: ['ent-doc-spec'] });
  });

  it('an UNTOUCHED launch never waits on a re-read: nothing it sends depends on the defaults', async () => {
    const load = vi.fn((input: { teamMemberId: string }) => (input.teamMemberId === 'ent-tm-scout'
      ? new Promise<typeof LAUNCH_DEFAULTS>(() => {})
      : Promise.resolve(LAUNCH_DEFAULTS)));
    const view = await renderWithDefaults({ loadLaunchDefaults: load });
    fireEvent.click(view.getByText('scout'));
    expect((view.getByRole('button', { name: /Launch/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(view.queryByTestId('launch-selection-wait')).toBeNull();
  });

  it('a group over the 240 ceiling cannot be edited, says so, and is never sent', async () => {
    const { launches, onLaunch } = launchesOf();
    const over = { ...LAUNCH_DEFAULTS, skills: { items: LAUNCH_DEFAULTS.skills.items, total: 300 } };
    const view = await renderWithDefaults({ onLaunch, loadLaunchDefaults: async () => over });
    const group = view.getByTestId('lsel-group-skills');
    expect(within(group).getByText(/300 defaults.*at most 240/)).toBeTruthy();
    fireEvent.click(view.getByTestId('lsel-row-skills-ent-sk-review'));
    fireEvent.click(view.getByRole('button', { name: /Launch/ }));
    expect('selection' in launches[0]!).toBe(false);
  });

  it('without `launch.defaults` the groups say the defaults are unknown, and nothing is selected', () => {
    const { launches, onLaunch } = launchesOf();
    const view = renderSheet({ onLaunch });
    expect(view.getByTestId('lsel-toggle-memories').textContent).toMatch(/defaults unknown — can’t be edited/);
    fireEvent.click(view.getByTestId('lsel-toggle-memories'));
    expect(view.getAllByText(/didn’t say what this launch loads by default/).length).toBeGreaterThan(0);
    fireEvent.click(view.getByRole('button', { name: /Launch/ }));
    expect('selection' in launches[0]!).toBe(false);
    expect(launches[0]!.selectionReasons).toEqual(ALL_NOT_ASKED);
  });

  it('is a picker and not a manager — no authoring controls anywhere in it', async () => {
    const { queryByTestId, queryByText } = await renderWithDefaults();
    expect(queryByTestId('memory-add')).toBeNull();
    expect(queryByTestId('memory-forget')).toBeNull();
    expect(queryByText(/remember something/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/**
 * DISPATCH (D5) — the option beside the manual flow.
 *
 * THE PROPERTY THAT MATTERS is what it does NOT carry. `ExecutionDispatchInput`
 * has no launch configuration at all, because — in the contract's own words —
 * "the moment a caller can name the teammate, it is spawning, not dispatching".
 * So the risk here is not a broken button; it is a button that quietly appears
 * to honour a form it structurally cannot use. These tests hold that line from
 * both sides: the payload is one field, and the sheet says so.
 */
describe('Dispatch hands off the subject and cannot smuggle a configuration', () => {
  it('sends ONLY the subject, whatever the sheet was configured to', async () => {
    const dispatched: Array<Record<string, unknown>> = [];
    const { getByTestId, getByText } = renderSheet({
      memories: LAUNCH_MEMORIES,
      loadLaunchDefaults: async () => LAUNCH_DEFAULTS,
      onDispatch: (r) => dispatched.push(r as unknown as Record<string, unknown>),
    });

    // Configure the sheet as fully as the surface allows first — a teammate
    // other than the default, a model, and a removed default memory.
    fireEvent.click(getByText('scout'));
    fireEvent.change(getByTestId('launch-model'), { target: { value: 'claude-opus-5' } });
    await waitFor(() => expect(getByTestId('lsel-toggle-memories').textContent).toMatch(/1 default/));
    fireEvent.click(getByTestId('lsel-toggle-memories'));
    fireEvent.click(getByTestId('lsel-row-memories-ent-mem-tokens'));

    fireEvent.click(getByTestId('launch-dispatch'));

    expect(dispatched).toHaveLength(1);
    // ONE key. Not "teamMemberId is undefined" — the key is absent, so no
    // future edit can start populating it without this failing.
    expect(Object.keys(dispatched[0] ?? {})).toEqual(['subjectId']);
    expect(dispatched[0]?.subjectId).toBe('task-1');
  });

  it('says out loud that the settings above are not used', () => {
    // A control that silently discards a form the viewer just filled in is the
    // worst class of surprise: everything looks like it was honoured.
    const { getByTestId } = renderSheet({ onDispatch: () => {} });
    const title = getByTestId('launch-dispatch').getAttribute('title') ?? '';
    expect(title).toContain('picks the teammate');
    expect(title).toMatch(/settings above are NOT used/i);
  });

  it('does not launch, and Launch does not dispatch', () => {
    // The two commits are different actions; neither may stand in for the other.
    const launched: unknown[] = [];
    const dispatched: unknown[] = [];
    const { getByTestId, getByRole } = renderSheet({
      onLaunch: (c) => launched.push(c),
      onDispatch: (r) => dispatched.push(r),
    });
    fireEvent.click(getByTestId('launch-dispatch'));
    expect(launched).toHaveLength(0);
    fireEvent.click(getByRole('button', { name: /Launch/ }));
    expect(dispatched).toHaveLength(1);
    expect(launched).toHaveLength(1);
  });

  it('refuses WITH A REASON when unwired, rather than hiding the button', () => {
    // A missing button would claim this node cannot dispatch at all.
    const { getByTestId } = renderSheet();
    const button = getByTestId('launch-dispatch');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toContain('not wired');
    expect(button.tagName).toBe('BUTTON');
  });
});

/**
 * THE SEAM SIDE of dispatch. The fixture seam is where a UI meets the resident
 * dispatcher saga in jsdom, and the two facts it must not flatten are that a
 * dispatcher can have to be SPAWNED, and that the answer is a delivery verdict
 * rather than a session.
 */
describe('the fixture seam models the dispatcher saga rather than stubbing it', () => {
  const firstSpaceId = async (seam: ReturnType<typeof createFixtureSeam>) => {
    const spaces = await seam.spaces();
    expect(spaces.length, 'the fixture seam must expose at least one space').toBeGreaterThan(0);
    return spaces[0]!.id;
  };

  it('spawns the dispatcher once, then reuses it', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const subject = (await seam.query({ spaceId })).page.items[0];
    if (!subject) throw new Error('fixture must supply a subject');

    const first = await seam.commands.dispatch({
      clientMutationId: 'cmid-d1', spaceId, subjectId: subject.id,
    });
    expect(first.dispatcherSpawned).toBe(true);
    expect(first.delivery).toBe('delivered');
    // A task is always derived — dispatch anchors on a task, never the subject.
    expect(first.taskId).toBeTruthy();

    const second = await seam.commands.dispatch({
      clientMutationId: 'cmid-d2', spaceId, subjectId: subject.id,
    });
    // RESIDENT, not per-request: a second dispatcher would be a real defect.
    expect(second.dispatcherSpawned).toBe(false);
    expect(second.dispatcherSessionId).toBe(first.dispatcherSessionId);
  });

  it('stores the request message for real — the id must resolve', async () => {
    /*
     * The handler posts the dispatch request as a durable message on the
     * derived task, and it survives whether or not delivery lands — that is
     * what makes `undelivered` non-fatal. A minted id that resolved to nothing
     * (the original fixture behaviour) would let a surface offer a link into
     * the void and look correct in every test that only checked the shape.
     */
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const subject = (await seam.query({ spaceId })).page.items[0];
    if (!subject) throw new Error('fixture must supply a subject');

    const result = await seam.commands.dispatch({
      clientMutationId: 'cmid-d3', spaceId, subjectId: subject.id, note: 'please route this',
    });
    expect(result.requestMessageId).toBeTruthy();

    const message = await seam.entity(result.requestMessageId!);
    expect(message.kind).toBe('message');
    // Anchored to the TASK — that is where the dispatcher replies, so it is
    // where the request has to live.
    expect(message.state.kind === 'message' ? message.state.anchorId : null).toBe(result.taskId);
    expect(message.content.kind === 'message' ? message.content.body : '').toContain('please route this');
  });

  it('resolves residency by LIVENESS, never by a recorded status', async () => {
    /*
     * DESIGN §5's hazard, stated twice there: "never trust
     * `work_sessions.status` for is-the-dispatcher-alive — sessions die in 40ms
     * with a NULL exit_code; probe, don't read." A dispatcher row that is
     * merely RECORDED as running is not a dispatcher.
     *
     * So: dispatch once, then take the dispatcher out of the liveness snapshot
     * while leaving its stored row untouched. A status-reading resolver would
     * reuse the dead session and report `dispatcherSpawned: false`, delivering
     * into nothing.
     */
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const subject = (await seam.query({ spaceId })).page.items[0];
    if (!subject) throw new Error('fixture must supply a subject');

    const first = await seam.commands.dispatch({
      clientMutationId: 'cmid-d4', spaceId, subjectId: subject.id,
    });
    expect(first.dispatcherSpawned).toBe(true);

    // The row still says `running`; only the verdict changes.
    const record = await seam.entity(first.dispatcherSessionId);
    expect(record.state.kind === 'work_session' ? record.state.status : null).toBe('running');
    seam.fixtureControls.setLiveness(spaceId, []);

    const second = await seam.commands.dispatch({
      clientMutationId: 'cmid-d5', spaceId, subjectId: subject.id,
    });
    expect(second.dispatcherSpawned).toBe(true);
    expect(second.dispatcherSessionId).not.toBe(first.dispatcherSessionId);
  });
});

/**
 * OBLIGATION 4 — the WORKING DIRECTORY default must survive a late project read.
 *
 * `projects` is derived from the gate's `linkedProjects`, which starts empty and
 * is filled by a later read. A sheet mounted before that read sees no projects,
 * and the `useState` initializer that picks the default target runs exactly once
 * — so without a re-seed the sheet latches to scratch, the rows appear a moment
 * later, and every launch the operator does not hand-click goes to a server temp
 * directory instead of the repository. Silent, because a projectless spawn is a
 * legitimate request the server honours by minting scratch.
 */
describe('OBLIGATION 4 — a late project read must still select the default', () => {
  const sheet = (projects: typeof LAUNCH_PROJECTS) => (
    <div className="cv2-root">
      <LaunchSheet
        subjectId={'task-1' as EntityId}
        fromChip="◔ Run ▸"
        fromCaption="task pre-associated"
        teammates={LAUNCH_TEAMMATES}
        projects={projects}
        profiles={LAUNCH_PROFILES}
        capacity={LAUNCH_CAPACITY}
        onLaunch={() => {}}
        onCancel={() => {}}
      />
    </div>
  );

  const checked = (view: ReturnType<typeof render>, name: RegExp) =>
    view.getByRole('radio', { name }).getAttribute('aria-checked');

  it('selects the default project when the list arrives after mount', () => {
    const view = render(sheet([]));
    // Nothing linked yet, so scratch is the only honest answer at this moment.
    expect(checked(view, /scratch/i)).toBe('true');

    view.rerender(sheet(LAUNCH_PROJECTS));

    expect(checked(view, /tm8-ui/)).toBe('true');
    expect(checked(view, /scratch/i)).toBe('false');
  });

  it('leaves an explicit scratch choice alone when the list arrives after it', () => {
    const view = render(sheet([]));
    fireEvent.click(view.getByRole('radio', { name: /scratch/i }));

    view.rerender(sheet(LAUNCH_PROJECTS));

    expect(checked(view, /scratch/i)).toBe('true');
    expect(checked(view, /tm8-ui/)).toBe('false');
  });
});
