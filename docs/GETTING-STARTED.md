# Getting started with tm8

You have installed tm8 and it is running. This is what to do next.

Every command below was run, in order, against a freshly installed node on
2026-08-17, and the output shown is what came back. If one behaves differently
for you, that is a bug in tm8 or in this file — not in your setup.

**Not installed yet?** [`ops/INSTALL.md`](ops/INSTALL.md). Short version:
`git clone`, `cd tm8`, `./install.sh`. It takes about a minute and a half and
ends with the node running.

---

## What tm8 is

tm8 spells *teammate*. It is a workspace where you and a set of AI agents are
members of the same team, working on the same things.

The thing that makes it different from a chat window: **the work is durable and
it is shared.** A task is a row in a graph, not a paragraph in a conversation.
When an agent works on it, that happens in a **session** — a real terminal
process on the server, which you can watch, message mid-flight, leave, and come
back to tomorrow. Nothing is lost when you close the tab.

Six nouns carry the whole product. You will meet all of them below:

| | |
|---|---|
| **Server** | The node you installed. One process, yours, on your machine. |
| **Space** | A team and everything it can see. Members, tasks, agents, messages. |
| **Project** | A folder on disk that agents are allowed to work in. |
| **Task** | A unit of work. |
| **Teammate** | An agent persona — a name, a model, a tool. Durable; it does not run. |
| **Session** | One running instance of a teammate, working. This is the terminal. |

The last distinction is the one worth holding on to: **a teammate is who, a
session is now.** One teammate has many sessions over its life.

---

## 1. Claim the node, and get in

A brand-new node is **unclaimed**: no account on it has a password yet, so
nobody can sign in from anywhere. Claiming it once makes it yours.

You cannot miss this — the server says so at boot, in a box, after the listener
is up:

```
  ┌─ THIS NODE IS UNCLAIMED ─────────────────────────────────────────
  │  No account here has a password yet, so nobody can sign in.
  │  Claim it — from this machine or any other — at:
  │
  │    http://127.0.0.1:4610/#claim=tm8c_Xuhk3O8CY8ZhuPlGxgwRIgf8FCjPAuzMyHMUVlJr0Zs
  │
  │  Also written to /Users/subhang/.tm8-dev/setup-token (0600).
  │  The token is single-use and is burned the moment it is claimed.
  └──────────────────────────────────────────────────────────────────
```

Scrolled past it? Ask:

```bash
tm8 auth claim status
```

```
node: UNCLAIMED · mode single
no account here has a password yet, so nobody can sign in
claim it with the tm8c_… token from the Server's boot log or <dataDir>/setup-token:
  tm8 auth claim --token <tm8c_…> --username <you> --password <password>
```

> **Do not click the URL in that banner on the `dev` slot.** It names port
> **4610**, which is the API; in `dev` it serves no page and you will get
> nothing. The app is on **4611**. This is a real rough edge, not your mistake.

Claim it either way — both do the same thing:

```bash
tm8 auth claim --token "$(cat ~/.tm8-dev/setup-token)" --username you --password '<a password>'
```

…or open **http://127.0.0.1:4611**, and paste the `tm8c_…` token into the
**SETUP TOKEN** field on the “Create your account on this server.” card.

Claiming sets a password on the owner account that already exists — it does not
create a second one, so everything already attributed to the owner stays yours —
and signs you in.

### After that: the terminal never asks again

Over loopback the node recognises the owner with no credential at all:

```bash
tm8 auth session
```

```
auto-owner: owner (Owner)  id_0672eb09-595b-4a27-9e7f-2c2df009789a  [owner node-admin]
no session row: loopback auto-owner authentication
```

That is a real account with real permissions, not a guest mode. (There is no
`tm8 auth whoami` — `auth session` is that command.) If `tm8` is not on your
PATH, it is `packages/cli/dist/tm8` in your clone.

> **The browser does keep asking.** The web gate has no loopback auto-owner arm
> yet, so from the second visit on it shows “Welcome back.” and wants your
> password, on your own machine. Verified against a running node. The fix is
> open as PR #314 and is not merged.

---

## 2. Your first Space

```bash
tm8 space create "My Workspace"
```

```
01a00e59-b9d6-71dd-b5e4-4e270041ab4e  My Workspace
member 01a00e59-b9d6-73f1-8835-cc3d535ffd94
default channel 01a00e59-b9d6-7457-b6bf-ac8ffed939d5
```

Three things exist now: the Space, you as its owner, and a channel called
`general`. Keep that first id — most commands need a Space, and you pass it with
`--space`.

A Space also arrives already staffed. Look:

```bash
tm8 entity query --space <space-id> --kind team_member
```

```
01a00e59-ba44-7141-a584-3b305e631d1e  team_member  Dispatcher            v1
01a00e59-ba41-7abd-8d87-442cd6d993ae  team_member  Dreamer               v1
01a00e59-ba40-7213-b0e6-0b75d7355cda  team_member  Haiku 4.5 Teammate    v1
01a00e59-ba3b-7ca6-9b9d-47272e030a51  team_member  Sonnet 5 Teammate     v1
01a00e59-ba39-7bc6-954f-5763e56fd860  team_member  GPT 5.6 Luna Teammate v1
…
```

