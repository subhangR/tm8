# Harness

How an agent session is composed: what prompt it boots with, what it is allowed to
discover, and what it can orchestrate.

| Document | What it is |
|---|---|
| [`HARNESS-ARCHITECTURE-EXPLAINED.md`](HARNESS-ARCHITECTURE-EXPLAINED.md) | **Start here.** The harness in plain words, short |
| [`AGENT-HARNESS-AND-COMMAND-DISCOVERY.md`](AGENT-HARNESS-AND-COMMAND-DISCOVERY.md) | The full design: semantic command discovery, how an agent learns the grammar at runtime |
| [`AGENT-JOURNEY-WALKTHROUGH.md`](AGENT-JOURNEY-WALKTHROUGH.md) | One agent's session narrated end to end against the planned harness |
| [`HARNESS-FLAVORS-AND-ORCHESTRATION-PLAN.md`](HARNESS-FLAVORS-AND-ORCHESTRATION-PLAN.md) | Harness flavors and the orchestration plan built on them |
| [`RUNTIME-CONFIG-TEMPLATES-AND-MODEL-TIERS.md`](RUNTIME-CONFIG-TEMPLATES-AND-MODEL-TIERS.md) | Template block vocabulary, runtime config vs. team member, model tiers |
| [`PROMPT-REFERENCE.md`](PROMPT-REFERENCE.md) | The prompt catalog — every prompt the system can emit, in one place |
| [`SESSION-SURFACE-ENGINEER-PROMPT.md`](SESSION-SURFACE-ENGINEER-PROMPT.md) | A worked persona, kept as an example of the shape a teammate prompt takes |

## [`reviews/`](reviews/)

The harness plan was reviewed by three models and then reconciled. Read the
consensus first; the individual reviews are the arguments behind it.

| Document | Reviewer |
|---|---|
| [`reviews/HARNESS-PLAN-CONSENSUS.md`](reviews/HARNESS-PLAN-CONSENSUS.md) | **The reconciled record** |
| [`reviews/HARNESS-PLAN-FINAL-REVIEW-opus-5.md`](reviews/HARNESS-PLAN-FINAL-REVIEW-opus-5.md) | Opus 5, adversarial |
| [`reviews/HARNESS-REVIEW-sonnet-5.md`](reviews/HARNESS-REVIEW-sonnet-5.md) | Sonnet 5, as a consumer |
| [`reviews/HARNESS-REVIEW-haiku-4.5.md`](reviews/HARNESS-REVIEW-haiku-4.5.md) | Haiku 4.5, as a consumer |

## Note

A persona is a **mission**, not a job title. A teammate's identity is the brief
injected as its system prompt — selecting one by role name generally hands the
agent someone else's problem.
