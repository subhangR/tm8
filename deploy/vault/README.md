# Secure Vault: deploy, verify and roll back

Open this runbook before deploying a tm8 build that contains the Secure Vault
(task `01a1fa87`), before rolling one back, and before anyone turns the vault on.
The isolated browser worker has its own runbook: [fill-worker/README.md](fill-worker/README.md).

**The vault ships OFF.** No real secret may enter it until the independent security
review and the penetration test (brief MSG 15) have both passed and an operator has
recorded that. Nothing in this directory provisions a server, a KMS key, a bucket, a
retention policy or a payment processor, and none of it installs or enables itself.

## 1. What a flag-off deploy changes

| Part | With `TM8_VAULT_MODE` unset or `off` |
| --- | --- |
| Server relay `/v2/vault/*` | Present. After authentication every call answers `503`, code `upstream_unavailable`, reason `vault_disabled`. Unauthenticated calls get the usual `401` first. No broker is contacted and no other vault knob is read. |
| Capture page `/vault/capture/*` | `404` for everyone, never the SPA. |
| Settings → Secure vault (UI) | Says “The vault is switched off.” It calls only the same-origin relay and sends no bearer. |
| Broker and fill worker | Not running. Nothing starts them. |
| Chat paste guard | Its own knob, `TM8_VAULT_PASTE_GUARD`, which this deploy also leaves unset or `off`. Off, the server builds nothing, and every message is stored as sent. Any value but `off` or `on` refuses to boot: the node never listens, and the journal shows `tm8-server failed to start: vault relay: TM8_VAULT_PASTE_GUARD must be off or on`. Turning it on is §5's last subsection. |
| Database | Migrations **450** and **451** apply (below). They write no member data. The one row 450 inserts is the audit chain's genesis head. |

**Migration 450 (`450_vault_store.sql`)** creates:
- schema `vault`. Every table that holds member data has RLS. The two exceptions are:
  - `session_hashes`, which no role but the schema owner can read; it is reached only
    through security-definer functions;
  - `audit_head`, the one global chain-head row, which the broker reads. That is the
    cross-tenant count leak listed in §6.
- three `NOLOGIN` roles: `tm8_vault_owner`, `tm8_vault_broker` and `tm8_vault_audit_writer`;
- membership in the owner and audit-writer roles for the migrating role.

`tm8_app` gets no reach into the schema. The role creation is race-safe, so concurrent applies on one cluster do not collide.

450 reuses a vault role that already exists only if the role has exactly the attributes 450
would have given it: no `LOGIN`, `SUPERUSER`, `BYPASSRLS`, `CREATEDB`, `CREATEROLE`,
`REPLICATION` or `INHERIT`, and membership in no other role. Otherwise 450 fails with
`42501` (`vault: a vault role exists with attributes or memberships 450 does not grant`)
and applies nothing. The reason: the broker works as `tm8_vault_broker`, and row security
does not bind a superuser or `BYPASSRLS` role. Roles that hold a vault role, such as the
migrating role or the broker's login role, are not checked.

**Migration 451 (`451_vault_alert_notifications.sql`)** adds one function,
`internal.vault_notify(...)`, through which the relay files vault alerts in the owner's inbox.

## 2. Deploy (flag off)

The rule in force: this task authorizes code and tests only. A deploy is a production
change, so it needs the owner's agreement for that occasion, and the SERVER cutover
cannot be run from an agent session.

1. On the deploy machine (root `ssh utho`), print the plan:
   `./deploy/utho/deploy.sh prod <sha> --plan`
2. Read the migration delta it prints in full. For the vault it must be exactly:
   - `A db/migrations/450_vault_store.sql`
   - `A db/migrations/451_vault_alert_notifications.sql`
   
   Anything else in the delta belongs to other work on main. Account for it before going on.
3. Confirm the prod environment has no `TM8_VAULT_*` knob, or only `TM8_VAULT_MODE=off` and
   `TM8_VAULT_PASTE_GUARD=off`.
4. Run the deploy without `--plan`. It requires typed confirmation, and it applies the
   migrations under its explicit superuser URL.

## 3. Verify after the deploy

Run these against prod's public origin, replacing `<origin>`. None of them needs a
secret. The relay admits only a member's or an agent's own session, never the node's
loopback owner, so a call without a session gets `401` on any address.

