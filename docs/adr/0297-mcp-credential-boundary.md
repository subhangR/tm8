# MCP credentials reuse the sealed space credential store

MCP credentials use provider `mcp` in `space_credentials`, bound by metadata to one connector. This provider is server-only. AES-GCM uses the existing node key and space/credential/provider authenticated binding. A parallel secret table would duplicate rotation, credential entities, sharing, revocation and the human-only write boundary.

New MCP credentials are private. Owners can explicitly share through existing credential sharing operations. Connector visibility confers no account permission. Runtime selection requires an explicit credential id, never a default account. Deletion/revocation leaves the connector definition intact; the next readiness or proxy read refuses the missing credential.

The proxy binds the live session, launching identity, space, connector and explicit credential. Its authorization port must consult durable live state each time. Vendor tokens remain server-side, including refresh tokens. Refresh is serialized per connection and writes compare-and-swap against ciphertext nonce; revoke or rotation wins. Definitions, manifests and subprocess arguments must contain only connector/account references. Legacy raw MCP configuration is refused.

HTTP uses pinned DNS, bounded responses, a timeout, no redirects, and HTTPS. An administrator-approved private-network definition may use HTTP or private addresses; client request input cannot grant that exception. OAuth uses discovery, exact issuer verification, S256 PKCE, expiring one-use state tied to the human identity, resource binding, and server-side exchange. Resource metadata discovers the issuer; public-client dynamic registration is used when no preregistered client id is supplied and the issuer advertises support.

Stdio execution requires explicit administrative code trust. Local subprocesses necessarily see any injected credential; remote credentials must not be injected into model subprocesses. Codex chat remains unsupported until a real adapter exists.

Protocol reference: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization

Revocation commits locally first: subsequent proxy calls fail even if the provider is unavailable. If discovery advertised a same-issuer revocation endpoint, tm8 then attempts to revoke refresh and access tokens server-side. Providers without revocation support (or a failed provider request) require account-side cleanup; the UI revoked flag describes tm8 access, not a provider guarantee. Tool audit stores session/server/credential references, method and started/succeeded/failed outcomes only, never tool arguments or results.
