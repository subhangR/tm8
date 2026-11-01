import { expect, it } from 'vitest';
import { providerClient } from '../../src/mcp/provider-config.js';

it('uses operator client credentials only for the exact reviewed provider endpoint', () => {
  const read = (key: string) => ({ TM8_MCP_CLIENT_ID_SLACK: 'client', TM8_MCP_CLIENT_SECRET_SLACK: 'secret' })[key];
  expect(providerClient('slack', 'https://mcp.slack.com/mcp', read)).toEqual({ clientId: 'client', clientSecret: 'secret' });
  expect(providerClient('slack', 'https://attacker.test/mcp', read)).toBeUndefined();
  expect(providerClient(undefined, 'https://mcp.slack.com/mcp', read)).toBeUndefined();
  expect(() => providerClient('slack', 'https://mcp.slack.com/mcp', () => undefined)).toThrow('awaiting setup');
});