```sh
# The relay is mounted and refuses before any vault decision: 401 without a session.
curl -s -o /dev/null -w '%{http_code}\n' <origin>/v2/vault/status            # expect 401
# The capture page is not served while the vault is off.
curl -s -o /dev/null -w '%{http_code}\n' <origin>/vault/capture/x            # expect 404
curl -s <origin>/vault/capture/x                                             # expect: the vault is off on this node
```

- **Signed in:** open Settings → Secure vault. It says “The vault is switched off.” The
  browser's network panel shows `503` for `/v2/vault/status`.
- **Journal:** the server's boot log does NOT contain `vault relay on`. That line
  appears only when the mode is not off. Nor does it contain `vault paste guard on`, which
  appears only when `TM8_VAULT_PASTE_GUARD=on`.
- **Database:** as the migration owner, check:
  - `select rolname, rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname like 'tm8_vault\_%'` gives three rows, all `f`;
  - `select count(*) from vault.items` gives `0`;
  - `select has_schema_privilege('tm8_app','vault','USAGE')` gives `f`.

## 4. Rollback

**Code.** Redeploy the previous sha with the same script:
`./deploy/utho/deploy.sh prod <previous-sha>`. With the vault off, no vault state is lost.
The previous build simply has no `/v2/vault` relay or capture route.

**Paste guard.** Set `TM8_VAULT_PASTE_GUARD=off`, or remove it, and restart the server.
Text it already redacted stays redacted. The guard never stores what it removed, so no
rollback can bring that text back.

**Schema.** Roll back only if the schema itself must go; the previous build ignores it.
Roll back 451 before 450, as the migration owner, with the vault off. Each down file's
header holds the authoritative commands:

```sh
psql "$OWNER_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/451_vault_alert_notifications.down.sql
psql "$OWNER_URL" -c "delete from public.applied_migrations where filename = '451_vault_alert_notifications.sql'"
psql "$OWNER_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/450_vault_store.down.sql
psql "$OWNER_URL" -c "delete from public.applied_migrations where filename = '450_vault_store.sql'"
```

- **451's down** drops only the function. Inbox rows it already wrote stay until the owner decides otherwise.
- **450's down** drops schema `vault` and everything in it. It also drops each vault role
  that no other database still holds. It touches no graph table and does not alter `tm8_app`.

  Under flag-off the schema is empty. Once the vault is on, this down DESTROYS every vault
  row and the audit chain. Archive the checkpoint sink and the deletion ledger first.

  After any later re-apply, grant `tm8_vault_broker` to the broker's login role again,
  because a dropped role takes its memberships with it.

**Re-deploying later.** If the code is redeployed later, `migrate up` applies 450 and 451 again.
A vault role that survived the down, because another database on the cluster still holds
it, is reused as it is. If its attributes or memberships have changed since, 450 refuses
with `42501` and applies nothing. Restore the role to the attributes listed in §1. Never
loosen the check.

## 5. Turning the vault on: NOT authorized yet

Each step below needs its own explicit owner decision. Production also needs the
recorded review gate. The broker enforces the rules listed here at start, and refuses
with a fixed line naming only the knob: `vault broker: invalid <KNOB>`. It never prints
the value.

### Modes

| Mode | What it allows |
| --- | --- |
| `dev` | Local development only. |
| `pre_review` | Test secrets only. At most `TM8_VAULT_PRE_REVIEW_MAX_ITEMS` live items per member (default 20). Fills and API calls go only to the exact test origins in `TM8_VAULT_PRE_REVIEW_FILL_ORIGINS` and the hosts in `TM8_VAULT_PRE_REVIEW_API_HOSTS`. |
| `production` | Refuses to start unless every condition below holds. |

`production` requires all of the following:
- `TM8_VAULT_REVIEW_GATE=passed`;
- `TM8_VAULT_KMS_KIND=gcp-kms`;
- a checkpoint sink (`TM8_VAULT_AUDIT_SINK`, `file` or `gcs`) signed through `TM8_VAULT_GCP_CHECKPOINT_KEY_VERSION`;
- no local KEK file and no local checkpoint key;
- an mTLS listener;
- a dedicated database role.

`TM8_VAULT_SPEND` must stay `false`: payments are `disabled_v1`, and the broker refuses `true`.

### Topology A: the only production shape

The broker runs on its own host under its own uid. The relay in the tm8 server reaches
it only over mutual TLS:

