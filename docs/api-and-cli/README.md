# API and CLI

The operation catalog is the API. The CLI is a grammar over the same catalog — it
adds no operations of its own.

| Document | What it is |
|---|---|
| [`API-CATALOG-GROUPED-GUIDE.md`](API-CATALOG-GROUPED-GUIDE.md) | **Start here.** Every catalog operation, grouped and explained in prose |
| [`CLI-GRAMMAR-REDESIGN.md`](CLI-GRAMMAR-REDESIGN.md) | The noun–verb grammar the CLI exposes, and why it is shaped that way |
| [`CLI-SESSION-COMMAND-JOURNAL.md`](CLI-SESSION-COMMAND-JOURNAL.md) | The command journal: what a session's CLI calls record, and how to read them back |

## The catalog is not here

These documents *describe* the catalog; they do not define it.
`packages/contract` defines it. When they disagree, the contract wins.

The machine-readable evidence lives at
`tools/conformance/generated/w1-conformance-manifest.json`, which is regenerated
from the contract and **checked byte-for-byte** by
`tools/conformance/test/foundation/w1-foundations.test.ts`. Editing it by hand
fails that gate.

## Related

- Agent-facing discovery (`tm8 help --format json`) is designed in
  [`../harness/AGENT-HARNESS-AND-COMMAND-DISCOVERY.md`](../harness/AGENT-HARNESS-AND-COMMAND-DISCOVERY.md).
- Adding an operation touches far more than one file — the count is pinned by
  frozen assertions in roughly a dozen test files.
