# tm8 W0 Consistency Matrices

**Status:** Vega-adopted W0 design freeze, 2026-07-26  
**Interpretation:** `S` = shipped source/migration fact; `A` = adopted amendment, not implemented; `R` = reserved/honest 501; `N` = mounted but no semantic handler; `F` = shipped facade handler; `X` = shipped execution handler; `E` = shipped events-poll handler; `WS` = WebSocket skeleton.  
**Authority:** complements `TM8-W0-AMENDMENT-DOSSIER.md`; differences are defects, not discretionary implementation choices.

## 1. Count reconciliation

| Measure | Exact value | Evidence/meaning |
|---|---:|---|
| Frozen catalog | 81 | 79 v1 + 2 reserved |
| Mounted HTTP | 80 | All non-WS catalog rows have router bindings, including two reserved routes |
| WebSocket | 1 | `events.subscribe`; upgrade skeleton, not semantic subscription delivery |
| Registerable HTTP handler ceiling | 78 | 81 − 1 WS − 2 reserved; registry refuses reserved rows |
| Wired semantic HTTP handlers | 28 | 23 facade + 4 execution + 1 event poll, only with configured database |
| Input schema bindings | 36 | Current `INPUT_SCHEMAS` entries |
| Explicit unbound commands | 13 | Frozen command rows deliberately lacking an input-schema binding |
| Product migration tables | 43 | Case-insensitive `create table` statements in migrations 001–006 |
| Physical bookkeeping table | 1 | `applied_migrations`; not part of the 43 product-table claim |
| Shipped core kinds | 13 | Seed/contract baseline |
| Adopted additive operations | 20 | A01–A20 in the dossier; target catalog becomes 101 only after W1 contract change |

## 2. Kind × route × projection × capability × menu × migration

| Kind/status | Route strategy | Projection | Capability disposition | Menu | Migration disposition |
|---|---|---|---|---|---|
| `channel` S | special `channel/{id}`; companion `channels` | S universal + `channels` detail | S generic; message anchor | A Channels default view | S seed/detail |
| `task` S | collection `k/tasks` | S universal + `tasks` | S generic + owner lifecycle | A Workspace child/default | S seed/detail |
| `message` S | anchored channel/thread; tombstone `e/{id}`; never `k/` | S universal + `messages`; one-store Chat/Discussion | create via `messages.post`; attachment edges owned; hierarchy off | not addressable as a menu kind | S seed/detail; A batch/source/parent columns |
| `member` S | collection `k/members` | S universal + `members` | S generic, identity/role guarded | A Members default | S seed + identity detail |
| `team_member` S | collection `k/teammates` | S universal + `team_members` | S generic; A profile-default/participant guards | A Workspace child/default | S seed/detail; A relations |
| `doc` S | collection `k/docs` | S universal + `documents` | S generic | A Workspace child/default | S seed/detail |
| `file` S | collection `k/files` | S universal + `files` | S generic; blob lifecycle guarded | registered, not default | S seed/detail |
| `spell` S | collection `k/spells` | S universal + `spells` | S generic | registered, not default | S seed/detail |
| `skill` S | collection `k/skills` | S universal + `skills` | S generic | registered, not default | S seed/detail |
| `pull_request` S | collection `k/pulls` | S universal + `pull_requests` | S generic; project link command | A Tracking/default | S seed/detail |
| `commit` S | collection `k/commits` | S universal + `commits` | S generic; project link command | registered, not default | S seed/detail |
| `work_session` S | collection `k/sessions`; Workspace panel Terminal/Chat | S universal + `work_sessions`; create execution-only | S generic reads; execution lifecycle; Terminal drive separate | A Workspace child/default | S seed/detail; A M:N/profile/feed/delivery |
| `collection` S | collection `k/collections` | S universal + `collections` | S generic | registered, not default | S seed/detail |
| `c:{name}` S framework | collision-checked collection `k/c-{name}` | S universal + `custom_entities` | S generic scalar-only | not default; config-addable | S custom registry/detail |
| `project` A | collection `k/projects`, restricted projection | A materialized universal/project detail; sanitized settings | hierarchy/edit/delete/points off; messages/reactions/connections on | A Tracking/default | A second-domain kind row, links/detail/materializer |
| `interaction_profile` A | collection `k/interaction-profiles`, restricted lifecycle | A universal + profile detail; sanitized handoff; immutable pin | generic create/edit/delete/move/hierarchy/points off; named lifecycle only | registered, not default | A separate kind row + versions/pins/preferences |
| `ui_template` non-entity | no entity route | static typed registry asset | bindings narrow only; never grant | not a kind/menu ref | no entity/table/API/CLI noun |

