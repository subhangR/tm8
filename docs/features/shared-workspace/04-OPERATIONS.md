# Hosted-workspace operations

> This runbook describes the required production behavior. The provisioner and
> gateway are not implemented in the current tree.

## Operational phases

A hosted workspace moves through several operational phases even if the final
API uses different state names:

1. **Requested** — identity and policy are accepted; no resources are trusted yet.
2. **Provisioning** — database, volumes, credentials, container, migrations, and
   routes are being reconciled.
3. **Ready** — the end-to-end owner probe passed; execution may still be disabled.
4. **Running** — the workspace server is healthy and serving activity.
5. **Stopped** — durable state remains but compute is off.
6. **Degraded** — resources exist but the full probe fails; launches are refused.
7. **Removing** — access is revoked and resources are being deleted or retained
   according to policy.

Treat these as operational concepts, not frozen contract enum names.

## Health checks

Check the complete route, not individual components:

1. authenticate as the workspace owner with a short-lived probe credential;
2. route through the public gateway;
3. reach the expected hosted tm8-server instance;
4. execute a harmless authenticated read against the expected database;
5. confirm the returned workspace/owner binding;
6. discard the probe credential.

Container-running, port-open, and database-accepting checks are useful
diagnostics but are not readiness proofs.

## Start, stop, and idle eviction

- Cold start must restore the same immutable workspace identity, database, and
  volumes before accepting traffic.
- Requests queue only within a small bounded window; after that they fail
  clearly rather than being rerouted.
- Idle eviction stops compute, not durable data.
- An active terminal, provisioning step, migration, backup, or bridge transfer
  prevents idle eviction.
- A launch never falls back to the hub process while a workspace starts.

## Resource controls

Apply limits before the container starts:

- CPU shares/quota;
- memory and swap ceiling;
- PID/process limit;
- workspace and log disk quota;
- I/O pressure policy;
- outbound network policy;
- maximum concurrent sessions and launch rate.

Alert before a hard disk limit. A full workspace disk should fail that workspace,
not consume the hub's database or container storage pool.

## Backups and restore

Back up database and persistent workspace volumes as separate, workspace-bound
artifacts. Encrypt them with keys and access policy appropriate to the tenant.

A restore is not complete until:

- the database and volume belong to the same workspace ID;
- routes and owner identity point to that workspace;
- stale gateway, agent, and bridge credentials are invalidated;
- migrations are compatible;
- the end-to-end owner probe passes;
- a different workspace cannot access the restored resources.

Never restore one workspace into another workspace's live identity merely to
make routing convenient.

## Upgrades

1. Stop new launches and bridge requests for the target workspace.
2. Drain or explicitly terminate running sessions.
3. Take a recoverable database/volume checkpoint.
4. update the image by immutable digest;
5. run migrations against only that workspace database;
6. start and run the owner probe;
7. reopen traffic or roll back image and data together.

Canary upgrades should use disposable workspaces before a tenant workspace.

## Reconciliation after partial failure

The provisioner records each resource by the server-minted workspace ID and can
reconcile repeatedly. On restart it must discover and handle:

- database exists, container missing;
- container exists, database missing or unmigrated;
- volume exists without a route;
- route points to the wrong or absent container;
- credentials exist after account revocation;
- removal started but some resources remain.

Idempotency means repeating the same requested outcome converges safely; it does
not mean ignoring mismatched resources.

## Deprovisioning

Deprovision in this order:

1. disable routing and new launches;
2. revoke gateway sessions, agent credentials, bridge grants, and enrolment links;
3. terminate workspace processes;
4. snapshot or expire data according to retention policy;
5. remove container and network attachments;
6. remove secret store and private volumes;
7. drop database and role;
8. remove routes and lifecycle metadata;
9. prove no resource remains addressable by the old identity.

Shared graph history authored by the member remains unless a separate data
retention policy requires redaction.

## Incident response

For suspected cross-workspace access:

1. disable launches and bridge operations node-wide;
2. preserve gateway, provisioner, container, database, and audit logs;
3. revoke affected gateway/agent/bridge credentials;
4. isolate affected containers without deleting volumes;
5. identify the first violated binding: identity→workspace, route→server,
   server→database, session→workspace, or process→container;
6. assume exposed tenant secrets are compromised and rotate them;
7. test the negative isolation cases before reopening.

Do not silently repair and continue. Cross-workspace access is a security
incident even when no evidence shows that data was read.

