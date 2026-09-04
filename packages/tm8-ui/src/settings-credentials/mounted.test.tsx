// @vitest-environment jsdom
/**
 * THE SECTION IS REACHABLE, AND THE LOGIN TERMINAL IS NOT.
 *
 * Three claims, none provable by the component test next door.
 *
 * 1. A HUMAN CAN GET TO IT. This repository already contains FOUR built,
 *    tested, never-imported surfaces — settings-governance's three screens and
 *    shell/LiveSessionBar — each of them real work no user has ever seen. Every
 *    one of them has a green component test. So a green component test is
 *    precisely the evidence that does NOT distinguish a shipped screen from a
 *    dead one, and this file supplies the evidence that does: the nav row
 *    exists, clicking it renders THIS module's body, and `GateApp` actually
 *    passes the section through the shell's slot.
 *
 *    The last of those is a static scan on purpose. It is the four-links
 *    problem `settings-space/port-seam.test.tsx` was written for: declaration,
 *    data, implementation and CALL can each be green while the feature is
 *    dead, because nobody asserted the caller passes the argument. Rendering
 *    the whole gate here would prove it too, but `gate.test.tsx` carries 15
 *    pre-existing localStorage failures in this environment, so a render-based
 *    mount proof would be indistinguishable from that noise.
 *
 * 2. LOGIN TERMINALS DO NOT APPEAR IN SESSION LISTS. Asserted on the RENDERED
 *    surfaces, not on the helper — `rowsFor` has a measured history of
 *    accepting a filter argument and ignoring it, so a green helper test can
 *    certify a filter that no surface applies.
 *
 * 3. HOME AND SETTINGS MOUNT ONE IMPLEMENTATION. A static caller check pins
 *    both hosts to `CredentialsProviderBlock`; duplicating provider markup in
 *    Home would fail even if both copies happened to look alike today.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntitySummary } from '@tm8/contract';
import { SettingsShell } from '../settings-space';
import { SETTINGS_SECTIONS } from '../settings-space/types';
import { projectRows } from '../data/project/domain-store';
import {
  sessionCredentialLogin,
  sessionExited,
  sessionFailed,
  sessionLive,
  sessionStale,
} from '../fixtures';
import { CredentialsSection } from './CredentialsSection';
import type { CredentialsPort } from './port';

const port: CredentialsPort = {
  load: async () => ({
    providers: [
      { provider: 'anthropic', connected: true, login: null, authMethod: 'oauth', status: 'active', connectedAt: null, lastVerifiedAt: null },
      { provider: 'openai', connected: false, login: null, authMethod: null, status: null, connectedAt: null, lastVerifiedAt: null },
      { provider: 'github', connected: false, login: null, authMethod: null, status: null, connectedAt: null, lastVerifiedAt: null },
      { provider: 'gemini', connected: false, login: null, authMethod: null, status: 'stale', connectedAt: null, lastVerifiedAt: null },
      { provider: 'hermes', connected: false, login: null, authMethod: null, status: 'unavailable', connectedAt: null, lastVerifiedAt: null },
      { provider: 'cursor', connected: true, login: null, authMethod: null, status: 'active', connectedAt: null, lastVerifiedAt: null },
    ],
    gitCredentialStore: 'absent',
  }),
  disconnect: async (provider) => ({
    provider, revoked: true, terminatedCredentialSessionIds: [], terminatedAgentSessionIds: [], failures: [],
  }),
  startLogin: async (provider) => ({
    workSessionId: 'ws-login-1', spaceId: 'space-1', provider,
    expiresAt: '2026-08-08T12:00:00.000Z', command: `${provider} login`,
  }),
  finishLogin: async (workSessionId) => ({
    workSessionId, provider: 'github' as const, connected: true, login: 'ada',
    authMethod: 'oauth', status: 'active' as const, stored: false, terminated: true,
  }),
};

const settingsPort = {
  loadSpace: async () => null,
  loadMembers: async () => [],
  loadIdentity: async () => ({ memberId: 'm-1', displayName: 'Ada', avatar: null, role: 'owner' }) as never,
  loadMenu: async () => ({ menu: null, source: 'default', error: null }) as never,
  loadInvites: async () => [],
  updateProfile: async () => ({}) as never,
};

describe('the section is REACHABLE from the shell a human already opens', () => {
  it('has a nav row in the shipped section list', () => {
    const row = SETTINGS_SECTIONS.find((s) => s.id === 'credentials');
    expect(row).toBeTruthy();
    expect(row?.label).toBe('Agent credentials');
    // Externally owned, so an unsupplied body renders the shell's honest
    // not-mounted state rather than a blank pane.
    expect(row?.externallyOwned).toBe(true);
  });

  it('clicking that nav row renders THIS module’s body, not a placeholder', async () => {
    render(
      <SettingsShell
        port={settingsPort as never}
        sections={{ credentials: <CredentialsSection port={port} /> }}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Agent credentials' }));

    // The body that appears is the real one — it has reached the port and is
    // drawing a provider card, not the shell's "built in another module" card.
    expect(await screen.findByTestId('credentials-provider-block')).toBeTruthy();
    expect(await screen.findByTestId('credential-card-anthropic')).toBeTruthy();
    expect(screen.getAllByTestId(/^credential-card-/)).toHaveLength(6);
    expect(screen.queryByTestId('section-absent')).toBeNull();
  });

  it('renders the shell’s honest not-mounted state when the body is NOT supplied', async () => {
    // The control for the test above: if the shell rendered a real-looking
    // body either way, the previous assertion would prove nothing.
    render(<SettingsShell port={settingsPort as never} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Agent credentials' }));
    expect(await screen.findByTestId('section-absent')).toBeTruthy();
    expect(screen.queryByTestId('credential-card-anthropic')).toBeNull();
  });

  /**
   * THE LINK THAT ACTUALLY SHIPS IT. Everything above passes with a `GateApp`
   * that never injects the section — that is exactly how four surfaces in this
   * repo came to be built and unreachable.
   */
  it('GateApp injects the section into the live shell', () => {
    // Resolved from the vitest root, not from `import.meta.url`: in a .tsx
    // module the transform does not leave that a `file:` URL, and the sibling
    // scans that do use it are all plain .ts.
    const gate = readFileSync(join(process.cwd(), 'src/views/GateApp.tsx'), 'utf8');
    expect(gate).toContain('credentialsPortFromSeam');
    expect(gate).toContain('CredentialsSection');
    // Passed through the shell's slot, on the SettingsShell that GateApp
    // actually renders — not merely imported.
    expect(gate).toMatch(/<SettingsShell[\s\S]*?sections=\{[\s\S]*?credentials:/);
  });

  it('Home and Settings mount the same provider block instead of forking its markup', () => {
    const settings = readFileSync(
      join(process.cwd(), 'src/settings-credentials/CredentialsSection.tsx'),
      'utf8',
    );
    const home = readFileSync(join(process.cwd(), 'src/home-page/HomePage.tsx'), 'utf8');

    expect(settings).toMatch(/<CredentialsProviderBlock\b/);
    expect(home).toMatch(/<CredentialsProviderBlock\b/);
    // The home host still binds spaceId at the same port adapter; it does not
    // call credentials operations directly or grow a second adapter.
    expect(home).toContain('credentialsPortFromSeam(data.seam, data.spaceId)');
    expect(home).not.toMatch(/data\.seam\.credentials\.(status|disconnect|startLogin|finishLogin)/);
  });
});

