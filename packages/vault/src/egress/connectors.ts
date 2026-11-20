import type { HttpMethod, KeyInjection } from '../types.js';

export interface ConnectorDenyEntry {
  methods: readonly HttpMethod[];
  pathPattern: RegExp;
}

export interface ConnectorTemplate {
  id: string;
  hosts: readonly string[];
  injection: KeyInjection;
  defaultPathPrefixes: readonly string[];
  deny: readonly ConnectorDenyEntry[];
}

export type ConnectorRegistry = Readonly<Record<string, ConnectorTemplate>>;
const ALL: readonly HttpMethod[] = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Fixed list from the vault brief; case-insensitive after URL normalization. */
export const GENERIC_DENY_SEGMENTS: ReadonlySet<string> = new Set([
  'token', 'tokens', 'api_keys', 'api-keys', 'apikeys', 'keys', 'credentials', 'secrets',
  'authorizations', 'oauth', 'webhooks', 'hooks', 'ssh_keys', 'gpg_keys', 'deploy_keys', 'sessions', 'invitations',
]);

export const CONNECTORS: ConnectorRegistry = Object.freeze({
  github: {
    id: 'github', hosts: ['api.github.com'], injection: { kind: 'bearer' }, defaultPathPrefixes: ['/repos', '/user', '/orgs', '/search'],
    deny: [
      // https://docs.github.com/en/rest/apps/oauth-applications — token checks, resets and grants.
      { methods: ALL, pathPattern: /(?:^|\/)(?:tokens?|access_tokens|authorizations|credentials|applications)(?:\/|$)/i },
      // https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
      { methods: ALL, pathPattern: /^\/app\/installations\/[^/]+\/access_tokens(?:\/|$)/i },
      // https://docs.github.com/en/rest/users/keys and https://docs.github.com/en/rest/deploy-keys/deploy-keys
      { methods: ALL, pathPattern: /(?:^|\/)(?:keys|ssh_keys|ssh_signing_keys|gpg_keys|deploy_keys)(?:\/|$)/i },
      // https://docs.github.com/en/rest/repos/webhooks and https://docs.github.com/en/rest/orgs/webhooks
      { methods: ALL, pathPattern: /(?:^|\/)(?:hooks|webhooks)(?:\/|$)/i },
      // https://docs.github.com/en/rest/actions/secrets — includes org, repo and environment secrets.
      { methods: ALL, pathPattern: /(?:^|\/)secrets(?:\/|$)/i },
      // https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
      { methods: ALL, pathPattern: /(?:^|\/)oauth(?:\/|$)/i },
      // https://docs.github.com/en/rest/orgs/members#create-an-organization-invitation
      { methods: ALL, pathPattern: /(?:^|\/)(?:invitations|invitations?)(?:\/|$)/i },
    ],
  },
  openai: {
    id: 'openai', hosts: ['api.openai.com'], injection: { kind: 'bearer' },
    defaultPathPrefixes: ['/v1/responses', '/v1/chat/completions', '/v1/embeddings', '/v1/models'],
    deny: [
      // https://platform.openai.com/docs/api-reference/admin-api-keys — deny the entire administration surface.
      { methods: ALL, pathPattern: /^\/v1\/(?:organization|organizations|admin)(?:\/|$)/i },
      // https://platform.openai.com/docs/api-reference/realtime-sessions — ephemeral credentials/client secrets.
      { methods: ALL, pathPattern: /(?:^|\/)(?:api_keys|admin_api_keys|service_accounts|client_secrets|sessions|tokens?|keys|credentials)(?:\/|$)/i },
      // https://platform.openai.com/docs/guides/webhooks — registration can create an exfiltration channel.
      { methods: ALL, pathPattern: /(?:^|\/)(?:webhooks|hooks|oauth|authorizations|secrets|invitations)(?:\/|$)/i },
    ],
  },
  anthropic: {
    id: 'anthropic', hosts: ['api.anthropic.com'], injection: { kind: 'header', name: 'x-api-key' },
    defaultPathPrefixes: ['/v1/messages', '/v1/models'],
    deny: [
      // https://platform.claude.com/docs/en/manage-claude/admin-api — API keys, invites, members and service accounts.
      { methods: ALL, pathPattern: /^\/v1\/(?:organizations?|admin)(?:\/|$)/i },
      // https://platform.claude.com/docs/en/manage-claude/admin-api — credential/admin aliases fail closed too.
      { methods: ALL, pathPattern: /(?:^|\/)(?:api_keys|api-keys|apikeys|keys|tokens?|credentials|service_accounts|secrets|oauth|authorizations|invitations|invites|sessions|webhooks|hooks)(?:\/|$)/i },
    ],
  },
  stripe: {
    id: 'stripe', hosts: ['api.stripe.com'], injection: { kind: 'basic', username: '' },
    defaultPathPrefixes: ['/v1/customers', '/v1/products', '/v1/prices', '/v1/payment_intents'],
    deny: [
      // https://docs.stripe.com/api/tokens and https://docs.stripe.com/api/ephemeral_keys
      { methods: ALL, pathPattern: /(?:^|\/)(?:tokens?|ephemeral_keys|api_keys|keys|credentials)(?:\/|$)/i },
      // https://docs.stripe.com/api/webhook_endpoints
      { methods: ALL, pathPattern: /(?:^|\/)(?:webhook_endpoints|webhooks|hooks)(?:\/|$)/i },
      // https://docs.stripe.com/stripe-apps/store-secrets
      { methods: ALL, pathPattern: /^\/v1\/apps\/secrets(?:\/|$)/i },
      // https://docs.stripe.com/connect/oauth-reference — OAuth exchange/revocation and client-secret sessions.
      { methods: ALL, pathPattern: /(?:^|\/)(?:oauth|secrets|sessions|authorizations|invitations)(?:\/|$)/i },
    ],
  },
  slack: {
    id: 'slack', hosts: ['slack.com'], injection: { kind: 'bearer' },
    defaultPathPrefixes: ['/api/chat.postMessage', '/api/conversations.info', '/api/conversations.history', '/api/users.info'],
    deny: [
      // https://docs.slack.dev/reference/methods/oauth.v2.access/ — also covers exchange and token rotation.
      { methods: ALL, pathPattern: /^\/api\/(?:oauth|openid|auth)(?:[./]|$)/i },
      // https://docs.slack.dev/reference/methods/apps.connections.open/ — socket, manifest and permission channels.
      { methods: ALL, pathPattern: /^\/api\/apps\.(?:connections|permissions|manifest|uninstall)(?:[./]|$)/i },
      // https://docs.slack.dev/reference/methods/admin.users.invite/ — deny admin persistence/credential operations.
      { methods: ALL, pathPattern: /^\/api\/admin\.(?:users|invites|apps|teams|auth|barriers)(?:[./]|$)/i },
      // https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/
      { methods: ALL, pathPattern: /(?:^|[/.])(?:tokens?|api_keys|keys|credentials|secrets|authorizations|webhooks|hooks|ssh_keys|gpg_keys|deploy_keys|sessions|invitations)(?:[/.]|$)/i },
      // https://docs.slack.dev/reference/methods/users.admin.invite/ — legacy invitation endpoint.
      { methods: ALL, pathPattern: /^\/api\/users\.admin\.(?:invite|setAdmin|setOwner)(?:[./]|$)/i },
    ],
  },
});