Exhaustiveness law: the first 13 rows equal the shipped core-kind union; `c:{name}` covers registered custom kinds; W1 adds exactly the two adopted core rows. `ui_template` is included as a negative sentinel so it cannot accidentally enter the entity registry.

## 3. Operation × DTO × binding × handler × CLI × tests

Test abbreviations: `CR` contract/router shape and honest-501 baseline; `FI` facade integration; `XT` execution service/PTY; `EP` event poll; `WT` WS skeleton; `W0-*` adopted dossier conformance IDs. `—` means no request body. CLI values after `→` are adopted target grammar; `legacy` identifies the tiny shipped CLI.

| # | Operation | DTO/input | Binding | Handler | CLI disposition | Tests |
|---:|---|---|---|---|---|---|
| 1 | `identity.get` | — | `GET /v2/identity` | F | legacy `whoami` → `identity get` | CR,FI |
| 2 | `spaces.list` | — | `GET /v2/spaces` | F | `space list` | CR,FI |
| 3 | `spaces.create` | `CreateSpaceInput` | `POST /v2/spaces` | F | `space create` | CR,FI |
| 4 | `spaces.get` | — | `GET /v2/spaces/:spaceId` | F | `space get` | CR,FI |
| 5 | `spaces.update` | `UpdateSpaceInput` | `PATCH /v2/spaces/:spaceId` | N | `space update` | CR |
| 6 | `spaces.navigation` | — | `GET /v2/spaces/:spaceId/navigation` | F | `space navigation get` | CR,FI |
| 7 | `spaces.home` | — | `GET /v2/spaces/:spaceId/home` | F | `space home get` | CR,FI |
| 8 | `spaces.settings` | — | `GET /v2/spaces/:spaceId/settings` | N | `space settings get` | CR |
| 9 | `spaces.members.list` | — | `GET /v2/spaces/:spaceId/members` | N | `space member list` | CR |
| 10 | `spaces.invites.list` | — | `GET /v2/spaces/:spaceId/invites` | N | `space invite list` | CR |
| 11 | `spaces.invites.create` | unbound | `POST /v2/spaces/:spaceId/invites` | N | `space invite create` | CR |
| 12 | `spaces.invites.revoke` | unbound | `POST /v2/spaces/:spaceId/invites/:inviteId/revoke` | N | `space invite revoke` | CR |
| 13 | `spaces.invites.redeem` | unbound | `POST /v2/invites/redeem` | N | `space invite redeem` | CR |
| 14 | `spaces.taskAxes.list` | — | `GET /v2/spaces/:spaceId/task-axes` | N | `space task-axis list` | CR |
| 15 | `spaces.taskAxes.create` | `TaskAxisInput` | `POST /v2/spaces/:spaceId/task-axes` | N | `space task-axis create` | CR |
| 16 | `spaces.taskAxes.update` | `TaskAxisInput` | `PATCH /v2/spaces/:spaceId/task-axes/:axisId` | N | `space task-axis update` | CR |
| 17 | `spaces.taskAxes.delete` | unbound | `DELETE /v2/spaces/:spaceId/task-axes/:axisId` | N | `space task-axis delete` | CR |
| 18 | `spaces.leaderboard` | — | `GET /v2/spaces/:spaceId/leaderboard` | N | `space leaderboard get` | CR |
| 19 | `spaces.awards` | — | `GET /v2/spaces/:spaceId/awards` | N | `space award list` | CR |
| 20 | `entities.get` | — | `GET /v2/entities/:id` | F | legacy task/session report reads → `entity get` | CR,FI |
| 21 | `entities.create` | `CreateEntityInput` A initial connections | `POST /v2/entities` | F | `entity create` | CR,FI,W0-CONN |
| 22 | `entities.patch` | `PatchEntityInput` | `PATCH /v2/entities/:id` | F | `entity update` | CR,FI |
| 23 | `entities.move` | `MoveEntityInput` | `POST /v2/entities/:id/move` | N | `entity move` | CR |
| 24 | `entities.delete` | unbound | `DELETE /v2/entities/:id` | N | `entity delete` | CR |
| 25 | `entities.restore` | unbound | `POST /v2/entities/:id/restore` | N | `entity restore` | CR |
| 26 | `entities.children` | — | `GET /v2/entities/:id/children` | F | `entity children` | CR,FI |
| 27 | `entities.hierarchy` | — | `GET /v2/entities/:id/hierarchy` | N | `entity hierarchy` | CR |
| 28 | `entities.connections` | A flat query | `GET /v2/entities/:id/connections` | N | `entity connections` | CR,W0-CURSOR |
| 29 | `entities.versions` | — | `GET /v2/entities/:id/versions` | N | `entity versions` | CR |
| 30 | `entities.activity` | — | `GET /v2/entities/:id/activity` | F | `entity activity` | CR,FI |
| 31 | `entities.react` | `ReactionInput` | `PUT /v2/entities/:id/reaction` | N | `entity react` | CR |
| 32 | `entities.points.add` | `GrantPointsInput` | `POST /v2/entities/:id/points` | F | `entity point grant` | CR,FI |
| 33 | `entities.commands.complete` | `CompleteTaskInput` | `POST /v2/entities/:id/commands/complete` | F | legacy `task report complete` → `task complete` | CR,FI |
| 34 | `entities.commands.work` | `WorkInput` | `POST /v2/entities/:id/commands/work` | F | legacy blocked report → `task transition` | CR,FI |
| 35 | `entities.commands.pull` | `PullInput` | `POST /v2/entities/:id/commands/pull` | N | `entity pull` | CR |
| 36 | `entities.commands.linkPr` | `LinkPrInput` A `projectId?` | `POST /v2/entities/:id/commands/link-pr` | N | `task link-pr --project` | CR,W0-PROJ |
| 37 | `entities.commands.linkCommit` | `LinkCommitInput` A `projectId?` | `POST /v2/entities/:id/commands/link-commit` | N | `task link-commit --project` | CR,W0-PROJ |
| 38 | `tracking.refresh` | `TrackingRefreshInput` | `POST /v2/tracking/refresh` | N | `tracking refresh` | CR |
| 39 | `edges.list` | — | `GET /v2/edges` | N | `edge list` | CR |
| 40 | `edges.create` | `CreateEdgeInput` | `POST /v2/edges` | F | `edge create` | CR,FI,W0-PROJ |
| 41 | `edges.patch` | `PatchEdgeInput` | `PATCH /v2/edges/:edgeId` | N | `edge update` | CR |
| 42 | `edges.delete` | unbound | `DELETE /v2/edges/:edgeId` | N | `edge delete` | CR,W0-OWNED |
| 43 | `edgeTypes.list` | — | `GET /v2/edge-types` | N | `edge type list` | CR |
| 44 | `messages.list` | — | `GET /v2/entities/:anchorId/messages` | F | `message list` | CR,FI,W0-AUTH |
| 45 | `messages.post` | `PostMessageInput` A batch/reply IDs | `POST /v2/messages` | F | `message send`; `message reply` composite | CR,FI,W0-BATCH,W0-B2 |
| 46 | `messages.edit` | `PatchMessageInput` A `expectedVersion` | `PATCH /v2/messages/:id` | N | `message update` | CR,W0-VERSION |
| 47 | `messages.delete` | A `expectedVersion` | `DELETE /v2/messages/:id` | N | `message delete` | CR,W0-VERSION |
| 48 | `collections.query` | `CollectionQuery` | `POST /v2/collections/query` | F | `entity query` | CR,FI |
| 49 | `graph.query` | `GraphQuery` | `POST /v2/graph/query` | N | `graph query` | CR |
| 50 | `placements.apply` | `PlacementInput` | `POST /v2/placements` | N | `placement apply` | CR |
| 51 | `commands.undo` | unbound | `POST /v2/undo` | N | `undo apply` | CR |
| 52 | `search.query` | — | `GET /v2/search` | R | `search query`, honest unavailable | CR,501 |
| 53 | `projects.list` | — | `GET /v2/projects` | F | `project list` | CR,FI |
| 54 | `projects.create` | `ProjectCreateInput` | `POST /v2/projects` | F | `project create` | CR,FI |
| 55 | `projects.get` | — | `GET /v2/projects/:projectId` | F | `project get` | CR,FI |
| 56 | `projects.update` | `ProjectUpdateInput` | `PATCH /v2/projects/:projectId` | F | `project update` | CR,FI |
| 57 | `projects.link` | `ProjectLinkInput` | `POST /v2/spaces/:spaceId/projects` | F | `project link` | CR,FI,W0-PROJ |
| 58 | `projects.unlink` | unbound | `DELETE /v2/spaces/:spaceId/projects/:projectId` | N | `project unlink` | CR,W0-PROJ |
| 59 | `files.uploadInit` | `FileUploadInitInput` | `POST /v2/files/uploads` | N | first stage `file upload` | CR |
| 60 | `files.uploadComplete` | `FileUploadCompleteInput` A targets | `POST /v2/files/uploads/:uploadId/complete` | N | finalize `file upload --attach-to` | CR,W0-OWNED |
| 61 | `files.uploadAbort` | `FileUploadAbortInput` | `POST /v2/files/uploads/:uploadId/abort` | N | `file upload abort` | CR |
| 62 | `files.download` | — | `GET /v2/files/:fileEntityId/download` | N | `file download` | CR |
| 63 | `bridge.fetchBlob` | — | `GET /v2/bridge/blobs/:fileEntityId` | R | no public CLI; internal reserved | CR,501 |
| 64 | `inbox.list` | A recipient query | `GET /v2/inbox` | N | `inbox list [--for]` | CR,W0-INBOX |
| 65 | `inbox.markRead` | unbound A recipient guard | `PUT /v2/inbox/:notificationId/read` | N | `inbox mark-read` | CR,W0-INBOX |
| 66 | `readMarks.upsert` | unbound | `PUT /v2/read-marks/:anchorId` | N | `message mark-read` | CR |
| 67 | `savedViews.list` | — | `GET /v2/spaces/:spaceId/saved-views` | N | `saved-view list` | CR |
| 68 | `savedViews.create` | `SavedViewInput` | `POST /v2/saved-views` | N | `saved-view create` | CR |
| 69 | `savedViews.update` | `SavedViewInput` | `PATCH /v2/saved-views/:viewId` | N | `saved-view update` | CR |
| 70 | `savedViews.delete` | unbound | `DELETE /v2/saved-views/:viewId` | N | `saved-view delete` | CR |
| 71 | `actions.list` | A enriched query/output | `GET /v2/actions` | N | `action list` | CR,W0-ACTIONS |
| 72 | `events.subscribe` | — | `WS /v2/ws` | WS | `event watch`; skeleton status explicit | CR,WT |
| 73 | `events.poll` | — | `GET /v2/spaces/:spaceId/events` | E | `event list`; reconnect stage | CR,EP,W0-EVENT |
| 74 | `presence.get` | — | `GET /v2/entities/:id/presence` | N | `presence get` | CR |
| 75 | `execution.spawn` | `ExecutionSpawnInput` A workdir/trust/profile | `POST /v2/execution/spawn` | X | `session spawn` | CR,XT,W0-SPAWN |
| 76 | `execution.prompt` | `ExecutionPromptInput` unchanged | `POST /v2/entities/:id/commands/prompt` | X, B1 guard A | no CLI; internal exact lookup only | CR,XT,W0-B1 |
| 77 | `execution.terminate` | `ExecutionTerminateInput` | `POST /v2/entities/:id/commands/terminate` | X | `session terminate` | CR,XT |
| 78 | `execution.streams.attach` | `ExecutionStreamsAttachInput` | `POST /v2/entities/:id/commands/streams-attach` | X | `session attach` | CR,XT |
| 79 | `entityKinds.list` | — | `GET /v2/spaces/:spaceId/entity-kinds` | N | `kind list` | CR |
| 80 | `entityKinds.create` | `EntityKindCreateInput` | `POST /v2/spaces/:spaceId/entity-kinds` | N | `kind create` | CR |
| 81 | `entityKinds.update` | `EntityKindUpdateInput` | `PATCH /v2/spaces/:spaceId/entity-kinds/:kind` | N | `kind update` | CR |

