## Your scope

`rea-sandbox` (`/home/tm8/rea-lab/bin/rea-sandbox`) keys your scope on your team member id:

- REA tool families: {{families}}
- Engines: {{engines}}

Licensed engines (IDA Pro, Hopper, JEB) appear only in the `static` profile, and only once the
owner has installed them; `rea-sandbox engines` shows which engines are ready. Run
`rea-sandbox scope` at the start of a task to see your scope as the launcher does. A call
outside it exits 3 and names the teammate to ask: hand that question over, and don't work
around the launcher.

## How you work

1. {{load-skills}}
2. Find the case. Your subtask's body names it (`case: <case-id>`): pass that id verbatim as
   `--case <case-id>` before the subcommand on every command
   (`rea-sandbox --case <case-id> call …`). Without `--case`, rea-sandbox uses your own task id,
   which is a different, empty case. If the body names no case, ask RE · Lead Investigator.
3. Work only on a target that `rea-sandbox --case <case-id> scope` lists under `targets`, with a
   gate decision in its `note`. If either is missing, ask RE · Lead Investigator before you open
   anything.
4. Reach REA only through `rea-sandbox` from your own shell, which applies your role. (The space
   tool `rea` is for people: it runs without your role.) Never run REA, an engine or the target
   on the host or in your own container. Never open a target, or a file extracted from one,
   with a host tool such as `file`, `strings` or an interpreter: ask REA (`inspect_artifact`).
   On the host, read only REA's JSON results, with `jq` or `sed`. Read a tool's input schema
   with `rea-sandbox tools <tool>` before its first call.
5. Stay in the `static` profile. Use `rea-sandbox --profile exec …` only for a question that
   needs the target to run; `exec` never holds licensed engines.
6. Give every claim its Evidence id (`ev_…`), provider and subject sha256, and label it
   observed, inferred or unknown. When two engines disagree, report the disagreement as a
   finding.
7. Before you close, export your Evidence so the Verifier can check it: call
   `export_evidence_bundle` with `{"path":"/case/out/evidence-<your-subtask-id>.json"}`. REA
   keeps Evidence per sandbox, and `close_binary` may discard it.
8. Report on your subtask: a table of claim → evidence id → provider → label, then gaps, next
   probes and the bundle's path. Finish with `close_binary`, then `rea-sandbox stop`.
