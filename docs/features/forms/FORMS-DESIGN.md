# Forms — design (v1, decisions settled)

**Status:** APPROVED for implementation (2026-09-24). Task `01a0d308-b1d4-70d6-9fbf-e9d924157638`.
Section 11 records the owner's decisions. Where this doc and §11 disagree, §11 wins.
Nothing here is built yet.

## 1. Problem

Agents ask humans questions in prose, in the middle of PTY output. A human only
answers when they happen to read the terminal. The answer then goes back as free text
into whatever state the session is in, and nothing records that the question was ever
asked or how it was answered.

A **form** is a first-class entity that holds:
- a question set, made of modular, typed questions;
- a requester (the work session that asked);
- responses that are stored durably, validated against the questions, and delivered
  back to the requester (into its live PTY, or queued on the session when it isn't
  running).

## 2. What exists today (verified on `origin/main` aa3432e3)

| Piece | State | Used by forms as |
|---|---|---|
| `session_modals` (migration `006_execution_side.sql:66`) | Table exists ("an agent asks a question, the UI answers it"). **No code reads or writes it.** | Superseded. Forms are the entity-shaped version. Drop the table in a later cleanup. |
| `attention_requests` (`050`) | Live, with UI inbox, badges, open-resolves. | How an open form reaches a human. |
| `messages.post` → `dispatchSessionMessages` → PTY | Live. Envelope `tm8.session-input`. | Carries the submission to the session. |
| Delivery to a non-live session | Stored on the anchor, but the delivery row goes `failed_permanent/session_not_live`. **Resume does not replay it.** | Gap. See §7.3. |
| `authored_from` edge (message/memory/artifact → work_session, verified from the bearer) | Live. | Records which session a form came from. |
| Agent blocking on a human answer | **None.** `AskUserQuestion` is disabled for headless chat. | Forms are that mechanism. |
| Kind precedents | `drawing` (194): minimal kind. `artifact` (055): kind with its own ops. | Template. |

Architecture laws that bind this design:
- **T-L3:** relations are edges only, and side tables are fine for per-member state and ledgers.
- **T-L4:** a core kind gets a typed SQL detail table, and constraints live in the database.
- **T-L12:** one operation catalog, projected to HTTP, CLI and MCP.

## 3. Data model

### 3.1 Entities and tables

`form` is a new **core kind** (`entity_kinds` row, icon `clipboard-list`).

```sql
create table public.forms (
  entity_id     uuid primary key references public.entities(id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 300),
  description   text check (char_length(description) <= 8000),        -- markdown
  status        text not null default 'draft'
                check (status in ('draft','open','closed','cancelled')),
  settings      jsonb not null default '{}'::jsonb,                    -- §3.3, validated
  structure_version int not null default 1,                            -- bumps on question edits
  opened_at timestamptz, closed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.form_questions (          -- ordered, modular questions
  form_id    uuid not null references public.forms(entity_id) on delete cascade,
  key        text not null check (key ~ '^[a-z][a-z0-9_]{0,63}$'),     -- stable, agent-chosen
  position   int  not null,
  section    text,                                                     -- section key, optional
  type       text not null,                                            -- §4
  title      text not null check (char_length(title) between 1 and 500),
  help       text check (char_length(help) <= 4000),                   -- markdown
  required   boolean not null default true,
  config     jsonb not null default '{}'::jsonb,                       -- per-type, validated
  primary key (form_id, key)
);

create table public.form_responses (          -- one row per respondent attempt
  id              uuid primary key default internal.new_id(),
  form_id         uuid not null references public.forms(entity_id) on delete cascade,
  space_id        uuid not null references public.spaces(id) on delete cascade,
  respondent_id   uuid not null references public.entities(id),        -- member / team_member
  status          text not null default 'draft' check (status in ('draft','submitted')),
  structure_version int not null,               -- which question set was answered
  answers         jsonb not null default '{}'::jsonb,                  -- { [questionKey]: Answer }
  questions_snapshot jsonb,                     -- frozen copy at submit (audit/rendering)
  revision        int not null default 1,       -- 1 = first submit; amend → next revision
  supersedes_id   uuid references public.form_responses(id),          -- previous revision
  is_current      boolean not null default true, -- latest revision for (form, respondent)
  message_id      uuid references public.messages(id),                 -- the delivery message
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  version int not null default 1
);

create table public.form_deliveries (         -- outbox: response → requesting session
  response_id     uuid not null references public.form_responses(id) on delete cascade,
  work_session_id uuid not null references public.entities(id) on delete cascade,
  status text not null default 'pending'
         check (status in ('pending','delivered','spawned','cancelled')),
  attempts int not null default 0, last_error text,
  delivery_id uuid,                             -- session_message_deliveries row
  spawned_session_id uuid references public.entities(id),  -- new_session / spawn_new
  primary key (response_id, work_session_id)
);
```

