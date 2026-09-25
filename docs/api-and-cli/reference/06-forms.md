# Forms

A **Form** is a first-class `form` entity (migration 209, FORMS-DESIGN v3): a
structured question set an agent or human "asks" a requesting session, with
sections, typed questions, versioned lifecycle (`draft -> open -> closed`,
plus `cancelled`), and a separate stream of **responses** — one per
respondent per revision chain, tracked outside the form entity so a large
response history never inflates the form's own read. Submitting a response
posts a plain-text message to the requesting session and files a delivery row
that W2's drain (`form-delivery.ts`) turns into a session resume/spawn. The
form itself is read through the universal entity read (`entities.get` /
`entities.context`, a `form` arm of `content`/`state`) — not documented as a
separate op here; the fifteen ops below cover the form's own commands and the
side channel of `forms.responses.*` and `forms.pendingForSessions`.

Every operation in this group is `status: v1`, `kind` as shown, and every one
has a registered handler (none answer `501 not_implemented`) — the handler
file's own comment calls this out: "All fifteen catalog rows register
together: a v1 row with no handler would answer 501 and make the catalog lie
about what this node does" (`packages/server/src/facade/handlers/w2/forms.ts:6-9`).

## Summary

| Operation | Method | Path | Kind | Served |
|---|---|---|---|---|
| `forms.create` | POST | `/v2/forms` | command | yes |
| `forms.update` | PATCH | `/v2/forms/:formId` | command | yes |
| `forms.questions.add` | POST | `/v2/forms/:formId/questions` | command | yes |
| `forms.questions.update` | PATCH | `/v2/forms/:formId/questions/:questionKey` | command | yes |
| `forms.questions.remove` | DELETE | `/v2/forms/:formId/questions/:questionKey` | command | yes |
| `forms.questions.move` | POST | `/v2/forms/:formId/questions/:questionKey/move` | command | yes |
| `forms.transition` | POST | `/v2/forms/:formId/transition` | command | yes |
| `forms.responses.save` | PUT | `/v2/forms/:formId/responses/mine` | command | yes |
| `forms.responses.discard` | DELETE | `/v2/forms/:formId/responses/mine` | command | yes |
| `forms.responses.submit` | POST | `/v2/forms/:formId/responses/submit` | command | yes |
| `forms.responses.list` | GET | `/v2/forms/:formId/responses` | read | yes |
| `forms.responses.get` | GET | `/v2/form-responses/:responseId` | read | yes |
| `forms.responses.mine` | GET | `/v2/form-responses` | read | yes |
| `forms.responses.redeliver` | POST | `/v2/form-responses/:responseId/redeliver` | command | yes |
| `forms.pendingForSessions` | GET | `/v2/forms-pending` | read | yes |

Source (catalog rows): `packages/contract/src/catalog.ts:358-374` (comment
block `:345-350`). Handler registration:
`packages/server/src/facade/handlers/w2/forms.ts:10-34`, delegating to
`W2FormsService` in `packages/server/src/facade/services/w2/forms.ts`.

## Shared types (define once)

**Envelope.** Every response is `{ "data": <shape below>, "requestId": "req_..." }`
(default status `200` for all fifteen ops — including `forms.create`, which
does **not** get the `201` some other `*.create` ops use, since it registers
its handler directly rather than through the `json(..., { status: 201 })`
wrapper other create ops use; `packages/server/src/http/server.ts:516-556`).

**`FormCommandContext`** — the envelope every `forms.*` **mutation** body
carries (stricter than the generic `CommandContext`: `clientMutationId` is
**required**, not optional):

