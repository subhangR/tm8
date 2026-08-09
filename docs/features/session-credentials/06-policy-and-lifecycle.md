# 6 — Policy and lifecycle

> Design document, exported from the tm8 graph at entity `019fdc8d-57fa-7ed9-9b96-4fc00d4515c6` v2.
> The graph entity is the source of truth; this file is the reviewable copy.

# 6 — Policy and lifecycle

*Sub-document of “Design: per-member credential management in sessions”. Basis: `origin/main` @ `7631e08`, 2026-08-07.*

### 3.6 Layer 5 — Policy when a user has no credential

Per-space `credentialPolicy`, recorded in the manifest so every session is self-describing:

| value | behaviour |
|---|---|
| `own` | fail-closed. `execution.spawn` → `invalid_input`, "you have no <provider> credential". |
| `node-fallback` | today's behaviour: the node's shared HOME/env. **Default**, so nothing breaks on day one. |
| `space-shared` | a space-owned credential set, admin-managed. |

Show the resolved policy in the session header. A user who does not know whose key they are
spending will assume it is theirs.

### 3.7 Layer 6 — Lifecycle

- **Rotation** — replacing a file affects the next spawn only. Running sessions already hold
  plaintext in their process env; that is unavoidable and must be documented, not papered over.
- **Revocation** — deleting a `credential_refs` row + wiping the directory. Terminating running
  sessions is a separate, explicit product decision.
- **OAuth refresh** — works by construction under B, since the CLI owns a writable directory.
  Under A it does not work at all. This alone decides A vs B.
- **Backup** — `<dataDir>/credentials/` must be **excluded** from S18's backup pairing, or the
  secret-free-backup property is lost by a different door than the one S15 guards.