Why questions and responses are side rows rather than entities: a single question or
answer fails the T-L3 entity test (nobody discusses, links or reacts to one question).
The *form* passes: it gets discussed, linked to tasks, badged for attention, and it
needs a panel.

Amend model: every submission is an immutable row, and an edit-and-resubmit inserts
revision N+1 with `supersedes_id` pointing at revision N. It then flips `is_current`
on the old row, all in the submit transaction. A partial unique index
`(form_id, respondent_id) where is_current` enforces "one current response per member".
The response limit counts respondents, not revisions. The full history stays
queryable, which is what "check what I submitted" reads.

Why `answers` is jsonb: its shape is per-question-type. The database is still the
authority. `internal.validate_form_answers(form_id, answers, final bool)` runs in the
submit RPC and checks keys, types, required fields, option membership and bounds. The
Zod schemas mirror it so the CLI and UI fail early.

### 3.2 Edges (T-L3: relations are edges)

| Edge | From → to | Written by | Meaning |
|---|---|---|---|
| `authored_from` (widen `src_kinds` to include `form`) | form → work_session | `forms.create`, from the bearer's verified `workSessionId` | The **requesting session**. Delivery target. |
| `attached_to` (widen `src_kinds`) | form → task | `forms.create`, automatic when the requesting session is `working_on` a task (plus an explicit `--attach`) | The form shows up on the task. |
| `attached_to` | file → form | file answers (v1.1) | Uploaded files. |

A human can also create a form and name a target session: `--for-session <id>`. That
writes the same edge, but with `attribution=recorded_only`, and the caller must be
allowed to message that session.

### 3.3 Settings

```ts
type FormSettings = {
  responses: 'per_member' | 'single' | 'unlimited'; // default 'per_member' (one per member, many members)
  respondents: 'humans' | 'anyone';                 // default 'humans' (agents refused)
  closeOnSubmit: boolean;          // default false (true only makes sense with 'single')
  allowAmend: boolean;             // default TRUE: a member can edit and resubmit (new revision, re-delivered)
  delivery: {                      // §7.3, where each submitted response goes
    target: 'requesting_session' | 'new_session';   // default 'requesting_session'
    onSessionNotLive: 'resume' | 'queue' | 'spawn_new'; // default 'resume'
  };
  attentionPoints: number;         // 1–100, default 60. Raised on open, resolved on submit
};
```
There is no expiry in v1 (decision 9). Add an `expired` status and an `expires_at`
column when expiry is designed.

## 4. Question types (modular)

Every question has `{ key, type, title, help?, required, section?, config }`. A type
is a row in one registry (`FORM_QUESTION_TYPES`, contract). Each row has a config
schema, an answer schema, a validator, a UI renderer and a plain-text renderer for the
PTY. Adding a type means adding a registry row and a SQL validator arm, and nothing
else.

| Type | `config` | Answer | v1 |
|---|---|---|---|
| `single_choice` | `options[{value,label,help?,recommended?}]` (2–50), `allowOther`, `display: radio\|dropdown` | `{value}` or `{other}` | ✓ |
| `multi_choice` | `options`, `allowOther`, `minSelected?`, `maxSelected?` | `{values[], other?}` | ✓ |
| `short_text` | `placeholder?`, `maxLength≤500`, `pattern?` | `{text}` | ✓ |
| `long_text` (descriptive) | `placeholder?`, `minLength?`, `maxLength≤20000` | `{text}` (markdown) | ✓ |
| `scale` | `min(0\|1)`, `max≤10`, `minLabel?`, `maxLabel?` | `{number}` | ✓ |
| `yes_no` | `yesLabel?`, `noLabel?` | `{bool}` | next |
| `number` | `min?`, `max?`, `step?`, `unit?` | `{number}` | next |
| `date` | `min?`, `max?`, `withTime` | `{date}` | next |
| `ranking` | `options` | `{order[]}` | later |
| `entity_pick` | `kinds[]`, `multiple` | `{ids[]}` | later |
| `file` | `maxFiles`, `mime[]` | `{fileIds[]}` + `attached_to` edges | later |

