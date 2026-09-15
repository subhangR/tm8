-- 185 — WHAT A SESSION COST, from the agent's own transcript, recorded once
-- at exit.
--
-- Measured 2026-09-15 on this node (prod DB + the transcripts on disk):
--   * work_sessions carries no usage or cost column; the only usage reader
--     (`execution.transcript` → collectStats) is window-bounded by contract,
--     is never persisted, and its input evaporates — 46.8% of ended
--     claude-code sessions' transcripts were already gone.
--   * that reader over-counted by 2.09x: the harness writes one record per
--     content block and every record of a streamed message repeats the same
--     cumulative `usage`; 67,552 usage records were 32,396 API messages.
--   * the harness's own `cost-state` record (present on 86/311 files) agreed
--     exactly with the de-duplicated transcript sum on 22/86, median 0.94 —
--     neither number is "the truth", so BOTH are stored, with provenance.
-- chat_turns already stores usage/usage_source/total_cost_usd for the headless
-- chat runtime; this is the same fact for PTY-hosted agents, whose usage lives
-- in their JSONL transcript and nowhere else.
--
-- THREE COLUMNS, NULLABLE, NEVER DEFAULTED — 107/171's rule. NULL means the
-- session was never measured (pre-185 row, still running, transcript gone
-- before exit, or on another node) and MUST render as no claim. A `{}` or a
-- zero here would say "this session cost nothing", which is a lie.
--
--   usage             — the document. Two halves: `transcript` (de-duplicated
--                       per message: tokens by model and by cache tier,
--                       messages, turns, tools, compactions, first/last-turn
--                       context, last stop_reason) and `harness` (the CLI's
--                       own cost-state: per-model tokens and USD, as the
--                       harness reported it — NEVER computed by tm8, which
--                       has no rate table). Shape is owned by
--                       packages/execution/src/transcript/session-usage.ts.
--   usage_source      — which dialect the document was read from. The two
--                       dialects do not share token semantics (codex's
--                       input_tokens includes its cached tokens; claude's does
--                       not), so nothing may sum across sessions without
--                       grouping by this.
--   usage_recorded_at — when the read happened. Every exit path re-reads and
--                       overwrites: the file is write-once per native session
--                       (062:9) and accumulates across resumes, so a later
--                       read is a superset of an earlier one. NOT cleared on
--                       respawn — 171's clear_ending_on_respawn nulls the
--                       ENDING facts because a respawned session has not
--                       ended again; the conversation's spend so far is
--                       still true.
--
-- NOT AN ENDING CLASS. No `context_exhausted` is added to ended_kind: PTY
-- sessions do not end on context exhaustion — they compact and continue
-- (measured: every transcript with a compaction marker kept running past it)
-- — and the classifier has only exit code, signal and the OOM counter. The
-- evidence (compactions, the largest pre-compaction prefix, the last turn's
-- context size, a trailing API error) goes in `usage` as facts, and
-- ended_kind keeps saying only what the process evidence supports.

alter table public.work_sessions add column if not exists usage jsonb;
alter table public.work_sessions add column if not exists usage_source text;
alter table public.work_sessions add column if not exists usage_recorded_at timestamptz;

do $$ begin
  alter table public.work_sessions add constraint work_sessions_usage_source_check
    check (usage_source is null or usage_source in ('claude_transcript', 'codex_rollout'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.work_sessions add constraint work_sessions_usage_object_check
    check (usage is null or jsonb_typeof(usage) = 'object');
exception when duplicate_object then null; end $$;

-- The three travel together: a document with no source cannot be read, and a
-- source with no document is a claim about nothing.
do $$ begin
  alter table public.work_sessions add constraint work_sessions_usage_together_check
    check ((usage is null) = (usage_source is null) and (usage is null) = (usage_recorded_at is null));
exception when duplicate_object then null; end $$;

comment on column public.work_sessions.usage is
  'Whole-conversation provider usage read from the agent''s own transcript at '
  'exit (packages/execution/src/transcript/session-usage.ts owns the shape). '
  'Two provenances, never merged: `transcript` (de-duplicated per API message) '
  'and `harness` (the CLI''s cost-state, USD as IT reported it — tm8 computes '
  'no cost). NULL = never measured (pre-185, still running, transcript gone) '
  'and must render as no claim, never as zero. Cumulative over the write-once '
  'native transcript; NOT cleared on respawn.';

comment on column public.work_sessions.usage_source is
  'Which dialect `usage` was read from: claude_transcript | codex_rollout. '
  'Token semantics differ between the two (codex input_tokens includes cached '
  'tokens; claude''s does not), so never sum across sessions without grouping '
  'by this. NULL iff `usage` is NULL.';

comment on column public.work_sessions.usage_recorded_at is
  'When the exit-time read happened. Every exit path re-reads and overwrites, '
  'so this moves forward across resumes. NULL iff `usage` is NULL.';

-- --- the writer ----------------------------------------------------------------
--
-- A SEPARATE FUNCTION, deliberately NOT a ninth parameter on
-- public.work_session_transition. That function is R29's single writer of
-- STATUS; 171:57-63 explains why a defaulted extra parameter breaks every
-- positional caller ('function is not unique') and forces DROP + CREATE, and
-- 171:150-153 / 177 show the PUBLIC-grant trap that comes with it. Usage is a
-- different fact with a different lifetime (cumulative, not cleared on
-- respawn), written AFTER the ending by a caller that swallows its own
-- failure. 001's status guard is `before update of status` only, so writing
-- these columns does not go through it — the same standing 062 and 107 rely on.
--
-- Shape mirrors 107's execution_record_checkout_branch: live entity, space
-- membership, then the write and a version bump so the summary state and
-- the event feed see the fact by version. `activity_at` is deliberately not
-- touched: measuring a dead session is not activity, and it must not reorder
-- session lists.

create or replace function public.record_work_session_usage(
  p_session_id uuid, p_usage jsonb, p_usage_source text
) returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
begin
  if p_usage is null or jsonb_typeof(p_usage) <> 'object' then
    raise exception 'usage must be a JSON object' using errcode = '22023';
  end if;
  if p_usage_source is null or p_usage_source not in ('claude_transcript', 'codex_rollout') then
    raise exception 'usage_source must be claude_transcript or codex_rollout, got %',
      coalesce(p_usage_source, '<null>') using errcode = '22023';
  end if;
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);

  update public.work_sessions
     set usage = p_usage,
         usage_source = p_usage_source,
         usage_recorded_at = now()
   where entity_id = p_session_id;
  if not found then
    return false;
  end if;

  update public.entities
     set version = version + 1, updated_at = now()
   where id = p_session_id;
  return true;
end
$$;

revoke all on function public.record_work_session_usage(uuid, jsonb, text) from public;
grant execute on function public.record_work_session_usage(uuid, jsonb, text) to tm8_app;
