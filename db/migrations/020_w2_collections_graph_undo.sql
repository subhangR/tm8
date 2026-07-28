-- =============================================================================
-- 020 — W2.G05 collection/graph/undo database boundary.
--
-- Collection and graph projections need no new relation: they read the shipped
-- graph through tm8_app RLS. This migration tightens the existing opaque undo
-- registry and replaces its RPC with an idempotent, actor-authorized redemption
-- path. No handoff operation is in the inverse allowlist: row-8 delivery is an
-- irreversible historical fact, not a reversible graph edit.
--
-- W2.X01 adds one more registered inverse: `messages.delete`, the honest token
-- 018 already issues for an `embed` placement, redeemed through 019's
-- `w2_tombstone_message`. The allowlist stays an explicit enumeration of
-- reversible operations for exactly the reason above — handoff and delivery
-- facts must never become undoable by widening it.
-- =============================================================================
set role tm8_graph_owner;

alter table public.undo_tokens
  add column redemption_client_mutation_id text,
  add constraint undo_tokens_redemption_cmid_check
    check (redemption_client_mutation_id is null
           or char_length(btrim(redemption_client_mutation_id)) between 1 and 200),
  add constraint undo_tokens_registered_inverse_check
    check (operation in ('edges.delete', 'entities.move', 'entities.restore',
                         'messages.delete'));

create unique index undo_tokens_redemption_cmid_idx
  on public.undo_tokens(redemption_client_mutation_id)
  where redemption_client_mutation_id is not null;

drop function public.undo_command(text, uuid);

-- Redeem only a live registered token. The command-ledger reservation happens
-- in the same transaction as the row lock, redemption mark, and inverse RPC:
-- any failed authorization/expiry/inverse rolls all four back together.
create function public.undo_command(
  p_token text,
  p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
declare
  undo_row public.undo_tokens;
  args jsonb;
  actor uuid;
  replay jsonb;
  inverse_result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'commands.undo');

  -- The row lock serializes distinct mutation ids aimed at one token. For the
  -- same mutation id, ledger_replay serializes first and the retry reaches this
  -- lock only after the winner committed its result.
  select * into undo_row
    from public.undo_tokens
   where undo_tokens.token = p_token
   for update;
  if undo_row.token is null then
    raise exception 'undo token not found' using errcode = 'P0002';
  end if;

  perform internal.require_space_member(undo_row.space_id);
  if p_actor_id is not null or internal.actor_id() is not null then
    actor := internal.resolve_actor(p_actor_id, undo_row.space_id);
    if actor <> undo_row.actor_id then
      raise exception 'only the original actor may undo this' using errcode = '42501';
    end if;
  else
    if not internal.can_act_as(undo_row.actor_id, undo_row.space_id) then
      raise exception 'only the original actor may undo this' using errcode = '42501';
    end if;
    actor := undo_row.actor_id;
  end if;
  perform internal.bind_actor(actor);

  if replay is not null then
    if undo_row.redemption_client_mutation_id is distinct from p_client_mutation_id then
      raise exception 'client mutation id does not redeem this token' using errcode = '23514';
    end if;
    return replay;
  end if;

  if undo_row.redeemed_at is not null then
    raise exception 'undo token already redeemed' using errcode = '23514';
  end if;
  if undo_row.expires_at < now() then
    raise exception 'undo token expired' using errcode = '23514';
  end if;

  update public.undo_tokens
     set redeemed_at = now(),
         redemption_client_mutation_id = nullif(btrim(p_client_mutation_id), '')
   where undo_tokens.token = p_token;

  args := undo_row.arguments;
  case undo_row.operation
    when 'edges.delete' then
      inverse_result := public.delete_edge(
        (args ->> 'edgeId')::uuid,
        undo_row.actor_id,
        null
      );
    when 'entities.move' then
      inverse_result := public.move_entity(
        (args ->> 'entityId')::uuid,
        (args ->> 'parentId')::uuid,
        (args ->> 'position')::double precision,
        (args ->> 'expectedVersion')::integer,
        undo_row.actor_id,
        null
      );
    when 'entities.restore' then
      inverse_result := public.restore_entity(
        (args ->> 'entityId')::uuid,
        undo_row.actor_id,
        null
      );
    when 'messages.delete' then
      -- Inverse of the embed placement (018): `placements.apply` with `embed`
      -- posts a message, so undoing it tombstones that message through 019's
      -- RPC. Tombstoning is a state transition, not a destructive delete —
      -- thread history survives. Expected version is null on purpose: like the
      -- other registered inverses this replays a known inverse unconditionally
      -- rather than re-running the caller's optimistic-concurrency check.
      inverse_result := public.w2_tombstone_message(
        (args ->> 'messageId')::uuid,
        null,
        undo_row.actor_id,
        null
      );
    else
      -- Defensive even though the table constraint makes this unreachable.
      raise exception 'no inverse registered for %', undo_row.operation using errcode = '0A000';
  end case;

  return internal.ledger_record(
    p_client_mutation_id,
    'commands.undo',
    inverse_result
  );
end
$$;

revoke all on function public.undo_command(text, uuid, text) from public;
grant execute on function public.undo_command(text, uuid, text) to tm8_app;

reset role;
