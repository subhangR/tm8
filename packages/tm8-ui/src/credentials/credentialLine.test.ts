import { describe, expect, it } from 'vitest';
import type { SessionCredentialCard, SessionCredentialProviderView, SessionCredentialView } from '@tm8/contract';

import { credentialLine } from './credentialLine';

/** Every case in spec 01a0e248 §6's table, plus the R1 states (§4). */

const card = (over: Partial<SessionCredentialCard> = {}): SessionCredentialCard => ({
  id: 'c1', label: 'Team Claude', provider: 'anthropic', status: 'active', visibility: 'public',
  owner: 'space', ownerName: null, displayLogin: null, keyHint: null, detailHidden: false, ...over,
});
const space = (provider: string, c: SessionCredentialCard | null): SessionCredentialProviderView =>
  ({ provider, rung: 'space', credential: c });
const view = (over: Partial<SessionCredentialView> = {}): SessionCredentialView => ({
  binding: 'bound', noneReason: null, providers: [], launchedByViewer: true, resumedBy: null, ...over,
});
const gitCard = (over: Partial<SessionCredentialCard> = {}) =>
  card({ id: 'g1', label: 'Release bot', provider: 'github', displayLogin: 'octo-bot', ...over });

describe('credentialLine — §6 table', () => {
  it('space-owned', () => {
    expect(credentialLine(view({ providers: [space('anthropic', card()), space('github', gitCard())] })))
      .toBe('Running on "Team Claude" · Anthropic · space credential · git as octo-bot');
  });

  it('mine, private', () => {
    const mine = { owner: 'you' as const, visibility: 'private' as const };
    expect(credentialLine(view({ providers: [
      space('anthropic', card({ label: "Subhang's Claude", ...mine, keyHint: 'k9Qz' })),
      space('github', gitCard({ ...mine, displayLogin: 'subhangR' })),
    ] }))).toBe('Running on "Subhang\'s Claude" · Anthropic · private, yours · git as subhangR');
  });

  it("another member's, private: no login, no key hint (gate 3)", () => {
    const theirs = { owner: 'other' as const, visibility: 'private' as const, detailHidden: true };
    const line = credentialLine(view({ providers: [
      space('anthropic', card({ label: "Subhang's Claude", ...theirs })),
      space('github', gitCard({ ...theirs, displayLogin: null })),
    ] }));
    expect(line).toBe('Running on "Subhang\'s Claude" · Anthropic · private, owned by someone else · git as (hidden)');
  });

  it("another member's, private: hides even a login that reached it, because the server marked it hidden", () => {
    // Defence in depth: the formatter never prints a login the server flagged.
    const line = credentialLine(view({ providers: [
      space('github', gitCard({ owner: 'other', visibility: 'private', detailHidden: true, displayLogin: 'leak', keyHint: 'k9Qz' })),
    ] }));
    expect(line).not.toContain('leak');
    expect(line).not.toContain('k9Qz');
  });

  it("another member's, public", () => {
    const theirs = { owner: 'other' as const, visibility: 'public' as const };
    expect(credentialLine(view({ providers: [
      space('anthropic', card({ label: "Subhang's Claude", ...theirs })),
      space('github', gitCard({ ...theirs, displayLogin: 'subhangR' })),
    ] }))).toBe('Running on "Subhang\'s Claude" · Anthropic · owned by someone else · git as subhangR');
  });

  it('names the owner when the server supplies a name', () => {
    expect(credentialLine(view({ providers: [
      space('anthropic', card({ owner: 'other', visibility: 'private', ownerName: 'Subhang', detailHidden: true })),
    ] }))).toBe('Running on "Team Claude" · Anthropic · private, owned by Subhang');
  });

  it('needs none, per R1 reason', () => {
    expect(credentialLine(view({ binding: 'none', noneReason: 'shell' }))).toBe('No vendor credential — shell session');
    expect(credentialLine(view({ binding: 'none', noneReason: 'credential_login' })))
      .toBe('No vendor credential — credential login terminal');
    expect(credentialLine(view({ binding: 'none', noneReason: 'container_exec' })))
      .toBe('No vendor credential — container exec session');
  });

  it('card revoked since launch still names the card', () => {
    expect(credentialLine(view({ providers: [space('anthropic', card({ status: 'revoked' }))] })))
      .toBe('Ran on "Team Claude" (revoked) · Anthropic');
  });

  it('resumed: unchanged credential, plus who resumed', () => {
    expect(credentialLine(view({ providers: [space('anthropic', card())], resumedBy: 'Asha' })))
      .toBe('Running on "Team Claude" · Anthropic · space credential · resumed by Asha');
  });
});