| field | type | required | description |
|---|---|---|---|
| `clientMutationId` | string (min 1) | yes | Idempotency key; replays return the original ledger result (`internal.ledger_replay`). |
| `actorId` | string | no | Acting entity; resolved server-side if omitted. |
| `workSessionId` | string | no | The originating session (only meaningful on `forms.create`'s bearer path — see below). |

Source: `packages/contract/src/forms.ts:694-706` (`formCommandShape` /
`FormCommandContext`).

**Question types registry** (`FORM_QUESTION_TYPES`,
`packages/contract/src/forms.ts:193-368`) — ONE object per type owns its
`config` schema, `answer` shape and validator; both the CLI/UI and the SQL
door (`internal.form_qtype_<type>`) must have an entry for every type
(checked by `forms-parity.pg.test.ts`). v1 has five:

| type | config (defaults applied) | answer |
|---|---|---|
| `single_choice` | `options: FormOption[]` (2..50, unique `value`, ≤1 `recommended`), `allowOther` bool = `false`, `display` `'radio'\|'dropdown'` = `'radio'` | `{value: string}` or `{other: string}` (if `allowOther`) |
| `multi_choice` | `options` (2..50, ≤50 `recommended`), `allowOther` = `false`, `minSelected?` 0..50, `maxSelected?` 1..50 | `{values: string[], other?: string}` |
| `short_text` | `placeholder?` (0..200 chars), `maxLength` 1..500 = `500`, `pattern?` (1..500 chars, must compile, whole-string match) | `{text: string}` |
| `long_text` | `placeholder?`, `minLength?` 0..20000, `maxLength` 1..20000 = `20000` | `{text: string}` |
| `scale` | `min` `0\|1` = `1`, `max` 2..10 = `5`, `minLabel?`, `maxLabel?` (0..100 chars) | `{number: int}` |

`FormOption`: `{value: string(1..200), label: string(1..500), help?: string(0..2000), recommended?: boolean}`
(`packages/contract/src/forms.ts:128-135`). Lengths are Unicode code points
(`formTextLength`), matching Postgres `char_length`; "blank" = ASCII
whitespace only (`isBlankFormText`) — both mirrored by
`internal.form_qtype_<type>` in SQL, which is the validation **authority**
(`packages/contract/src/forms.ts:1-33`).

**`FormQuestionWire`** — a question as sent over the wire in `forms.create` /
`forms.questions.add` (structure checked client-side; `config` is passed
through unvalidated so an author-supplied `short_text.pattern` never runs
through in-process JS `RegExp` on the request path — a ReDoS guard):

| field | type | required | description |
|---|---|---|---|
| `key` | string, `/^[a-z][a-z0-9_]{0,63}$/` | yes | Stable, agent-chosen. |
| `type` | string, `/^[a-z][a-z0-9_]{0,40}$/` | yes | One of the registry keys above. |
| `title` | string (1..500) | yes | |
| `help` | string (0..4000) | no | |
| `required` | boolean | no | Default `true` (server-side). |
| `section` | string (a section key) | no | Must name a section in the same call/form. |
| `config` | object | no | Shape depends on `type` (table above); SQL is the authority. |

Source: `packages/contract/src/forms.ts:709-718`.

**`FormSection`**: `{key: FormKey, title: string(1..300), help?: string(0..4000)}`
(`forms.ts:388-393`). Stored/read back as **`FormSectionRow`** (adds
`position: int`, `forms.ts:489-492`) and **`FormQuestionRow`** (stored
question: `key, type, title, help?, required, section?, position, config`,
`forms.ts:477-487`) — these are what `content.sections` / `content.questions`
carry on the form entity's own read, and what `FormSnapshot` freezes at
submit time (`structureVersion, sections, questions`, `forms.ts:892-897`).

**`FormSettingsPatch`** — every key sparse/optional, sent by `forms.create`
and `forms.update` (an absent key means "leave the default / current value"):

| field | type | default | description |
|---|---|---|---|
| `responses` | `'per_member'\|'single'\|'unlimited'` | `'per_member'` | One current response per member, one on the whole form, or unlimited. |
| `respondents` | `'humans'\|'anyone'` | `'humans'` | `'anyone'` also admits `team_member` (agent) respondents. |
| `closeOnSubmit` | boolean | `false` | Auto-`closed` after the first submit (§7.1 step 5). |
| `allowAmend` | boolean | `true` | A respondent may edit and resubmit (new revision, re-delivered). |
| `delivery.target` | `'requesting_session'\|'new_session'` | `'requesting_session'` | |
| `delivery.onSessionNotLive` | `'resume'\|'queue'\|'spawn_new'` | `'resume'` | |
| `attentionPoints` | int 1..100 | `60` | |

Source: `packages/contract/src/forms.ts:436-451,721-731`
(`FormSettingsSchema` / `FormSettingsPatchSchema`; `DEFAULT_FORM_SETTINGS` is
every key at its default).

**`FormStatus`**: `'draft'|'open'|'closed'|'cancelled'`. Transitions
(`FORM_TRANSITIONS`, `forms.ts:465-470`): `draft -> open|cancelled`;
`open -> closed|cancelled`; `closed -> open`; `cancelled` is terminal.
Agents create forms already `open`; humans create `draft` (§5;
`create_form`, `db/migrations/211_forms_ops.sql:540`).

**`FormResponseView`** — the shape every `forms.responses.*` op returns (a
single view, or paged as `FormResponsePage`):

| field | type | description |
|---|---|---|
| `id` | string | Response row id. |
| `formId` | string | |
| `respondentId` | string | |
| `respondentName` | string \| null | Resolved server-side (member/team_member display name). |
| `status` | `'draft'\|'submitted'` | |
| `revision` | number | 1-based within its `lineageKey` chain. |
| `supersedesId` | string \| null | The revision this one amends. |
| `lineageKey` | string | Groups all revisions of "the same answer". |
| `isCurrent` | boolean | Latest submitted revision in its lineage. |
| `structureVersion` | number | The form's `structureVersion` this response was validated against. |
| `answers` | `FormAnswers` (`{[questionKey]: object \| null}`) | |
| `questionsSnapshot` | `FormSnapshot \| null` | Frozen at submit; `null` on a draft. |
| `messageId` | string \| null | The delivery message (jump to the timeline). |
| `createdAt` / `updatedAt` | string (ISO) | |
| `submittedAt` | string (ISO) \| null | `null` on a draft. |
| `version` | number | Optimistic-lock version of the response row (guards `responseVersion`). |
| `deliveries` | `FormDeliveryView[]` | `[]` for drafts. |

**`FormDeliveryView`**: `{workSessionId, status: 'pending'|'delivered'|'spawned'|'cancelled', spawnedSessionId: string|null, lastError: string|null, attempts: number, createdAt: string}`.

**`FormResponsePage`**: `{items: FormResponseView[], nextCursor: string|null}`
(keyset pagination, same cursor convention as other list ops — opaque,
encodes a fingerprint of the filter plus the last row's sort key; a cursor
from a different filter combination is rejected as `invalid_cursor`).

Source: `packages/contract/src/forms.ts:892-945`.

**`CommandResult`** (generic; used by `forms.create/update/questions.*/transition`,
same shape every entity command returns across the API):
`{entity?: EntityDetail, edge?: EdgeView, activity?: ActivityItem, patches: EntitySummary[], undo?: UndoToken, warnings?: ResultWarning[]}`
(`packages/contract/src/contract.ts:1687-1695`). `entity` is the form's own
`EntityDetail` (an `EntitySummary` plus `content`, `hierarchy`, `connections`,
`capabilities`) built by `toCommandResult` / `buildDetail` from the same code
path as `entities.get` — a client that just created a form and one that just
fetched it see identical objects
(`packages/server/src/facade/handlers/entities.ts:319-403`).

The form's `content` arm (`kind: 'form'`, on both `EntityDetail.content` and
`entities.context`'s reads):

```
{ kind: 'form', status: FormStatus, description: string | null,
  settings: FormSettings, structureVersion: number,
  sections: FormSectionRow[], questions: FormQuestionRow[],
  openedAt: string | null, closedAt: string | null }
```

and the row-summary arm (`EntitySummary.state`, `kind: 'form'`):
`{kind: 'form', status: FormStatus, questionCount: number}`.

Source: `packages/contract/src/contract.ts:491,851-853` (imports `FormStatus`
etc. from `packages/contract/src/forms.ts` at `contract.ts:22`).

**Errors used by this group** — HTTP status from `ERROR_STATUS`
(`packages/contract/src/contract.ts:1613-1637`); the Postgres → taxonomy
mapping is a closed, mechanical SQLSTATE table, never a message regex
(`packages/server/src/http/errors.ts:34-64`):

| code | HTTP | SQLSTATE(s) | when |
|---|---|---|---|
| `invalid_input` | 400 | `22023` and Zod failures | Malformed body/query (e.g. `respondent` not `me`, both `lineageKey` and `respondent`, non-array `questions`/`sections`, `to` not `new_session|resume`, more than one delivery with no `deliverySessionId`). |
| `invalid_cursor` | 400 | (app-level) | Cursor malformed or doesn't match the current filter. |
| `unauthenticated` | 401 | `28000` | |
| `forbidden` | 403 | `42501` | Not a space member; not the form's author/space-admin on a structural edit; not the respondent/author/admin on a redeliver; a session-bound caller naming a different session on create. |
| `not_found` | 404 | `P0002`, `22P02` | Form/response/session/attach-target id doesn't exist, is deleted, or isn't readable. |
| `version_conflict` | 409 | `40001` | `expectedVersion` (form) or `responseVersion` (draft) stale; the submit basis (`structureVersion`/`supersedesId`/answers) changed between render and commit. `details.reason`: `form_response_version` (+ `currentVersion`), `form_structure_changed` (+ `structureVersion`), `form_revision_changed`. |
| `conflict` | 409 | `TFC01`, `TFD01` | `TFC01`: duplicate key/position (`details.reason: 'form_key_taken'`), illegal lifecycle transition (`'form_transition_invalid'`, + `from`/`to`), or a redeliver on the wrong delivery state (`'delivery_not_cancelled'`\|`'delivery_not_pending'`\|`'session_deleted'`). `TFD01`: a second draft already in flight for another target. |
| `form_answers_invalid` | 422 | `TFA01` | Answers or question `config` fail validation. `details`: `{reason: 'form_answers_invalid'\|'form_config_invalid', issues: [{key, code, message}]}`. |
| `form_not_open` | 409 | `TFN01` | The form is `cancelled` (or otherwise not accepting the requested change). |
| `form_structure_frozen` | 409 | `TFS01` | Editing `sections` (or removing/moving questions across the freeze) after the form's first submitted response. |
| `form_response_limit` | 409 | `TFL01` | `single`/`per_member` slot already has a response and `allowAmend` is false, or the mode's cap is otherwise reached. |
| `form_respondent_not_allowed` | 403 | `TFR01` | A `team_member` (agent) answering a `respondents: 'humans'` form, or the respondent isn't a space member. |
| `invariant_violation` | 409 | `23503`/`23505`/`23514` | Unmapped constraint/FK/check violation. |
| `upstream_unavailable` | 503 | (anything unmapped) | |

Source: error-taxonomy header comment `db/migrations/209_forms_foundation.sql:94-100`;
raise sites `db/migrations/209_forms_foundation.sql:1088-1112,1147,1159,1211,1229,1271,1286`,
`db/migrations/211_forms_ops.sql:245-290,386,502-533,619-625,848-849,916,979-994,1060-1063`,
`db/migrations/221_forms_redeliver_and_pending.sql:282-341`.

---

### `forms.create`
`POST /v2/forms` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/forms.ts:273-305`, RPC `public.create_form` at `db/migrations/211_forms_ops.sql:467-596`)
CLI: `tm8 form create`

Creates a form entity in one call: settings, sections and questions all
written together (`form` is born only from this door — no generic
`entities.create` path admits `kind: 'form'`). Agents default to `open`;
humans default to `draft`. The requesting session — where answers will be
delivered — is either the bearer's own verified session (if the caller is a
session-bound bearer) or an explicit `forSession` (human naming a session,
`attribution: 'recorded_only'`); the two must agree if both are present.

**Path params** — none (`spaceId` is a body field, not a path segment).

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `spaceId` | string | yes | | |
| `title` | string | yes | 1..300 chars | |
| `description` | string | no | 0..8000 chars | |
| `sections` | `FormSection[]` | no | ≤50, unique `key` | |
| `questions` | `FormQuestionWire[]` | yes | ≤200, unique `key`; each `section` must name a section in this array | |
| `settings` | `FormSettingsPatch` | no | | |
| `open` | boolean | no | | Overrides the agent/human default. |
| `forSession` | string (uuid) | no | | A human naming the session the answers go to. |
| `attachTo` | string[] (uuid) | no | ≤20 | Extra tasks to attach to (beyond the requesting session's `working_on` tasks). |
| `parentId` | string | no | | |
| ...`FormCommandContext` | | | `clientMutationId` required | |

Example request:
```json
PUT-style POST /v2/forms
{
  "clientMutationId": "cm_01",
  "spaceId": "3e5d...",
  "title": "Backfill approach",
  "questions": [
    { "key": "approach", "type": "single_choice", "title": "Which approach?",
      "config": { "options": [
        { "value": "online_backfill", "label": "Online backfill", "recommended": true },
        { "value": "dual_write", "label": "Dual write" } ] } }
  ],
  "forSession": "9c11..."
}
```

**Response** — 200; `data` is `CommandResult` (`entity` = the new form's
`EntityDetail`) plus:

| field | type | description |
|---|---|---|
| `url` | string | `/#/s/:spaceId/e/:formId` |
| `requestingSessionId` | string \| null | The session answers will be delivered to, if any. |
| `attachedTo` | string[] | Task ids the form ended up attached to. |

```json
{ "data": { "entity": { "id": "f1...", "kind": "form", "version": 1,
      "content": { "kind": "form", "status": "open", "questionCount": 1 } },
    "patches": [], "url": "/#/s/3e5d.../e/f1...",
    "requestingSessionId": "9c11...", "attachedTo": ["t1..."] },
  "requestId": "req_..." }
```
(illustrative, from schema)

**Errors** — `invalid_input` (malformed `questions`/`sections` array, or
`workSessionId` and `forSession` both set and disagree); `forbidden` (bearer
session doesn't match the resolved actor's `participates_in` edge);
`not_found` (`forSession` or an `attachTo` id doesn't exist/isn't readable);
`form_answers_invalid` details.reason `form_config_invalid` (bad question
`config` or settings shape); `conflict` details.reason `form_key_taken`
(duplicate section/question key or position).

**Notes** — Idempotent via `clientMutationId` (command ledger replay, keyed
also to the `spaceId` subject). No `expectedVersion` (nothing to conflict
with on create). Side effects: an `attention` request raised if the form
opens immediately; an `authored_from` edge to the requesting session; an
`attached_to` edge per target task; an activity row (`kind: 'created'`).
Source: `packages/contract/src/catalog.ts:358`; input schema
`packages/contract/src/forms.ts:735-762`; handler
`packages/server/src/facade/services/w2/forms.ts:273-305`.

---

### `forms.update`
`PATCH /v2/forms/:formId` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/forms.ts:307-315`, RPC `public.update_form` at `db/migrations/211_forms_ops.sql:602-`)
CLI: `tm8 form update <form-id> --expect-version <n> [--title|--description|--settings|--sections ...]`

Sparse-patches the form's `title`, `description`, `settings` and/or
`sections` (replaces the whole sections array when sent). Only keys present
in the body change — an absent key means "unchanged" (`pick()` at
`packages/server/src/facade/services/w2/forms.ts:250-254`).

**Path params**

| name | type | description |
|---|---|---|
| `formId` | string (uuid) | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `expectedVersion` | int | yes | ≥1 | Optimistic lock on the FORM (not a response). |
| `title` | string | no | 1..300 chars | |
| `description` | string \| `null` | no | 0..8000 chars; `null` clears it | |
| `settings` | `FormSettingsPatch` | no | | |
| `sections` | `FormSection[]` | no | ≤50, unique `key`; refused if the form already has a submitted response (`form_structure_frozen`) | |
| ...`FormCommandContext` | | | | |

**Response** — 200; `data` is `CommandResult` (`entity` refreshed).

**Errors** — `version_conflict` (`expectedVersion` stale); `forbidden` (not
author/space-admin); `form_not_open` (form is `cancelled`);
`form_structure_frozen` (sections patched after the first submit);
`form_answers_invalid` details.reason `form_config_invalid` (bad settings
shape).

**Notes** — Idempotent via `clientMutationId`. Every create/update receipt
prints the new `version`, which is what the next `--expect-version` uses (per
the CLI's own hint). Source: `packages/contract/src/forms.ts:764-779`.

---

### `forms.questions.add`
`POST /v2/forms/:formId/questions` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/forms.ts:317-324`, RPC `public.add_form_question`)
CLI: `tm8 form question add <form-id> --expect-version <n> --question <key:type:title[:options]>` (or `--spec <json>`)

