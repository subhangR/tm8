# MCP connector definitions

Open this document when registering, importing, attaching, or launching an MCP connector. It describes definition metadata, the authorization boundary, and CLI selection behavior. Remote credentials and OAuth implementation are described in [the credential boundary ADR](adr/0297-mcp-credential-boundary.md).

In the native UI, open the MCP catalog to register or import definitions, or choose **Browse directory** to prefill an official remote server (Notion, Slack, Figma) and add it like any other definition. Open a connector to approve it, connect an account by API key or OAuth, run a connection test, and inspect its tools. The account picker distinguishes accounts you can use from accounts you can manage. Task and teammate connector editors manage defaults; the launch picker explicitly chooses each account for that launch. Disconnect removes the selected account or attachment; revoke prevents future account use.

A space administrator registers a `mcp_server`. Its definition contains a stable name, transport, URL or command/arguments, authentication metadata, and names of secret slots. Literal `env` or `headers` maps are rejected. The name `tm8` is reserved; names are unique within a space ignoring case. Registration, approval, stdio trust, and private-network policy require the same administrator authorization through the MCP facade and generic entity operations.

HTTP definitions use one declared API-key header, OAuth, or no authentication. Stdio definitions use one declared API-key environment variable or no authentication. Executing stdio requires `stdioTrusted: true`: the executable receives its configured credential and must be trusted with it. `allowPrivateNetwork` is an explicit administrator decision, not something inferred from a submitted URL. Keep literal credentials out of URLs, commands, arguments, provenance, and names.

For example, save this nonsecret request as `connector.json`:

```json
{
  "definition": {
    "name": "example",
    "transport": "http",
    "url": "https://example.test/mcp",
    "envKeys": [],
    "headerKeys": ["Authorization"],
    "auth": {"type": "api_key", "headerName": "Authorization", "prefix": "Bearer"},
    "approved": false
  }
}
```

Run `tm8 mcp server create --input @connector.json`. Update the complete definition with `tm8 mcp server update <server-id> --expected-version <version> --input @connector.json`. An import takes `{"definitions": [...]}` through `tm8 mcp server import --input @connectors.json`; the whole batch is transactional. That operation still refuses literal credentials; `tm8 mcp import` is what converts a native config into definitions with named slots.

## Reusing a Claude Code or Codex configuration

`tm8 mcp import --from claude|codex|mcp-json [--path <file>]` reads the MCP servers a member has already configured on their own machine and registers them as connectors. The default sources are `~/.claude.json` (the global `mcpServers` block and every `projects[*].mcpServers` block), a project `.mcp.json`, and `~/.codex/config.toml` (`[mcp_servers.*]`, including `bearer_token_env_var`, `http_headers` and `env_http_headers`). The server never reads these files: the command runs in the member's own process, and the translator (`@tm8/contract`'s `translateMcpConfigText`, shared with the UI's import box) emits metadata only.

`http`/`sse` entries become HTTP definitions at the same URL, `command`/`args` entries become stdio definitions, and a literal header or environment value becomes a declared slot with `api_key` auth — never definition content. A host tm8 knows speaks OAuth (Slack, Notion, Figma, Linear, GitHub, Atlassian, Sentry, Asana, Stripe, Intercom) and that carries no credential of its own becomes an `oauth2` definition to connect in tm8 instead. Everything the translation drops — a second header, an illegal header name, a URL carrying a query string — is reported rather than silently skipped.

`--dry-run` prints the plan and writes nothing; it deduplicates against the space's connectors by URL for HTTP and by argv for stdio. `--trust-stdio` is required before any connector that runs a local command is registered. `--with-credentials` additionally seals each literal token found in the file as the importing member's own private credential through the human-only `mcp.credentials.create`; without it the token stays in the file and is only counted. Imported connectors arrive unapproved, nothing is ever shared with the space, and no token is printed. Launches are unaffected: `--strict-mcp-config` and the stripped Codex home stay exactly as ADR 0297 requires, because a connector reaches an agent only through the tm8 bridge.

A human creates a private account with `tm8 mcp credential create <server-id> --input @credential.json`. The file contains `{"label":"My account","secret":"..."}`. Use a restricted local file or stdin (`--input -`); credential JSON is refused inline to avoid secrets in command arguments. Rotation uses `tm8 mcp credential rotate <credential-id> --input @credential.json` with only `secret`. Sharing and revocation use the explicit credential commands; connector visibility does not grant account use.

Attach an approved connector with the ordinary `equips` edge, directed from the task, teammate, or work session to the connector, with empty properties. Accounts are never attached to tasks. The graph cannot carry credential options on MCP equipment edges. A caller must be a member and must be able to access both endpoints in the same space. Unapproved and disabled connectors cannot be attached.

Worker and chat launch requests accept `mcpSelections: [{"serverId":"...","credentialId":"..."}]`. CLI launches use `--mcp-selections <json-source>`:

