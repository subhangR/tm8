# Chat agent modes and full tool surface

Status: accepted implementation design  
Task: `01a00206-631f-70f8-b300-78eb9d84111a`

## Decision summary

Chat gets a thread-owned project checkout and the selected coding provider's
native tools. It does not proxy repository reads through a long-lived worker
session, and it does not replace capable provider tools with MCP facsimiles.

For a configured chat thread, the Server resolves the Space's linked
`ProjectResource`; the model never supplies an absolute root. Exactly one
linked project must exist and have `trust=trusted`. A Git project is
materialized once as a standalone `git clone --no-local` below the Server-owned
chat directory. Clone and checkout commands disable hooks and filesystem
monitors. This is intentionally not a Git worktree: creating a worktree would
write refs and worktree metadata into the shared source repository, and a
project-controlled hook could execute in the Server process.

Every fallback repository tool resolves a relative path against the clone,
rejects `.git`, follows no symlink on writes, and applies byte/result caps. The
same clone persists for the thread: Ask and Plan can read it and Build can edit
it. Mode is sticky, so the checkout's authority does not change underneath an
existing conversation. Its sanitized public remote is retained when one
exists; local paths and embedded credentials are never returned as a git
remote.

If the Space has no linked project, or more than one and no project can be
resolved unambiguously, repository tools return a named unavailable result.
They never fall back to the Server process working directory. A linked resource
that is not a Git checkout returns a named provisioning conflict; direct reads
and edits both require the isolated Git clone.

Why this path:

- A worker proxy adds cold-start latency to every code question and recreates
  the lifecycle dependency this feature is intended to remove.
- A chat-owned checkout gives stable paths, a stable branch and direct
  read-after-write behavior without sharing a worker's mutable terminal or
  mutating the Server's source checkout.
- Server resolution preserves the existing `space_projects` authorization
  boundary. Path confinement is an execution concern, not an instruction the
  model is trusted to remember.

## Product research and native-tool decision

Research was refreshed on 2026-08-14 against primary product documentation:

- [Claude Code tools](https://code.claude.com/docs/en/tools-reference) exposes
  built-in `Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash`, `WebFetch`, and
  `WebSearch`, while MCP is the extension surface.
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)
  separates visibility from approval: `--tools` chooses which built-ins the
  model can see, `--allowed-tools` pre-approves calls, and `dontAsk` denies an
  unmatched call instead of blocking a headless process for input.
