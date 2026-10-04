# MCP connector definitions

Open this document when registering, importing, attaching, or launching an MCP connector. It describes definition metadata, the authorization boundary, and CLI selection behavior. Remote credentials and OAuth implementation are described in [the credential boundary ADR](adr/0297-mcp-credential-boundary.md).

In the native UI, open the MCP catalog to register or import definitions. Open a connector to approve it, connect an account by API key or OAuth, run a connection test, and inspect its tools. The account picker distinguishes accounts you can use from accounts you can manage. Task and teammate connector editors manage defaults; the launch picker explicitly chooses each account for that launch. Disconnect removes the selected account or attachment; revoke prevents future account use.

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

Run `tm8 mcp server create --input @connector.json`. Update the complete definition with `tm8 mcp server update <server-id> --expected-version <version> --input @connector.json`. An import takes `{"definitions": [...]}` through `tm8 mcp server import --input @connectors.json`; the whole batch is transactional. Import does not ingest upstream configs containing literal credentials: convert these to definitions with named slots and create credentials separately.

A human creates a private account with `tm8 mcp credential create <server-id> --input @credential.json`. The file contains `{"label":"My account","secret":"..."}`. Use a restricted local file or stdin (`--input -`); credential JSON is refused inline to avoid secrets in command arguments. Rotation uses `tm8 mcp credential rotate <credential-id> --input @credential.json` with only `secret`. Sharing and revocation use the explicit credential commands; connector visibility does not grant account use.

Attach an approved connector with the ordinary `equips` edge, directed from the task, teammate, or work session to the connector, with empty properties. Accounts are never attached to tasks. The graph cannot carry credential options on MCP equipment edges. A caller must be a member and must be able to access both endpoints in the same space. Unapproved and disabled connectors cannot be attached.

Worker and chat launch requests accept `mcpSelections: [{"serverId":"...","credentialId":"..."}]`. CLI launches use `--mcp-selections <json-source>`:

- Omitted selections resolve connector attachments on selected tasks, the teammate, and their accessible ancestors (at most 16 parent steps). The nearest attachment wins for a name; distinct definitions with the same name at the same depth are refused.
- `[]` disables all optional connectors.
- A nonempty array completely replaces attachment defaults.
- An authenticated connector always requires an explicit usable credential id. Missing or denied accounts fail readiness; the resolver does not choose another account.

`tm8 mcp resolve --input @selection.json` previews readiness. The request includes `spaceId`, optional `targetIds` and `teamMemberId`, and optional `mcpSelections`. `tm8 mcp server list --target <target-id>` exposes server-derived attachment permissions, including when the catalog is empty. New launches may use the selected teammate as their target before a task exists.

Connection test results are cached per testing member and definition version. Editing a definition invalidates its cached result. Another member does not inherit that account's tool inventory. Tools and cached status describe the last test; runtime authorization must still recheck the live session, selected account, approval, membership, and revocation before each use.

Development verification uses a fresh scratch database: `TM8_W1_ADMIN_DATABASE_URL=<scratch-postgres-url> node packages/server/node_modules/vitest/vitest.mjs run packages/server/test/db/mcp-foundation.pg.test.ts`. The suite exercises the full migration chain and generic entity round-trips. CLI checks are `bun run --cwd packages/cli test test/mcp.test.ts test/discovery-operations.test.ts`.

OAuth requires an authorization server that supports PKCE S256 and suitable resource metadata. Discovery and dynamic client registration are attempted where supported; providers that require pre-registration need their own client id and approved redirect URI. No provider account is bundled. The browser redirect is the public TM8 origin plus `/mcp/oauth/callback`. Only fixture protocol behavior is claimed here; live vendor compatibility requires provider-specific verification.

Worker connectors support Claude Code and Codex bridge configuration. Chat retains the repository's existing Claude Code runtime; Codex chat is not supported by the baseline. Connector removal, account revocation, and account unsharing are separate actions. Revocation ends future account use; it does not delete the provider account itself.