Inserts one question. `after` omitted appends to the end; `after: null` (or
`--first`) puts it first; `after: "<key>"` inserts right after that question.

**Path params** — `formId` (uuid).

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `expectedVersion` | int | yes | ≥1 | Form version. |
| `question` | `FormQuestionWire` | yes | see registry table | |
| `after` | string \| `null` | no | a question key, or `null` for first | Omitted = append. |
| ...`FormCommandContext` | | | | |

**Response** — 200; `data` is `CommandResult`.

**Errors** — `version_conflict`; `forbidden`; `not_found` (`after` names no
question on this form); `form_not_open`; `form_answers_invalid`
details.reason `form_config_invalid`; `conflict` details.reason
`form_key_taken` (duplicate key/position). Unlike `forms.update`'s
`sections` patch, adding a question is **not** blocked by
`form_structure_frozen` — that freeze applies only to replacing the sections
array, not to questions (confirmed: `TFS01` appears nowhere in
`add_form_question`, `db/migrations/211_forms_ops.sql:670-706`).

**Notes** — Idempotent via `clientMutationId`. Source:
`packages/contract/src/forms.ts:781-792`.

---

### `forms.questions.update`
`PATCH /v2/forms/:formId/questions/:questionKey` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/forms.ts:326-335`)
CLI: `tm8 form question update <form-id> <question-key> --expect-version <n> [--title|--type|--help-text|--section|--required|--config ...]`

Sparse-patches one question by key. `help`/`section` cleared with an empty
CLI value (sent as JSON `null`). The CLI validates the **merged** question
locally against the registry before sending, but the body carries only the
changed keys (W1-R4 5b).

**Path params**

| name | type | description |
|---|---|---|
| `formId` | string (uuid) | |
| `questionKey` | string | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `expectedVersion` | int | yes | ≥1 | |
| `type` | string | no | `/^[a-z][a-z0-9_]{0,40}$/` | |
| `title` | string | no | 1..500 chars | |
| `help` | string \| `null` | no | 0..4000 chars | |
| `required` | boolean | no | | |
| `section` | string \| `null` | no | | |
| `config` | object | no | shape depends on (new or existing) `type` | |
| ...`FormCommandContext` | | | | |

**Response** — 200; `data` is `CommandResult`.

**Errors** — `version_conflict`; `forbidden`; `not_found` (no such question
key on this form); `form_not_open`; `form_answers_invalid` details.reason
`form_config_invalid`.

**Notes** — Idempotent via `clientMutationId`. Source:
`packages/contract/src/forms.ts:794-813`.

---

### `forms.questions.remove`
`DELETE /v2/forms/:formId/questions/:questionKey` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/forms.ts:337-344`)
CLI: `tm8 form question remove <form-id> <question-key> --expect-version <n>`

