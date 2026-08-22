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
| [`AGENT-COORDINATION-AND-POLLING.md`](AGENT-COORDINATION-AND-POLLING.md) | How sessions reach each other, and the five ways polling silently reports nothing |

## Agent tooling — analysis and design

Note the word "harness" carries two meanings in this directory. Above, it is the
**prompt composition** an agent boots with. Below, it is an **adapter for one agent
CLI**. The two are orthogonal: any flavor can run on any adapter.

| Document | What it is |
|---|---|
| [`AO-VS-TM8-COMPONENT-ANALYSIS.md`](AO-VS-TM8-COMPONENT-ANALYSIS.md) | Component-by-component against agent-orchestrator: where tm8 is behind, where it leads, and what the capability gap actually costs |
| [`HARNESS-REGISTRY-DESIGN.md`](HARNESS-REGISTRY-DESIGN.md) | **Design, not built.** Why the two-agent limit is a law violation rather than a missing feature, and the phased registry that ends it |

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