describe('login terminals are filtered out of session lists', () => {
  const spaceId = sessionLive.spaceId;
  /** Only the rows a given case is about — `projectRows` also promotes rows it
   *  knows but the read never returned, so a wide table would add arrivals and
   *  make the assertion about the wrong thing. */
  const table = (...rows: EntitySummary[]): Record<string, EntitySummary> =>
    Object.fromEntries(rows.map((s) => [s.id, s]));

  it('drops a credential session the server DID return', () => {
    const out = projectRows({
      ordered: [sessionLive.id, sessionCredentialLogin.id],
      entities: table(sessionLive, sessionCredentialLogin),
      kind: 'work_session',
      spaceId,
      filter: undefined,
    });
    expect(out.map((r) => r.id)).toEqual([sessionLive.id]);
  });

  it('drops a credential session that ARRIVES on the event stream', () => {
    // The other half of the loop: a login terminal opened AFTER the read — so
    // present in the store and absent from `ordered` — must not be promoted to
    // the head of the list either.
    const out = projectRows({
      ordered: [sessionLive.id],
      entities: table(sessionLive, sessionCredentialLogin),
      kind: 'work_session',
      spaceId,
      filter: undefined,
    });
    expect(out.map((r) => r.id)).toEqual([sessionLive.id]);
  });

  /**
   * THE INVERSE-FILTER LAW, asserted as an asymmetry so it cannot be tidied
   * into an equality later.
   *
   * The field is OPTIONAL. A row hydrated from a payload cached before 082, or
   * served by a node that predates it, carries NO `sessionKind`. Written as
   * `=== 'agent'` this filter would drop every one of them — a bug that
   * reproduces on nobody's fresh local data and silently blanks the session
   * list for exactly the users least able to explain why. ABSENCE MEANS
   * VISIBLE.
   */
  it('KEEPS a session with NO sessionKind at all — the frozen-server case', () => {
    // The four fixtures beside the credential one carry no sessionKind: they
    // are the pre-082 shape, and every one of them must survive.
    for (const pre082 of [sessionLive, sessionStale, sessionExited, sessionFailed]) {
      expect((pre082.state as { sessionKind?: unknown }).sessionKind).toBeUndefined();
    }
    const out = projectRows({
      ordered: [sessionLive.id, sessionStale.id, sessionExited.id, sessionFailed.id, sessionCredentialLogin.id],
      entities: table(sessionLive, sessionStale, sessionExited, sessionFailed, sessionCredentialLogin),
      kind: 'work_session',
      spaceId,
      filter: undefined,
    });
    expect(out.map((r) => r.id)).toEqual([
      sessionLive.id, sessionStale.id, sessionExited.id, sessionFailed.id,
    ]);
  });

  it('keeps an EXPLICIT agent session', () => {
    const explicit = {
      ...sessionLive,
      id: 'ws-explicit-agent',
      state: { ...(sessionLive.state as object), sessionKind: 'agent' },
    } as EntitySummary;
    const out = projectRows({
      ordered: [explicit.id],
      entities: { [explicit.id]: explicit },
      kind: 'work_session',
      spaceId,
      filter: undefined,
    });
    expect(out.map((r) => r.id)).toEqual([explicit.id]);
  });

  /**
   * ON A RENDERED SURFACE, per the ruling. The fixture roster CONTAINS the
   * credential login session, so a list panel that stopped filtering would
   * draw a row here.
   */
  it('does not appear in a rendered session list panel', async () => {
    const { EntityListPanel } = await import('../panels');
    // `rowsFor` is wired the way the shell wires it — THROUGH `projectRows` —
    // rather than handed a pre-filtered array. Handing the panel a clean list
    // would assert only that the panel renders what it is given, which is not
    // the claim: the claim is that the surface a human sees applies the filter.
    const rowsFor = () =>
      projectRows({
        ordered: [sessionLive.id, sessionCredentialLogin.id],
        entities: table(sessionLive, sessionCredentialLogin),
        kind: 'work_session',
        spaceId,
        filter: undefined,
      });

    const { container } = render(
      <EntityListPanel
        kind="work_session"
        rowsFor={rowsFor}
        ctx={{ viewer: null, capabilities: {} } as never}
      />,
    );

    expect(within(container).queryByText(sessionCredentialLogin.title)).toBeNull();
    expect(within(container).getAllByText(sessionLive.title).length).toBeGreaterThan(0);
  });
});
