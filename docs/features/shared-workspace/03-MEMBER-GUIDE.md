# Member guide

> **Current status:** hosted workspaces are not yet available in the product.
> The steps below define the member experience the gateway and UI must provide.
> Until [Implementation status](06-IMPLEMENTATION-STATUS.md) says otherwise,
> use a separately operated tm8 node for genuinely private credentials.

## What you get

Your hosted workspace is a private tm8 environment on a shared hub. It contains
your tm8-server, database, home directory, repositories, agent sessions, and
credential store. Other hub members collaborate with you through shared Spaces;
they do not receive shell or filesystem access to your workspace.

The node operator still controls the machine and is trusted. A hosted workspace
does not protect secrets from the host administrator or from a host/kernel
compromise.

## 1. Join the hub

1. Open the invitation from the node administrator.
2. Establish your hub account and recovery method.
3. Review the node operator, isolation tier, resource limits, retention policy,
   allowed outbound network destinations, and backup policy.
4. Join the shared Space(s) required for collaboration.

Joining a Space shares graph data in that Space. It does not grant another
member access to your private workspace.

## 2. Activate your hosted workspace

After the administrator provisions it, open the workspace enrolment route and
confirm that the workspace identity shown belongs to you. tm8 should display the
workspace's isolation tier, execution status, resource limits, and last
successful health check before you add any credentials.

If the UI shows a provisioning or degraded state, do not add secrets or launch
agents. A workspace is ready only after the authenticated end-to-end probe has
passed.

## 3. Add credentials

Add GitHub, cloud, model-provider, and package-registry credentials from inside
your hosted workspace. Prefer short-lived provider credentials and narrowly
scoped tokens.

- Use a separate token for the workspace instead of copying a personal
  all-purpose token.
- Scope GitHub access to the repositories the workspace needs.
- Prefer cloud roles with short expiry and explicit project/account scope.
- Rotate a credential immediately if it appears in a message, task, log, or
  repository file.
- Never send a secret to the central teammate or node admin through the graph.

tm8 manifests should show only secret names, not values.

## 4. Launch teammates

When you launch a teammate, tm8 derives your hosted workspace from your signed-in
identity. You do not choose a raw workspace ID. The teammate runs with your
workspace files and the credentials you have allowed for that launch.

Before approving a launch, review:

- the Space, task, teammate persona, repository, and working directory;
- the permission and network posture;
- which credential names will be supplied;
- whether the launch was requested by the central teammate or another member.

If your workspace is stopped, tm8 may cold-start it. If the start or identity
check fails, the launch must fail; it must never run in the hub environment.

## 5. Collaborate through the hub

Shared tasks and discussions live in the hub Space. Private repositories and
credentials stay in your workspace.

The intended flow is:

1. Pull or accept a bounded work request through the bridge.
2. Run it in your workspace under your identity.
3. Review the result for private data.
4. Report only the intended result back to the hub Space.

The central teammate can coordinate and read what you report. It cannot inspect
your workspace merely because it created the request.

## 6. Control delegated requests

Delegated launch is off by default. If you enable it, use the narrowest policy
that works: named requester, named Space/repository, allowed task type, maximum
resource posture, and expiry. tm8 must keep both the policy version and every
decision in an audit trail.

An auto-accepting agent is not human consent. Auto-accept is only legitimate when
it enforces a policy you deliberately configured beforehand.

## 7. Stop or leave

Stopping the workspace ends compute while retaining its durable state according
to hub policy. Revoking the workspace invalidates sessions and grants. Before
permanent deletion, export what you need and verify the retention/backup window;
deprovisioning removes private workspace data but does not erase messages and
other history you intentionally authored in shared Spaces.

## What other people can and cannot see

| Other hub members may see | They must not see |
|---|---|
| Data in shared Spaces they belong to | Your credential values |
| Results you intentionally report | Your home directory or unrelated repositories |
| Shared session output you explicitly expose | Private terminal input/output by default |
| Your historical shared authorship | Your database or workspace volume |
| Workspace availability at an appropriate coarse level | Process environments, SSH agents, or secret-store contents |

