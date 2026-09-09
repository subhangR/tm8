# Control app and registered workspace machines

The control app owns Supabase authentication, invitations, opaque central
sessions, machine registration and sticky account assignments. Each machine runs
its own graph PostgreSQL database and tm8 UI/API. A node receives only its own
enrollment credential and short-lived account authorization; it does not receive
the central database password or Supabase backend credentials.

## Start the control app

Create a Supabase project with GitHub OAuth configured and the Email/password
provider disabled. Allow the redirect `https://login.example.com/auth/callback`.
Enable only GitHub. tm8 refuses password signup/login/recovery and access-token
exchange endpoints. Existing password accounts need an explicit GitHub link from
an existing session or an operator mapping, including when Supabase automatically
combines identities with the same email.

```bash
cp deploy/docker/control.env.example deploy/docker/control.env
chmod 600 deploy/docker/control.env
# Fill the four required settings in this ignored file.
docker compose -f deploy/docker/control.compose.yaml build
docker compose -f deploy/docker/control.compose.yaml run --rm control node apps/control-plane/src/migrate.mjs
docker compose -f deploy/docker/control.compose.yaml run --rm control node apps/control-plane/src/migrate.mjs bootstrap-admin ADMIN_EMAIL
docker compose -f deploy/docker/control.compose.yaml up -d
```

Put an HTTPS reverse proxy in front of loopback port 4620. Use the printed
one-time invitation to enroll the first administrator. No tm8 account can enter
without a valid invitation and verified email. Supabase may create Auth records
through its public signup endpoint; those records alone do not grant tm8 access.
The private `tm8_directory` schema must not be exposed through PostgREST.

## Register a machine

On an AWS, Azure, Utho or local machine with Docker, prepare the repository and
run `node deploy/docker/configure.mjs` to generate its private database settings.
In the control app register its name,
HTTPS origin, provider and capacity (default **10**). Record the returned machine
UUID and one-time enrollment credential in that machine's private `.env`:

```dotenv
TM8_DISTRIBUTED_SYSTEM_FLAG=true
TM8_MACHINE_ID=REGISTERED_UUID
TM8_MACHINE_CREDENTIAL=ENROLLMENT_CREDENTIAL
TM8_CONTROL_ORIGIN=https://login.example.com
TM8_PUBLIC_ORIGIN=https://node.example.com
```

Build dependencies and artifacts without starting a standalone tm8 server (and
without creating a local owner), then start the registered node:

```bash
docker compose -f compose.yaml -f deploy/docker/workspaces.compose.yaml build
docker build -f deploy/docker/runner.Dockerfile -t tm8-workspace:ubuntu24 .
docker compose -f compose.yaml -f deploy/docker/workspaces.compose.yaml run --rm --entrypoint bash tm8 -c 'bun install --frozen-lockfile && bun run build && cd packages/tm8-ui && bun run build'
docker compose -f compose.yaml -f deploy/docker/workspaces.compose.yaml -f deploy/docker/node.compose.yaml -f deploy/docker/production.compose.yaml up -d
```

Terminate HTTPS at the registered node hostname and forward to loopback 4610.
Forward WebSocket upgrades and preserve `Host` and `Origin`. Keep PostgreSQL,
Docker and broker sockets private. Production serves the built UI from tm8 and
mounts the application source read-only. Artifact previews are disabled in this
overlay; enabling them requires the existing separate preview hostname setup.

Assignment is atomic and remains fixed to a machine. Pending, provisioning,
ready, failed and suspended assignments all consume capacity. A healthy node
with the lowest used/capacity ratio is selected unless an invitation pins the
recipient to a machine. When capacity is full the account waits; an administrator
registers another machine and the user retries. Existing assignments do not move
automatically. Capacity changes through `/api/machines/configure` are checked
against allocated users and reach the node on its next heartbeat.

A browser receives a 60-second, single-use handoff in a URL fragment. The node
redeems it with its own credential and sets a host-only HttpOnly session cookie.
Central authorization leases last 30 seconds. During a control outage an existing
lease works only until its deadline; fresh sign-ins and expired leases fail closed.
Node logout revokes the central session. Open event and terminal connections
recheck authorization and close on expiry.

Create email-bound space invitations from **My workspace** or
`tm8 workspace invite create`. Space administration is checked on the owning
node. A recipient already assigned to another machine is refused. Revoking an
invitation prevents future acceptance; removing an already accepted member uses
the existing space membership controls.

Live GitHub OAuth and Supabase integration require the operator's actual
provider settings. The repository tests exercise controlled provider responses,
real PostgreSQL and two composed tm8 nodes; they do not claim a live cloud login.

References: [Supabase GitHub login](https://supabase.com/docs/guides/auth/social-login/auth-github),
[Supabase identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking),
[Supabase PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow).
