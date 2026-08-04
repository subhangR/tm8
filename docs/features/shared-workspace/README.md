# Hosted workspaces

Hosted workspaces let several people use one tm8 hub while each person runs agents
inside a private execution environment with their own files and credentials.

> **Implementation status:** this is the operating and product documentation for
> the approved design, not a claim that hosted workspaces are available today.
> The gateway, provisioner, per-workspace containers, UI, and collaboration bridge
> are not implemented. See [Implementation status](06-IMPLEMENTATION-STATUS.md)
> before deploying or exposing tm8 to multiple users.

## The short version

A tm8 **Space** is where people collaborate. A hosted **Workspace** is where one
person's server, agents, files, and credentials live. Sharing a Space must not
mean sharing an execution environment.

The hub runs a gateway and a central teammate. Each hosted workspace runs in its
own rootless container, with its own tm8-server process, database, filesystem,
credentials, and resource limits. The central teammate coordinates through the
tm8 graph and the workspace bridge; it has no ambient permission to enter a
member's container or read their secrets.

```text
                         shared collaboration
                  ┌─────────────────────────────┐
                  │ hub Space + central teammate│
                  └──────────────┬──────────────┘
                                 │ gateway / bridge
                ┌────────────────┼────────────────┐
                │                │                │
         ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
         │ Alice       │  │ Bob         │  │ Carol       │
         │ container   │  │ container   │  │ container   │
         │ server + DB │  │ server + DB │  │ server + DB │
         │ files+secrets│ │ files+secrets│ │ files+secrets│
         └─────────────┘  └─────────────┘  └─────────────┘
```

The most important rule is:

> A session launched for user U executes in U's hosted workspace. Neither a
> Space role nor the central teammate can redirect it into another user's
> environment.

## Read by goal

| If you want to… | Read |
|---|---|
| Understand the model and request flow | [How it works](01-HOW-IT-WORKS.md) |
| Operate the hub or add a user | [Administrator guide](02-ADMIN-GUIDE.md) |
| Use your private workspace as a member | [Member guide](03-MEMBER-GUIDE.md) |
| Run, upgrade, recover, or remove workspaces | [Operations](04-OPERATIONS.md) |
| Review the isolation promise and threat model | [Security model](05-SECURITY-MODEL.md) |
| See what exists in the current tree | [Implementation status](06-IMPLEMENTATION-STATUS.md) |
| Review the detailed design and evidence | [Design record](SHARED-WORKSPACE-DESIGN.md) |

## Vocabulary

| Term | Meaning |
|---|---|
| **Node** | A machine or deployment that runs tm8 components. |
| **Hub** | A node with the gateway enabled. It hosts shared Spaces and may host private workspaces. |
| **Space** | The collaboration and data-visibility boundary. Many members may belong to one Space. |
| **Workspace** | The root container served by one tm8-server and owned by one tm8 identity. |
| **Hosted workspace** | A private workspace provisioned on a hub for a member. |
| **Central teammate** | The hub's coordinator. It works through graph messages and bridge requests, not another user's filesystem. |
| **Gateway** | Authentication, routing, workspace lifecycle, relay, and bridge entry point. |
| **Bridge** | The explicit workspace-to-workspace protocol for pulling shared work and reporting results. |

## Source of truth

This section explains an approved architecture and its intended operation. The
binding architectural rules remain [Node and gateway](../../architecture/02-NODE-AND-GATEWAY.md),
[Architecture laws](../../architecture/01-LAWS.md), and the contracts in
`packages/contract`. When this guide and the contract disagree, the contract
wins and this guide must be updated.

