# Provisioning the second account — the working, documented path

**Identity v2 Stage 1 · 2026-08-02.** A second human on a tm8 server needs two
things or they log in successfully and see nothing: an **account** (RLS is
real now — a non-member reads zero rows) and a **member row in a space**.
`auth.signup` is node-admin gated **by design** (F1 — never open
self-registration), so provisioning is the operator's act. This is the exact
sequence; every command is real and was run against a live server.

## 0. Where to run this

On the server's own machine (or any shell whose requests reach it over
loopback), a credential-free CLI call is the **auto-owner** — a node admin —
so no login is needed for the admin half. Two traps:

- **tm8-spawned shells are agents, not humans.** They carry
  `TM8_AGENT_TOKEN` / `TM8_SESSION_ID` / `TM8_TEAM_MEMBER_ID`, which the CLI's
  credential store refuses (doc 13 §4.3). Acting as a human from one requires
  `env -u TM8_AGENT_TOKEN -u TM8_SESSION_ID -u TM8_TEAM_MEMBER_ID tm8 …`.
- **The CLI defaults to prod.** Add `--server staging` (or the right named
  server) to every command when the target is not the default node.

## 1. The operator creates the account (node admin)

```sh
tm8 auth signup bob --password 'a-real-password-8+' --display-name 'Bob Example'
```

Refusals mean the gate is working: `28000` = you are not authenticated at all;
`42501` = authenticated but not a node admin.

## 2. The operator invites them into a space (space admin)

```sh
tm8 space invite create <space-id> --max-uses 1
```

The response contains the one-time **code** — hand it to Bob out of band. The
code is a credential; the CLI notes the disclosure in its journal.

## 3. Bob logs in and redeems — as Bob, not as the owner

```sh
tm8 auth login bob --password 'a-real-password-8+'   # stores Bob's credential (origin-keyed store)
tm8 space invite redeem <code>                        # creates Bob's HUMAN membership
```

The redeem must run under **Bob's** credential — redemption binds membership
to the caller. On a machine where the CLI store is unavailable, `auth login`
prints the `tm8s_…` token once; export it as `TM8_AGENT_TOKEN` for the redeem.

## 4. Bob signs in from a browser

Open the UI, and on the sign-in card enter `bob` + password. The gate performs
`auth.login`, stores the pass per server (origin-keyed, mirroring the CLI
ruling), and every request from the app now acts as Bob — tasks he creates
carry his `created_by`, his name, and his icon (initials until he sets an
avatar in Settings; every profile row ships NULL, and initials are the normal
rendering, not an error).

**TLS is mandatory off localhost** (review finding F8): `auth.login` carries
the password in the request body. Utho staging has a real certificate
(`tm8-server.tail28ac62.ts.net:8888`).

### The browser-only variant, on a loopback/tailnet-forwarded server

The gate's **"create another account"** path (sign-in card → create) performs
`auth.signup` unauthenticated. On a server whose requests arrive via loopback
(a single machine, or Utho staging behind `tailscale serve`), that request
resolves to the auto-owner and **succeeds** — so account two can be created
entirely in the browser there. The space invite (steps 2–3) is still CLI:
the gate deliberately ships no invite UI (a documented CLI step was ruled
acceptable; a half-built invite surface was not).

## 5. The acceptance check

`scripts/two-users-acceptance.mjs` (repo root, `TM8_BASE_URL=… node …`)
drives the whole sequence — two signups, two logins, invites, two tasks, two
distinct `created_by` — over the API. The browser half is the gate itself:
create/sign in as each account, make a task as each, and the two tasks show
two different names and icons.