Removes one question.

**Path params** — `formId`, `questionKey`.

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `expectedVersion` | int | yes | ≥1 | |
| ...`FormCommandContext` | | | | |

**Response** — 200; `data` is `CommandResult`.

**Errors** — `version_conflict`; `forbidden`; `not_found` (`questionKey`
names no question on this form); `form_not_open`. Like `questions.add`, this
is **not** guarded by `form_structure_frozen` (`TFS01` does not appear in
`remove_form_question`, `db/migrations/211_forms_ops.sql:749-774`).

**Notes** — Idempotent via `clientMutationId`. Source:
`packages/contract/src/forms.ts:815-821`.

---

### `forms.questions.move`
`POST /v2/forms/:formId/questions/:questionKey/move` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/forms.ts:346-353`)
CLI: `tm8 form question move <form-id> <question-key> --expect-version <n> (--after <key>|--first)`

Reorders one question. `after` omitted **or** `null` moves it first
(`--first` on the CLI is sugar for `after: null`; the two flags are mutually
exclusive).

**Path params** — `formId`, `questionKey`.

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `expectedVersion` | int | yes | ≥1 | |
| `after` | string \| `null` | no | a question key | |
| ...`FormCommandContext` | | | | |

**Response** — 200; `data` is `CommandResult`.

**Errors** — `version_conflict`; `forbidden`; `not_found` (unknown
`questionKey` or `after` target, `P0002`); `invalid_input` (`after` names the
question being moved, `22023`); `form_not_open`.

**Notes** — Idempotent via `clientMutationId`. Source:
`packages/contract/src/forms.ts:823-832`.

---

### `forms.transition`
`POST /v2/forms/:formId/transition` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/forms.ts:355-369`, RPC `public.transition_form`)
CLI: `tm8 form open|close|cancel|reopen <form-id> --expect-version <n> [--reason <text>]` (`reopen` sends `to: 'open'` from `closed`)

