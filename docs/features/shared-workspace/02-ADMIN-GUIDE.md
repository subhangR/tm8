# Administrator guide

> **Not available in the current build.** There is no hosted-workspace screen,
> provisioner, gateway package, or supported CLI/API command yet. This guide is
> the required operator workflow for the implementation. Do not approximate it
> with several tm8 processes under one OS user; that shares credentials and does
> not meet the isolation contract.

## 1. Choose the isolation tier

Before enabling hosted workspaces, decide who shares the host:

| Co-tenants | Minimum honest deployment |
|---|---|
| One trusted team, trusted node operator | Rootless container per workspace |
| Mutually distrusting or paying tenants | Separate VM per workspace, or an equivalent separately administered kernel boundary |
| Developer laptop | Single workspace only |

All tiers still trust the node operator. Root can read a container's memory,
volume, and secrets. A tenant who cannot trust the operator needs their own node.

## 2. Host prerequisites

The production implementation must refuse provisioning until these checks pass:

- Linux host with cgroup v2 and a supported rootless container runtime.
- A dedicated, non-root service identity for the gateway/provisioner.
- Postgres cluster health, migration compatibility, and backup destination.
- Durable workspace and database volumes with capacity thresholds.
- TLS at the public gateway and authenticated internal control channels.
- Default-deny workspace networking with only required tm8 and package/provider
  endpoints enabled by policy.
- CPU, memory, PID, disk, and idle-time limits configured before the first user.
- Auto-owner/anonymous loopback access disabled for multi-workspace operation.
- No operator LLM, GitHub, SSH, or cloud credential inherited by hosted
  containers.

## 3. Add a member and workspace

The intended UI workflow is:

1. Open node administration and invite or select the member.
2. Choose **Create hosted workspace**.
3. Set a display name and resource policy. The display name is presentation data
   only; tm8 mints every database, container, route, and volume identifier.
4. Leave execution disabled while provisioning.
5. Wait for the end-to-end readiness probe, not merely container/database
   creation.
6. Deliver the one-time enrolment route to the member.
7. After the member has established their account and reviewed network/resource
   policy, enable execution for that workspace if required.

Provisioning is node-admin-only and rate-limited. A Space owner or teammate role
must not gain this capability.

## 4. Credential enrolment

The member, not the node admin, adds GitHub, cloud, and model-provider
credentials inside the private workspace. The admin configures which secret
names and providers are allowed, but never sees or supplies their values.

Verify after enrolment:

- the secret value is absent from gateway/server logs and database rows;
- manifests record only environment-variable names;
- a process in another workspace cannot read the secret store or process
  environment;
- deleting or rotating a credential takes effect for new sessions without an
  image rebuild;
- package/build subprocesses do not receive the tm8 agent credential.

## 5. Enable collaboration

Create or select the hub Space in which members collaborate. Space membership
governs shared graph visibility; it does not grant access to a hosted workspace.

Bridge or delegated-launch policy must start at **deny**. A member can later
allow specific requesters, Spaces, task kinds, repositories, time windows, or
resource ceilings. The policy is versioned and auditable so a later review can
answer what was allowed when a request ran.

## 6. Validate isolation before admitting users

Use two disposable test identities and prove all negative cases:

- Alice cannot route to Bob's workspace by changing a request parameter.
- Alice cannot attach, write input, resize, or terminate Bob's session.
- Alice cannot read Bob's database, volume, home, manifests, journals, process
  environment, SSH agent, or container control socket.
- Alice's GitHub/cloud credentials are absent from Bob's process environment.
- An unauthenticated loopback or gateway request receives 401, never owner.
- Stopping Alice's container cannot cause her next launch to run on the hub.
- A forged bridge request is rejected and recorded.
- Resource exhaustion in Alice's workspace hits her cgroup/quota before it
  degrades Bob's workspace.

Do not call the node multi-tenant-ready until these tests run in CI and against
the deployment shape actually used in production.

## 7. Suspend, revoke, and remove

Suspension stops new launches and bridge requests but preserves data. Revocation
also invalidates gateway sessions and workspace grants and terminates running
processes. Deprovisioning additionally removes container, database, volumes,
routes, secret store, and workspace-scoped credentials according to retention
policy.

Authored shared-graph history is not deleted merely because an account is
revoked; historical attribution must remain intact.

## 8. Never do these

- Do not run multiple users' agents as the tm8-server OS user.
- Do not mount the host home, Docker/Podman socket, SSH agent, or tm8 data root
  into a tenant container.
- Do not derive an identifier or path from a display name.
- Do not expose Postgres trust authentication beyond its intended private
  boundary.
- Do not turn on execution globally because one workspace needs it.
- Do not treat `127.0.0.1` as authenticated on a multi-workspace node.
- Do not fall back to in-process spawn when a workspace is unhealthy.

