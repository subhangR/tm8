| Item | Groomed decision |
|---|---|
| User outcome | A person working on their own laptop can point tm8 at a folder on **that laptop**, and tm8's server-side agents can read and write it. |
| Status | **Design only.** No product source, no migration, nothing deployed. Phases 0–2 deliberately do not depend on this. |
| Scope | The transport, the pairing/auth model, and the filesystem seam. |
| Out of scope | Editor features, conflict UI, offline queueing beyond reconnect. |
| Completion | Cannot be reached by this repository alone — see "What done cannot mean". |

Why phase 3 exists at all
-------------------------

Phases 0–2 answer "each user gets a private workspace and their own GitHub"
with a **server-side** directory. That is the right default: tm8's value is
server-side agents, and code they cannot see is code they cannot work on. Under
that model your laptop and tm8 stay in step through GitHub, which is how
Codespaces and every hosted agent product does it.

What phases 0–2 do NOT deliver is the literal request: *a folder on my laptop*.
This document scopes that honestly rather than letting it hide inside the other
work.

The constraint, stated once
---------------------------

A browser cannot give a server filesystem access. `<input type="file">` yields
bytes and a bare filename — never a path, never a directory handle the server
can use. This is a deliberate browser security boundary and no amount of tm8
code moves it.

So there are exactly three shapes, and only one of them satisfies both halves of
the requirement:

| Shape | Local folder? | Agents can work on it? |
|---|---|---|
| Server-side workspace + GitHub bridge (**phases 0–2**) | No | **Yes** |
| Browser File System Access API (`showDirectoryPicker`) | **Yes** | No — only the tab can see the bytes |
| **Local daemon (this document)** | **Yes** | **Yes** |

The middle row is worth naming because it looks attractive and is a trap: it
would give a genuinely local folder while making every work session, spawn and
agent blind to it. That converts tm8 into an editor.

Design
------

| Layer | Change | Reason |
|---|---|---|
| Daemon | A small binary the user runs on their laptop. Holds ONE outbound connection to the tm8 node; no inbound port, no public listener. | An inbound listener on a laptop behind NAT is not deployable, and would be a security liability if it were. |
| Pairing | The daemon is paired by a short-lived code minted in the UI and redeemed once, yielding a long-lived per-daemon credential bound to ONE account. Revocable from the same screen. | Mirrors the existing per-work-session bearer discipline (074): a credential per principal, revocable, never shared. |
| Transport | Request/response over the existing WS spine, framed as filesystem operations: stat, list, read-range, write, remove, watch. | tm8 already runs an authenticated WS to each browser; a second bespoke transport would be a second thing to secure. |
| Filesystem seam | `packages/execution` gains a `WorkspaceFs` interface with two implementations: the node's own `fs` (today's behaviour) and a remote one backed by the daemon. Everything that touches a project directory goes through it. | This is the load-bearing refactor. Today project paths are used as raw `fs` calls and a PTY `cwd`; a remote folder has neither. |
| The PTY problem | A spawned agent gets a shell whose `cwd` is a real directory. A remote folder has no local `cwd`. Either the agent runs ON the laptop (the daemon spawns it) or the folder is mirrored to the node and synced. | **This is the hard part and the reason this is a separate phase.** It is not a transport problem, it is a "where does the agent run" problem. |

The honest assessment of cost
-----------------------------

The transport and pairing are ordinary work. The filesystem seam is a wide but
mechanical refactor. **The PTY problem is a product decision, not an
implementation detail**, and it forks:

- **Agent runs on the laptop.** True local editing; the laptop must be awake and
  the daemon becomes an execution host, inheriting the whole sandbox/permission
  posture tm8 currently enforces node-side (`resolveSandboxPosture`, trust
  levels, the codex network preflight). Effectively a second execution
  environment to secure.
- **Folder mirrors to the node.** Agents keep running where they do now; you
  inherit two-way sync — conflicts, deletes, renames, large files, and the
  question of what happens when both sides change while the laptop is asleep.
  This is the problem Dropbox is, and it is not small.

A third option deserves stating because it is cheaper than both: **do nothing
here, and make the GitHub bridge excellent instead.** If phase 2 gives every
user their own credential and a one-click clone/pull/push, the laptop round trip
is `git pull`. Most of the value of "work on my local folder" is really "my
changes and the agent's changes meet somewhere", and a remote already does that
with well-understood semantics.

What "done" cannot mean
-----------------------

This repository can produce the daemon, the pairing flow and the server seam. It
cannot install a binary on anyone's laptop, and nothing in this design is
exercised until someone does. Any plan that treats phase 3 as "shipped" when the
code merges is mis-stating its own status — the same way this file's ancestor
`WORKTREE-DESIGN.md` still says "design only" while phases 1 and 2 of it landed
and phase 3 never did, leaving `WorktreeManager` real, tested, and reachable
from nothing.