### Adopted additive rows A01–A20

All handler cells are `A/N`: adopted exact handler/RPC responsibility, no source implementation. All require generated contract/router/help reachability plus the named W0 suite.

| # | Operation | DTO/input | Binding | Handler/RPC owner | CLI | Tests |
|---:|---|---|---|---|---|---|
| A01 | `spaces.menu.get` | — | `GET /v2/spaces/:spaceId/menu` | Space read/RLS | `space menu get` | W0-MENU |
| A02 | `spaces.menu.update` | `UpdateMenuInput` | `PUT /v2/spaces/:spaceId/menu` | `update_space_menu` | `space menu update` | W0-MENU |
| A03 | `spaces.defaultChannel.set` | `SetDefaultChannelInput` | `PUT /v2/spaces/:spaceId/default-channel` | `set_space_default_channel` | `space default-channel set` | W0-DEFAULT |
| A04 | `projects.associations.correct` | `CorrectProjectAssociationInput` | `POST /v2/entities/:artifactId/commands/correct-project-association` | `correct_project_association` | `project association correct` | W0-PROJ |
| A05 | `handoffs.send` | `SendHandoffInput` | `POST /v2/work-sessions/:workSessionId/handoffs` | `prepare_session_handoff` + worker settle | `handoff send` | W0-HANDOFF |
| A06 | `handoffs.list` | `HandoffListQuery` | `GET /v2/work-sessions/:workSessionId/handoffs` | RLS read | `handoff list` | W0-HANDOFF |
| A07 | `handoffs.withdraw` | `WithdrawHandoffInput` | `POST /v2/handoffs/:handoffId/withdraw` | `withdraw_session_handoff` | `handoff withdraw` | W0-HANDOFF |
| A08 | `messages.attachments.add` | `AddMessageAttachmentsInput` | `POST /v2/messages/:messageId/attachments` | `add_message_attachments` | `message attachment add` | W0-OWNED |
| A09 | `messages.attachments.remove` | `RemoveMessageAttachmentsInput` | `DELETE /v2/messages/:messageId/attachments` | `remove_message_attachments` | `message attachment remove` | W0-OWNED |
| A10 | `messages.delivery.get` | `MessageDeliveryQuery` | `GET /v2/messages/:messageId/delivery` | authorized delivery read | `message delivery` | W0-B1,W0-B2 |
| A11 | `entities.feed` | `EntityFeedQuery` | `GET /v2/entities/:id/feed` | anchor-authorized feed read | `entity feed` | W0-FEED,W0-AUTH |
| A12 | `entities.context` | `EntityContextQuery` | `GET /v2/entities/:id/context` | bounded aggregate read | `entity context` | W0-CONTEXT |
| A13 | `interactionProfiles.propose` | `ProposeInteractionProfileInput` | `POST /v2/spaces/:spaceId/interaction-profiles` | `propose_interaction_profile` | `interaction-profile propose` | W0-PROFILE |
| A14 | `interactionProfiles.updateDraft` | `UpdateInteractionProfileDraftInput` | `PATCH /v2/interaction-profiles/:profileId/draft` | `update_interaction_profile_draft` | `interaction-profile update` | W0-PROFILE |
| A15 | `interactionProfiles.validate` | `ValidateInteractionProfileInput` | `POST /v2/interaction-profiles/:profileId/validate` | `validate_interaction_profile` | `interaction-profile validate` | W0-PROFILE |
| A16 | `interactionProfiles.preview` | `PreviewInteractionProfileInput` | `POST /v2/interaction-profiles/:profileId/preview` read | sanitized preview query | `interaction-profile preview` | W0-PROFILE |
| A17 | `interactionProfiles.activate` | `ActivateInteractionProfileInput` | `POST /v2/interaction-profiles/:profileId/activate` | `activate_interaction_profile` | `interaction-profile activate` | W0-PROFILE |
| A18 | `interactionProfiles.retire` | `RetireInteractionProfileInput` | `POST /v2/interaction-profiles/:profileId/retire` | `retire_interaction_profile` | `interaction-profile retire` | W0-PROFILE |
| A19 | `teamMembers.interactionProfile.setDefault` | `SetTeammateProfileDefaultInput` | `PUT /v2/team-members/:teamMemberId/interaction-profile-default` | `set_teammate_profile_default` | `teammate interaction-profile set-default` | W0-PROFILE |
| A20 | `spaces.interactionProfile.setDefault` | `SetSpaceProfileDefaultInput` | `PUT /v2/spaces/:spaceId/interaction-profile-default` | `set_space_profile_default` | `space interaction-profile set-default` | W0-PROFILE |

## 4. Binding invariants checked across both matrices

- Server is the root; Space is the authorization/event boundary; Workspace is a view.
- ProjectResource is configuration truth; per-Space `project` is a restricted projection.
- Session Project membership is M:N `in_project`; `launchProjectId` is immutable provenance only.
- Terminal is a complete native PTY peer; Chat is optional, never a split, and uses the one message store.
- `providerCaptureMode='explicit-only'`; static templates never become entities or operations.
- `interaction_profile` is restricted and its immutable pin is runtime authority.
- Events are durable and ordered per Space only after storage/replay conformance; the current WS/live publisher remains a skeleton.
- There is no public prompt/report/progress/whoami/alias grammar in the adopted target.
- Catalogued but unavailable and reserved rows remain honest; a mounted route is not an implemented semantic handler.