Moves the form along its lifecycle (`FORM_TRANSITIONS`: `draft->open|cancelled`,
`open->closed|cancelled`, `closed->open`, `cancelled` terminal). On
`to: 'cancelled'`, the service also fires the `onFormCancelled` hook
(best-effort — delivers a `form_cancelled` notice to the requesting session;
a hook failure never fails the call, since the stored transition is the
durable truth).

**Path params** — `formId` (uuid).

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `expectedVersion` | int | yes | ≥1 | |
| `to` | `'open'\|'closed'\|'cancelled'` | yes | must be a legal edge from the current status | |
| `reason` | string | no | 1..1000 chars | |
| ...`FormCommandContext` | | | | |

**Response** — 200; `data` is `CommandResult`.

**Errors** — `version_conflict`; `forbidden`; `conflict` details.reason
`form_transition_invalid` (+ `from`, `to`) — the illegal-edge case the CLI's
own hint prints the transition table for.

**Notes** — Idempotent via `clientMutationId`. Side effect on cancel: a
`form_cancelled` delivery to the requesting session (best-effort, outbox is
the durable path). Source: `packages/contract/src/forms.ts:834-845`;
RPC raise site `db/migrations/211_forms_ops.sql:848-849`.

---

### `forms.responses.save`
`PUT /v2/forms/:formId/responses/mine` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/forms.ts:385-396`, RPC `public.save_form_response`)
CLI: `tm8 form response save <form-id> --answers <json-source> [--amend-of <id>] [--response-version <n>]`

Upserts the **caller's own** draft answers (partial validation only — shape
and per-answer bounds, no `required` check; see `validateFormAnswers(...,
{final: false})`). `amendOf` names the submitted revision being edited
(needed only under `responses: 'unlimited'`; `per_member`/`single` find the
target themselves). `responseVersion`, if sent, must match the draft's
current `version` or the call is refused — draft autosave's own optimistic
lock, independent of the form's `expectedVersion`.

**Path params** — `formId` (uuid).

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `answers` | `FormAnswers` (`{[key]: object\|null}`) | yes | keys must name questions on the form | |
| `amendOf` | string (uuid) | no | | |
| `responseVersion` | int | no | ≥1 | Guards the draft, not the form. |
| ...`FormCommandContext` | | | | |

**Response** — 200; `data` is `FormResponseView` (see shared types).

**Errors** — `version_conflict` details.reason `form_response_version` (+
`currentVersion`); `form_answers_invalid` (shape/bounds issues per key);
`form_respondent_not_allowed`; `form_response_limit` (draft not permitted
under the mode/limit); `not_found`.

**Notes** — Idempotent via `clientMutationId`, keyed also to `formId` as the
replay subject. No `expectedVersion` (form version) is ever asked of a
respondent — only `responseVersion` on the response row (W1-R2). Source:
`packages/contract/src/forms.ts:847-862`.

---

### `forms.responses.discard`
`DELETE /v2/forms/:formId/responses/mine` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/forms.ts:434-445`, RPC `public.discard_form_response` at `db/migrations/211_forms_ops.sql:1037-1071`)
CLI: `tm8 form response discard <form-id> [--response-version <n>]`

