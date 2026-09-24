// @vitest-environment jsdom
/**
 * SC-8 — sharing a personal credential into a space (sc8-6).
 *
 * What is held here: Settings → Agent credentials offers "Share to this space"
 * only for a fine-grained GitHub token and sends a LABEL, never a token (by
 * reference); a classic or OAuth token is refused on screen with the reason;
 * "Stop sharing" confirms, un-shares through the space credential delete and
 * says how many sessions it ended; and a share row in Space credentials reads
 * "Shared by <name>" and is editable by its sharer alone, removable by an admin.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  CredentialsSharesView,
  SpaceCredentialShareView,
  SpaceCredentialView,
} from '@tm8/contract';
import { SharesBlock, shareTokenSentence } from './SharesBlock';
import type { SharesPort } from './port';
import { canManage, canRemove, sharedByLabel } from './space-credentials-model';

const ME = 'acct-me';
const OTHER = 'acct-other';

function share(over: Partial<SpaceCredentialShareView> = {}): SpaceCredentialShareView {
  return {
    id: 'sh-1',
    spaceId: 'space-1',
    spaceName: 'Space One',
    provider: 'github',
    shape: 'token',
    label: 'Ada’s GitHub',
    isDefault: false,
    status: 'active',
    createdByAccountId: ME,
    displayLogin: 'ada',
    keyHint: null,
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:00.000Z',
    lastUsedAt: null,
    lastProbeAt: null,
    shareKind: 'personal_token',
    sharedBy: { accountId: ME, displayName: 'Ada' },
    ...over,
  };
}

function sharesPort(github: CredentialsSharesView['github'], initial: SpaceCredentialShareView[] = []) {
  let shares = [...initial];
  const port = {
    spaceId: 'space-1',
    load: vi.fn(async (): Promise<CredentialsSharesView> => ({ shares: shares.map((s) => ({ ...s })), github })),
    shareToken: vi.fn(async (label: string): Promise<SpaceCredentialView> => {
      const created = share({ id: `sh-${shares.length + 1}`, label });
      shares = [...shares, created];
      return created;
    }),
    unshare: vi.fn(async (credentialId: string) => {
      shares = shares.filter((s) => s.id !== credentialId);
      return { credentialId, revoked: true, terminatedLoginSessionIds: [], terminatedAgentSessionIds: ['ws-1', 'ws-2'], failures: [] };
    }),
  } satisfies SharesPort;
  return port;
}

const FINE = { connected: true, login: 'ada', tokenKind: 'fine_grained', shareable: true } as const;
const CLASSIC = { connected: true, login: 'ada', tokenKind: 'classic', shareable: false } as const;

describe('SharesBlock — Share to this space', () => {
  it('shares a fine-grained token by LABEL: the port is called with the label and nothing else', async () => {
    const port = sharesPort(FINE);
    render(<SharesBlock port={port} />);
    const input = await screen.findByTestId('share-token-label');
    fireEvent.change(input, { target: { value: 'Ada’s GitHub' } });
    fireEvent.click(screen.getByTestId('share-token-submit'));
    await waitFor(() => expect(port.shareToken).toHaveBeenCalledTimes(1));
    expect(port.shareToken.mock.calls[0]).toEqual(['Ada’s GitHub']);
    expect((await screen.findByTestId('shares-notice')).textContent).toContain('Shared your GitHub token to this space');
    expect((await screen.findByTestId('share-row-sh-1')).textContent).toContain('shared to Space One');
    // Already shared here: the form is gone rather than offering a second share.
    expect(screen.getByTestId('share-token-already')).toBeTruthy();
    expect(screen.queryByTestId('share-token-label')).toBeNull();
  });

  it('CONTROL: a classic token offers no form and says why', async () => {
    const port = sharesPort(CLASSIC);
    render(<SharesBlock port={port} />);
    expect((await screen.findByTestId('share-token-sentence')).textContent).toContain('Only a fine-grained token can be shared');
    expect(screen.queryByTestId('share-token-label')).toBeNull();
    expect(port.shareToken).not.toHaveBeenCalled();
  });

  it('every token kind has its own sentence, and none quotes a token', () => {
    expect(shareTokenSentence({ connected: false, login: null, tokenKind: null, shareable: false })).toMatch(/Connect GitHub/);
    expect(shareTokenSentence(FINE)).toMatch(/can be shared/);
    expect(shareTokenSentence(CLASSIC)).toMatch(/classic token/);
    expect(shareTokenSentence({ ...CLASSIC, tokenKind: 'oauth' })).toMatch(/OAuth token/);
    expect(shareTokenSentence({ ...CLASSIC, tokenKind: 'other' })).toMatch(/github_pat_/);
  });
});

describe('SharesBlock — Stop sharing', () => {
  it('confirms, un-shares through the port, and reports the ended sessions', async () => {
    const port = sharesPort(FINE, [share()]);
    render(<SharesBlock port={port} />);
    fireEvent.click(await screen.findByTestId('share-stop-sh-1'));
    expect(port.unshare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('share-stop-confirm-sh-1'));
    await waitFor(() => expect(port.unshare).toHaveBeenCalledWith('sh-1'));
    expect((await screen.findByTestId('shares-notice')).textContent).toContain('2 live sessions on it were ended');
    expect(await screen.findByTestId('shares-empty')).toBeTruthy();
  });
});

describe('Space credentials — a share row (amended D11)', () => {
  const row = share() as SpaceCredentialView;
  const sharer = { accountId: ME, isSpaceAdmin: false, isNodeAdmin: false };
  const admin = { accountId: OTHER, isSpaceAdmin: true, isNodeAdmin: false };
  const member = { accountId: OTHER, isSpaceAdmin: false, isNodeAdmin: false };

  it('reads "Shared by <name>" to others and "you" to the sharer', () => {
    expect(sharedByLabel(row, member)).toBe('Ada');
    expect(sharedByLabel(row, sharer)).toBe('you');
    expect(sharedByLabel({ ...row, sharedBy: null }, member)).toBe('a member');
  });

  it('only the sharer manages it; an admin may only remove it; a member may do neither', () => {
    expect(canManage(row, sharer)).toBe(true);
    expect(canManage(row, admin)).toBe(false);
    expect(canRemove(row, admin)).toBe(true);
    expect(canManage(row, member)).toBe(false);
    expect(canRemove(row, member)).toBe(false);
  });
});