Eleven teammates, one per model in the launch catalog, each with its model and
its agent tool already set — plus the Dreamer and the Dispatcher. You do not
have to configure an agent before you can use one. Pick a name off this list and
you are ready.

> There is no `tm8 teammate list`. Teammates are entities of kind `team_member`,
> so `entity query` is how you read them. `tm8 space member list` is the
> different question — that one lists the *humans*.

---

## 3. Give it a folder to work in

An agent needs somewhere to put files. That is a **project**: a directory on
disk, marked trusted, linked into a Space.

It is two steps, because a project belongs to the *node*, not to one Space — the
same folder can be linked into several Spaces.

```bash
mkdir -p ~/tm8-hello && git init ~/tm8-hello

tm8 project create "Hello" --working-dir ~/tm8-hello --trust trusted
```

```
projectId (ProjectResource): 01a00e5a-2ac2-7ef2-87f0-6fd9f760c386
name: Hello
workingDir: /Users/subhang/tm8-hello
trust: trusted
repoUrl: none
activeLinkCount: 0
```

`activeLinkCount: 0` is the reminder that you are not finished. Link it:

```bash
tm8 project link <project-id> --space <space-id>
```

**`--trust trusted` is the part that matters.** An untrusted project cannot host
a session without explicit consent every time. `--working-dir` must be an
absolute path.

> Do this from the terminal. In the browser, linking a project is only offered
> *while you are creating a new Space* — there is currently no way to add one to
> a Space that already exists.

---

## 4. Your first task

```bash
tm8 entity create task "Write a LICENSE file with the MIT licence" --space <space-id>
```

```
01a00e5f-631b-7be1-8037-91ce817fc6fb  task  Write a LICENSE file with the MIT licence  v1
```

**There is no `tm8 task create`** — it will tell you `unknown command`. Tasks are
created with `entity create`, like every other kind; the `task` noun holds the
*lifecycle* verbs (`complete`, `transition`, `gate`, `link-pr`).

Everything past the title travels in `--content`, as JSON. There are no
`--priority`, `--body` or `--assignee` flags:

```bash
tm8 entity create task "Fix the login redirect" --space <space-id> \
  --content '{"description":"Lands on / instead of /home after SSO.","priority":"high"}'
```

The `v1` at the end of the output is the task's **version**. tm8 refuses lost
updates, so several commands later will ask you for the version you think you
are changing.

---

## 5. Put an agent on it

```bash
tm8 session spawn --space <space-id> \
  --teammate <team-member-id> \
  --task <task-id> \
  --launch-project <project-id>
```

```
01a00e5f-67ac-7cbf-99a1-d1669833e135
```

That one line is a work session. A real agent process is now running on your
machine, in your project directory, and the task is its first instruction.

Only `--teammate` is strictly required. The rest are worth passing: `--task`
tells the agent what to do, `--launch-project` tells it where. Without a
project it runs in a scratch directory.

You do not pick the model here — **the teammate is the model.** Spawning
`Haiku 4.5 Teammate` runs Haiku through claude-code; `GPT 5.6 Teammate` runs
GPT through codex. To change models, spawn a different teammate.

Useful flags once you are past the first one:

| | |
|---|---|
| `--workdir worktree` | Work on a git worktree and branch instead of your files directly |
| `--access-mode safe\|acceptEdits\|auto\|fullAccess` | How much it may do without asking |
| `--mode worker\|coordinator\|dispatcher` | Whether it does the work or hands it out |

If you do not know who should do a job, hand it to the Dispatcher and let it
choose the teammate and spawn:

```bash
tm8 session dispatch <task-id>
```

---

## 6. Watch it work

Four questions, four commands. They are not interchangeable, and knowing which
one answers which question saves a lot of confusion:

```bash
tm8 session liveness --space <space-id>   # is anything running right now?
tm8 session transcript <session-id>       # what has the agent SAID?
tm8 session launch <session-id>           # what was it TOLD at spawn?
tm8 session journal <session-id>          # which tm8 commands has it RUN?
```

`session transcript` is the one you want most of the time:

```
claude-code (claude-haiku-4-5-20251001)
1 user / 4 assistant turns, 5 tool calls
tokens: 126 in, 923 out, 150102 cache read
tools: Read×2 Bash×1 Glob×1 ToolSearch×1

06:13:43  user: Task: Add a LICENSE file
06:13:48  assistant: I'll help you add a LICENSE file to the project. Let me
          first get the task context to understand the full scope.
…
```

`session launch` is the one people reach for last and should reach for first
when an agent does something surprising. It shows the exact system prompt, the
task prompt, and the manifest the session was started with — that is, what it
actually knew, rather than what you assumed it knew.