Deletes the caller's own draft on the form. **Idempotent by design**: no
draft to discard is not an error — the response reports `discarded: false`.
Submitted responses are never touched here (a DB trigger refuses deleting a
submitted row regardless).

**Path params** — `formId` (uuid).

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `responseVersion` | int | no | ≥1 | Only checked if a draft exists. |
| ...`FormCommandContext` | | | | |

**Response** — 200; `data`:

| field | type | description |
|---|---|---|
| `formId` | string | |
| `discarded` | boolean | `true` iff a draft existed and was deleted. |
| `responseId` | string \| null | The deleted draft's id, or `null`. |

```json
{ "data": { "formId": "f1...", "discarded": true, "responseId": "r1..." },
  "requestId": "req_..." }
```
(illustrative, from schema)

**Errors** — `version_conflict` details.reason `form_response_version` (only
when a draft exists and `responseVersion` was sent and doesn't match).

**Notes** — Idempotent via `clientMutationId` (and idempotent in the "no
draft" sense too, at the domain level). Source:
`packages/contract/src/forms.ts:864-874`.

---

### `forms.responses.submit`
`POST /v2/forms/:formId/responses/submit` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/forms.ts:398-431`, RPC `public.submit_form_response` at `db/migrations/211_forms_ops.sql:936-1029`)
CLI: `tm8 form submit <form-id> [--answers <json-source>] [--amend-of <id>] [--response-version <n>]`

Full validation (including `required`), stores the response as `submitted`,
renders the plain-text body (`renderFormResponseText` — generic over the
registry; "changed answers first" on a resubmission) and posts a message to
`[requestingSession, form]` (the session copy is the delivery message,
truncated at ~9,850 chars with a fetch pointer if longer). Leaves a
`form_deliveries` row (pending) if there's a requesting session; W2's drain
turns that into a session resume/spawn per `delivery` settings. If `answers`
is omitted, the caller's existing draft's answers are submitted as-is. The
door **re-renders under lock**: it re-checks the exact basis
(`structureVersion`, `supersedesId`, answers) the message text was rendered
from, and refuses (`version_conflict`) rather than store a response whose
delivered text could describe something else.

**Path params** — `formId` (uuid).

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `answers` | `FormAnswers` | no | required-question check enforced here | Omitted = submit the existing draft. |
| `amendOf` | string (uuid) | no | | |
| `responseVersion` | int | no | ≥1 | Draft's version, if editing a draft. |
| ...`FormCommandContext` | | | | |

**Response** — 200; `data` is `FormResponseView`.

**Errors** — `version_conflict` details.reason `form_response_version` \|
`form_structure_changed` \| `form_revision_changed` (basis raced under lock);
`form_answers_invalid` (required/shape/bounds issues); `form_respondent_not_allowed`;
`form_response_limit` (mode's slot already has a submitted response and
`allowAmend` is `false`, or an amend target can't be resolved); `form_not_open`
(form `cancelled`).

**Notes** — Idempotent via `clientMutationId`. **Side effects**: posts a
message (author = the respondent, on the form and, if present, the
requesting session — `internal.form_post_message`); inserts a
`form_deliveries` row for the requesting session; if `settings.closeOnSubmit`
is true, transitions the form to `closed`; resolves any open `attention`
request on the form; records an activity row
(`change: 'response_submitted'`). After commit, the service calls
`onResponseSubmitted` (W2's delivery drain hook) — best-effort, the stored
row is the durable path regardless of hook success. Source:
`packages/contract/src/forms.ts:876-887`.

---

### `forms.responses.list`
`GET /v2/forms/:formId/responses` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/forms.ts:505-579`)
CLI: `tm8 form response list <form-id> [--respondent me | --lineage <key>] [--limit] [--cursor]`

Three mutually exclusive modes (W1-R3): **default** — every **current**
submitted revision on the form, newest first; **`?lineageKey=`** — one
revision chain, oldest first; **`?respondent=me`** — the caller's current
revision plus their own draft (RLS hides every other member's draft; a draft
has no `submittedAt` so this branch keys on `coalesce(submittedAt, createdAt)`).

**Path params** — `formId` (uuid).

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `respondent` | string | no | only `'me'` accepted | Mutually exclusive with `lineageKey`. |
| `lineageKey` | string (uuid) | no | | Mutually exclusive with `respondent`. |
| `limit` | int | no | default 50, max 200 | |
| `cursor` | string | no | opaque | Must match this exact filter combination. |

**Response** — 200; `data` is `FormResponsePage`.

```json
{ "data": { "items": [ { "id": "r1...", "formId": "f1...", "respondentId": "m1...",
      "respondentName": "<redacted>", "status": "submitted", "revision": 1,
      "isCurrent": true, "answers": { "approach": { "value": "online_backfill" } },
      "deliveries": [] } ],
    "nextCursor": null },
  "requestId": "req_..." }
```
(illustrative, from schema)

**Errors** — `invalid_input` (`respondent` not `'me'`; both `lineageKey` and
`respondent` set); `invalid_cursor`; `not_found` (form doesn't exist / not
readable).

**Notes** — RLS enforces that a draft is visible only to its own respondent
regardless of query mode; `forms.responses.list` never leaks another
member's draft even with no filter (default mode selects only
`is_current`, which excludes drafts). Cursor is keyset (`(revision,id)`,
`(coalesce(submitted_at,created_at),id)`, or `(submitted_at,id)` depending on
mode), fingerprinted so it can't be replayed against a different mode.
Source: `packages/contract/src/catalog.ts:368`.

