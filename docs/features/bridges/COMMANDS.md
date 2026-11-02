# Starting a session from WhatsApp

A linked member can start a fresh session for the group with `/new session`.
The bridge moves to that session after a successful spawn. The previous session
and the group's history remain intact. Subsequent messages, `/work`, and `/new`
use the selected teammate.

```text
/new session
/new session teammate:"WhatsApp Bridge Engineer" model:gpt-6.1-sol effort:xhigh
/new session provider:openai model:gpt-6.1-sol
/new session effort:high
/new model:gpt-6.1-sol
```

`teammate:`, `provider:`, `model:`, and `effort:` are independently optional and
may appear in any order on the command line. Quote multiword values with single
or double quotes; escape a matching quote or backslash with `\`. Keys and
provider/effort values ignore case; model identifiers retain their catalog spelling.
`/help new` shows examples.

| Omitted choice | Resolution |
| --- | --- |
| Teammate | The bridge's teammate, then the target chat/session's teammate, then the managed-session fallback. An explicit name must match a visible teammate in this space; an exact name wins over partial matches, and ambiguous matches are refused. |
| Model and provider | The selected teammate's ordinary execution model/tool defaults. If no model is configured, execution's native `sonnet` fallback applies. The previous session's per-launch overrides are not inherited. |
| Provider, with a model supplied | Inferred from `LAUNCH_MODEL_CATALOG`, along with its execution tool. For example, `gpt-6.1-sol` selects `openai` and `codex`; `kimi-k3` selects `moonshot` and `claude-code`. |
| Model, with a provider supplied | Keep the teammate's model if it belongs to that provider; otherwise use the first offering for that vendor in `LAUNCH_MODEL_CATALOG`. |
| Effort | Leave it unpinned (`default`) for the execution tool/provider to resolve. No effort is copied from the old session. |

`provider:` means the model-serving vendor (`openai`, `anthropic`, `moonshot`,
`groq`), independently of the WhatsApp transport and the `codex`/`claude-code`
execution tools. It is unnecessary when selecting a model. Explicit models must
come from the authoritative launch catalog; WhatsApp does not see browser-local
custom model additions. A custom model already configured on a teammate remains
its ordinary default, but an explicit effort requires known support. Execution's
native `sonnet` fallback accepts the authoritative Claude Code effort values.

Effort is validated against the selected model's catalog entry, including
`medium`, `xhigh`, and `ultra` where supported. Kimi and other fixed-effort models
refuse `effort:`. `gpt-6-astra` accepts `ultra`; `gpt-6.1-sol` does not. Changing
provider/model starts with unpinned effort unless the command supplies one.

Bare `/new` preserves its existing behavior: a session target gets a new session,
and a chat target explains how to start a chat in tm8. `/new` with any launch
option explicitly requests a session, including on a chat bridge. `/new chat`
always gives tm8's New chat guidance; it refuses session options. Channel bridges
refuse session replacement.

Unknown/duplicate options, empty values, broken quotes, free text/body lines,
unknown models/providers, and incompatible effort are refused before saving a
launch plan, spawning, or retargeting. `/new` option values are parsed literally;
trailing punctuation or polite words are not silently removed. The linked
member's current space membership and teammate visibility apply.

A validated command saves its launch selection under the inbound message ID.
Retries use that selection and the same spawn mutation ID, including its original
bridge/message/member provenance. A failed spawn or retarget leaves the target
and teammate unchanged. Retargeting and updating the bridge's teammate happen in
one transaction after a successful spawn; an admitted receipt whose boot failed
cannot retarget the group. A transient retarget failure retries the
same session; a completed redelivery cannot undo a later `/new`. If another
command moves the bridge before retarget succeeds, the pending command refuses to
replace that newer target. A successfully spawned session may remain unattached
in that case; it is not silently terminated.