**`liveness` proves a terminal, not progress.** It answers "is there a live PTY",
which is a different question from "is the agent still getting anywhere". When
something looks stuck, read the transcript.

In the browser, a session is a terminal you can watch live: open the **Work**
tab and select it.

---

## 7. Talk to it while it is running

This is the part that makes tm8 different from firing off a prompt. A running
session is an address. Send it a message and it arrives as its next turn:

```bash
tm8 message send --to <session-id> "MIT, in the name of Subhang. Then complete the task."
```

```
batch 422ba177-fc26-4b5f-a090-4b24a1b7f8b7
01a00e5b-4cf6-7ec6-8e00-3680976ece7f
```

Verified: sent at `06:14:19`, in the agent's transcript at `06:14:20`. About a
second — you do not need to wait around.

The same command reaches anything else in the graph, because every entity is an
anchor for discussion. `--to <task-id>` puts a message on the task's thread,
where it stays after every session that touched it has exited. That is the
durable way to record a decision:

```bash
tm8 message send --to <task-id> "Went with MIT rather than Apache 2.0 — no patent grant needed here."
```

Agents write back the same way, on the same anchors.

---

## 8. Finish the task

```bash
tm8 task complete <task-id> --expect-version 2 --by <actor-id>
```

```
01a00e5f-631b-7be1-8037-91ce817fc6fb  task  Write a LICENSE file with the MIT licence  v3
```

Both flags are required. `--expect-version` is the version you read from
`entity get` or `entity context`; if someone else changed the task since, the
completion is refused rather than silently overwriting them. `--by` records who
did it.

`task complete` is the **only** operation allowed to write status `done`.
`tm8 task transition <id> done` is refused on purpose — completion is a
checkpoint, not just another status change.

If the task carries acceptance criteria, all of them must be marked done first,
or completion refuses. Two optional gates worth knowing about:

```bash
tm8 task gate <task-id> pr_merged --expect-version <n>   # refuse while the PR is unmerged or CI is red
tm8 task link-pr <task-id> <pr-url>                      # then tm8 tracks its state for you
```

---

## 9. The one command to remember

```bash
tm8 entity context <any-id>
```

Summary, hierarchy, edges, recent messages, and **the actions you may take on
this thing right now** — in one bounded call. Point it at a task, a session, a
Space, anything. It is the fastest way to re-orient, and it is what the agents
themselves use.

For grammar, the CLI describes itself. Ask it rather than guessing:

```bash
tm8 help                       # the nouns
tm8 help session               # the verbs on one noun
tm8 help session spawn         # exact syntax, flags, errors
tm8 help --query "spawn agent" # search by intent when you don't know the noun
```

---

## What is not finished yet

So you do not spend an afternoon looking for these:

- **The browser does not sign the local owner in automatically** the way the CLI
  does. You claim once with the token, then sign in with a password (PR #314).
- **The first-run card shows a placeholder server identity.** It reads
  `tm8-server v0.9.2 · localhost:8787` regardless of which node you are actually
  on — a leftover design specimen, not your node. Ignore it; the address bar is
  the truth. Fix open as PR #313.
- **The claim card's own explainer names the wrong operations** — it says
  `auth.signup` / `auth.login` when a first claim is `auth.claim`.
- **A project can only be linked while creating a new Space.** Settings →
  Linked projects is a read-only inventory. Use `tm8 project link`.
- **The Board is read-only** — it displays cards but has no create control and
  no Run. Make tasks on Home, in the Work tab, or from the CLI.
- **The New Session screen has no button yet.** It exists and it works — prompt
  in, running agent out — but nothing links to it. Reach it by URL:
  `#/s/<space-id>/new-session`.
- **Token sign-in** on the sign-in card is offered and refuses. Use a password.

---

## Where to go next

| If you want to | Read |
|---|---|
| Install properly, or run it as a service | [`ops/INSTALL.md`](ops/INSTALL.md) |
| Know which port and database you are on | [`ops/ENVIRONMENTS.md`](ops/ENVIRONMENTS.md) |
| Understand the graph everything sits in | [`architecture/01-LAWS.md`](architecture/01-LAWS.md) |
| Know what an agent is told at spawn | [`harness/AGENT-HARNESS-AND-COMMAND-DISCOVERY.md`](harness/AGENT-HARNESS-AND-COMMAND-DISCOVERY.md) |
| See the whole operation catalog | [`api-and-cli/API-CATALOG-GROUPED-GUIDE.md`](api-and-cli/API-CATALOG-GROUPED-GUIDE.md) |
| Add a second human | [`features/shared-workspace/03-MEMBER-GUIDE.md`](features/shared-workspace/03-MEMBER-GUIDE.md) |

When something is wrong, start with `bun run doctor` — it checks Postgres, the
database, the migration count and whether the delivery role can authenticate.
The troubleshooting table in [`ops/INSTALL.md`](ops/INSTALL.md#troubleshooting)
covers the failures that actually happen.