---

### `forms.responses.get`
`GET /v2/form-responses/:responseId` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/forms.ts:581-585`)
CLI: `tm8 form response get <response-id>`

Reads one response by id (RLS applies: a draft is visible only to its
respondent).

**Path params**

| name | type | description |
|---|---|---|
| `responseId` | string (uuid) | |

**Response** — 200; `data` is `FormResponseView`.

**Errors** — `not_found` (no such response, or not readable under RLS —
same code either way).

**Notes** — No pagination/query params. Source:
`packages/contract/src/catalog.ts:369`.

---

### `forms.responses.mine`
`GET /v2/form-responses` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/forms.ts:630-658`)
CLI: `tm8 form response mine [--limit] [--cursor]` (space taken from CLI context)

Every **submitted** response the caller has made, across the whole space,
newest first (drafts excluded; this is the "what have I answered" read, not
per-form).

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `spaceId` | string (uuid) | yes | | |
| `limit` | int | no | default 50, max 200 | |
| `cursor` | string | no | opaque | |

**Response** — 200; `data` is `FormResponsePage`.

**Errors** — `invalid_input` (`spaceId` missing/not a uuid); `invalid_cursor`.

**Notes** — Keyed on `(submitted_at, id)` within `(spaceId, callerRespondentIds)`.
Source: `packages/contract/src/catalog.ts:370`.

