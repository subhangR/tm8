| Item | Groomed decision |
|---|---|
| User outcome | From the Space “+” control, create a Space and connect one node-local project folder without leaving the product UI. |
| Product surface | `packages/tm8-ui`, the staging product UI (`deploy/staging/run-ui.sh:2-16`), not the legacy `packages/ui` app. |
| Scope | Space creation, node-local directory browsing/creation, project creation and Space linking, plus one durable memory recording the configured binding. |
| Out of scope | File mirroring, offline replay, Git synchronization, conflict resolution, and changing a project after onboarding. Those belong to the separate offline-folder-sync task. |
| Safety | Directory browsing is node-side and root-confined; project trust is an explicit checkbox and defaults to untrusted. |
| Completion | The flow is contract-backed, server-authorized, retry-safe, visible in the real UI, and covered by contract/server/UI tests. |

Grooming
--------

The live Space bar already reserves an Add Space affordance, but it is deliberately disabled because the seam has no create operation (`packages/tm8-ui/src/shell/SpaceTabBar.tsx:44-50`, `packages/tm8-ui/src/shell/SpaceTabBar.tsx:93-105`). The real seam can list linked projects only (`packages/tm8-ui/src/data/real/ops.ts:201-203`), while the contract and server already support creating a project with an absolute `workingDir` and linking it many-to-many to a Space (`packages/contract/src/contract.ts:1322-1366`, `packages/server/src/facade/services/w2/projects-associations.ts:342-359`).

tm8 has no desktop shell; it is a server plus browser UI (`README.md:15-19`). A browser-native directory picker does not reveal a usable absolute path to the server, so “browse local folder” means browsing the selected tm8 node’s filesystem through an authenticated, bounded server read. It does not mean uploading browser files.

| Acceptance criterion | Evidence required |
|---|---|
| The Space “+” control and the zero-Spaces state open the same onboarding dialog. | UI interaction test. |
| The dialog collects Space name, project name, and a node-local directory. | UI form test. |
| “Browse folders” navigates directories returned by the selected tm8 node, never browser-invented paths. | Contract + server + UI test. |
| The viewer can select an existing directory or name one new child directory to create. | Server filesystem test and UI interaction test. |
| Submit creates the Space, creates the project, links it to the Space, and creates a memory describing the configured path. | Ordered-port UI test; server project test. |
| Project trust is explicit and defaults to untrusted. | UI test and contract assertion. |
| A retry reuses mutation ids, so a partial saga does not duplicate durable records. | Orchestration unit test. |
| Failures identify the stage that failed and retain the entered values. | UI failure test. |

Design
------

| Layer | Change | Reason |
|---|---|---|
| Contract | Add a `projects.directories.list` read returning allowed roots, the canonical current path, parent path, and child directories. Add `ensureWorkingDir` to project creation. | The operation catalog is the route law; the server must not accept an undocumented filesystem read. |
| Server | Resolve browse roots from `TM8_PROJECT_ROOTS` (platform-delimited), defaulting to the server account’s home directory. Canonicalize existing paths, reject paths outside every root, list directories only, cap the response, and create only one missing child under a canonical allowed parent. | Prevent traversal and symlink escape while supporting both existing-folder selection and local folder creation. |
| Seam | Expose the new directory read plus Space/project create/link commands on the real seam. | The product UI uses one typed transport seam; components do not assemble URLs. |
| UI | Add one modal from the Space bar. The folder browser is an in-modal screen with root buttons, parent navigation, and child rows. | Keeps the workflow anchored to the control the user clicked and makes node locality explicit. |
| Saga | Use stable mutation ids for `spaces.create`, `projects.create`, `projects.link`, and `entities.create(memory)`. Retry from the first step with the same ids. | Existing command ledgers make a multi-operation UI flow safely resumable without a cross-resource transaction. |
| Memory | Record the Space id/name, project id/name and configured path; state that the record does not establish file synchronization or commit state. | The memory is durable and truthful, using the existing memory lifecycle (`packages/server/src/facade/services/w2/entities-commands-tracking.ts:1037-1047`). |

The directory may be created before the project database row. If the database command then fails, the empty directory is retained: deleting node-local user data during compensation would be more dangerous than leaving a retryable empty folder. A retry sees the same directory and reuses the same project mutation id.

The onboarding saga is deliberately not presented as atomic. The dialog reports the failed stage, retains the form and mutation ids, and retries idempotently. On full success it adds the returned Space to the tab bar and selects it, which reuses the existing Space-open hydration path (`packages/tm8-ui/src/views/useGateData.ts:683-759`).
