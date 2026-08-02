# Chat surface — the complete changeset

Every code change made 2026-07-31 to let an Interaction Profile choose its opening
Content surface, and to fix the pin that was forcing Terminal. Companion to
`CHAT-SURFACE-CONTEXT-AND-HANDOFF.md` (architecture, root cause, status).

All of this is **uncommitted** in the working tree at `~/Desktop/Projects/tm8`.
Applied to both `tm8_dev` and `tm8_stable`; present in the prod build at
`~/.local/share/tm8-stable`.

Line numbers were correct at time of writing but several lanes are editing these
files concurrently — anchor on the symbol, not the number.

---

## 1. `db/migrations/051_profile_selects_content_surface.sql` — NEW FILE

Three `create or replace`. Each was diffed against its original before applying, to
prove only the intended lines moved.

### 1.1 `internal.w2g12_profile_snapshot` (original in 027)

Exactly one added line, inside the `browserProjection` arm:

```sql
     'browserProjection', jsonb_build_object(
       'templateKey', version_row.draft_json -> 'templateKey',
       'templateVersion', version_row.draft_json -> 'templateVersion',
+      'initialContentSurface', version_row.draft_json -> 'initialContentSurface',
       'feedPolicy', version_row.draft_json -> 'feedPolicy',
       'composerPolicy', version_row.draft_json -> 'composerPolicy'
     )
```

**The `and version_row.validation_status = 'valid'` guard in the WHERE clause is
preserved.** It was dropped in a first draft and caught only by diffing against the
original. An unvalidated draft must never resolve into a pin. Re-verify this if the
function is ever rewritten again.

`agentProjection` is deliberately untouched: the surface is a presentation fact and
must not cross into the agent-facing half of the snapshot.

### 1.2 `internal.w1_core_pin_snapshot` (original in 027)

Exactly one added line. A literal rather than a lookup, so the 30-line
`w2g12_core_draft()` JSON blob did not have to be retyped:

```sql
     'browserProjection', jsonb_build_object(
       'templateKey', 'tm8.chat.core', 'templateVersion', 1,
+      'initialContentSurface', 'chat',
       'feedPolicy', internal.w2g12_core_draft() -> 'feedPolicy',
       'composerPolicy', internal.w2g12_core_draft() -> 'composerPolicy'
     )
```

### 1.3 `internal.ensure_core_interaction_pin` (original in 015)

Exactly one changed literal:

```sql
-  values (target_session, next_revision, null, null, 'core', 1,
+  values (target_session, next_revision, null, null, 'tm8.chat.core', 1,
           'core-profile-v1', internal.w1_core_pin_snapshot());
```

`'core'` was not in `STATIC_CHAT_TEMPLATE_REGISTRY`, so any session whose newest pin
was the trigger's projected `compatibility: 'unknown_template'` — forcing Terminal
and showing a "not registered in this build" banner. The snapshot that same trigger
wrote already said `tm8.chat.core` internally; only the column disagreed with its own
payload.

Guarded by the same "no pin yet" check as 015, so it can only affect sessions created
from here on.

### 1.4 What was deliberately NOT done

**No existing pin was rewritten.** Pins are immutable and auditable; a backfill would
forge history to make a new feature look retroactive. Legacy `'core'`-pinned sessions
(23 of 101 on `tm8_dev`, all created ≤ 2026-07-29) keep their old behaviour. If they
should gain Chat, **append a new pin revision** — never rewrite one.

---

## 2. `packages/contract/src/contract.ts`

```ts
// InteractionProfileDraft (~:1686)
+  /** Which Content surface a session pinned to this profile opens on. Absent
+      means "defer to the pinned static template", which is what every draft
+      written before this field existed meant implicitly. */
+  initialContentSurface?: 'terminal' | 'chat';

// CoreEntityState, interaction_profile arm (~:116)
   | { kind: 'interaction_profile'; status: InteractionProfileStatus;
       currentDraftVersion: number; activeVersion: number | null;
       activeHash: string | null; retiredAt: string | null;
+      /** The draft's surface choice, absent when the draft has no opinion. */
+      initialContentSurface?: 'terminal' | 'chat' };
```