| Side | Knobs |
| --- | --- |
| Relay (tm8 server) | `TM8_VAULT_MODE`, `TM8_VAULT_BROKER_URL` (an https origin), `TM8_VAULT_RELAY_TLS_KEY_FILE`, `TM8_VAULT_RELAY_TLS_CERT_FILE`, `TM8_VAULT_RELAY_TLS_CA_FILE`, `TM8_VAULT_RELAY_PRIVATE_KEY_FILE` |
| Broker | `TM8_VAULT_BROKER_MTLS_LISTEN`, `TM8_VAULT_BROKER_TLS_KEY_FILE`, `TM8_VAULT_BROKER_TLS_CERT_FILE`, `TM8_VAULT_BROKER_TLS_CA_FILE`, `TM8_VAULT_RELAY_PUBLIC_KEY_FILE` |

- The relay signs every request with an Ed25519 key (`TM8_VAULT_RELAY_PRIVATE_KEY_FILE`).
  The broker holds only the public half (`TM8_VAULT_RELAY_PUBLIC_KEY_FILE`).
- The relay refuses to boot unless its key files are `chmod 600` and owned by the server's user.

**Unix socket (`TM8_VAULT_BROKER_SOCKET`).** The broker always listens on it, in production
too, next to the mTLS listener. It refuses to start unless the socket's directory is
exactly `0700` and owned by its own uid, and it makes the socket `0600`. So only that
same uid can connect.
- **Default path:** `/run/tm8-vault-broker/broker.sock`. A non-root broker cannot create a
  directory in `/run`, so its unit creates one with `RuntimeDirectory=tm8-vault-broker`
  and `RuntimeDirectoryMode=0700`.
- **Never `/run/tm8-vault`.** The fill worker's `tmpfiles.conf` makes that directory
  group-shared (`2770`), and the broker refuses it.
- **Only `dev` and `pre_review`** may point the relay at the socket. A relay under a
  different uid on the same host has no supported socket path; that is an open review
  item. In production the relay refuses the socket.

### Database

- `TM8_VAULT_DATABASE_URL` names a LOGIN role whose only membership is `tm8_vault_broker`.
- The role is not a superuser and has no `BYPASSRLS`, because either one ignores vault
  RLS. It also has no `CREATEROLE` or `CREATEDB`, and no membership besides
  `tm8_vault_broker`. Production refuses any other role. The other modes start, but log
  `vault_broker_database_role_not_dedicated`.
- The URL carries no password; the password comes from `PGPASSFILE` only.
- Never point the broker at the migration owner or at `tm8_app`.

### Files the operator creates (the broker never provisions them)

- **`TM8_VAULT_DELETION_LEDGER`:** the append-only deletion and revocation ledger. It
  holds one JSON line, fsynced, for each:
  - deleted item;
  - revoked grant;
  - consumed one-use approval.

  Each line is written before the transaction that makes the change commits. At every
  start, the broker replays the whole file before it serves, so a restored database backup
  never revives a deleted item, a revoked grant or a consumed approval.

  Keep the file on different media from the database, and never restore it from the same
  backup: a ledger rolled back with the database undoes its own guarantee. The file is
  0600 and owned by the broker user. The start stops with `vault broker: start failed`,
  before the socket binds, when a line cannot be parsed or names a grant or approval
  under another item. Either one means the file has been damaged.

  When the file cannot be written:
  - deleting an item fails and deletes nothing;
  - a use that needs a one-use approval fails and nothing runs;
  - revoking a grant still revokes it in the database and then reports the error. Until a
    retry succeeds, a restore could bring that grant back.
- **Checkpoint sink:**
  - `file` uses the directory `TM8_VAULT_CHECKPOINT_DIR`;
  - `gcs` uses the bucket `TM8_VAULT_GCS_BUCKET`.

  tm8 writes create-only objects. It never sets, holds or locks a bucket's retention.
  **Do not enable Bucket Lock or any irreversible retention** until the owner decides so
  explicitly.
- **Keys and the canary file:** mode `0600`, owned by the service user.
  - `TM8_VAULT_CANARY_FILE` holds operator decoy values, one per line, 12+ characters each.
  - The planting of canaries in production is still open.

### Process hardening (broker unit)

- Run under a dedicated non-login uid. Share the `tm8-vault` group only with the fill
  worker; agents and the tm8 server uid must not join it.
