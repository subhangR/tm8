// @vitest-environment jsdom
/**
 * The §10.2 connect flow's few high-signal tests (surface ruling S17).
 *
 *  - **S14 item (a)** — the security core. The popup navigates to the provider,
 *    so the opener's `message` listener is reachable from pages tm8 does not
 *    control. Each of the three checks is asserted on its own, so removing any
 *    one of them fails a test rather than silently widening what the page will
 *    believe.
 *  - **§10.2's popup-blocked fallback** — the row where getting it wrong leaves
 *    a person with a dead Connect button and no way through. It also pins the
 *    `returnTo` that makes the same-tab path come back here.
 *  - **One error → copy** — the DCR 403, which is the only producer of §10.0's
 *    `provider_blocked` row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { CollabError } from '@tm8/contract';
import { ConnectorDrawer } from './ConnectorDrawer';
import { connectFailure } from './errors';
import { useConnect, acceptOAuthMessage, returnToPath, OAUTH_MESSAGE_TYPE } from './useConnect';
import type { McpCatalog, McpPort, McpServer } from './port';

afterEach(cleanup);

const server = (over: Partial<McpServer> = {}): McpServer => ({
  id: '11111111-1111-4111-8111-111111111111', version: 1, title: 'Figma', description: '',
  transport: 'http', url: 'https://figma.example/mcp', auth: 'oauth',
  approved: true, enabled: true, canManage: true, canAttach: true, accounts: [],
  source: { name: 'Figma', transport: 'http', url: 'https://figma.example/mcp', envKeys: [], headerKeys: [], auth: { type: 'oauth2', scopes: [] }, approved: true },
  ...over,
});

function port(over: Partial<McpPort> = {}): McpPort {
  return {
    catalog: vi.fn(async (): Promise<McpCatalog> => ({ servers: [], defaults: [], canRegister: true, canAttach: true })),
    catalogEntries: vi.fn(async () => []), addFromCatalog: vi.fn(async () => ({ serverId: 'x', adopted: false })),
    request: vi.fn(), patch: vi.fn(), register: vi.fn(), update: vi.fn(), remove: vi.fn(),
    importConfig: vi.fn(), importMany: vi.fn(), attach: vi.fn(), detach: vi.fn(),
    test: vi.fn(async () => ({ ok: true, message: 'ready', tools: [] })),
    createKey: vi.fn(), rotateKey: vi.fn(),
    startOAuth: vi.fn(async () => ({ authorizationUrl: 'https://figma.example/oauth/authorize?state=s' })),
    share: vi.fn(), revoke: vi.fn(), members: vi.fn(async () => []),
    ...over,
  };
}

describe('S14(a) — the opener believes one origin, one window, one type', () => {
  const popup = { name: 'popup' } as unknown as Window;
  const good = { origin: 'https://tm8.example', source: popup, data: { type: OAUTH_MESSAGE_TYPE, status: 'connected', credentialId: 'cred' } };

  it('accepts the message the callback page actually sends', () => {
    expect(acceptOAuthMessage(good, popup, 'https://tm8.example')).toMatchObject({ status: 'connected', credentialId: 'cred' });
  });

  it('refuses another origin', () => {
    // The provider's own page, or anything it embeds, posting into the opener.
    expect(acceptOAuthMessage({ ...good, origin: 'https://figma.example' }, popup, 'https://tm8.example')).toBeNull();
    expect(acceptOAuthMessage({ ...good, origin: 'null' }, popup, 'https://tm8.example')).toBeNull();
  });

  it('refuses another window, including when no popup of ours is open', () => {
    const stranger = { name: 'other' } as unknown as Window;
    expect(acceptOAuthMessage({ ...good, source: stranger }, popup, 'https://tm8.example')).toBeNull();
    // A `source` of null must not match a `popup` of null.
    expect(acceptOAuthMessage({ ...good, source: null }, null, 'https://tm8.example')).toBeNull();
  });

  it('refuses another type or an unknown status', () => {
    expect(acceptOAuthMessage({ ...good, data: { type: 'tm8.something.else', status: 'connected' } }, popup, 'https://tm8.example')).toBeNull();
    expect(acceptOAuthMessage({ ...good, data: { type: OAUTH_MESSAGE_TYPE, status: 'whatever' } }, popup, 'https://tm8.example')).toBeNull();
    expect(acceptOAuthMessage({ ...good, data: 'tm8.mcp.oauth' }, popup, 'https://tm8.example')).toBeNull();
  });
});

describe('§10.2 — the popup-blocked fallback', () => {
  it('offers a same-tab link, and asks the server to bring the person back here', async () => {
    const live = port();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<ConnectorDrawer server={server()} port={live} admin={false} busy={false}
      run={async action => { await action(); }} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    const link = await screen.findByRole('link', { name: 'Continue to Figma' });
    expect(link.getAttribute('href')).toBe('https://figma.example/oauth/authorize?state=s');
    expect(screen.getByRole('alert').textContent).toContain('blocked the sign-in window');
    // The same-tab path has no opener to message, so `returnTo` on the SERVER's
    // pending row is the only thing that gets the person back.
    expect(live.startOAuth).toHaveBeenCalledWith(server().id, 'Figma', 'member', returnToPath(window.location));
    open.mockRestore();
  });

  it('keeps returnTo a path on this origin, never a URL', () => {
    expect(returnToPath({ pathname: '/', search: '', hash: '#/s/space/settings/connectors' })).toBe('/#/s/space/settings/connectors');
    // `//host` and a backslash are read as another origin by browsers, so the
    // contract refuses both — sending one would fail the whole `begin`.
    expect(returnToPath({ pathname: '//evil.example/', search: '', hash: '' })).toBeUndefined();
    expect(returnToPath({ pathname: '/\\evil.example', search: '', hash: '' })).toBeUndefined();
  });
});

describe('§10.2 — the DCR 403 is the provider_blocked row', () => {
  it('names the provider, offers no retry, and tells only an admin what to do', () => {
    const refusal = new CollabError('upstream_unavailable', 'OAuth client registration rejected by provider: https://www.figma.com answered 403 (forbidden).');

    const member = connectFailure(refusal, { name: 'Figma', admin: false });
    expect(member).toMatchObject({ status: 'provider_blocked', retry: false });
    expect(member.message).toBe("Figma hasn't approved tm8 as an MCP client yet.");
    // A member gets no server diagnosis and no settings button they cannot use.
    expect(member.cause).toBeUndefined();
    expect(member.adminHint).toBeUndefined();

    const admin = connectFailure(refusal, { name: 'Figma', admin: true });
    expect(admin.adminHint).toContain('Client ID');
    expect(admin.cause).toContain('answered 403');
  });

  it('shows the admin the row, and a member only what happened', async () => {
    const live = port({ startOAuth: vi.fn(async () => { throw new CollabError('upstream_unavailable', 'OAuth client registration rejected by provider: https://www.figma.com answered 403.'); }) });
    render(<ConnectorDrawer server={server()} port={live} admin={false} busy={false}
      run={async action => { await action(); }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("hasn't approved tm8 as an MCP client yet"));
    // §10.0's row, which only a failed begin can produce.
    expect(screen.getByText(/Figma hasn't approved tm8 yet/)).toBeTruthy();
    // No provider text crosses into the view for a member.
    expect(document.body.textContent).not.toContain('www.figma.com');
  });
});


it('opens the sign-in window during the click, before asynchronous discovery finishes', async () => {
  let finish: (value: { authorizationUrl: string }) => void = () => {};
  const pending = new Promise<{ authorizationUrl: string }>(resolve => { finish = resolve; });
  const child = { close: vi.fn(), focus: vi.fn(), location: { href: 'about:blank' }, closed: false };
  const open = vi.spyOn(window, 'open').mockReturnValue(child as unknown as Window);
  const p = port({ startOAuth: vi.fn(() => pending) });
  const { result, unmount } = renderHook(() => useConnect({ port: p, admin: true, onConnected: vi.fn() }));
  let started: Promise<void> = Promise.resolve();
  act(() => { started = result.current.start(server(), { label: 'Work', scope: 'member' }); });
  expect(open).toHaveBeenCalledWith('about:blank', 'tm8-mcp-oauth', expect.any(String));
  await act(async () => { finish({ authorizationUrl: 'https://figma.example/authorize' }); await started; });
  expect(child.location.href).toBe('https://figma.example/authorize');
  unmount(); open.mockRestore();
});