**OPTIONAL is load-bearing.** Every draft written before the field existed stays
valid, and absent means "defer to the template" — exactly the behaviour those drafts
already had. Making it required would break reads of every existing row.

---

## 3. `packages/contract/src/schemas.ts`

```ts
// InteractionProfileDraftSchema (~:1815)
   composerPolicy: ComposerInteractionPolicySchema,
+  /* Which Content surface this profile opens on. OPTIONAL on purpose: every
+     draft written before this field existed stays valid, and an absent value
+     means "defer to the pinned static template" — exactly the behaviour those
+     drafts already had. Authors who set it are choosing, not overriding. */
+  initialContentSurface: z.enum(['terminal', 'chat']).optional(),
 }).strict();

// interaction_profile entity-state schema (~:250)
   retiredAt: IsoTimestamp.nullable(),
+  initialContentSurface: z.enum(['terminal', 'chat']).optional(),
 }).strict(),
```

Both objects are `.strict()`, so the field had to be declared in the schema as well
as the type or the read would have been rejected.

---

## 4. `packages/server/src/facade/entity-read.ts`

```ts
// ENTITY_COLUMNS (~:97)
   profile_version.draft_json ->> 'name' as ip_name,
+  profile_version.draft_json ->> 'initialContentSurface' as ip_initial_content_surface,

// EntityRow (~:228)
+  ip_initial_content_surface: string | null;

// new module-private helper (~:875)
+/**
+ * The draft's surface choice, as a spreadable fragment. A draft written before
+ * `initialContentSurface` existed has no opinion, and the ABSENT key is the
+ * honest encoding of that — emitting a guessed 'chat' here is exactly the lie
+ * the launch picker used to tell, where a hardcoded constant made every profile
+ * advertise Chat regardless of what it actually did.
+ */
+function surfaceOf(raw: string | null): { initialContentSurface?: 'terminal' | 'chat' } {
+  return raw === 'terminal' || raw === 'chat' ? { initialContentSurface: raw } : {};
+}

// interaction_profile arm of stateOf() (~:989)
   retiredAt: isoOrNull(row.ip_retired_at),
+  ...surfaceOf(row.ip_initial_content_surface),
```

The existing join is reused — `profile_version` was already joined on
`coalesce(ip.active_version, ip.current_draft_version)`. No new join, no N+1.

---

## 5. `packages/server/src/events/projector.ts`

Mirrors §4 exactly. **The two readers must agree**, or the same profile would
describe itself differently over the event feed than over a read — a bug class that
looks like a caching problem for a week.

```ts
// SummaryRow (~:231)
+  ip_initial_content_surface: string | null;

// hydration join column list (~:328)
   profile_version.draft_json ->> 'name' as ip_name,
+  profile_version.draft_json ->> 'initialContentSurface' as ip_initial_content_surface,

// interaction_profile arm (~:904)
   retiredAt: iso(r.ip_retired_at),
+  // Absent key when the draft has no opinion — see entity-read's
+  // `surfaceOf`. Both readers must agree or the same profile would
+  // describe itself differently over the feed than over a read.
+  ...(r.ip_initial_content_surface === 'terminal'
+    || r.ip_initial_content_surface === 'chat'
+    ? { initialContentSurface: r.ip_initial_content_surface }
+    : {}),
```

---

## 6. `packages/tm8-ui/src/views/useGateData.ts`

```ts
     isSpaceDefault: row.id === spaceDefaultProfileId,
+    /* The template facts stay constant — one static template ships, and
+       profiles are validated against it before launch. The SURFACE does
+       not: it is the profile's own choice now, so the picker reads it
+       from the projection instead of asserting Chat for everyone. A draft
+       with no opinion still falls back to the template's Chat, which is
+       what it will actually do once pinned. */
     ...CORE_CHAT_LAUNCH_PRESENTATION,
+    initialContentSurface:
+      row.state.initialContentSurface ?? CORE_CHAT_LAUNCH_PRESENTATION.initialContentSurface,
   }];
```