describe('credentialLine — legacy names present and future (§4 rule 4)', () => {
  it('member rung, launched by the viewer', () => {
    expect(credentialLine(view({ binding: 'legacy', providers: [{ provider: 'anthropic', rung: 'member', credential: null }] })))
      .toBe('Running on your own credential (member rung) · Anthropic — this rung goes away at release 2');
  });

  it('member rung, launched by someone else', () => {
    expect(credentialLine(view({ binding: 'legacy', launchedByViewer: false,
      providers: [{ provider: 'anthropic', rung: 'member', credential: null }] })))
      .toBe("Running on the launcher's own credential (member rung) · Anthropic — this rung goes away at release 2");
  });

  it('node rung', () => {
    expect(credentialLine(view({ binding: 'legacy', providers: [{ provider: 'openai', rung: 'node', credential: null }] })))
      .toBe("Running on the node's login (node rung) · OpenAI — this rung goes away at release 2");
  });

  it('mixed: a space card with git on the node rung (the pessimistic roll-up)', () => {
    expect(credentialLine(view({ binding: 'legacy', providers: [
      space('anthropic', card()), { provider: 'github', rung: 'node', credential: null },
    ] }))).toBe('Running on "Team Claude" · Anthropic · space credential · git on the node\'s login (node rung) — this rung goes away at release 2');
  });

  it('both rungs', () => {
    expect(credentialLine(view({ binding: 'legacy', providers: [
      { provider: 'anthropic', rung: 'member', credential: null }, { provider: 'github', rung: 'node', credential: null },
    ] }))).toBe("Running on your own credential (member rung) · Anthropic · git on the node's login (node rung) — these rungs go away at release 2");
  });

  it('echo-agent with an empty map is legacy, never "none"', () => {
    const line = credentialLine(view({ binding: 'legacy' }));
    expect(line).toBe('No named credential; a personal or node login is still reachable — these rungs go away at release 2');
    expect(line).not.toContain('No vendor credential');
  });
});

describe('credentialLine — the other R1 states', () => {
  it('unrecorded stays distinct from legacy and from none', () => {
    const line = credentialLine(view({ binding: 'unrecorded' }));
    expect(line).toBe('Credential not recorded — this session started before sessions recorded theirs');
    expect(line).not.toContain('rung');
    expect(line).not.toContain('No vendor credential');
  });

  it('pending', () => {
    expect(credentialLine(view({ binding: 'pending' }))).toBe('Credential not recorded yet — the session is still resolving it');
  });

  it('unrecorded and resumed', () => {
    expect(credentialLine(view({ binding: 'unrecorded', resumedBy: 'Asha' })))
      .toBe('Credential not recorded — this session started before sessions recorded theirs · resumed by Asha');
  });

  it('a card the viewer cannot read is not guessed at', () => {
    expect(credentialLine(view({ providers: [space('anthropic', null)] })))
      .toBe('Running on a credential not visible to you · Anthropic');
  });

  it('no block renders nothing, never "no credential"', () => {
    expect(credentialLine(undefined)).toBeNull();
    expect(credentialLine(null)).toBeNull();
  });

  it('ownership copy never says member or node outside a rung name', () => {
    for (const owner of ['space', 'you', 'other'] as const) {
      for (const visibility of ['public', 'private'] as const) {
        const line = credentialLine(view({ providers: [space('anthropic', card({ owner, visibility }))] })) ?? '';
        expect(line).not.toMatch(/\bmember\b|\bnode\b/);
      }
    }
  });
});
