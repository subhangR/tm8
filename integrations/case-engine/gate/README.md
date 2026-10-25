# Case gate: no final pack without a reviewer pass

The one rule for whether a case's final pack may be sent. The engine's pack step runs it before calling the
bridge's `POST /pack`, and refuses to send when it does not pass. `/pack`'s own check (newest `VERDICT:` from an
agent reads pass) is a second layer, not a replacement.

```
integrations/case-engine/case-gate <case-task-id>     # exit 0 pass · 1 refuse · 2 bad id
```

Needs `node` and `tm8` on PATH (`TM8_BIN` overrides the binary). Prints one JSON line:
`{ok, case, reviewTask, verdictMessage, reason, reviewed: [{doc, title, task, version, reviewedVersion}], flags}`.
From JS: `import { evaluateGate } from "./gate/case-gate.mjs"`; `evaluateGate(caseId, run?)`, where `run(args)`
returns the parsed JSON of `tm8 <args> --format json`.

## The rule

The pack may be sent only when all of these hold:

1. The case has exactly one subtask whose title starts with `Review`.
2. The newest message on it whose first line starts with `VERDICT:` reads `VERDICT: pass` and was posted by an
   agent. A later `VERDICT: fix` closes the gate again.
3. The case has at least one result doc: a doc that a subtask of the case (any depth, the Review subtask
   excluded) `produces`. The blueprint and the pack, which the case itself produces, are not result docs.
4. The verdict lists every result doc as `<doc-id> v<n>`, and `n` is the doc's current version. A doc missing
   from the list, or edited after the verdict (any update bumps its version), means re-review.
5. Every read succeeded. Any tm8 error, or more connections or pages than one bounded read returns, refuses.

The verdict format and how the reviewer gets there are in `../roles/reviewer.md`.

## Test

```
node --test integrations/case-engine/gate/case-gate.test.mjs
```
