# Bridges

A **bridge** binds one conversation on another network — a WhatsApp group, a
Slack channel, an Instagram inbox — to one tm8 **chat**, **work session** or
**channel**, as a first-class entity. It is Phase 2 of the WhatsApp bridge that
runs today from `integrations/whatsapp-bridge` on a `config.json`.

| Document | What it decides |
|---|---|
| [`BRIDGE-ENTITY-DESIGN.md`](BRIDGE-ENTITY-DESIGN.md) | The `bridge` kind: nouns, target semantics, the message model, people and identity links, connections and the connector runtime, contract, UI, providers, security, migration and phasing; all its open questions settled (D14–D19); one connection per group (D20); workers read and post on the bridge freely (D21, §2.7); an inherited provenance edge on everything a bridge causes, which group commands read (D22, §2.8); subagents and multi-agent workflows out of scope for now (§7.4); v4 (FINAL) adds D23–D30 — space-wide access, fix notice, one chat per bridge, loops, labels, connected groups only, agile work, cross-group provenance — and the one build order (§7.2) |
| [`BRIDGES-V2-DESIGN.md`](BRIDGES-V2-DESIGN.md) | The v2 companion: UI gaps, memories on a bridge, loops as scheduled teammates, today's WhatsApp commands and their server-side redesign (`/work`) |

Where the Phase-1 bridge is documented: `integrations/whatsapp-bridge/README.md`
and `OPERATIONS.md` (how it runs today), and the Phase-1 design of 2026-10-19
that the design above cites. A rendered one-page version of the design, with
diagrams and UI mockups, is published as a tm8 artifact of the same name.

Status is not recorded here (see `../README.md`): check the tree.
