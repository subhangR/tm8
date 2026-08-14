# Chat agent modes and full tool surface

Status: accepted implementation design  
Task: `01a00206-631f-70f8-b300-78eb9d84111a`

## Decision summary

Chat gets a thread-owned project checkout. It does not proxy repository reads
through a long-lived worker session.

For a configured chat thread, the Server resolves the Space's linked
`ProjectResource`; the model never supplies an absolute root. A Git project is
materialized once as a worktree below the Server-owned chat thread directory.
Every repository tool resolves a relative path against that root, follows no
escaping symlink, and applies byte/result caps. The same checkout persists for
the thread: Ask and Plan can read it and Build can edit it. Mode is sticky, so
the checkout's authority does not change underneath an existing conversation.

If the Space has no linked project, or more than one and no project can be
resolved unambiguously, repository tools return a named unavailable result.
They never fall back to the Server process working directory. A linked resource
that is not a Git checkout returns a named provisioning conflict; direct reads
and edits both require the isolated Git worktree.

Why this path:

- A worker proxy adds cold-start latency to every code question and recreates
  the lifecycle dependency this feature is intended to remove.
- A chat-owned checkout gives stable paths, a stable branch and direct
  read-after-write behavior without sharing a worker's mutable terminal.
- Server resolution preserves the existing `space_projects` authorization
  boundary. Path confinement is an execution concern, not an instruction the
  model is trusted to remember.

## Registry and schemas

The MCP registry is one source of truth. Every entry has a stable name, JSON
schema, safety annotations, execution adapter and per-mode permission. The
router checks the mode again on every call; provider registration/allowlists
are only an outer minimization layer, never the authority.

### Repository

| Tool | Input | Result |
| --- | --- | --- |
| `repo_read_file` | `path`, optional `offset`, `limit` | UTF-8 text, line/byte counts, truncation |
| `repo_glob` | `pattern`, optional `limit` | sorted project-relative paths, truncation |
| `repo_grep` | `query`, optional `glob`, `limit` | path/line/column/text matches, truncation |
| `repo_write` | `path`, `content` | changed flag and byte count |
| `repo_edit` | `path`, `oldText`, `newText`, optional `replaceAll` | replacement count |
| `repo_multi_edit` | ordered edits using the `repo_edit` shape | atomic preflight, per-file counts |
| `repo_bash` | `command`, optional timeout | capped stdout/stderr and exit status |

Write/edit/multi-edit are real edits in the chat worktree. There is no
propose-patch or diff-card intermediate. `repo_bash` is represented in policy
even when a deployment keeps it at `ask` or `deny`.

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
loopback, link-local and private destinations before connecting.

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
| Repository read (`read/glob/grep`) | allow | allow | allow | deny |
| Web fetch/search | allow | allow | allow | deny |
| Session transcript/tail | allow | allow | allow | allow |
| Git/PR reads | allow | allow | allow | allow |
| Docs/artifact writes | deny | allow | allow | deny |
| Scratchpad | deny | allow | allow | deny |
| Memory write | deny | deny | allow | deny |
| Graph messages/task mutations | deny | deny | allow | allow |
| Delegate/follow-up/stop | deny | deny | allow | allow |
| Repository write/edit/multi-edit | deny | deny | allow | deny |
| Repository bash | deny | deny | ask by default | deny |

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

1. Human/requester graph claims minted into the thread's agent-runtime token.
2. Stored chat mode policy at tool and, where applicable, catalog-operation
   granularity.
3. Existing catalog/RLS authorization for graph, session and project entities.
4. Filesystem/network confinement for local and open-world tools.

A provider allowlist minimizes exposure but does not grant authority. The MCP
router enforces the stored mode even if a provider calls a tool by name.

Tool calls are already stored as append-only `message_parts` before being
published. A database trigger projects every `tool_call` part into an
`activity.created` graph event containing only thread id, assistant message id,
tool name, tool-call id, state and stored mode. Arguments and outputs are not
copied into audit events because they can contain source, write payloads or
secrets; they remain on the access-controlled transcript part.

## Limits and failure behavior

- Repository paths are relative; NULs, absolute paths and realpath escapes are
  rejected. Result count and bytes are capped and truncation is explicit.
- Writes preflight every target. `repo_multi_edit` performs no writes if any
  target or expected text is invalid.
- Commands run with the checkout as `cwd`, a bounded timeout and capped output;
  no shell environment secrets are returned.
- Web follows a small redirect cap and re-validates every destination.
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
