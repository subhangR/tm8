import { expect, it } from 'vitest';
import { readOAuthToken } from '../src/oauth-token.js';

it('records Slack user scopes instead of a different top-level grant', () => {
  const token = readOAuthToken({ ok: true, access_token: 'fixture', token_type: 'user',
    scope: 'channels:history,chat:write', authed_user: { scope: 'channels:read,emoji:read' } }, 'https://slack.com/api/oauth.v2.user.access');
  expect(token.scope).toBe('channels:read emoji:read');
});
it('normalizes Slack comma scopes without changing standard OAuth scope syntax', () => {
  const response = { access_token: 'fixture', token_type: 'Bearer', scope: 'read,limited write', expires_in: 10 };
  expect(readOAuthToken(response, 'https://example.com/token', 1000)).toMatchObject({ scope: 'read,limited write', expiresAt: 11000 });
  expect(readOAuthToken({ ...response, scope: 'channels:read,emoji:read' }, 'https://slack.com/api/oauth.v2.user.access').scope).toBe('channels:read emoji:read');
});
it('does not accept a Slack error envelope or a missing token', () => {
  expect(() => readOAuthToken({ ok: false, access_token: 'fixture', token_type: 'user' }, 'https://slack.com/api/oauth.v2.user.access')).toThrow('invalid');
  expect(() => readOAuthToken({ token_type: 'Bearer' }, 'https://example.com/token')).toThrow('invalid');
});