- Set:
  - `LimitCORE=0` and `MemorySwapMax=0`, so a crash or swap cannot carry plaintext to disk;
  - `UMask=0077` (the broker also sets umask 077 itself);
  - `NoNewPrivileges=yes`;
  - `ProtectSystem=strict`, with `ReadWritePaths` limited to the socket directory, the
    ledger and the checkpoint directory.

  The fill worker's unit is a working model.
- **`TM8_VAULT_FILL_SOCKET`:** the broker's default is the shipped worker unit's own path,
  `/run/tm8-vault/fill.sock`, and `test/broker/deploy-defaults.test.ts` keeps the two
  equal. If you move it, set the knob on both units.
- **Start command:** `node packages/vault/dist/broker/main.js`, with no argument. Any
  argument other than `enroll`, including `serve`, stops it with
  `vault broker: invalid arguments`. Mode `off` exits 0 before it opens a database, a KMS,
  a file or a socket.

### Owner enrollment

`node packages/vault/dist/broker/main.js enroll <memberId> <spaceId> <ttlSeconds>` prints
a one-time enrollment code on stdout. That code is the root of trust for the owner's
first passkey (an open review item), so:
- hand it over out of band;
- keep the TTL short;
- never paste it into a chat, a task or a log.

### Chat paste guard (`TM8_VAULT_PASTE_GUARD=on`)

Turning it on is a separate owner decision, not part of a flag-off deploy. It is the one
part of this build that works with the vault off: it puts nothing in the vault and holds no
secret. It does change what tm8 stores for every message a person sends, and its limits are
on the review list in §6. Whether to wait for the review is part of that decision.

With the guard on, the server replaces secret-shaped text that a person sends with
`[redacted:<kind>]` before it stores anything:
- `messages.post` and `chat.start`. The sender gets a `vault_paste_redacted` warning that
  names kinds of secret, never values. A post or start that no longer fits once marked is
  refused. When a start's opening message loses a secret, the title sent is dropped and the
  chat takes its default title from the redacted message: a title cut from the message can
  keep a piece of the secret too short to detect.
- `messages.edit`. An edit whose new text holds secret-shaped text is refused
  (`invalid_input`, reason `vault_paste_redacted`), and the message keeps its earlier text.
- A bridged person's message, and their edit at the provider: body, slash-command text and
  media captions. The chat gets one notice per message and one per edit, threaded on the
  stored copy.

It does not read agents' posts, bots, attachments or file names. With `TM8_VAULT_MODE=off`
the warning leaves out the capture-link advice. Detection is best-effort. Plan `01a1fab7` §10
lists what it does not catch, including the legacy WhatsApp bridge's own store.

To verify after the restart, check the boot log for `[tm8] vault paste guard on (vault off)`
(or `(vault on)`). Never post a real secret to test it.

## 6. Open before real secrets (gate items)

The independent review must close these or accept them in writing. The task's review list
on `01a1fa87` holds the full set with severities. The headline items:

**Database and keys**
- A trust-auth or superuser database login bypasses RLS. Production refuses it, but the
  other modes only log it.
- Agent sessions run under the tm8 server's uid, so `chmod 600` does not keep the relay's
  signing key or TLS key from them.
- The KMS REST path leaves the unwrapped DEK un-zeroed.

**Browser surface**
- The capture page shares the SPA's origin.
- The SPA has no CSP.
- The SPA still keeps a bearer in `localStorage`, though the vault transport never sends it.

**Owner enrollment and passkeys**
- The enrollment code is the root of trust.
- Attestation is format `none` only.
- The Argon2 cost cap.
- Revoking the last passkey.

**Grants and connectors**
- GraphQL bodies bypass the connector path deny-list.
- `startUrl` restriction.
- `devMode` must come from broker config.
- An origin change should require step-up.
- Paste detection, including the chat paste guard's limits (plan `01a1fab7` §10).

**Durability and alerts**
- The ledger needs separate media.
- Relay alerts queued in the broker are lost on a broker restart.
- Canaries have no production planting.
- Re-granting the broker role after a 450 rollback.
- `grant.dropped_on_leave` has no trigger.
- Recovery codes have no lifetime.

**Platform**
- RLS does not separate a human from an agent caller.
- Topology B (relay and broker under different uids on one host) is unsupported by the socket directory.
- 450 and 451 are not yet proven on PostgreSQL 17 locally; CI's server jobs run 17.
- The vault UI on a phone is untested.
- The named-server proxy has no vault.