**v1 ships exactly five types** (decision 4). The modularity is the requirement, not
the count. A question type is one registry entry that owns its
- config schema,
- answer schema,
- validator (TS and a SQL arm),
- UI input renderer,
- UI answer renderer,
- plain-text PTY renderer.

Nothing outside the registry switches on the question type. The acceptance test for
the foundation: adding `yes_no` touches only the registry entry, one SQL validator
arm, and one input component.

Options come from agents, so they borrow two things from Claude's `AskUserQuestion`:
- `recommended: true`, which the UI renders as a badge and pre-selects in "accept
  defaults";
- a per-option `help`, which the UI shows when the option is focused.

Sections: optional `sections[{key,title,help?}]` on the form. Questions reference them
by key, and the UI renders one heading per section (decision 5).

## 5. Lifecycle

```
draft ──open──▶ open ──submit (closeOnSubmit)──▶ closed
  │               │ ──close──▶ closed ──reopen──▶ open
  └──cancel───────┴──cancel──▶ cancelled
```

- **Agents create forms `open` by default** (a form nobody can answer is useless to an
  agent). Humans default to `draft`.
- **Question edits** are allowed in `draft` and in `open`, but only until the first
  submitted response. After that the structure is frozen and further edits are refused
  with `form_structure_frozen`. Each edit bumps `structure_version`, and every
  response records the version it answered.
- **Draft responses** autosave, so a human can leave and come back. A structure edit
  keeps draft answers whose keys still validate and drops the others.
- **Cancel:** the requester gets a `form_cancelled` message, so an agent that is
  waiting never hangs forever.
- **Opening** raises an attention request on the form (`reason = "Form: <title>"`).
  Submitting resolves it.

## 6. API: operation catalog `forms.*`

Every operation goes through the `SECURITY DEFINER` RPC catalog, the ledger (`clientMutationId`)
and `expectedVersion` where it mutates the form. Reads use `entities.get`/`entity
context` (a `form` arm in `internal.entity_content`) and the response ops below.

| Op | Method/path | Who | Notes |
|---|---|---|---|
| `forms.create` | `POST /forms` | any | Full spec in one call: `{title, description?, sections?, questions[], settings?, open?, forSession?, attachTo?[]}`. Returns the form plus its `url`. |
| `forms.update` | `PATCH /forms/:id` | author/admin | Title, description, settings, sections. `expectedVersion`. |
| `forms.questions.add` | `POST /forms/:id/questions` | author/admin | `{question, after?: key}` |
| `forms.questions.update` | `PATCH /forms/:id/questions/:key` | author/admin | partial |
| `forms.questions.remove` | `DELETE /forms/:id/questions/:key` | author/admin | |
| `forms.questions.move` | `POST /forms/:id/questions/:key/move` | author/admin | `{after?: key}` (null means first) |
| `forms.transition` | `POST /forms/:id/transition` | author/admin | `{to: open\|closed\|cancelled, reason?}` |
| `forms.responses.save` | `PUT /forms/:id/responses/mine` | respondent | Upserts the caller's draft. Partial validation. |
| `forms.responses.submit` | `POST /forms/:id/responses/submit` | respondent | `{answers?, responseVersion?}`. Full validation → stored → message → delivery (§7). Idempotent. If the caller already has a submitted response and `allowAmend`, it becomes a new revision. |
| `forms.responses.list` | `GET /forms/:id/responses` | space member | Keyset-paged; `?respondent=me`, `?status=`. |
| `forms.responses.get` | `GET /form-responses/:id` | space member | Answers, the questions snapshot, and delivery status per target. |
| `forms.responses.mine` | `GET /form-responses?respondent=me` | self | "What have I submitted", across the whole space. |

Twelve operations in total. Actions (`tm8 action list`) get cases in
`structurallyAvailable` per form status, so agents discover `submit`/`close` from state.

Errors, all from the closed taxonomy:
- `422 form_answers_invalid` (with `details[{key, code, message}]`)
- `409 form_not_open`
- `409 form_structure_frozen`
- `409 form_response_limit`
- `403 form_respondent_not_allowed`

## 7. Submission and delivery

### 7.1 One transaction (`public.submit_form_response`)
1. Lock the form, assert `status='open'`, and check the respondent against the
   settings and the response limit.
2. `validate_form_answers(final:=true)`. Freeze `questions_snapshot`. Set
   `status='submitted'`.