- [OpenCode tools](https://opencode.ai/docs/tools/) uses the same native
  read/edit/shell/web families and applies `allow | ask | deny` by tool or
  resource pattern; MCP tools participate in that same policy.
- [Cursor modes](https://docs.cursor.com/agent) likewise makes Ask a read-only
  search surface and Agent a full native-tool surface, with custom modes
  selecting tools and instructions.

Decision: adapters map tm8 modes to provider-native tools first. For the
current Claude Code adapter, Ask and Plan see
`Read/Glob/Grep/Bash/WebFetch/WebSearch` plus `TodoWrite` as its scratchpad;
Build additionally sees `Edit/Write`; Orchestrate explicitly disallows every
known Claude built-in because an empty `--tools` value is not a visibility
restriction. The runtime always uses `dontAsk`. Read, search, fetch, and Build
edits are pre-approved by the checkout-anchored `Edit(/**)` rule (which Claude
also applies to `Write`); file reads, glob, and grep are scoped by the
checkout-anchored `Read(/**)` rule. Bash is visible but not blanket-approved,
so Claude's built-in read-only classifier can run safe inspection commands
while anything that needs an interactive prompt fails closed. tm8 MCP remains primary for
graph/session/docs/artifacts/memory and structured git/PR operations.

The MCP repo and web implementations remain registered as provider-neutral
fallbacks for adapters without equivalent native tools. They are not shown
alongside Claude's equivalents, avoiding duplicate schemas and inconsistent
behavior. A future interactive approval channel can settle `ask` calls without
changing the registry or persisted mode model.

## Registry and schemas

The MCP registry is one source of truth for tm8 and provider-fallback tools.
Every entry has a stable name, JSON schema, safety annotations, execution
adapter and per-mode permission. The router checks the mode again on every
call; provider visibility/allowlists are an outer minimization layer, never the
authority for MCP calls. Provider-native calls are constrained by the exact
`--tools`/`--allowed-tools` lists derived from the same stored mode.

### Repository

| Tool | Input | Result |
| --- | --- | --- |
| `repo_read_file` | `path`, optional `offset`, `limit` | UTF-8 text, line/byte counts, truncation |
| `repo_glob` | `pattern`, optional `limit` | sorted project-relative paths, truncation |
| `repo_grep` | `query`, optional `glob`, `limit` | path/line/column/text matches, truncation; regex execution is isolated behind per-file and total wall-clock budgets |
| `repo_write` | `path`, `content` | changed flag and byte count |
| `repo_edit` | `path`, `oldText`, `newText`, optional `replaceAll` | replacement count |
| `repo_multi_edit` | ordered edits using the `repo_edit` shape | atomic preflight, rollback on write failure, per-file counts |
| `repo_bash` | `command`, optional timeout | capped stdout/stderr and exit status |

Write/edit/multi-edit are real edits in the chat clone. Claude Code uses its
native `Edit` and `Write` tools instead of these fallback aliases. There is no
propose-patch or diff-card intermediate. `repo_bash` is represented in policy
even when a headless deployment keeps it at `ask` or `deny`.

### Sessions and graph artifacts

| Tool | Catalog mapping |
| --- | --- |
| `session_transcript` | `execution.transcript` |
| `session_tail` | bounded newest window of `execution.transcript` |
| `session_followup` | `messages.post` anchored to the work session |
| `session_stop` | `execution.terminate` |
| `doc_create` | `entities.create(kind=doc)` |
| `doc_update` | `entities.patch` with an expected version |
| `artifact_create` | `artifacts.create` |
| `memory_write` | `entities.create(kind=memory)` |
| `memory_search` | bounded Space memory query plus local text ranking |
| `git_branch`, `git_status`, `git_diff` | thread checkout or `execution.git*` for a named worker |
| `git_pr` | PR entities connected to the work session / checkout branch |

`session_followup` deliberately uses the public durable-message composite; it
does not expose the Server-internal `execution.prompt` transport.

### Web

`web_fetch` accepts one HTTP(S) URL and returns extracted, capped text with the
final URL and content type. It refuses credentials in URLs, non-HTTP schemes,
loopback, link-local, private, carrier-grade NAT, benchmarking and documentation
destinations before connecting. It revalidates redirects and pins the validated
DNS address for the request to prevent rebinding.

`web_search` accepts a query and bounded result count and returns title, URL and
snippet. Search provider configuration is Server-owned. A missing provider is
a named unavailable result, not a silent empty list.

## Mode matrix

`allow`, `ask`, and `deny` are first-class policy values. Headless chat has no
safe modal approval channel, so `ask` fails closed with
`permission_required`; the assistant must ask the human to choose a mode or a
deployment-specific approval path. `deny` is never overridable by the model.

| Tool family | Ask | Plan | Build | Orchestrate |
| --- | --- | --- | --- | --- |
| Graph/entity reads | allow | allow | allow | allow |
| Native repository read (`Read/Glob/Grep`, read-only `Bash`) | allow | allow | allow | deny |
| Native `WebFetch/WebSearch` | allow | allow | allow | deny |
| Native session scratchpad (`TodoWrite`) | deny | allow | allow | deny |
| Session transcript/tail | allow | allow | allow | allow |
| Git/PR reads | allow | allow | allow | allow |
| Docs/artifact writes | deny | allow | allow | deny |
| Memory write | deny | deny | allow | deny |
| Graph messages/task mutations | deny | deny | allow | allow |
| Delegate/follow-up/stop | deny | deny | allow | allow |
| Native `Edit/Write` | deny | deny | allow | deny |
| Mutating/exec `Bash` | deny | deny | ask (fails closed headlessly) | deny |

Ask is the default and has zero mutation paths. Plan's system prompt requires
its final durable document to end with an explicit **Approve -> dispatch**
handoff. Build authorizes direct edits. Orchestrate intentionally has no code
or web tools: it supervises sessions and changes task/message state.

Operation-level gates are required for existing hierarchical groups. For
example, Ask may call `tm8_messages` for `messages.list` but not
`messages.post`; Orchestrate may use task command operations but not arbitrary
entity deletion. A top-level MCP allowlist alone cannot express this.

## Persistence and transcript provenance

Mode is write-once with the thread's teammate/model/runtime binding and is
returned on every thread summary. The composer shows a mode chip next to the
model picker; teammate, model and mode become disabled together after the
first send. Each assistant turn renders the pinned mode in its byline so a
reader can tell what authority applied when the answer was produced.

The launch resolver derives both the mode-specific system prompt and the exact
registered/allowed tool set from the stored mode. A resume re-reads the same
stored value; browser state cannot widen it.

## Permission and audit model

Authorization is the intersection of four independent checks:

1. The current turn sender's server-recorded human claims minted into the
   thread's agent-runtime token. A different sender closes and resumes the hot
   provider process with a newly minted token; a shared thread never borrows
   its configurer's authority.
2. Stored chat mode policy at tool and, where applicable, catalog-operation
   granularity.
3. Existing catalog/RLS authorization for graph, session and project entities.
4. Filesystem/network confinement for local and open-world tools.

A provider allowlist minimizes exposure but does not grant authority. The MCP
router enforces the stored mode even if a provider calls a tool by name.

Tool calls are already stored as append-only `message_parts` before being
published. A database trigger projects every distinct `tool_call` state
(`running`, then `completed` or `error`) into a `chat.tool_called` graph event
containing only thread id, assistant message id, tool name, tool-call id, state
and stored mode. Arguments and outputs are not copied into audit events because
they can contain source, write payloads or secrets; they remain on the
access-controlled transcript part. These events render in the transcript.

## Limits and failure behavior

- Repository paths are relative; NULs, absolute paths, `.git`, symlink
  components and realpath escapes are rejected. Writes use `O_NOFOLLOW`, reject
  hard-linked existing files, and cap file size. Result count and bytes are
  capped and truncation is explicit.
- Writes preflight every target. `repo_multi_edit` performs no writes if any
  target or expected text is invalid and rolls completed writes back if a later
  write fails. This is best-effort process atomicity, not a filesystem
  transaction.
- Commands run with the checkout as `cwd`, a bounded timeout and capped output;
  no shell environment secrets are returned.
- Web follows a small redirect cap, re-validates every destination and pins a
  validated address through connect.
- Claude-native visibility and path rules are a versioned provider contract.
  Adapter argument tests cover the exact flags, and deployment should pin or
  smoke-test the Claude CLI before upgrading it.
- Catalog errors retain their structured code/retryability. Mode and project
  refusals have distinct codes so the UI/model cannot mistake them for empty
  success.

## Delivery order

1. Persist mode in the contract/database and centralize registry/policy.
2. Repo read tools and thread-owned checkout.
3. Session transcript/tail/follow-up/stop.
4. Docs/artifact tools.
5. Web and memory tools.
6. Git/PR reads.
7. Direct repo edits and optional bash.
8. Composer mode chip, sticky thread rendering and end-to-end tests.
