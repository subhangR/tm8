-- `spaces.update` stops counting unread it no longer returns.
--
-- `SpaceSummary.unreadTotal` is now `null` on every path that builds one — the
-- count came off `SPACE_COLUMNS` (packages/server/src/facade/handlers/spaces.ts)
-- because it cost seconds on `spaces.list`, the request that gates workspace
-- boot. `w2_update_space` builds the same DTO, so its `unread_total` key is now
-- read by nobody: the facade assembler discards it.
--
-- Measured on prod 2026-08-19 (5 spaces / 7 099 entities / 4 542 messages,
-- `set role tm8_app`, inside a rolled-back transaction), the `SPACE_COLUMNS`
-- select this key mirrors costs 4 553 ms / 125 388 shared buffer hits with the
-- unread subquery and 0.5 ms / 30 hits without it. This function's own copy is
-- cheaper than that — since 158 it reads `public.unread_counts`, which PR #433
-- took from 1 290 ms to 46 ms — but 46 ms of work whose result is thrown away
-- one layer up is still 46 ms nobody asked for, and leaving the key in place
-- would leave `spaces.update` as the one response still carrying a number the
-- type now says is not measured.
--
-- The key is DROPPED rather than zeroed. A `'unread_total', 0` would be the
-- exact confusion the DTO change exists to end — a measurement nobody took,
-- shaped like one somebody did. Absent is what "this function does not report
-- unread" looks like in jsonb, and `toSpaceSummary` on the TS side already
-- reads `null` for it.
--
-- `member_count` stays: it is a bitmap index scan on `members`, sub-millisecond
-- on the same measurement, and it IS returned.
--
-- The measured per-space unread total remains `public.unread_counts`, reached
-- through `spaces.navigation` — a lazy per-space read that is not part of boot.
-- Nothing about that function, and no RLS policy, changes here.
--
-- SUPERSEDES 031_w2_sec1_replay_principal_resource_binding.sql:235, NOT
-- 016_w2_identity_spaces.sql:72. This body is 031's verbatim, minus the
-- `unread_total` key. Every line of 031's replay hardening is preserved
-- deliberately and must stay: `internal.require_replay_principal` before the
-- ledger read AND again inside the replay branch (the second call is the
-- security boundary — it runs with the advisory lock held; the first is only a
-- fast path), plus `internal.require_replay_subject` binding the addressed
-- space. Re-issuing 016's body here would silently revert that fix.

create or replace function public.w2_update_space(
  p_space_id uuid,
  p_patch jsonb,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  space_row public.spaces;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.update');
  if replay is not null then
    -- THE SECURITY BOUNDARY. internal.ledger_replay takes
    -- pg_advisory_xact_lock on the cmid and only then selects, so this call
    -- runs with that lock HELD and the recorded row guaranteed visible. The
    -- identical call before ledger_replay is a fast path, NOT the boundary:
    -- it runs unlocked and reads "not found" against a victim's still
    -- uncommitted row. See the TOCTOU note in 031's header.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{space,id}', p_space_id::text, 'space');
    return replay;
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'Space metadata patch must be a non-empty object'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_patch) patch_key
     where patch_key not in ('name', 'description', 'githubRepo')
  ) then
    raise exception 'Space metadata patch contains an unknown field'
      using errcode = '22023';
  end if;
  if p_patch ? 'name' and (
       jsonb_typeof(p_patch -> 'name') <> 'string'
       or char_length(btrim(p_patch ->> 'name')) not between 1 and 200
  ) then
    raise exception 'Space name must contain 1 to 200 characters'
      using errcode = '22023';
  end if;
  if p_patch ? 'description' and jsonb_typeof(p_patch -> 'description') <> 'string' then
    raise exception 'Space description must be a string'
      using errcode = '22023';
  end if;
  if p_patch ? 'githubRepo'
     and jsonb_typeof(p_patch -> 'githubRepo') not in ('string', 'null') then
    raise exception 'githubRepo must be a string or null'
      using errcode = '22023';
  end if;

  perform internal.require_space_admin(p_space_id);
  perform internal.resolve_actor(internal.actor_id(), p_space_id);
  update public.spaces
     set name = case when p_patch ? 'name' then p_patch ->> 'name' else name end,
         description = case
           when p_patch ? 'description' then p_patch ->> 'description'
           else description
         end,
         github_repo = case
           when p_patch ? 'githubRepo' then p_patch ->> 'githubRepo'
           else github_repo
         end
   where id = p_space_id
   returning * into space_row;
  if space_row.id is null then
    raise exception 'space not found' using errcode = 'P0002';
  end if;

  result := jsonb_build_object(
    'space', to_jsonb(space_row) || jsonb_build_object(
      'member_count', (select count(*) from public.members where space_id = p_space_id)
      -- no 'unread_total' — see this file's header
    ),
    'patches', '[]'::jsonb
  );
  return internal.ledger_record(p_client_mutation_id, 'spaces.update', result);
end
$$;
