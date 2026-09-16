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
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import { LAUNCH_CAPACITY, LAUNCH_MEMORIES, LAUNCH_PROFILES, LAUNCH_PROJECTS, LAUNCH_TEAMMATES } from './launch-fixtures';

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
      'MEMORIES',
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
 * THE MEMORY PICKER (D3a, `memoryIds`).
 *
 * Two things here are easy to get wrong and expensive to notice later:
 *
 * 1. ABSENT IS NOT EMPTY. `memories === undefined` means nobody has read the
 *    kind into this client; `memories === []` means the space has none. Only
 *    the second is a measurement, and a picker that renders them the same way
 *    reports a fact nobody established.
 * 2. THE CAP IS THE CONTRACT'S. `memoryIds` is `max(32)` (schemas.ts:1662).
 *    Enforced at the pick, not at the launch, so the 33rd is refused with a
 *    reason instead of the node rejecting a launch already committed to.
 */
describe('the memory picker hands ids to spawn without becoming a manager', () => {
  const openPicker = (props: Partial<React.ComponentProps<typeof LaunchSheet>> = {}) => {
    const view = renderSheet({ memories: LAUNCH_MEMORIES, ...props });
    fireEvent.click(view.getByLabelText('Change picked memories'));
    return view;
  };

  it('says the list is UNKNOWN when memories were never read, not empty', () => {
    // The prop is omitted entirely — the boot-time state before `ensureKind`.
    const { getByText, queryByLabelText } = renderSheet();
    expect(getByText(/have not been read into this client/i)).toBeTruthy();
    expect(getByText(/unknown, not empty/i)).toBeTruthy();
    // …and there is nothing to open, because there is nothing to choose from.
    expect(queryByLabelText('Change picked memories')).toBeNull();
  });

  it('says the SPACE is empty when the read happened and found none', () => {
    const { getByText } = openPicker({ memories: [] });
    expect(getByText(/This space has no memories yet/i)).toBeTruthy();
  });

  it('carries picked ids into onLaunch, and omits the field when none picked', () => {
    const launches: Array<Record<string, unknown>> = [];
    const { getByText, getByRole } = openPicker({
      onLaunch: (config) => launches.push(config as unknown as Record<string, unknown>),
    });

    fireEvent.click(getByRole('button', { name: /Launch/ }));
    // An absent field and an empty array are not the same statement.
    expect(launches[0] && 'memoryIds' in launches[0]).toBe(false);

    fireEvent.click(getByText('tokens.css is verbatim — a byte-equality test guards it'));
    fireEvent.click(getByText('The fixture seam drops fields it does not know'));
    fireEvent.click(getByRole('button', { name: /Launch/ }));
    expect(launches[1]?.memoryIds).toEqual(['ent-mem-tokens', 'ent-mem-disputed']);
  });

  it('toggles a pick off again — it is a set, not a one-way door', () => {
    const launches: Array<Record<string, unknown>> = [];
    const { getByText, getByRole } = openPicker({
      onLaunch: (config) => launches.push(config as unknown as Record<string, unknown>),
    });
    const row = getByText('tokens.css is verbatim — a byte-equality test guards it');
    fireEvent.click(row);
    fireEvent.click(row);
    fireEvent.click(getByRole('button', { name: /Launch/ }));
    expect(launches[0] && 'memoryIds' in launches[0]).toBe(false);
  });

  it('announces a SET, not a single choice, and shows each mark before the pick', () => {
    const { getAllByRole, getByText } = openPicker();
    // checkbox, never radio: a radiogroup would announce single-choice.
    expect(getAllByRole('checkbox')).toHaveLength(3);
    // A disputed claim cannot be picked without its mark being visible.
    expect(getByText(/disputed · data\/fixtures/)).toBeTruthy();
    // The SCOPE rides along — a true statement about the wrong subject is the
    // failure the scope line exists to prevent.
    expect(getByText(/unflagged · packages\/tm8-ui\/src\/styles\/tokens\.css/)).toBeTruthy();
  });

  it('is a picker and not a manager — no authoring controls anywhere in it', () => {
    const { queryByTestId, queryByText } = openPicker();
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
  it('sends ONLY the subject, whatever the sheet was configured to', () => {
    const dispatched: Array<Record<string, unknown>> = [];
    const { getByTestId, getByText, getByLabelText } = renderSheet({
      memories: LAUNCH_MEMORIES,
      onDispatch: (r) => dispatched.push(r as unknown as Record<string, unknown>),
    });

    // Configure the sheet as fully as the surface allows first — a teammate
    // other than the default, a model, and a picked memory.
    fireEvent.click(getByText('scout'));
    fireEvent.change(getByTestId('launch-model'), { target: { value: 'claude-opus-5' } });
    fireEvent.click(getByLabelText('Change picked memories'));
    fireEvent.click(getByText('tokens.css is verbatim — a byte-equality test guards it'));

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
