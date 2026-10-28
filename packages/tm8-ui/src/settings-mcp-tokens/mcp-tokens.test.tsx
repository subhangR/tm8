// @vitest-environment jsdom
/**
 * §10.7 — Settings → MCP tokens. A FEW HIGH-SIGNAL TESTS (test policy v5),
 * each one holding a claim the surface would otherwise only assert in prose:
 *
 * - THE SECURITY ONE: the secret is shown once and is GONE after the panel is
 *   dismissed — not in the DOM, not in `localStorage` or `sessionStorage`, and
 *   not recoverable by reopening anything (surface security item e). Revert-
 *   proved: keeping `created` on dismiss makes it fail.
 * - `spaceIds` is the member's explicit choice — `null` only for the "All my
 *   spaces" radio, the chosen list otherwise. Never omitted.
 * - the three snippets carry the SERVER'S endpoint and a bearer header.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpTokenCreateResult, McpTokenView } from '@tm8/contract';
import { McpTokensSection } from './McpTokensSection';
import type { McpTokenCreateFields, McpTokensPort } from './port';

const SECRET = 'tm8m_11111111-1111-4111-8111-111111111111.sEcReTvAlUe0123456789';
const ENDPOINT = 'https://tm8.example.com/mcp';

function view(over: Partial<McpTokenView> = {}): McpTokenView {
  return {
    id: '11111111-1111-4111-8111-111111111111', label: 'Laptop – Claude',
    spaceIds: null, missingSpaceIds: [], readOnly: false, connectorIds: null,
    expiresAt: new Date(Date.now() + 83 * 86_400_000).toISOString(),
    lastUsedAt: null, lastUsedIp: null,
    createdAt: new Date().toISOString(), revokedAt: null,
    ...over,
  };
}

function fixture(over: Partial<McpTokensPort> = {}) {
  const created: McpTokenCreateFields[] = [];
  const port: McpTokensPort = {
    list: vi.fn(async () => [] as McpTokenView[]),
    spaces: vi.fn(async () => [{ id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'atelier' },
      { id: 'bbbbbbbb-1111-4111-8111-111111111111', name: 'tm8-web' }]),
    create: vi.fn(async (fields: McpTokenCreateFields) => {
      created.push(fields);
      return { token: view({ label: fields.label }), secret: SECRET, endpoint: ENDPOINT } satisfies McpTokenCreateResult;
    }),
    revoke: vi.fn(async () => view({ revokedAt: new Date().toISOString() })),
    ...over,
  };
  return { port, created };
}

async function createToken(port: McpTokensPort, pick?: () => void) {
  render(<McpTokensSection port={port} />);
  await screen.findByTestId('mcp-tokens-empty');
  fireEvent.click(screen.getByTestId('mcp-token-new'));
  fireEvent.change(screen.getByRole('textbox', { name: /label/i }), { target: { value: 'Laptop – Claude' } });
  pick?.();
  fireEvent.click(screen.getByTestId('mcp-token-create'));
  await screen.findByTestId('mcp-token-created');
}

afterEach(cleanup);

describe('§10.7 — the token is shown once and never persisted', () => {
  it('drops the secret from the page when the show-once panel is dismissed', async () => {
    const { port } = fixture();
    await createToken(port);
    // Shown once: the secret, and every snippet built from it, are on screen.
    expect(screen.getByTestId('mcp-token-secret').textContent).toBe(SECRET);
    expect(document.body.innerHTML).toContain(SECRET);

    fireEvent.click(screen.getByTestId('mcp-token-dismiss'));

    await waitFor(() => expect(screen.queryByTestId('mcp-token-created')).toBeNull());
    // THE assertion this file exists for.
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(screen.queryByTestId('mcp-token-secret')).toBeNull();
    for (const store of [window.localStorage, window.sessionStorage]) {
      const dump = Object.keys(store).map((key) => `${key}=${store.getItem(key) ?? ''}`).join('\n');
      expect(dump).not.toContain(SECRET);
    }
    // And there is no door back to it: the list that replaced the panel is
    // built from `mcp.tokens.list`, whose rows have never carried a secret.
    expect(JSON.stringify(await port.list())).not.toContain(SECRET);
  });

  it('offers no reveal: a listed token draws no secret and no way to ask for one', async () => {
    const { port } = fixture({ list: vi.fn(async () => [view()]) });
    render(<McpTokensSection port={port} />);
    await screen.findByTestId('mcp-token-11111111-1111-4111-8111-111111111111');
    expect(screen.queryByTestId('mcp-token-secret')).toBeNull();
    expect(screen.queryByRole('button', { name: /reveal|show token|copy token/i })).toBeNull();
    // The row says when it expires in words, never an ISO string.
    expect(screen.getByTestId('mcp-token-expiry-11111111-1111-4111-8111-111111111111').textContent).toBe('expires in 83 days');
  });
});

describe('§10.7 — "all my Spaces" is a choice, not a default', () => {
  it('sends spaceIds: null only for the All radio, and the chosen list otherwise', async () => {
    const all = fixture();
    await createToken(all.port);
    expect(all.created).toEqual([{ label: 'Laptop – Claude', spaceIds: null, expiresInDays: 90 }]);
    cleanup();

    const some = fixture();
    await createToken(some.port, () => {
      fireEvent.click(screen.getByLabelText('Only these'));
      fireEvent.click(screen.getByLabelText('tm8-web'));
    });
    expect(some.created).toEqual([
      { label: 'Laptop – Claude', spaceIds: ['bbbbbbbb-1111-4111-8111-111111111111'], expiresInDays: 90 },
    ]);
  });

  it('refuses "Only these" with nothing chosen rather than falling back to all', async () => {
    const { port, created } = fixture();
    render(<McpTokensSection port={port} />);
    await screen.findByTestId('mcp-tokens-empty');
    fireEvent.click(screen.getByTestId('mcp-token-new'));
    fireEvent.change(screen.getByRole('textbox', { name: /label/i }), { target: { value: 'CI' } });
    fireEvent.click(screen.getByLabelText('Only these'));
    fireEvent.click(screen.getByTestId('mcp-token-create'));
    expect((await screen.findByTestId('mcp-token-create-error')).textContent).toMatch(/at least one Space/i);
    expect(created).toEqual([]);
  });
});

describe('§10.7 — the client snippets', () => {
  it('point Claude Desktop, Cursor and the CLI at the server’s endpoint with a bearer', async () => {
    const { port } = fixture();
    await createToken(port);
    for (const id of ['claude-desktop', 'cursor', 'cli']) {
      const block = screen.getByTestId(`mcp-token-snippet-${id}`);
      expect(block.textContent, id).toContain(ENDPOINT);
      expect(block.textContent, id).toContain(`Bearer ${SECRET}`);
    }
    expect(screen.getByTestId('mcp-token-snippet-cli').textContent)
      .toContain(`claude mcp add --transport http tm8 ${ENDPOINT}`);
  });
});

describe('§10.7 — revoke asks first', () => {
  it('revokes only after the confirm, and says what it did', async () => {
    const { port } = fixture({ list: vi.fn(async () => [view()]) });
    render(<McpTokensSection port={port} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Laptop – Claude' }));
    expect(port.revoke).not.toHaveBeenCalled();
    expect(screen.getByTestId('mcp-token-confirm-11111111-1111-4111-8111-111111111111').textContent)
      .toContain('stop working immediately');
    fireEvent.click(screen.getByTestId('mcp-token-revoke-11111111-1111-4111-8111-111111111111'));
    await waitFor(() => expect(port.revoke).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111'));
    expect((await screen.findByTestId('mcp-tokens-notice')).textContent).toContain('Revoked Laptop – Claude');
  });
});
