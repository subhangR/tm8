# Remote

Phase 2: reaching a tm8 node that is not on this machine.

| Document | What it is |
|---|---|
| [`REMOTE-END-TO-END-DESIGN.md`](REMOTE-END-TO-END-DESIGN.md) | **The design.** Phase 2 end to end |
| [`PHASE-2-REMOTE-SERVER-INTEGRATION.md`](PHASE-2-REMOTE-SERVER-INTEGRATION.md) | The binding boundary — what integration is actually committed to |
| [`REMOTE-DEEP-REPORT-A.md`](REMOTE-DEEP-REPORT-A.md) | Verified deep report on the remote surface |
| [`REMOTE-DEEP-REPORT-B.md`](REMOTE-DEEP-REPORT-B.md) | Independent verification of Report A, plus extensions |
| [`REMOTE-STATUS-2026-07-29.md`](REMOTE-STATUS-2026-07-29.md) | Status audit as of 2026-07-29 |

Report B verifies Report A. Reading A alone will leave you with claims that B
already corrected.

## Deployment is not designed here

Running a remote node — hosts, deploys, environments — is
[`../ops/`](../ops/). This section is about the protocol and the model.