---

### `forms.responses.redeliver`
`POST /v2/form-responses/:responseId/redeliver` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/forms.ts:591-608`, RPC `public.redeliver_form_response` at `db/migrations/221_forms_redeliver_and_pending.sql:256-360`)
CLI: `tm8 form response redeliver <response-id> [--to new_session|resume] [--session <delivery-session-id>]`

W3's two delivery buttons. `to: 'new_session'` (default) re-routes a
**cancelled** delivery to a fresh session ("Send to a new session");
`to: 'resume'` resumes a still-**pending** queued one ("Resume now").
`deliverySessionId` names the delivery row and is required only when the
response has more than one delivery. On success (`status: 'pending'`), the
service also fires `onResponseRedelivered` (drains that delivery immediately
rather than waiting for the next tick — best-effort).

**Path params**

| name | type | description |
|---|---|---|
| `responseId` | string (uuid) | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `to` | `'new_session'\|'resume'` | no | default `'new_session'` | |
| `deliverySessionId` | string (uuid) | no | required iff >1 delivery on this response | |
| ...`FormCommandContext` | | | | |

**Response** — 200; `data`:

| field | type | description |
|---|---|---|
| `responseId` | string | |
| `workSessionId` | string | |
| `to` | `'new_session'\|'resume'` | |
| `status` | `FormDeliveryStatus` | The delivery's status after this call. |
| `redelivered` | boolean | `false` when the row was already routed this way (idempotent replay at the domain level). |

```json
{ "data": { "responseId": "r1...", "workSessionId": "s1...", "to": "new_session",
    "status": "pending", "redelivered": true },
  "requestId": "req_..." }
```
(illustrative, from schema)

**Errors** — `forbidden` (not the respondent/form-author/space-admin);
`not_found` (no such response, or no delivery — or no delivery to the named
session); `invalid_input` (`to` not one of the two values; >1 delivery with
no `deliverySessionId`); `conflict` details.reason `delivery_not_cancelled` \|
`delivery_not_pending` \| `session_deleted`.

**Notes** — Idempotent via `clientMutationId`. Source:
`packages/contract/src/forms.ts:947-978`.

---

### `forms.pendingForSessions`
`GET /v2/forms-pending` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/forms.ts:615-627`, RPC `public.forms_pending_for_sessions`, SECURITY INVOKER)
CLI: `tm8 form pending <session-id>[,<session-id>...]` (space taken from CLI context)

The session tile chip and banner read (§10): for each named session, how
many forms are waiting on the caller to answer, and (batched) the newest few
of them — one statement, run under the caller's own RLS, so an unreadable
session or form simply contributes nothing. "Waiting" = the form is `open`,
`authored_from` one of the named sessions, the caller may respond (a member;
or a `team_member` only if `respondents: 'anyone'`), and the caller hasn't
already answered per the form's `responses` mode.

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `spaceId` | string (uuid) | yes | | |
| `sessionIds` | string[] (uuid) | yes | 1..100, distinct; accepted as a repeated key, a comma list, or both | |

**Response** — 200; `data`:

| field | type | description |
|---|---|---|
| `sessions` | `FormPendingSession[]` | Only sessions with `total > 0` or `queued > 0`, in request order. |

`FormPendingSession`: `{workSessionId, total: number, queued: number, forms: FormPendingItem[]}`
(`forms` newest-opened-first, at most 20 — `FORMS_PENDING_MAX_FORMS` — `total`
still counts them all).

`FormPendingItem`: `{formId, title, version, structureVersion, questionCount, openedAt: string|null, draft: {id, version} | null}`
(`draft` is the caller's own draft on that form, so a "Fill" action can chain
straight into `forms.responses.save`).

```json
{ "data": { "sessions": [ { "workSessionId": "s1...", "total": 2, "queued": 1,
      "forms": [ { "formId": "f1...", "title": "Backfill approach", "version": 3,
                   "structureVersion": 1, "questionCount": 4, "openedAt": "2026-09-20T00:00:00.000Z",
                   "draft": null } ] } ] },
  "requestId": "req_..." }
```
(illustrative, from schema)

**Errors** — `invalid_input` (`spaceId` missing/not uuid; `sessionIds` empty,
>100, or has duplicates).

**Notes** — Read-only, no pagination (bounded by the 100-session /
20-forms-per-session caps: `FORMS_PENDING_MAX_SESSIONS`,
`FORMS_PENDING_MAX_FORMS`, `packages/contract/src/forms.ts:981-983`). Source:
`packages/contract/src/forms.ts:985-1020`; migration
`db/migrations/221_forms_redeliver_and_pending.sql:374-`, with a viewer-in-space
fix in `db/migrations/222_forms_pending_viewer_in_space.sql`.

---

## Verification

No real response examples were captured — capturing one would require a form
already existing in this space plus specific fixture data (a form id with
known responses) that wasn't available without running a mutating
`forms.create` first, which the instructions forbid for this exercise. All
examples above are marked "(illustrative, from schema)", built directly from
the Zod schemas and DTO types cited inline, not invented.