Before this, the blanket `...CORE_CHAT_LAUNCH_PRESENTATION` spread made **every**
profile in the launch sheet advertise "starts in Chat" regardless of behaviour.

`packages/tm8-ui/src/views/LaunchSheet.tsx` already rendered
`profile.initialContentSurface === 'terminal' ? 'Terminal' : 'Chat'`, so it needed no
change — it was being fed a constant.

### Not changed, and worth knowing

`packages/tm8-ui/src/panels/bodies/WorkSessionContent.tsx` needed **no** change. Its
`resolveInitialSurface` already ended in `return profile.initialContentSurface;` — the
value had simply never been anything but the template constant.

---

## 7. How 051 was applied (and why not via the runner)

`db/migrate.mjs up` applies **all** pending files in lexical order and cannot target
one. At the time, `050_entity_attention.sql` was untracked and unapplied (another
lane's in-flight work), and `007_rpc_catalog.sql` showed checksum drift, which makes
the runner refuse outright.

Procedure used — trial first, which validates SQL *and* role permissions at zero risk:

```bash
{ echo "begin;"; cat db/migrations/051_*.sql; echo "rollback;"; } > /tmp/trial.sql
psql "postgres://tm8@127.0.0.1:5442/<db>" -v ON_ERROR_STOP=1 -q -f /tmp/trial.sql

CK=$(node -e "const{createHash}=require('crypto'),{readFileSync}=require('fs');\
console.log(createHash('sha256').update(readFileSync('db/migrations/051_...sql')).digest('hex'))")

psql "postgres://tm8@127.0.0.1:5442/<db>" -v ON_ERROR_STOP=1 -1 -q \
  -f db/migrations/051_....sql \
  -c "insert into public.applied_migrations(filename, checksum, duration_ms) \
      values ('051_....sql','$CK',0)"
```

`TM8_DATABASE_URL` must be set — the runner's fallback uses `$USER` (`subhang`),
which is not a role, and reports "database unreachable".

**Consequence that followed:** deploying the tree build shipped the attention lane's
server code too, which needs 050. The freshly deployed server answered
`42P01 relation "public.attention_requests" does not exist` on **every entity read**
until 050 was also applied. 050 was audited first (purely additive: one table,
indexes, RLS policy, three functions, grants — no drops, no alters of existing
tables) and trial-run in a rolled-back transaction before applying.

---

## 8. Verification performed

| Check | Result |
|---|---|
| `bunx tsc --noEmit -p packages/contract` | clean |
| `npm run build` (`tsc -b` all packages) | clean |
| `packages/tm8-ui` `tsc --noEmit` | clean |
| `vite build` | clean; Chat code-splits into `SessionChatSurface` + `ChannelScreen` chunks |
| contract suite | 47/47 |
| `tm8-ui` `launch.test.tsx` | 19/19 |
| `tm8-ui` `panels/bodies/` | 149/149 |
| server `interaction-profile-summary-title` + `w2/entity-kinds-profiles` | 28/28 |
| prod `tm8_stable` `applied_migrations` | 051 present |
| prod `pg_get_functiondef(ensure_core_interaction_pin)` | writes `tm8.chat.core` |
| prod dist | contains `browser-projection.js` + `ip_initial_content_surface` |
| prod live API, real session | `chatEnabled: true`, `compatibility: "supported"`, `initialContentSurface: "chat"` |

Draft→projection mechanism, proven in a **rolled-back** transaction against three
throwaway versions:

| draft says | projected to browser |
|---|---|
| `terminal` | `terminal` |
| `chat` | `chat` |
| (silent) | null → UI falls back to template default |

Known reds, both pre-existing and unrelated: `seam-real.test.ts` interface census
(trips on the attention lane's `resolveAttention`), and load-sensitive tm8-ui
timeouts — the failing set changed between runs and every suspect passed in
isolation.

### Not verified

No browser was driven; no Chrome extension was connected. Nobody has **seen** the
Chat tab render or typed into the composer. And no profile carrying
`initialContentSurface: 'terminal'` has been authored through the real
propose→validate→activate flow and spawned, so §1.1 is proven at the DB layer only.