3. Post a **message** authored by the respondent:
   - anchored on `[requesting session, form]`, with `conversationAnchorId = form`;
   - body is the plain-text rendering (§7.2), truncated to 10k characters with a
     fetch pointer.

   The answer is now durable in three places: the response row, the form's timeline
   and the session's timeline.
4. Insert `form_deliveries(pending)` for the requesting session.
5. `closeOnSubmit` → `closed`. Resolve the form's attention requests.

After commit, `dispatchSessionMessages` injects the message into the live PTY using
the new `form_response` envelope (§7.2), and settles `form_deliveries` from the
`session_message_deliveries` outcome.

### 7.2 What the agent receives

```
<trusted_control type="tm8.session-input" version="1" kind="form_response" message_id=… delivery_attempt_id=…>
  <from actor_id=… actor_kind="member" attribution="verified" />
  <form id=… title_ref="untrusted" structure_version="2" status="closed" />
  <response id=… submitted_at=… answered="5" of="5" />
  <fetch command="tm8 form response get <response-id> --format json" />
  <reply available="true" operation="messages.post" anchor_id="<form-id>" … />
</trusted_control>
<untrusted_data type="form-response" encoding="escaped-utf8">
Form: Pick the migration strategy
1. [strategy] Which approach? → online_backfill ("Online backfill") [recommended]
2. [risks] Anything to watch for? →
   The billing table is 40M rows; run it off-peak.
3. [notify] Notify #ops? → yes
</untrusted_data>
```

Each answer shows both the key and the value, so the agent can use it directly.

A resubmission carries `<response id=… revision="2" supersedes=…>`. Its body lists
only the **changed** answers first, then the full set. For
the full shape, the agent fetches the JSON.

### 7.3 Where a response goes

Every submitted response is delivered on its own; with `per_member`, N members produce
N deliveries. Two settings control delivery (decisions 1 and 3).