- Omitted selections resolve connector attachments on selected tasks, the teammate, and their accessible ancestors (at most 16 parent steps). The nearest attachment wins for a name; distinct definitions with the same name at the same depth are refused.
- `[]` disables all optional connectors.
- A nonempty array completely replaces attachment defaults.
- An authenticated connector always requires an explicit usable credential id. Missing or denied accounts fail readiness; the resolver does not choose another account.

`tm8 mcp resolve --input @selection.json` previews readiness. The request includes `spaceId`, optional `targetIds` and `teamMemberId`, and optional `mcpSelections`. `tm8 mcp server list --target <target-id>` exposes server-derived attachment permissions, including when the catalog is empty. New launches may use the selected teammate as their target before a task exists.

Connection test results are cached per testing member and definition version. Editing a definition invalidates its cached result. Another member does not inherit that account's tool inventory. Tools and cached status describe the last test; runtime authorization must still recheck the live session, selected account, approval, membership, and revocation before each use.

Security-relevant definition changes (URL, transport, authentication mode or metadata, header and environment slots, stdio command or arguments, private-network policy, or trust settings) advance the connector's security revision. Existing private credentials and pending OAuth consent are bound to the revision they authorized and fail closed until the owner reconnects. Display and provenance edits remain usable. Reverting a definition does not revive an invalidated credential. The update and credential-creation transactions serialize on the connector, and runtime checks compare the credential revision with the exact definition snapshot used for the request.

Development verification uses a fresh scratch database: `TM8_W1_ADMIN_DATABASE_URL=<scratch-postgres-url> node packages/server/node_modules/vitest/vitest.mjs run packages/server/test/db/mcp-foundation.pg.test.ts`. The suite exercises the full migration chain and generic entity round-trips. CLI checks are `bun run --cwd packages/cli test test/mcp.test.ts test/mcp-import.test.ts test/discovery-operations.test.ts`; the translator's own fixtures are `bun run --cwd packages/contract test test/mcp-import.test.ts`, and `packages/execution/test/mcp-import-toml.test.ts` cross-checks its Codex TOML reader against `@iarna/toml`.

OAuth requires an authorization server that supports PKCE S256 and suitable resource metadata. Discovery and dynamic client registration are attempted where supported; providers that require pre-registration need their own client id and approved redirect URI. A preregistered client may also be confidential: `auth.clientSecretEnv` names a server environment variable holding its secret, never the secret itself, and must match `TM8_MCP_CLIENT_SECRET_[A-Z0-9_]+` so that a definition cannot direct a token request at any other server variable. The token request authenticates with `client_secret_basic`, or with `client_secret_post` when that is all the issuer advertises. Starting authorization fails before the consent screen if the variable is unset. No provider account is bundled. The browser redirect is the public TM8 origin plus `/mcp/oauth/callback`: set `TM8_PUBLIC_ORIGIN` to the origin members open tm8 at, because without it the redirect is the loopback bind address, which a remote browser cannot reach. Only fixture protocol behavior is claimed here; live vendor compatibility requires provider-specific verification.

## Directory providers

Each member connects their own account; the directory only fills in the definition. Requirements come from each provider's official MCP documentation (checked 2026-10-19):

- **Notion** (`https://mcp.notion.com/mcp`, [docs](https://developers.notion.com/guides/mcp/get-started-with-mcp)): OAuth with dynamic client registration; no setup beyond approving the connector. Only workspace members can connect, not guests.
- **Slack** (`https://mcp.slack.com/mcp`, [docs](https://docs.slack.dev/ai/mcp-server/)): no dynamic client registration, and only internal or directory-published Slack apps may use MCP. Create a Slack app, enable MCP for it, add `<TM8_PUBLIC_ORIGIN>/mcp/oauth/callback` as a redirect URL and the user scopes, enter its Client ID in the connector, set `TM8_MCP_CLIENT_SECRET_SLACK` to its Client Secret in the server environment and restart. The issuer is pinned to `https://mcp.slack.com` because Slack's resource metadata names that origin rather than the `/mcp` URL. Slack's token endpoint labels the user token `token_type: "user"`; tm8 presents it as a bearer token, as Slack's MCP server's `WWW-Authenticate: Bearer` challenge asks.
- **Figma** (`https://mcp.figma.com/mcp`, [docs](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)): only clients on Figma's MCP catalog allowlist can connect. Its registration endpoint refuses a client named `tm8` with 403, which Connect reports as "OAuth client registration rejected by provider". It works once the deployment is approved through Figma's MCP client waitlist.

Worker connectors support Claude Code and Codex bridge configuration. Chat retains the repository's existing Claude Code runtime; Codex chat is not supported by the baseline. Connector removal, account revocation, and account unsharing are separate actions. Revocation ends future account use; it does not delete the provider account itself.
