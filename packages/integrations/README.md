# Integrations runtime

A Node.js library for direct provider MCP connections, with no dependency on tm8's database, UI, contract, or a hosted integration broker. tm8 uses this package in its live OAuth, credential encryption, outbound transport, and proxy response paths.

## Surfaces

- `@tm8/integrations/providers`: browser-safe reviewed provider catalog, provider schemas, extensible `ProviderCatalog`.
- `@tm8/integrations`: OAuth discovery, PKCE authorization, encrypted one-time pending state, code exchange, refresh/revoke, guarded HTTP, JSON/SSE response parsing.
- `@tm8/integrations/crypto`: AES-256-GCM sealing with account/tenant/resource binding and key identifiers. Existing ciphertext encodings are preserved.

`McpOAuth<Claims>` accepts a callback URL, an implementation of `McpOAuthPendingStore<Claims>`, and an `IntegrationKeyProvider`. Claims need an authenticated `identityId`; hosts can carry additional immutable claims. The historical `spaceId` and `serverId` names represent opaque tenant and integration identifiers. The core does not interpret or authorize them.

```ts
import { McpOAuth, refreshOAuth, revokeOAuth } from '@tm8/integrations';

const oauth = new McpOAuth(callbackUrl, pendingStore, keyProvider);
const redirect = await oauth.begin(claims, {
  spaceId: tenantId, serverId: integrationId, resource: provider.endpoint,
  label: 'Work', allowPrivateNetwork: false,
});
// Redirect the account holder to redirect.authorizationUrl.
const connected = await oauth.callback(claims, { state, code, issuer }, async target => {
  // Re-read ownership, access and the approved definition revision here.
  await authorizeCurrentTarget(claims, target);
});
// Persist connected.secret encrypted under this account's ownership binding.
// Tokens stay server-side; expose only non-secret account metadata to clients.
```

The pending store must persist across restarts, isolate identities, enforce expiry, and consume a row atomically exactly once. Its rows contain encrypted state; neither a browser nor an untrusted client may submit the store's row contents. Key providers choose keys by ID and must refuse unknown IDs. Hosts must authorize before beginning OAuth, again at callback, and before every tool call. Credential storage, refresh locking, audit persistence, account grants and session provenance belong to the host adapter.

The tm8 adapter lives in `packages/server/src/mcp`: `oauth.ts` supplies PostgreSQL pending state and wire error translation; `provider-config.ts` supplies deployment-owned client identity only for exact reviewed catalog endpoints; the credential store and proxy retain tm8's ownership, grant, revision, refresh locking, audit and session checks. This extraction does not change existing encrypted rows or their associated data.

## Provider configuration

End users choose branded apps and sign in. The operator registers the product's own OAuth application where required and supplies `TM8_MCP_CLIENT_ID_GITHUB` / `TM8_MCP_CLIENT_SECRET_GITHUB`, similarly `SLACK` and optionally `FIGMA`. These values are not user-facing custom-server settings and are never copied from another client. Google keeps tm8's existing first-party configuration.

`ProviderCatalog([...PROVIDERS, reviewedProvider])` adds adapters without a provider enum. In tm8, additions also need an endpoint-identity migration for `internal.mcp_catalog`; the database deliberately refuses arbitrary provider impersonation.

Run `node packages/integrations/dist/probe.js` after building to check public OAuth metadata. The probe never registers clients, consents accounts or calls private tools. A successful probe does not prove provider admission, account consent or tool execution. Figma can advertise registration while restricting actual clients.

## Verification

`bun run --cwd packages/integrations test` exercises real HTTP framing and provider catalog extension. tm8's server tests exercise the same extracted code through real OAuth fixtures and PostgreSQL account isolation. The verified release scope and remaining provider limits are recorded in `docs/verification/connect-apps-release.md`; public metadata probes alone are not account acceptance.