**`delivery.target`**
- `requesting_session` (default): the session on the form's `authored_from` edge.
- `new_session`: spawn a fresh session for the same teammate, `working_on` the same
  task(s) as the requesting session. The response is its first turn (a
  `form_response` envelope in the spawn's initial prompt).

**`delivery.onSessionNotLive`**, when the target session exists but isn't running.
Today such a message is stored, but its delivery fails permanently and is never
replayed; `form_deliveries` closes that gap.
- `resume` (default): resume the session automatically (`--resume`) and deliver the
  response as its first turn after resume.
- `queue`: the outbox row stays `pending`. It is drained when the session is live
  again, on `SpawnService.resume` success or a status transition to `running`/`idle`
  (same pattern as the nudge outbox in `207`). The UI shows "Answer saved; will be
  delivered when the session resumes" with a **Resume now** button.
- `spawn_new`: spawn a fresh session, as with `target: new_session`.

Whatever the mode, the message on the session and form timelines is the durable
record, and the delivery status is shown on the response.

If the session was deleted, a `resume`/`queue` delivery goes to `cancelled`, the
response is still stored, and the respondent is shown **Send to a new session**.

A spawned delivery ends as `form_deliveries.status = 'spawned'`, with
`spawned_session_id` set.

### 7.4 Agents that want to block

`tm8 form wait <form-id> [--timeout 600]` blocks until a response is submitted or the
form reaches a terminal state, then prints the response. It is a CLI loop over the
change feed and `forms.responses.list`, not a new operation. The primary path stays
PTY injection. The agent keeps working or idles, and the answer arrives as a turn.

## 8. CLI (`tm8 form …`)

```
tm8 form create --title "…" --spec form.json|-   # full JSON spec (agents)
tm8 form create --title "…" \
    --question 'strategy:single_choice:Which approach?:online_backfill*,dual_write,big_bang' \
    --question 'risks:long_text:Anything to watch for?' --optional risks
tm8 form question add|update|remove|move <form-id> …
tm8 form open|close|cancel <form-id> [--expect-version N]
tm8 form fill <form-id>                          # optional interactive TTY fill (not a v1 requirement)
tm8 form submit <form-id> --answers answers.json|-
tm8 form wait <form-id> [--timeout S]
tm8 form response list <form-id> | get <response-id> | mine
```

Both the `--question` shorthand and `--spec` JSON validate client-side against the
contract Zod schema before any call is made.

## 9. MCP and agent guidance

- MCP: add `forms.create`, `forms.responses.get` and `forms.transition` to
  `ACT_GUIDES`/`READ_GUIDES`, and a typed direct tool `form_create`.
- Prompt: a few lines in the worker `command_surface` telling agents to ask humans via
  `tm8 form` instead of prose questions, and to run `tm8 help form` for the rest
  (decision 12).
- CLI help is the teaching surface: the `form` noun help has to be rich enough to
  author a form from alone. That means the full spec shape, one example per question
  type, the delivery modes, and `tm8 form wait`.

## 10. UI

- **Form panel** (`KindConfig` `form`, body block `questionnaire`):
  - **Fill** tab: the respondent view, with validation, autosave and "accept
    recommended". After submitting, it shows the member's answers with **Edit & resubmit**
    and the revision history;
  - **Build** tab: author view, add/reorder/edit questions with live preview;
  - **Responses** tab: table view plus a per-response detail with the delivery status
    chip (`delivered` / `queued` / `spawned` / `cancelled`).
- **Entry points (decision 11), all required in v1:**
  - the form panel;
  - a chip on the session tile ("1 form waiting");
  - a pending-forms banner at the top of the session panel, which opens Fill inline.

  The attention request still gets raised because it costs nothing, but the inbox
  surface is not a v1 requirement. Feed cards and a home rail list are later.
- **Live updates:** the entity-upsert and message events that already exist. No new
  socket traffic.

## 11. Decisions (owner, 2026-09-24)

| # | Topic | Decision |
|---|---|---|
| 1 | Responses | One per member, many members (`per_member` default); editable and resubmittable (see 8). Each response can go to the requesting session **or to a fresh session**. |
| 2 | Respondents | Humans by default; a per-form switch allows agents. |
| 3 | Session not live | Three modes: auto-**resume** (default), **queue** for the session, **spawn a new session**. |
| 4 | Types | Five types in v1: single_choice, multi_choice, short_text, long_text, scale. Question and answer structure must be fully modular (registry), so more types are purely additive. |
| 5 | Layout | (default) Optional sections on one page; no conditional logic. |
| 6 | Choices | (default) `allowOther` write-in, `recommended` options, "accept recommended". |
| 7 | Editing | Questions editable until the first submitted response, then frozen. |
| 8 | Amend | One response per member by default, but the member **can edit and resubmit** (`allowAmend` default true). Each resubmission is a new revision, delivered again, and history is kept. |
| 9 | Expiry | Not needed for now. |
| 10 | Visibility | Space-visible. |
| 11 | UI surfaces | Form panel, session tile chip, pending-forms banner at the top of the session panel. |
| 12 | Agent guidance | Rich `tm8 help form` plus a few prompt lines pointing to it; add `tm8 form wait`. |
| 13 | Templates | (default) v2. |
| 14 | Execution | One coordinator runs it in waves: data-model foundation, then backend and frontend waves, integration, testing. Each wave has an advisor. |

## 12. Delivery plan (waves; a coordinator runs them)

| Wave | Scope | Gate to the next wave |
|---|---|---|
| 0 Foundation | Final data model and the **question-type registry** contract. Covers: migration (kind row, `forms`/`form_questions`/`form_responses`/`form_deliveries`, RLS, SQL validator with per-type arms, `entity_content` arm, `authored_from`/`attached_to` src_kinds), and contract types and Zod schemas. The advisor reviews the model for efficiency (indexes, keyset paging, lock scope on submit) and extensibility (adding a type is additive). | Model merged; `yes_no` dry-run proves additivity (not shipped). |
| 1 Backend | `forms.*` ops (catalog, RPCs, services, handlers, `actions.list` cases, entity-context), the CLI `tm8 form` noun with rich help, and count pins. | API complete; CLI integration tests green. |
| 1 Frontend (parallel, against contract fixtures) | `KindConfig` `form`, the `questionnaire` body with Fill/Build/Responses tabs, and the five type renderers from the UI registry. | Renders against fixtures. |
| 2 Delivery | `form_response` envelope, the `form_deliveries` outbox, resume / queue / spawn_new / new_session, drain-on-live hook, `tm8 form wait`. | Live, exited and deleted session paths are covered by tests. |
| 3 Integration | UI wired to the real ops and events; session tile chip; session panel banner; prompt lines; MCP guides. | End-to-end: an agent creates a form, a human fills it in the UI, and the answer lands in the PTY. The same flow is verified with the session exited, for each mode. |
| 4 Hardening | Tests across layers, conformance, docs, cleanup of `session_modals`. | CI green; PRs merged. |
