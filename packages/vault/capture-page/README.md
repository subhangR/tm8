# Standalone vault capture and import page

Open this file when integrating the standalone page with the server relay or
changing its browser contracts. The page has no runtime dependencies or bundler.

```sh
cd packages/vault/capture-page
npx tsc -p .
npx vitest run
```

TypeScript emits `dist/capture.js` and its neighboring ES modules. Build output
is ignored by git. The nested package.json makes `npx` run from this directory
instead of changing to the parent vault package. jsdom is a pinned, test-only
dependency in `packages/vault/package.json`.

## Serving (WS-A)

- `/vault/capture/assets/capture.css` serves `capture.css`.
- `/vault/capture/assets/<module>.js` serves the corresponding file from `dist`.
  Serve only known module basenames; missing assets return 404.
- All other `/vault/capture/*` paths serve `index.html`. A capture UUID or the
  exact `/vault/capture/import` path chooses the mode; other paths render a
  fixed invalid-link state.

Use `text/html`, `text/css`, and `text/javascript` MIME types as appropriate.
Serve the document and assets over the same HTTPS origin as the relay. Apply
`CAPTURE_RESPONSE_HEADERS` from `src/headers.ts` to the document, assets and
errors:

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Referrer-Policy: no-referrer
Cache-Control: no-store
X-Content-Type-Options: nosniff
Cross-Origin-Opener-Policy: same-origin
```

The capture link token is read from `#t=…`, then history is replaced with the
pathname before auth reads or fetch. Queries and fragments are discarded. Do
not move the token into a query parameter or introduce document analytics.

## Authentication and API wiring (WS-A)

`src/tm8-auth.ts` exports the single `tm8Authorization(): string | null` seam.
It ports only `authTokenFor(LOCAL_SERVER_ID)` from the SPA: read
`tm8ui.auth.passes.v1`, choose `window.location.origin`, validate the token and
account shape, and return its Bearer header. There is no storage write and no
fallback to another SPA server connection. This is implemented, not a stub.
Keep the page on the SPA/relay origin so this existing human pass is available.

`vault.status` checks for a vault session. If missing, a user clicks the passkey
sign-in button; the page calls challenge, `navigator.credentials.get`, then
session.begin. Vault session and refresh cookies remain HttpOnly. Every fetch
uses `credentials: 'same-origin'`, no-store, no-referrer policy, and refuses
redirects. GET status has no body because browsers reject GET bodies; every
command has a JSON body and clientMutationId.

`src/contract.ts` is a browser-only snapshot of the used contract rows and
types. Runtime imports of the shared validators would bring in zod. Tests
compare all routes, formats, item types and size limits with the real contract,
validate outgoing inputs with its schemas, and compare challenge and submit
bindings using `vaultStepUpBoundParams`.

The page expects the existing `{data}` / `{error}` envelope, reads only typed
error reasons, and shows fixed copy. Reserved operations returning 501 show an
unavailable state. WS-A must provide the broker/relay operations; this lane
implements no server routes. `secret_in_metadata` fixed copy is included for
the broker addition after this lane's base commit.

## Capture, import and hygiene

The browser sealer interoperates with `CaptureKeyPair`: P-256 ECDH,
HKDF-SHA256 with salt SHA-256(kid) and info `tm8-vault-capture-v1|bindingId`,
then AES-256-GCM with AAD `tm8-vault-capture-v1|bindingId|kid`. It verifies the
recipient's point against kid, including consistency when both JWK and raw
encodings are supplied. Imports use importId as bindingId. The 16-byte GCM tag
counts toward maxCiphertextBytes; the page also enforces the 8 MiB import cap.
Base64url and envelope metadata make the JSON request larger than the binary
ciphertext cap; the relay body limit must account for that expansion.

All capture values, including names and identity field names, are sealed.
Import files are sealed locally. Import preview contains metadata only, with
include, exposure tier, name override and origin override per candidate. Tier
a is blocked until rotation, b schedules rotation, and c is treated as b.
Commit needs a fresh passkey assertion bound to those exact rows.

Name and origin overrides are intentionally plain text metadata controls.
They appear only in the commit rows and their step-up challenge. WS-A confirmed
that the broker rejects secret-shaped metadata with `secret_in_metadata`; the
page does not duplicate the paste detector. Canary coverage applies to every
capture field and all import file contents, with separate checks for the two
metadata controls.

Fields are cleared as soon as submission has been encoded, and on errors,
expiry, cancellation and pagehide. Plaintext byte arrays are zeroed in finally,
including read/seal failures. The page drops its token and session references
on pagehide, aborts work and passkey prompts, and prevents late responses from
reopening cancelled views. Import cancel remains available while busy or
expired. A late begin response is cancelled once its new importId is known.
There is no clipboard access, cookie access, logging, third-party request or
storage write. JavaScript strings and browser-owned File storage cannot be
forcibly zeroed; references are dropped, and no secure-deletion guarantee is
made. The result reminds the person to delete source plaintext exports.

Tests use Node 22 WebCrypto, synthetic runtime-generated canaries and an injected
fake authenticator. They never call a real authenticator or a live vault. The
parent vault suite retains its existing optional tests that are skipped when
their environment is absent; server integration and review remain WS-A's work.
