# Adding a second person to a tm8 node

A second person needs two things, or they sign in and see nothing: an
**account** on the node, and a **membership** in a space (RLS is real, so a
non-member reads zero rows). Open self-registration does not exist (F1). Every
new account starts from something the operator hands out.

The recommended path is an **invite**: one code creates the account and the
membership, and the newcomer chooses their own password, so you never learn
it. An operator-created account (§4) is the fallback.

## 0. Before you start: can they reach the node?

- **Same machine:** nothing to do.
- **Another machine:** the node must be in `TM8_NODE_MODE=multi` behind a TLS
  proxy, with `TM8_PUBLIC_ORIGIN` set. See
  [`../ops/OPERATOR-GUIDE.md`](../ops/OPERATOR-GUIDE.md). Do **not** hand
  someone an ssh tunnel to a `single`-mode node: a tunnel arrives on loopback
  and is treated as the owner.

**Which node is the CLI talking to?** `tm8` targets `http://127.0.0.1:4610` (the
`dev` slot) unless `TM8_BASE_URL` or `~/.config/tm8/config.json` says otherwise.
For any other node, prefix commands with `TM8_BASE_URL=<its origin>`, e.g.
`TM8_BASE_URL=https://tm8.example.com`. `--server <name>` picks a server that is
registered on the local node, so it is no help on a machine without one.

**tm8-spawned shells are agents, not people.** They carry `TM8_AGENT_TOKEN`,
`TM8_SESSION_ID` and `TM8_TEAM_MEMBER_ID`. To act as yourself from one, strip them:
`env -u TM8_AGENT_TOKEN -u TM8_SESSION_ID -u TM8_TEAM_MEMBER_ID tm8 …`.

## 1. You: sign in, and mint an invite

On a `single` node, on its own machine, you are already the owner over loopback
and can skip the login. On a `multi` node everybody signs in, the owner included:

```sh
tm8 auth login <your-username> --password '<your password>'
tm8 space invite create <space-id> --max-uses 1            # --role admin for a co-admin
```

The response holds a one-time code, `inv_…`. It is a credential, so send it to the
person privately.

## 2. They: redeem it, creating their account

From their own machine, against the node's public origin:

```sh
TM8_BASE_URL=https://tm8.example.com \
  tm8 auth invite signup --code inv_… --username bob --password '<their password>' --display-name 'Bob Example'
```

The account, the membership and the use of the invite happen in one
transaction. An invite can never create a node admin or an owner. The call
signs them in, and the CLI stores the session per origin.

The CLI is the path that works today. A browser sign-up page that redeems an
invite is being added separately.

## 3. They: sign in from a browser

Open the node's URL and sign in on the sign-in card with the same username and
password. From then on, tasks they create carry their `created_by`, name and
initials. (Every profile starts without an avatar; initials are the normal look.)

## 4. Fallback: you create the account

A node admin can create the account and then invite it:

```sh
tm8 auth signup bob --password 'a-real-password-8+' --display-name 'Bob Example'
tm8 space invite create <space-id> --max-uses 1
```

Bob then signs in and redeems the invite **as Bob**, because redemption binds
the membership to the caller:

```sh
TM8_BASE_URL=https://tm8.example.com tm8 auth login bob --password 'a-real-password-8+'
TM8_BASE_URL=https://tm8.example.com tm8 space invite redeem inv_…
```

Refusals mean the gate is working: `28000` means you are not authenticated;
`42501` means you are authenticated but not a node admin.

## Behind a proxy

A reverse proxy connects to tm8 on loopback, but that does **not** make the
remote browser local. A request carrying `Forwarded`, `X-Forwarded-For`,
`X-Forwarded-Host` or `X-Real-IP` is never the auto-owner. In `multi` mode
nothing is, so the operator signs in like everyone else.

**TLS is mandatory off localhost** (review finding F8): sign-in, claim and
invite sign-up all send the password in the request body.

## The acceptance check

`scripts/two-users-acceptance.mjs` (repo root, `TM8_BASE_URL=… node …`) drives
two accounts, invites, two tasks and two distinct `created_by` values over the
API. The browser half has a login-only mode for proxied deployments:

```sh
E2E_LOGIN_ONLY=1 \
E2E_SPACE_ID='<shared-space-id>' \
E2E_AMBER_USER='amber' E2E_AMBER_PASS='<password>' \
E2E_BOBBY_USER='bobby' E2E_BOBBY_PASS='<password>' \
UI_URL='https://tm8.example.com' API_URL='https://tm8.example.com' \
node packages/tm8-ui/e2e/two-accounts-browser.mjs
```
