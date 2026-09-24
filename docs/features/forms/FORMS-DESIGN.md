# Forms — design draft (v0, awaiting decisions)

**Status:** DRAFT for review. Task `01a0d308-b1d4-70d6-9fbf-e9d924157638`. Section 11 has the
open questions. Every question has a recommended default, and the rest of this doc
assumes those defaults. Nothing here is built yet.

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
                check (status in ('draft','open','closed','cancelled','expired')),
  settings      jsonb not null default '{}'::jsonb,                    -- §3.3, validated
  structure_version int not null default 1,                            -- bumps on question edits
  opened_at timestamptz, closed_at timestamptz, expires_at timestamptz,
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
         check (status in ('pending','delivered','stored_only','cancelled')),
  attempts int not null default 0, last_error text,
  delivery_id uuid,                             -- session_message_deliveries row
  primary key (response_id, work_session_id)
);
```

Why questions and responses are side rows rather than entities: a single question or
answer fails the T-L3 entity test (nobody discusses, links or reacts to one question).
The *form* passes: it gets discussed, linked to tasks, badged for attention, and it
needs a panel.

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
  responses: 'single' | 'per_member' | 'unlimited'; // default 'single'
  respondents: 'humans' | 'anyone';                 // default 'humans' (agents refused)
  closeOnSubmit: boolean;          // default true when responses='single'
  allowAmend: boolean;             // default false: submitted answers are immutable
  expiresAt?: string;              // ISO. On expiry, status → 'expired' and the requester is told
  onSessionNotLive: 'queue' | 'resume' | 'store'; // §7.3, default 'queue'
  attentionPoints: number;         // 1–100, default 60. Raised on open, resolved on submit
};
```

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
| `number` | `min?`, `max?`, `step?`, `unit?` | `{number}` | ✓ |
| `yes_no` | `yesLabel?`, `noLabel?` | `{bool}` | ✓ |
| `scale` | `min(0\|1)`, `max≤10`, `minLabel?`, `maxLabel?` | `{number}` | ✓ |
| `date` | `min?`, `max?`, `withTime` | `{date}` | ✓ |
| `ranking` | `options` | `{order[]}` | v1.1 |
| `entity_pick` | `kinds[]`, `multiple` | `{ids[]}` (stored as data; see Q9) | v1.1 |
| `file` | `maxFiles`, `mime[]` | `{fileIds[]}` + `attached_to` edges | v1.1 |
| `statement` | markdown only, no answer (explanatory text between questions) | — | ✓ |

Options come from agents, so they borrow two things from Claude's `AskUserQuestion`:
- `recommended: true`, which the UI renders as a badge and pre-selects in "accept
  defaults";
- a per-option `help`, which the UI shows when the option is focused.

Sections: optional `sections[{key,title,help?}]` on the form. Questions reference them
by key, and the UI renders one heading per section (or one page per section, Q5).

## 5. Lifecycle

```
draft ──open──▶ open ──submit (closeOnSubmit)──▶ closed
  │               │ ──close──▶ closed ──reopen──▶ open
  │               │ ──expiresAt passes──▶ expired
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
- **Cancel/expire:** the requester gets a `form_cancelled` / `form_expired` message,
  so an agent that is waiting never hangs forever.
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
| `forms.responses.submit` | `POST /forms/:id/responses/submit` | respondent | `{answers?, responseVersion?}`. Full validation → stored → message → delivery (§7). Idempotent. |
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

Each answer shows both the key and the value, so the agent can use it directly. For
the full shape, the agent fetches the JSON.

### 7.3 Requesting session not live

Today a message to an exited session is stored, but the delivery fails permanently and
is never replayed. `form_deliveries` closes that gap. The behaviour is set per form
(`onSessionNotLive`):

- **`queue` (default):** the outbox row stays `pending`. A drain hook fires when the
  session becomes live again: `SpawnService.resume` success, plus a status transition
  to `running`/`idle`. The same pattern as the nudge outbox in `207`. The drain
  delivers the pending form responses in order. The UI shows "Answer saved; will be
  delivered when the session resumes", with a **Resume now** button.
- **`resume`:** the session is resumed automatically (`--resume`), and the form
  response becomes its first turn.
- **`store`:** the outbox row goes to `stored_only`. The message on the session is the
  record, and nothing is pushed.

If the session was deleted, the delivery goes to `cancelled`, the response is still
stored, and the respondent is told.

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
tm8 form fill <form-id>                          # interactive TTY fill for humans
tm8 form submit <form-id> --answers answers.json|-
tm8 form wait <form-id> [--timeout S]
tm8 form response list <form-id> | get <response-id> | mine
```

Both the `--question` shorthand and `--spec` JSON validate client-side against the
contract Zod schema before any call is made.

## 9. MCP and agent guidance

- MCP: add `forms.create`, `forms.responses.get` and `forms.transition` to
  `ACT_GUIDES`/`READ_GUIDES`, and a typed direct tool `form_create`.
- Prompt: one line in the worker `command_surface` telling agents to ask via
  `tm8 form create` instead of prose questions (Q12).

## 10. UI

- **Form panel** (`KindConfig` `form`, body block `questionnaire`):
  - **Fill** tab: the respondent view, with validation, autosave and "accept
    recommended";
  - **Build** tab: author view, add/reorder/edit questions with live preview;
  - **Responses** tab: table view plus a per-response detail with the delivery status
    chip (`delivered` / `queued` / `stored`).
- **Entry points:**
  - the attention inbox row (opens **Fill**);
  - a chip on the session tile ("1 form waiting");
  - an inline form card in the session and task message feeds (the answer message
    links back);
  - a home rail "Forms" list, with open forms for me and my submissions.
- **Live updates:** the entity-upsert and message events that already exist. No new
  socket traffic.

## 11. Open questions (defaults assumed in this doc)

See the task thread for the numbered list. Answers update this section and remove the
DRAFT status.

## 12. Delivery plan (proposed)

| PR | Scope |
|---|---|
| 1 | Migration (kind, tables, RPCs, validator, edges, content arm), contract types, `forms.*` ops, server services, CLI `tm8 form`, count pins, conformance. |
| 2 | Delivery: `form_response` envelope, `form_deliveries` outbox with drain-on-live, `resume` mode, expiry sweeper, `tm8 form wait`. |
| 3 | UI: panel (Fill/Build/Responses), attention and session-tile entry points, feed card, home rail. |
| 4 | MCP tools, prompt guidance, v1.1 types (`ranking`, `entity_pick`, `file`), drop `session_modals`. |
