# Agents and server restarts: what survives, what cannot, and why

Written against the incident of 2026-08-22 11:04:16 UTC (four agents killed by a
deploy, recorded as ordinary exits — see PR #510), and against the policy that
followed it:

> The only acceptable involuntary death is genuine resource exhaustion. OOM,
> memory pressure, disk. Everything else — deploys, restarts, rotations,
> supervisor sweeps, config reloads — must leave running agents alive.

This note records what was **measured** on the prod node, what that rules out,
and what would actually satisfy the policy. It exists because three of the four
obvious fixes do not work, and the reason is not obvious from reading the code.

---

## The finding that decides everything

**A PTY child dies when the process holding its master fd dies. This has nothing
to do with cgroups, and no systemd setting changes it.**

Measured directly, with no systemd involved — a plain parent process holding a
`node-pty` master, SIGKILLed, with two children that differ only in whether they
touch the terminal:

| child | behaviour | after parent SIGKILL |
|---|---|---|
| `quiet` — never reads/writes the tty, appends to a file | one more iteration, then dead | **dead** |
| `talky` — writes to stdout each iteration, like a streaming agent | froze immediately | **dead** |
| `ignores` — `trap '' HUP`, otherwise identical to `quiet` | kept running normally | **survived** |

The third row isolates the mechanism: the kernel raises **SIGHUP** on the
terminal's foreground process group when the master side closes. A process with
the default disposition dies. Only a process that explicitly ignores SIGHUP
survives — and `claude` does not, nor should it.

So the agent's life is bound to the *fd*, not to the cgroup. That single fact is
what rules out the cheap options.

## What that rules out

**`KillMode=process` — does not work.** It stops systemd from sweeping the
cgroup, and the agents die anyway, because the thing that kills them is the
closing master fd in the exiting server. It buys nothing and costs the
guarantee that a unit stop actually stops the unit.

**A transient scope (`systemd-run --scope`) — does not work.** Same reason.
Moving the agent to a different cgroup does not move the master fd. It is
strictly more machinery for the same outcome.

Both would additionally be *harmful* in the one case where the agent does ignore
SIGHUP: the process then survives with no server able to reach it — alive,
credentialed, burning CPU, unreachable, and destined to be retired as a ghost
anyway. An orphan is not a survivor.

**`Restart=always` + SIGTERM instead of SIGKILL — necessary, but not sufficient.**
The deploy script hard-kills for a documented reason: the server exits 0 on
SIGTERM and the unit is `Restart=on-failure`, so a graceful stop would leave prod
dead with no passwordless sudo to restart it. Fixing that mismatch removes the
need for `kill -KILL` and — importantly — gives the server a **shutdown window**
in which it can say why each session is ending. It does not keep a single agent
alive. The master fd still closes when the process exits.

**Drain-first — does not satisfy the policy.** Draining ends the session
politely. The policy asks that the agent *survive* the deploy. Useful as a
complement; not the answer.

## What would actually work

**Move the PTY master out of the API server.**

The agent must be held by a process whose lifetime is not the deploy unit's.
That is a **PTY host daemon**: its own systemd unit, holding every master fd,
with the API server as a *client* over a local socket. A deploy then restarts
only the API server; the daemon and every agent under it keep running, and the
new API server reconnects.

This is less speculative than it sounds — much of it already exists:

- `PtyHostService` is already a self-contained class with an injected status
  sink (`onSessionStatus`), not a tangle of server internals.
- `packages/server/src/pty/pty-ws-server.ts` is already a full attach/replay/
  offset-resume protocol for talking to a PTY over a socket, with scrollback
  replay and byte-offset reattach. That is most of the wire format a daemon
  needs, already written and proven.
- The repo has prior art for a separate long-lived server process.

The real costs, honestly stated:

1. **A control plane**, not just a data plane. Today's socket streams bytes; the
   daemon also needs spawn / kill / resize / prompt-handoff as requests.
2. **The status sink crosses a process boundary.** `handlePtyExit` writes to the
   graph under the session's captured claims. Either the daemon gets graph
   credentials, or exits are forwarded to the API server and buffered while it
   is down. The second is safer and needs a durable queue.
3. **Re-adoption on API-server boot** — see below.
4. **A migration path**: two units, ordering, and what happens to agents running
   under the old single-process arrangement at cutover.

Estimate: a real design task, not an afternoon. It should be scoped as one.

### Cheaper alternatives, and why they rank below it

- **fd passing (`SCM_RIGHTS`) at cutover** — the outgoing server hands its master
  fds to the incoming one. Genuinely possible, and avoids a new daemon. But it
  needs both processes alive at once and a handshake the current
  rotate-then-kill deploy cannot provide, and the *in-memory* PTY state
  (scrollback, headless xterm) has to cross too. Fragile at exactly the moment
  you most want boring behaviour.
- **tmux/screen as the PTY holder** — cheap, proven, survives everything. But it
  puts a third-party terminal multiplexer inside the product's core loop and
  makes scrollback semantics someone else's implementation detail.

## Re-adoption: feasible, and mandatory under this policy

If agents outlive the server, `reconcileNodeGhosts` becomes actively dangerous:
it retires every session it cannot account for, so a *surviving* agent would be
retired as a ghost. That is the same bug wearing a different hat.

Under a PTY-host split, re-adoption is straightforward, because the daemon is
the authority: on boot the API server asks it which sessions it is holding, and
that answer replaces the current "my in-process map is empty, therefore
everything is dead" inference. The reconciler's rule changes from

> a row this node owns with no live PTY **in this process** is a ghost

to

> a row this node owns that **the PTY host does not know about** is a ghost

which is the same sentence with a durable source of truth substituted for a
volatile one. **`reconcileNodeGhosts` must not run at all until the PTY host has
been queried** — that ordering is the whole safety property.

Without the split, re-adoption is not feasible: there is no way to recover a
master fd from a process that no longer exists.

## OOM must stay distinguishable

Under this policy a memory kill becomes the one legitimate death, so it has to be
recognisable rather than folded into a generic ending.

It is directly detectable, and cheaply: the cgroup exposes a kernel-maintained
counter at
`/sys/fs/cgroup/system.slice/<unit>/memory.events` → `oom_kill`. Read it when a
session starts and again when it ends; if it advanced, the death was a memory
kill, and that is kernel evidence rather than an inference from a signal number.

Measured on prod at the time of writing: `oom_kill 0`, `memory.max = max`,
`memory.current ≈ 4.5G`. **OOM is not what has been happening** — every death
studied so far was a deploy. But once deploy deaths are eliminated this is the
signal that matters, and it should be wired before it is needed, not after.

## Recommendation

1. **Now** — make every ending legible, and stop the deploy from needing a hard
   kill. Neither keeps an agent alive; both are prerequisites for anything that
   does, and they end the "silently recorded as a normal exit" failure that made
   the original incident invisible.
2. **Next, as its own design task** — the PTY host split. It is the only option
   measured to satisfy "everything except resource exhaustion must leave running
   agents alive", and re-adoption has to land with it, not after it.

Stating the uncomfortable half plainly: **until the split lands, a deploy still
kills every running agent.** Nothing in step 1 changes that. It changes only
whether the graph tells the truth about it afterwards.
