-- =============================================================================
-- 073 — the composed launch prompts become durable.
--
-- THE OBSERVED GAP. Everything about how a session was configured is already
-- persisted: `public.session_manifests.manifest` carries the persona, the
-- resolved launch posture, the command network policy, the workdir/project and
-- its trust, the interaction-profile pin and the task list, and
-- `env_var_names` carries the environment's KEYS. One thing is not persisted
-- and it is the single most load-bearing input the agent ever receives: the
-- SYSTEM PROMPT, plus the TASK prompt that is its first user turn. Both are
-- composed in memory by `composePrompt(manifest, …)` in SpawnService, appended
-- straight onto the child's argv (`--append-system-prompt` / the positional for
-- Claude; `-c developer_instructions=` / the positional for Codex), and then
-- lost the moment the process starts. Nothing — not the manifest row, not the
-- manifest file, not the command ledger — records what the agent was actually
-- told.
--
-- WHY STORE RATHER THAN RECOMPOSE ON READ. `composePrompt` is a pure function
-- of the stored manifest, so a reader COULD re-derive the text. That is exactly
-- the trap: recomposition answers "what would this build send today", not "what
-- was this agent sent", and the two silently diverge the first time the
-- composer changes — while still rendering as a confident verbatim quote. A
-- debug surface that shows a plausible reconstruction of a prompt an agent
-- never received is worse than one that shows nothing. So the bytes are stored
-- at the moment they are handed to the PTY, and a session that predates this
-- migration renders an explained empty instead of a guess.
--
-- NULLABLE ON PURPOSE, AND NOT BACKFILLED. Every session spawned before this
-- file ran has no recoverable prompt: the text was never written anywhere, the
-- PTY argv is gone with the process, and the manifest alone cannot distinguish
-- "composed by the build that ran" from "composed by the build reading it".
-- NULL is the honest answer and the read surface must say why.
--
-- RESUME DELIBERATELY DOES NOT REWRITE THESE. `SpawnService.resume` already
-- declines to re-record the manifest ROW (it documents the ORIGINAL launch;
-- the resume's exact command is in the ledger). The prompts follow the same
-- rule and for the same reason — this row describes one launch, the first one,
-- and a resume that quietly overwrote it would erase the only record of what
-- the session was originally told.
--
-- ⚠ SHARED-OBJECT NOTICE (the 052/053/055/056/057/065/066 rule, continued).
-- §3 does `create or replace function internal.guard_manifest_secrets`. That
-- swaps the ENTIRE body. The base text here is copied verbatim from 006 — the
-- only definition in the tree, verified by grep across db/migrations — plus one
-- arm covering the two new columns. WHOEVER TOUCHES THIS FUNCTION NEXT MUST
-- COPY THIS FILE'S BODY.
--
-- ⚠ SIGNATURE CHANGE, not an overload. §2 DROPS the 3-argument
-- `record_session_manifest` before creating the 5-argument one. Adding the two
-- parameters with defaults while leaving the old function in place would make
-- every existing 3-argument call ambiguous ("function is not unique", 42725) —
-- which is to say it would break every spawn on the node. The blanket
-- `grant execute on all functions in schema public to tm8_app` in 008 applies
-- to functions that existed then, so the new signature is granted explicitly,
-- the way 048/062 do for the same reason.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The columns.
--
--    `text`, not jsonb: these are prompt BYTES handed to a CLI, and the one
--    property that matters is that what comes back out is what went in. Wrapping
--    them in a json document would add an encoding round-trip between the agent
--    and the person reading what the agent was told.
-- -----------------------------------------------------------------------------
alter table public.session_manifests
  add column if not exists system_prompt text,
  add column if not exists task_prompt   text;

comment on column public.session_manifests.system_prompt is
  'Verbatim system prompt handed to the agent at spawn (--append-system-prompt / '
  'developer_instructions). NULL means it was never recorded — a session spawned '
  'before migration 073 — and must never be presented as an empty prompt.';
comment on column public.session_manifests.task_prompt is
  'Verbatim first user turn handed to the agent at spawn (the CLI positional). '
  'NULL has the same meaning as for system_prompt.';

-- -----------------------------------------------------------------------------
-- 2. record_session_manifest — same behaviour, two more recorded facts.
--
--    The prompts are trimmed to NULL when blank so "the caller passed an empty
--    string" and "there was no prompt" cannot be told apart downstream by
--    accident: both mean the agent received nothing on that channel, and the
--    read surface distinguishes THAT from "never recorded" using the column
--    being absent for pre-073 rows.
-- -----------------------------------------------------------------------------
drop function if exists public.record_session_manifest(uuid, jsonb, text[]);

create or replace function public.record_session_manifest(
  p_session_id uuid, p_manifest jsonb, p_env_var_names text[] default '{}'::text[],
  p_system_prompt text default null, p_task_prompt text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare e public.entities;
begin
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  insert into public.session_manifests(
    work_session_id, manifest, env_var_names, system_prompt, task_prompt)
  values (
    p_session_id, p_manifest, coalesce(p_env_var_names, '{}'::text[]),
    nullif(p_system_prompt, ''), nullif(p_task_prompt, ''))
  on conflict (work_session_id) do update
    set manifest      = excluded.manifest,
        env_var_names = excluded.env_var_names,
        -- A caller that passes nothing must not ERASE a recorded prompt. Only a
        -- re-record that actually carries text replaces it.
        system_prompt = coalesce(excluded.system_prompt, session_manifests.system_prompt),
        task_prompt   = coalesce(excluded.task_prompt, session_manifests.task_prompt);
  return jsonb_build_object('workSessionId', p_session_id);
end
$$;

-- `create function` grants EXECUTE to PUBLIC by default, and the blanket
-- `revoke ... from public` in 007 ran BEFORE this file exists — so recreating
-- the function silently re-opens it to every role, including the delivery
-- worker whose surface is pinned at exactly three functions. Revoke first,
-- then name the one role that may call it.
revoke all on function
  public.record_session_manifest(uuid, jsonb, text[], text, text) from public;
grant execute on function
  public.record_session_manifest(uuid, jsonb, text[], text, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 3. internal.guard_manifest_secrets — VERBATIM 006 BODY + one arm for the two
--    new columns. See the shared-object notice above.
--
--    S15 is a property of the TABLE, not of the `manifest` column: a credential
--    smuggled into a persona's identity text would reach Postgres through the
--    prompt just as readily as through the manifest, and the whole point of the
--    guard is that pg_dump backups are secret-free BY CONSTRUCTION. The prompt
--    is composed FROM the manifest, so in practice anything the new arm can
--    catch the old one would have caught first — which is the argument for
--    adding it, not against: a guard with a hole is only as good as the reason
--    the hole is currently unreachable.
-- -----------------------------------------------------------------------------
create or replace function internal.guard_manifest_secrets() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  rendered text := new.manifest::text;
  secret_pattern constant text :=
    '(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})';
begin
  if rendered ~ secret_pattern then
    raise exception 'manifest appears to contain a credential value'
      using errcode = '23514',
            detail = 'session_manifests stores env var NAMES, never values (S15)';
  end if;
  -- 073: the launch prompts are covered by the same rule as the manifest.
  if coalesce(new.system_prompt, '') ~ secret_pattern
     or coalesce(new.task_prompt, '') ~ secret_pattern then
    raise exception 'launch prompt appears to contain a credential value'
      using errcode = '23514',
            detail = 'session_manifests stores env var NAMES, never values (S15)';
  end if;
  if exists (
    select 1 from unnest(new.env_var_names) as n
     where n !~ '^[A-Z][A-Z0-9_]{0,80}$'
  ) then
    raise exception 'env_var_names must be environment variable names, not values'
      using errcode = '22023';
  end if;
  return new;
end
$$;

reset role;
