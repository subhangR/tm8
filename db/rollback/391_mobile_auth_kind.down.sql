-- =============================================================================
-- ROLLBACK for 391_mobile_auth_kind.sql — NOT a migration (db/migrate.mjs never
-- reads this directory). Run by hand, as the migration owner, only to undo 391:
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/391_mobile_auth_kind.down.sql
--   psql "$OWNER_URL" -c "delete from public.applied_migrations where filename = '391_mobile_auth_kind.sql'"
--
-- Puts back the seventeen definitions verbatim and the two CHECK constraints
-- without 'mobile'. It REFUSES while any auth_sessions row has kind 'mobile' or
-- any chat_turns row recorded it: revoking and deleting those sessions signs
-- every phone out, which is the operator's decision, not this script's.
-- =============================================================================

do $guard$
begin
  if exists (select 1 from public.auth_sessions where kind = 'mobile') then
    raise exception 'mobile sessions exist; delete them first (this signs phones out): '
      'delete from public.auth_sessions where kind = ''mobile''';
  end if;
  if exists (select 1 from public.chat_turns where requested_by_auth_kind = 'mobile') then
    raise exception 'chat turns recorded a mobile requester; the old CHECK cannot hold them';
  end if;
end
$guard$;

set role tm8_graph_owner;

alter table public.auth_sessions
  drop constraint if exists auth_sessions_kind_check;
alter table public.auth_sessions
  add constraint auth_sessions_kind_check
  check (kind in ('browser', 'cli', 'agent', 'agent_runtime', 'link'));

alter table public.chat_turns
  drop constraint if exists chat_turns_requested_by_auth_kind_check;
alter table public.chat_turns
  add constraint chat_turns_requested_by_auth_kind_check
  check (requested_by_auth_kind is null or requested_by_auth_kind in ('browser', 'cli'));

-- internal.require_human_auth_kind: 083_credential_sessions.sql verbatim.
create or replace function internal.require_human_auth_kind() returns void
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare kind text;
begin
  kind := internal.claim_text('tm8.auth_kind');
  -- Null, empty and unrecognised all land here. Do not add an `is null` escape:
  -- "we could not tell" must read as "no", or the gate is decorative.
  if kind is null or kind not in ('browser', 'cli') then
    raise exception 'credentials are human-only' using errcode = '42501',
      detail = jsonb_build_object('authKind', coalesce(kind, 'none'))::text;
  end if;
end
$$;

-- public.enter_space: 268_space_logins.sql verbatim.
create or replace function public.enter_space(
  p_space_id uuid,
  p_parent_session_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_label text default null,
  p_space_verifier text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  caller text;
  acct public.accounts;
  parent public.auth_sessions;
  new_kind text := 'browser';
  new_expiry timestamptz := p_expires_at;
  s public.auth_sessions;
begin
  caller := internal.require_identity();
  if nullif(current_setting('tm8.session_space_id', true), '') is not null then
    raise exception 'a space-pinned session cannot enter a space; use the gate session'
      using errcode = '42501';
  end if;
  if coalesce(internal.claim_text('tm8.auth_kind'), '') not in ('browser', 'cli') then
    raise exception 'only a human session can enter a space' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_expires_at is null or p_expires_at <= now() then
    raise exception 'invalid space session credential' using errcode = '22023';
  end if;

  select a.* into acct
    from public.accounts a
   where a.identity_id = caller and a.status = 'active'
   order by a.is_owner desc, a.created_at
   limit 1;
  if acct.id is null then
    raise exception 'account not found or disabled' using errcode = 'P0002';
  end if;

  if p_parent_session_id is not null then
    select s0.* into parent
      from public.auth_sessions s0
     where s0.id = p_parent_session_id
       and s0.revoked_at is null
       and s0.expires_at > now()
       and s0.space_id is null
       and s0.kind in ('browser', 'cli');
    if parent.id is null then
      raise exception 'gate session not found' using errcode = '42501';
    end if;
    select a.* into acct from public.accounts a
     where a.id = parent.account_id and a.identity_id = caller and a.status = 'active';
    if acct.id is null then
      raise exception 'gate session not found' using errcode = '42501';
    end if;
    new_kind := parent.kind;
    new_expiry := least(p_expires_at, parent.expires_at);
  end if;

  -- Membership of the target, read directly (the caller is unpinned, so this
  -- is exactly `is_space_member`). Not-a-member and no-such-space answer the
  -- same so the call is not a space-existence oracle.
  if not exists (
    select 1 from public.members m
     where m.space_id = p_space_id and m.identity_id = caller
       and m.status = 'active'
  ) then
    raise exception 'not a member of that space' using errcode = '42501';
  end if;

  -- 268 (W5, K2): the space password. Required when the space says so, and
  -- always when this account's login for the space is locked. The verifier
  -- must be the one the server checked the password against AND the current
  -- active row's; a null never matches.
  if exists (select 1 from public.spaces sp
              where sp.id = p_space_id and sp.require_space_credential)
     or exists (select 1 from public.space_logins l
                 where l.space_id = p_space_id and l.account_id = acct.id
                   and l.status = 'locked') then
    if not exists (
      select 1 from public.space_logins l
       where l.space_id = p_space_id and l.account_id = acct.id
         and l.status = 'active'
         and l.verifier = p_space_verifier
    ) then
      raise exception 'space password required or not accepted' using errcode = '42501';
    end if;
  end if;

  insert into public.auth_sessions(account_id, kind, token_hash, label, expires_at, space_id, parent_session_id)
  values (acct.id, new_kind, p_token_hash, p_label, new_expiry, p_space_id, parent.id)
  returning * into s;
  return to_jsonb(s) - 'token_hash';
end
$$;

-- public.set_space_require_credential: 268_space_logins.sql verbatim.
create or replace function public.set_space_require_credential(
  p_space_id uuid,
  p_required boolean,
  p_own_verifier text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  acct uuid;
  mine public.space_logins;
  caller_role text;
  unlogged int;
  revoked uuid[] := '{}';
begin
  caller_role := internal.require_space_password_admin(p_space_id);
  if p_required is null then
    raise exception 'required must be true or false' using errcode = '22023';
  end if;
  if p_required then
    -- Turning it on is an owner's act: it changes how every owner gets in.
    if caller_role is distinct from 'owner' then
      raise exception 'only an owner can require a space password' using errcode = '42501';
    end if;
    -- Turning it on must not lock out the admin turning it on.
    acct := internal.space_login_account(internal.identity_id());
    if acct is null then
      raise exception 'account not found or disabled' using errcode = 'P0002';
    end if;
    select l.* into mine from public.space_logins l
     where l.space_id = p_space_id and l.account_id = acct for update;
    if mine.status = 'locked' then
      raise exception 'your space password is locked' using errcode = '42501';
    end if;
    if p_own_verifier is not null then
      perform internal.require_space_verifier(p_own_verifier);
      insert into public.space_logins(space_id, account_id, verifier)
      values (p_space_id, acct, p_own_verifier)
      on conflict (space_id, account_id) do update set verifier = excluded.verifier;
    elsif mine.account_id is null then
      raise exception 'set your own space password to turn this on' using errcode = '22023';
    end if;
    -- ...nor any other owner: every active owner with an active account must
    -- already hold an active login row, or the flip would shut that owner out
    -- of their own space. (An owner identity with no active account cannot
    -- enter any space, password or not, so it has nothing to be shut out of.)
    select count(*) into unlogged
      from (select internal.space_login_account(m.identity_id) as account_id
              from public.members m
             where m.space_id = p_space_id and m.role = 'owner' and m.status = 'active') o
     where o.account_id is not null
       and not exists (
         select 1 from public.space_logins l
          where l.space_id = p_space_id and l.account_id = o.account_id
            and l.status = 'active');
    if unlogged > 0 then
      raise exception 'every owner of this space needs an active space password first'
        using errcode = '42501';
    end if;
    -- Sessions already pinned to this space were entered without a password.
    -- End them (browser and cli only — agent sessions are never pinned by
    -- enter_space), exactly as reset and lock do; the caller's own included,
    -- so every live session in the space has passed the password it now needs.
    with ended as (
      update public.auth_sessions s set revoked_at = now()
       where s.space_id = p_space_id and s.kind in ('browser', 'cli')
         and s.revoked_at is null
      returning s.id
    )
    select coalesce(array_agg(id), '{}') into revoked from ended;
  end if;
  perform set_config('tm8.space_password_writer', 'on', true);
  update public.spaces set require_space_credential = p_required where id = p_space_id;
  perform set_config('tm8.space_password_writer', '', true);
  return jsonb_build_object('spaceId', p_space_id, 'requireSpacePassword', p_required,
    'revokedSessionIds', to_jsonb(revoked));
end
$$;

-- public.w2_post_message_batch: 176_chat_entity.sql verbatim.
create or replace function public.w2_post_message_batch(
  p_anchor_ids uuid[], p_body text, p_parent_message_id uuid default null,
  p_mention_ids uuid[] default '{}'::uuid[], p_attachment_ids uuid[] default '{}'::uuid[],
  p_source_work_session_id uuid default null, p_actor_id uuid default null,
  p_client_mutation_id text default null, p_chat_turn_mode text default null,
  p_source_chat_id uuid default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb; anchors uuid[]; mentions uuid[]; files uuid[]; anchor_count integer;
  first_anchor public.entities; anchor public.entities; parent public.messages;
  parent_envelope public.entities; target_space uuid; actor uuid; thread_root uuid;
  mention_json jsonb; attachment_json jsonb; message_ids uuid[]:='{}'::uuid[];
  message_id uuid; stable_hash text; replay_hash text; replay_author uuid; replay_space uuid;
  delivery_intents jsonb:='[]'::jsonb; require_space_files boolean:=false; result jsonb;
  turn_mode text;
  -- 176. A message may name at most one source, and a chat anchor queues a turn
  -- for whoever wrote it.
  source_chat public.chats; chat_anchor public.chats;
  queued_turn_id uuid; actor_kind text; queue_auth_kind text;
begin
  if p_client_mutation_id is null or btrim(p_client_mutation_id)='' then
    raise exception 'clientMutationId is required' using errcode='22023';
  end if;
  if p_body is null or char_length(p_body) not between 1 and 10000 then
    raise exception 'message body must contain 1..10000 characters' using errcode='22023';
  end if;
  -- The per-turn chat mode. NULL is legal and means "no request" (the thread
  -- default resolves at claim time). A non-NULL value that is NOT one of the six
  -- modes FAILS LOUD, exactly like the clientMutationId and body guards above —
  -- so a seventh mode added to the ChatMode enum and the composer but missed in
  -- this list surfaces as an error instead of every send silently falling back
  -- to the thread default. Only meaningful for a chat-thread anchor; harmless
  -- (but still validated) on any other message.
  if p_chat_turn_mode is not null
     and p_chat_turn_mode not in ('ask','explain','plan','build','orchestrate','craft') then
    raise exception 'unknown chat turn mode: %', p_chat_turn_mode using errcode='22023';
  end if;
  -- ONE SOURCE PER MESSAGE, refused here rather than resolved by precedence.
  -- `edges_authored_from_source_idx` already makes one authored_from per source
  -- entity a hard rule; a batch naming two sources would either violate it or
  -- silently drop one, and "silently drop one" is how provenance becomes a
  -- guess. 42501-worthy? No: this is a malformed request, not a denied one.
  if p_source_work_session_id is not null and p_source_chat_id is not null then
    raise exception 'a message has one source: name a work session or a chat, not both'
      using errcode='22023';
  end if;
  turn_mode := p_chat_turn_mode;
  select coalesce(array_agg(value order by value),'{}'::uuid[]) into anchors
    from unnest(coalesce(p_anchor_ids,'{}'::uuid[])) item(value);
  select coalesce(array_agg(value order by value),'{}'::uuid[]) into mentions
    from unnest(coalesce(p_mention_ids,'{}'::uuid[])) item(value);
  select coalesce(array_agg(value order by value),'{}'::uuid[]) into files
    from unnest(coalesce(p_attachment_ids,'{}'::uuid[])) item(value);
  anchor_count:=cardinality(anchors);
  if anchor_count not between 1 and 16 or anchor_count<>cardinality(coalesce(p_anchor_ids,'{}'::uuid[]))
     or cardinality(mentions)>16 or cardinality(mentions)<>cardinality(coalesce(p_mention_ids,'{}'::uuid[]))
     or cardinality(files)>16 or cardinality(files)<>cardinality(coalesce(p_attachment_ids,'{}'::uuid[])) then
    raise exception 'message batch requires bounded unique anchors, mentions, and files' using errcode='22023';
  end if;
  if anchor_count*cardinality(files)>64 then
    raise exception 'anchor by attachment pair limit exceeded' using errcode='54000';
  end if;
  if octet_length(convert_to(jsonb_build_object(
      'anchorIds',anchors,'body',p_body,'parentMessageId',p_parent_message_id,
      'mentionIds',mentions,'attachmentIds',files,'actorId',p_actor_id
    )::text,'UTF8'))>262144 then
    raise exception 'canonical message request exceeds 256 KiB' using errcode='54000';
  end if;

  replay:=internal.ledger_replay(p_client_mutation_id,'messages.post');
  if replay is not null then
    replay_author:=nullif(replay#>>'{_audit,authorId}','')::uuid;
    replay_space:=nullif(replay#>>'{_audit,spaceId}','')::uuid;
    replay_hash:=internal.w2_message_batch_hash(
      internal.identity_id(),p_actor_id,replay_author,replay_space,
      anchors,p_body,p_parent_message_id,mentions,files);
    if replay_hash is distinct from replay->>'_stableHash' then
      raise exception 'message batch identity mismatch' using errcode='23514',
        detail='message_batch_identity_mismatch';
    end if;
    return replay;
  end if;

  perform 1 from public.entities e where e.id=any(anchors) order by e.id for update;
  if (select count(*) from public.entities e
       where e.id=any(anchors) and e.deleted_at is null and internal.entity_readable(e.id))<>anchor_count then
    raise exception 'message anchor not found' using errcode='P0002';
  end if;
  select * into first_anchor from public.entities where id=anchors[1];
  target_space:=first_anchor.space_id;
  if exists(select 1 from public.entities e where e.id=any(anchors) and e.space_id<>target_space) then
    raise exception 'message anchors must share one Space' using errcode='23514';
  end if;
  require_space_files:=exists(select 1 from public.entities e where e.id=any(anchors) and e.visibility='space');
  perform internal.require_space_member(target_space);
  actor:=internal.resolve_actor(p_actor_id,target_space);
  perform internal.bind_actor(actor);

  if p_parent_message_id is not null then
    if anchor_count<>1 then raise exception 'a reply has exactly one anchor' using errcode='22023'; end if;
    perform 1 from public.entities where id=p_parent_message_id for update;
    select * into parent from public.messages where entity_id=p_parent_message_id;
    select * into parent_envelope from public.entities where id=p_parent_message_id;
    if parent.entity_id is null or not internal.entity_readable(parent.entity_id) then
      raise exception 'parent message not found' using errcode='P0002';
    end if;
    if parent.anchor_id<>anchors[1] then
      raise exception 'reply anchor must equal parent anchor' using errcode='23514';
    end if;
    thread_root:=coalesce(parent.root_message_id,parent.entity_id);
  end if;

  perform 1 from public.entities e where e.id=any(files) order by e.id for update;
  mention_json:=internal.w2_resolve_mentions(mentions,target_space);
  attachment_json:=internal.w2_validate_attachment_files(files,target_space,require_space_files);

  if p_source_work_session_id is not null then
    perform 1 from public.entities e join public.work_sessions ws on ws.entity_id=e.id
     where e.id=p_source_work_session_id and e.space_id=target_space and e.deleted_at is null
       and exists(select 1 from public.edges edge where edge.src_id=actor
                   and edge.dst_id=p_source_work_session_id and edge.type='participates_in')
     for update;
    if not found then
      raise exception 'authored_from provenance does not match the resolved author session'
        using errcode='42501';
    end if;
  end if;

  -- The chat analogue of the check above. A session proves provenance with a
  -- `participates_in` edge from the author; a chat's author IS its bound
  -- teammate, so the binding edge is the same proof in the shape chat has. The
  -- server never takes this id from request input — it comes off the bearer's
  -- own `runtime_chat_id` row — but the door is authorized independently, so a
  -- future caller cannot claim a chat it does not run.
  if p_source_chat_id is not null then
    select c.* into source_chat
      from public.chats c
      join public.entities e on e.id=c.entity_id
     where c.entity_id=p_source_chat_id and e.space_id=target_space and e.deleted_at is null
     for update of c;
    if source_chat.entity_id is null or source_chat.teammate_id<>actor then
      raise exception 'authored_from provenance does not match the resolved author chat'
        using errcode='42501';
    end if;
  end if;

  stable_hash:=internal.w2_message_batch_hash(
    internal.identity_id(),p_actor_id,actor,target_space,
    anchors,p_body,p_parent_message_id,mentions,files);

  foreach message_id in array anchors loop
    select * into anchor from public.entities where id=message_id;
    message_id:=internal.new_id();
    insert into public.entities(id,space_id,kind,parent_id,position,created_by,visibility)
    values(message_id,target_space,'message',p_parent_message_id,null,actor,anchor.visibility);
    insert into public.messages(
      entity_id,anchor_id,root_message_id,author_id,body,mentions,attachments,
      client_msg_id,message_batch_id,requested_chat_mode
    ) values(
      message_id,anchor.id,thread_root,actor,p_body,mention_json,attachment_json,null,p_client_mutation_id,turn_mode
    );
    message_ids:=array_append(message_ids,message_id);
    if anchor.kind='work_session' then
      delivery_intents:=delivery_intents||jsonb_build_array(jsonb_build_object(
        'messageId',message_id,'targetWorkSessionId',anchor.id,
        'content',p_body,'mode','send'));
    end if;
    -- 176 — THE CHAT ARM. This replaces `internal.queue_chat_human_reply`
    -- (104/115/153), whose author test was the second half of the reported
    -- defect: a team_member author had no `members` row, found no turn to queue,
    -- and the message stayed inert context. Ruling R-A removes every gate that
    -- was there — no author-kind test, no auth-kind test, no cap, no per-chat
    -- wake flag — and keeps exactly one, which sessions already have:
    --
    --   A CHAT IS NEVER HANDED ITS OWN MESSAGE.
    --
    -- The guard is keyed on the SOURCE, not on the author. Keying it on the
    -- author (`actor = chat.teammate_id`) would also suppress a message the
    -- teammate wrote from a DIFFERENT chat or session, which is precisely the
    -- traffic this feature exists to carry. It is keyed on the source because
    -- the orchestrator's own `Agent turn in progress.` placeholder is posted
    -- with the chat as both anchor and source — that post is the reason the
    -- guard exists and the reason it has this shape.
    if anchor.kind='chat' and p_source_chat_id is distinct from anchor.id then
      select * into chat_anchor from public.chats where entity_id=anchor.id;
      if chat_anchor.entity_id is not null then
        select e.kind into actor_kind from public.entities e where e.id=actor;
        -- The turn's auth kind is PROVENANCE and must stay unforgeable: only the
        -- two human kinds the column admits are recorded, and an agent-authored
        -- turn records none rather than inheriting the configurer's.
        queue_auth_kind := case
          when internal.claim_text('tm8.auth_kind') in ('browser','cli')
            then internal.claim_text('tm8.auth_kind') else null end;
        insert into public.chat_turns(
          chat_id, root_message_id, user_message_id,
          requested_by_member_id, requested_by_actor_id,
          requested_by_session_id, requested_by_chat_id,
          requested_by_auth_kind, mode, pricing_provider, pricing_model, queued_at
        ) values (
          chat_anchor.entity_id, null, message_id,
          case when actor_kind='member' then actor else null end, actor,
          p_source_work_session_id, p_source_chat_id,
          queue_auth_kind, coalesce(turn_mode, chat_anchor.chat_mode),
          chat_anchor.provider, chat_anchor.model, now()
        ) returning turn_id into queued_turn_id;
        delivery_intents:=delivery_intents||jsonb_build_array(jsonb_build_object(
          'kind','chat_turn','messageId',message_id,
          'chatId',chat_anchor.entity_id,'turnId',queued_turn_id));
      end if;
    end if;
  end loop;

  if p_source_work_session_id is not null then
    perform internal.w1_set_writer('message_recorder');
    insert into public.edges(space_id,src_id,dst_id,type,created_by)
      select target_space,id,p_source_work_session_id,'authored_from',actor
        from unnest(message_ids) item(id);
    perform internal.w1_set_writer('');
  end if;
  -- 176: the same provenance write, to a chat. Without it a reply to a chat
  -- agent's post has nothing to resolve and 168's `recorded_only` fallback is
  -- the best a chat could get.
  if p_source_chat_id is not null then
    perform internal.w1_set_writer('message_recorder');
    insert into public.edges(space_id,src_id,dst_id,type,created_by)
      select target_space,id,p_source_chat_id,'authored_from',actor
        from unnest(message_ids) item(id);
    perform internal.w1_set_writer('');
  end if;
  if cardinality(files)>0 then
    perform internal.w1_set_writer('message_attachment');
    insert into public.edges(space_id,src_id,dst_id,type,created_by)
      select target_space,file_id,message_ref,'attached_to',actor
        from unnest(files) f(file_id) cross join unnest(message_ids) m(message_ref);
    perform internal.w1_set_writer('');
  end if;

  if parent.entity_id is not null then
    perform internal.w2_notify_actor(
      target_space,parent.author_id,'message_reply',parent.anchor_id,actor,
      jsonb_build_object('messageId',message_ids[1],'parentMessageId',parent.entity_id,
                         'anchorId',parent.anchor_id));
  end if;

  result:=jsonb_build_object(
    'messageBatchId',p_client_mutation_id,
    'messageIds',to_jsonb(message_ids),
    'deliveryIntents',delivery_intents,
    '_stableHash',stable_hash,
    '_audit',jsonb_build_object('authorId',actor,'spaceId',target_space)
  );
  return internal.ledger_record(p_client_mutation_id,'messages.post',result);
end
$$;

-- public.open_space_link_token: 256_space_link_provenance.sql verbatim.
create or replace function public.open_space_link_token(p_link_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.space_link_tokens;
begin
  -- ALLOW-list, not a deny-list: the human kinds plus 'agent' (W7's own-row
  -- path). link, agent_runtime, any later kind, null and empty all refuse.
  if coalesce(internal.claim_text('tm8.auth_kind'), '') not in ('browser', 'cli', 'agent') then
    raise exception 'this session kind cannot use a space link' using errcode = '42501',
      detail = jsonb_build_object('authKind', coalesce(internal.claim_text('tm8.auth_kind'), 'none'))::text;
  end if;
  -- W7p: an agent minted under a link never opens a link (no chaining).
  if internal.claim_text('tm8.via_link') is not null then
    raise exception 'a session minted under a space link cannot use a space link' using errcode = '42501';
  end if;
  row := internal.space_link_own_row(p_link_id);
  if row.status <> 'signed_in' or row.ciphertext is null then
    raise exception 'space link is %', row.status using errcode = '23514',
      detail = jsonb_build_object('status', row.status)::text;
  end if;
  update public.space_link_tokens set last_used_at = now() where id = row.id;
  return jsonb_build_object(
    'linkId', row.link_id,
    'homeSpaceId', row.home_space_id,
    'memberId', row.member_id,
    'targetSpaceId', row.target_space_id,
    'sessionId', row.auth_session_id,
    'allowSpawn', row.allow_spawn,
    'spawnBudget', row.spawn_budget,
    'ciphertext', encode(row.ciphertext, 'base64'),
    'nonce', encode(row.nonce, 'base64'));
end
$$;

-- public.mark_space_link_stale: 256_space_link_provenance.sql verbatim.
create or replace function public.mark_space_link_stale(p_link_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.space_link_tokens;
begin
  if p_status not in ('signed_out', 'unreachable') then
    raise exception 'a use can only mark a link signed_out or unreachable' using errcode = '22023';
  end if;
  -- ALLOW-list, not a deny-list: the human kinds plus 'agent' (W7's own-row
  -- path). link, agent_runtime, any later kind, null and empty all refuse.
  if coalesce(internal.claim_text('tm8.auth_kind'), '') not in ('browser', 'cli', 'agent') then
    raise exception 'this session kind cannot use a space link' using errcode = '42501',
      detail = jsonb_build_object('authKind', coalesce(internal.claim_text('tm8.auth_kind'), 'none'))::text;
  end if;
  -- W7p: a session minted under a link never changes a link's state — the
  -- same refusal as open_space_link_token.
  if internal.claim_text('tm8.via_link') is not null then
    raise exception 'a session minted under a space link cannot use a space link' using errcode = '42501';
  end if;
  row := internal.space_link_own_row(p_link_id);
  if p_status = 'signed_out' then
    if row.auth_session_id is not null then
      update public.auth_sessions set revoked_at = now()
       where id = row.auth_session_id and revoked_at is null;
    end if;
    update public.space_link_tokens
       set status = 'signed_out', ciphertext = null, nonce = null, auth_session_id = null
     where id = row.id
     returning * into row;
    perform internal.space_link_raise_attention(row,
      'Space link signed out: the target refused the stored session. Sign in again.');
  else
    update public.space_link_tokens set status = 'unreachable' where id = row.id returning * into row;
    perform internal.space_link_raise_attention(row, 'Space link unreachable: the target did not answer.');
  end if;
  return internal.space_link_json(p_link_id, row.member_id);
end
$$;

-- public.mark_server_reach: 261_remote_servers.sql verbatim.
create or replace function public.mark_server_reach(p_server_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me uuid;
begin
  if p_status not in ('reachable', 'unreachable', 'offline') then
    raise exception 'unknown reach status' using errcode = '22023';
  end if;
  if coalesce(internal.claim_text('tm8.auth_kind'), '') not in ('browser', 'cli', 'agent') then
    raise exception 'this session kind cannot probe a server' using errcode = '42501';
  end if;
  me := internal.server_member(p_server_id);
  update public.servers set reach_status = p_status, reach_checked_at = now()
   where entity_id = p_server_id;
  return internal.server_json(p_server_id, me);
end
$$;

-- public.add_cross_space_ref: 279_cross_space_refs.sql verbatim.
create or replace function public.add_cross_space_ref(
  p_entity_id uuid,
  p_link_id uuid,
  p_target_entity_id uuid,
  p_target_kind text,
  p_title text
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  me uuid;
  tok public.space_link_tokens;
  server_id uuid;
  row public.cross_space_refs;
begin
  if coalesce(internal.claim_text('tm8.auth_kind'), '') not in ('browser', 'cli', 'agent') then
    raise exception 'this session kind cannot use a space link' using errcode = '42501';
  end if;
  if internal.claim_text('tm8.via_link') is not null then
    raise exception 'a session minted under a space link cannot use a space link' using errcode = '42501';
  end if;
  select * into e from public.entities where id = p_entity_id and deleted_at is null;
  if e.id is null or not internal.entity_readable(p_entity_id) then
    raise exception 'entity not found' using errcode = 'P0002';
  end if;
  me := internal.current_member_id(e.space_id);
  if me is null then
    raise exception 'entity not found' using errcode = 'P0002';
  end if;
  -- D7: the caller's OWN row on a link out of A, signed in. Owning or
  -- belonging to both spaces is not an authority on its own.
  select t.* into tok from public.space_link_tokens t
   where t.link_id = p_link_id and t.member_id = me and t.home_space_id = e.space_id;
  if tok.id is null then
    raise exception 'no space link from this entity''s space for your member' using errcode = '42501',
      detail = jsonb_build_object('reason', 'cross_space_ref_no_link')::text;
  end if;
  if tok.status <> 'signed_in' then
    raise exception 'space link is %: ask your human to sign in to the link again', tok.status
      using errcode = '42501',
      detail = jsonb_build_object('reason', 'cross_space_ref_link_inactive', 'status', tok.status)::text;
  end if;
  if tok.target_space_id = e.space_id then
    raise exception 'a reference must point into another space; use an edge' using errcode = '22023';
  end if;
  if p_target_entity_id is null or p_target_kind is null or btrim(p_target_kind) = '' then
    raise exception 'target entity and kind are required' using errcode = '22023';
  end if;
  select l.target_server_id into server_id from public.space_links l where l.entity_id = p_link_id;

  insert into public.cross_space_refs as r (
    space_id, entity_id, link_id, target_space_id, target_server_id, target_entity_id,
    target_kind, title_snapshot, created_by, created_by_actor)
  values (
    e.space_id, e.id, p_link_id, tok.target_space_id, server_id, p_target_entity_id,
    left(btrim(p_target_kind), 100), left(coalesce(nullif(btrim(p_title), ''), 'Untitled'), 500),
    me, nullif(internal.claim_text('tm8.actor_id'), '')::uuid)
  on conflict (entity_id, target_space_id, target_entity_id) do update
    set link_id = excluded.link_id,
        target_server_id = excluded.target_server_id,
        target_kind = excluded.target_kind,
        title_snapshot = excluded.title_snapshot,
        updated_at = now()
  returning r.* into row;
  return internal.cross_space_ref_json(row);
end
$$;

-- public.resolve_space_link_invoke: 301_remote_space_links.sql verbatim.
create or replace function public.resolve_space_link_invoke(p_home_space_id uuid, p_ref text)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me uuid;
  row public.space_link_tokens;
  server_id uuid;
begin
  if coalesce(internal.claim_text('tm8.auth_kind'), '') not in ('browser', 'cli', 'agent') then
    raise exception 'this session kind cannot use a space link' using errcode = '42501',
      detail = jsonb_build_object('authKind', coalesce(internal.claim_text('tm8.auth_kind'), 'none'))::text;
  end if;
  if internal.claim_text('tm8.via_link') is not null then
    raise exception 'a session minted under a space link cannot use a space link' using errcode = '42501';
  end if;
  me := internal.current_member_id(p_home_space_id);
  if me is null or p_ref is null or btrim(p_ref) = '' then
    raise exception 'space link not found' using errcode = 'P0002';
  end if;
  select t.* into row from public.space_link_tokens t
   where t.member_id = me and t.home_space_id = p_home_space_id
     and not t.remote_inbound
     and (t.alias = lower(p_ref)
          or (p_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              and t.link_id = p_ref::uuid))
   order by (t.alias = lower(p_ref)) desc nulls last
   limit 1;
  if row.id is null then
    raise exception 'space link not found' using errcode = 'P0002';
  end if;
  select l.target_server_id into server_id from public.space_links l where l.entity_id = row.link_id;
  return jsonb_build_object(
    'linkId', row.link_id,
    'tokenRowId', row.id,
    'memberId', row.member_id,
    'homeSpaceId', row.home_space_id,
    'targetSpaceId', row.target_space_id,
    'targetServerId', server_id,
    'status', row.status,
    'allowSpawn', row.allow_spawn,
    'spawnBudget', row.spawn_budget);
end
$$;

-- public.read_space_service_key: 318_tools.sql verbatim.
create or replace function public.read_space_service_key(p_space_id uuid, p_provider text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials; v_account uuid; v_source text;
begin
  if p_provider in ('mcp','tool') then raise exception 'MCP/tool requires an explicit definition and account' using errcode='42501'; end if;
  if not internal.is_server_only_credential_provider(p_provider) then
    raise exception '% is not a server-only credential; a launch reads it with read_space_credential_for_spawn', p_provider
      using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_server_only', 'provider', p_provider)::text;
  end if;
  if coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link' then
    raise exception 'a space link session cannot read a service key' using errcode = '42501';
  end if;
  perform internal.require_space_member(p_space_id);

  if coalesce(internal.claim_text('tm8.auth_kind'), '') in ('browser', 'cli') then
    v_account := internal.current_account_id();
    select sc.* into stored
      from public.member_defaults md
      join public.space_credentials sc on sc.id = md.credential_id and sc.space_id = md.space_id
     where md.space_id = p_space_id and md.account_id = v_account
       and md.provider = p_provider and sc.provider = p_provider
       and sc.status = 'active' and sc.owner_account_id = v_account;
    if stored.id is not null then v_source := 'my_default'; end if;
  end if;

  if stored.id is null then
    select * into stored from public.space_credentials
     where space_id = p_space_id and provider = p_provider
       and is_default and status = 'active';
    if stored.id is null then return null; end if;
    v_source := 'space_default';
  end if;

  update public.space_credentials set last_used_at = now()
   where id = stored.id;

  return jsonb_build_object(
    'credentialId', stored.id,
    'spaceId', stored.space_id,
    'provider', stored.provider,
    'source', v_source,
    'secretCiphertext', encode(stored.secret_ciphertext, 'base64'),
    'secretNonce', encode(stored.secret_nonce, 'base64')
  );
end
$$;

-- public.issue_tool_session_human_session: 323_tool_run_human_tokens.sql verbatim.
create or replace function public.issue_tool_session_human_session(p_session_id uuid,
 p_token_hash text,p_expires_at timestamptz,p_api_scope text,p_parent_auth_session_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare
 e public.entities; ws public.work_sessions; caller uuid; member uuid;
 account_row public.accounts; session_row public.auth_sessions; parent_auth public.auth_sessions;
 access text; scope text;
begin
 if coalesce(internal.claim_text('tm8.auth_kind'),'') not in ('browser','cli')
 or internal.claim_text('tm8.via_link') is not null then
  raise exception 'human tool API access requires a human session' using errcode='42501';
 end if;
 e:=internal.live_entity(p_session_id,'work_session');
 perform internal.require_space_member(e.space_id);
 member:=internal.current_member_id(e.space_id);
 caller:=internal.caller_work_session(e.space_id);
 -- The run must be the caller's own, started from where the caller stands:
 -- top level, or (a tool run from inside a human tool run) under that run.
 if member is null or e.created_by is distinct from member
 or caller=e.id or e.parent_id is distinct from caller then
  raise exception 'tool bearer must belong to the invoking human' using errcode='42501';
 end if;
 select * into ws from public.work_sessions where entity_id=e.id for update;
 if ws.session_kind<>'tool' or ws.tool_state<>'running' or ws.outcome<>'open' or ws.status not in ('spawning','running','idle') then
  raise exception 'live tool session required' using errcode='42501';
 end if;
 select a.* into account_row from public.accounts a
 where a.id=internal.current_account_id() and a.status='active';
 if account_row.id is null then raise exception 'active account required' using errcode='42501'; end if;
 -- A caller with a work session is a bearer by construction; it must name it.
 if caller is not null and p_parent_auth_session_id is null then
  raise exception 'live invoking human bearer required' using errcode='42501';
 end if;
 if p_parent_auth_session_id is not null then
  -- Share-lock so a concurrent revoke waits and 249's cascade sees the child.
  select * into parent_auth from public.auth_sessions where id=p_parent_auth_session_id for share;
  if parent_auth.id is null or parent_auth.kind not in ('browser','cli') or parent_auth.via_link_id is not null
  or parent_auth.account_id is distinct from account_row.id
  or parent_auth.work_session_id is distinct from caller
  or (parent_auth.space_id is not null and parent_auth.space_id is distinct from e.space_id)
  or parent_auth.revoked_at is not null or parent_auth.expires_at<=now() then
   raise exception 'live invoking human bearer required' using errcode='42501';
  end if;
 end if;
 access:=ws.tool_tm8_access;
 if access is null or access='none' then
  raise exception 'tool version has no tm8 API access' using errcode='42501';
 end if;
 if p_api_scope is null or p_api_scope not in ('read','write') or p_token_hash is null
 or p_token_hash !~ '^[a-f0-9]{64}$' or p_expires_at is null or p_expires_at<=now() then
  raise exception 'invalid tool credential' using errcode='22023';
 end if;
 scope:=case when access='read' or internal.claim_text('tm8.api_scope')='read' or p_api_scope='read'
   or parent_auth.api_scope='read' then 'read' else 'write' end;
 update public.auth_sessions set revoked_at=now() where work_session_id=e.id and revoked_at is null;
 insert into public.auth_sessions(account_id,kind,work_session_id,token_hash,label,expires_at,space_id,api_scope,parent_session_id)
 values(account_row.id,'cli',e.id,p_token_hash,'tool-run:'||e.id,
   least(p_expires_at,coalesce(parent_auth.expires_at,'infinity'),now()+make_interval(secs=>ws.tool_timeout_seconds::double precision+60)),
   e.space_id,scope,parent_auth.id)
 returning * into session_row;
 return to_jsonb(session_row)-'token_hash';
end $$;

-- internal.stamp_loop_armed_by: 384_loops_first_class.sql verbatim.
create or replace function internal.stamp_loop_armed_by() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare v_space uuid; v_member uuid; v_human boolean; v_content_changed boolean;
begin
  v_human := coalesce(internal.claim_text('tm8.auth_kind'), '') in ('browser', 'cli')
             and coalesce(internal.claim_text('tm8.via_link'), '') = '';

  if tg_op = 'INSERT' then
    if not v_human then
      new.armed_at := null;
      return new;
    end if;
  else
    v_content_changed :=
         (to_jsonb(new) - 'next_run_at' - 'last_run_at' - 'last_error' - 'updated_at'
            - 'enabled' - 'paused_until' - 'retry_attempt' - 'armed_at'
            - 'armed_by_member_id' - 'armed_by_identity_id')
      is distinct from
         (to_jsonb(old) - 'next_run_at' - 'last_run_at' - 'last_error' - 'updated_at'
            - 'enabled' - 'paused_until' - 'retry_attempt' - 'armed_at'
            - 'armed_by_member_id' - 'armed_by_identity_id')
      or (new.enabled and not old.enabled);
    if not v_content_changed then
      new.armed_by_member_id := old.armed_by_member_id;
      new.armed_by_identity_id := old.armed_by_identity_id;
      new.armed_at := old.armed_at;
      return new;
    end if;
    if not v_human then
      new.armed_by_member_id := null;
      new.armed_by_identity_id := null;
      new.armed_at := null;
      return new;
    end if;
  end if;

  select space_id into v_space from public.entities where id = new.entity_id;
  if v_space is null then return new; end if;
  v_member := internal.current_member_id(v_space);
  if v_member is null then
    if tg_op <> 'INSERT' then
      new.armed_by_member_id := null;
      new.armed_by_identity_id := null;
    end if;
    new.armed_at := null;
    return new;
  end if;
  new.armed_by_member_id := v_member;
  new.armed_by_identity_id := internal.identity_id();
  new.armed_at := now();
  return new;
end
$$;

-- public.read_mcp_session_binding: 343_mcp_provenance.sql verbatim.
create or replace function public.read_mcp_session_binding(p_session uuid, p_auth_session uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare b internal.mcp_session_bindings; generation_read boolean := false; v_root uuid;
begin
  if internal.claim_text('tm8.auth_kind') = 'agent_runtime' then
    if p_auth_session::text is distinct from internal.claim_text('tm8.auth_session_id')
      or not exists(select 1 from public.auth_sessions where id = p_auth_session and runtime_chat_id = p_session) then
      raise exception 'MCP session unavailable' using errcode = '42501';
    end if;
    perform internal.assert_chat_generation(true);
    generation_read := true;
  end if;
  select * into b from internal.mcp_session_bindings where session_id = p_session and auth_session_id = p_auth_session;
  if b.session_id is null or b.runtime_identity_id is distinct from
      (case when generation_read then internal.claim_text('tm8.identity_id') else internal.identity_id() end)
    or coalesce(internal.claim_text('tm8.via_link'), '') <> '' then
    raise exception 'MCP session unavailable' using errcode = '42501';
  end if;
  if generation_read then
    if (internal.session_space_id() is not null and b.space_id <> internal.session_space_id())
      or not exists(select 1 from public.members member join public.entities entity on entity.id = member.entity_id
        where member.identity_id = b.runtime_identity_id and member.space_id = b.space_id
          and member.status = 'active' and entity.deleted_at is null) then
      raise exception 'MCP session unavailable' using errcode = '42501';
    end if;
  else perform internal.require_space_member(b.space_id); end if;
  if not exists(select 1 from public.auth_sessions session join public.accounts account on account.id = session.account_id
      where session.id = b.auth_session_id and session.revoked_at is null and session.expires_at > clock_timestamp()
        and session.via_link_id is null and account.status = 'active')
    or not exists(select 1 from public.members member join public.accounts account on account.identity_id = member.identity_id
      where member.space_id = b.space_id and member.identity_id = b.launcher_identity_id and member.status = 'active' and account.status = 'active')
    or not exists(select 1 from public.entities entity where entity.id = p_session and entity.space_id = b.space_id and entity.deleted_at is null
      and (generation_read or exists(select 1 from public.work_sessions work where work.entity_id = entity.id and work.status in ('spawning', 'running', 'idle'))
        or exists(select 1 from public.chats chat where chat.entity_id = entity.id and chat.runtime_state = 'live'))) then
    raise exception 'MCP session unavailable' using errcode = '42501';
  end if;
  -- 343 / §6.2. Only for a binding that recorded a chain; see the header.
  if b.root_identity_id is not null then
    if not internal.mcp_root_in_every_space(b.root_identity_id, b.chain_space_ids) then
      raise exception 'MCP provenance root is no longer a member of every space in the chain'
        using errcode = '42501';
    end if;
    -- REDUNDANT BY CONSTRUCTION, and kept deliberately: `chain[1]` is always
    -- this session, so its Space is `b.space_id` and the §6.2 check above has
    -- already covered this one. No test can tell the two apart, which is why
    -- this comment exists rather than a cell — disabling this branch leaves
    -- every cell green. It stays because the redundancy is only guaranteed while
    -- the chain's head is this session, and `v_root` is also what the caller
    -- resolves accounts under: if a future writer ever stores a chain that does
    -- not start here, this is the line that still fails closed.
    v_root := internal.mcp_root_member_in(b.root_identity_id, b.space_id);
    if v_root is null then
      raise exception 'MCP provenance root is no longer a member of this space' using errcode = '42501';
    end if;
  end if;
  return jsonb_build_object('sessionId', b.session_id, 'spaceId', b.space_id, 'identityId', b.runtime_identity_id,
    'launcherIdentityId', b.launcher_identity_id, 'launcherAuthKind', b.launcher_auth_kind, 'selections', b.selections,
    'rootMemberId', v_root, 'rootIdentityId', b.root_identity_id,
    -- Carried so a chain deeper than one hop keeps replaying the human's own
    -- kind rather than losing it at the first hop (343).
    'rootAuthKind', case when b.launcher_auth_kind in ('browser', 'cli') then b.launcher_auth_kind else null end,
    'chain', to_jsonb(coalesce(b.chain, '{}'::uuid[])),
    'chainSpaceIds', to_jsonb(coalesce(b.chain_space_ids, '{}'::uuid[])),
    'depth', coalesce(array_length(b.chain, 1), 0));
end
$$;

-- internal.mcp_audit_visible: 346_mcp_call_audit.sql verbatim.
create or replace function internal.mcp_audit_visible(p_space uuid, p_root uuid)
returns boolean language sql stable security definer set search_path = public, internal, pg_temp as $$
  -- A human oversight surface (lead ruling on #1321): an agent bearer carries
  -- its owner's identity, so without the kind check an admin's agent would read
  -- the whole Space. The member branch honours the session pin exactly as
  -- is_space_admin does for the admin branch.
  select coalesce(internal.claim_text('tm8.via_link'), '') = ''
     and coalesce(internal.claim_text('tm8.auth_kind'), '') in ('browser', 'cli')
     and (internal.is_space_admin(p_space)
          or (p_root is not null
              and (internal.session_space_id() is null or internal.session_space_id() = p_space)
              and exists(select 1 from public.members m
                where m.entity_id = p_root and m.space_id = p_space
                  and m.identity_id = internal.identity_id() and m.status = 'active')))
$$;

-- public.record_mcp_call_audit: 346_mcp_call_audit.sql verbatim.
create or replace function public.record_mcp_call_audit(
  p_session uuid, p_server uuid, p_credential uuid, p_method text, p_tool text, p_outcome text,
  p_root_member uuid, p_chain uuid[], p_deny_reason text,
  p_latency_ms integer, p_request_bytes integer, p_response_bytes integer)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_auth uuid := nullif(internal.claim_text('tm8.auth_session_id'), '')::uuid;
  v_kind text := coalesce(internal.claim_text('tm8.auth_kind'), '');
  v_chat boolean;
  v_space uuid;
  b internal.mcp_session_bindings;
  v_root uuid;
  v_root_identity text;
  v_chain uuid[];
  v_scope text;
begin
  -- Only the audited session's own runtime bearer writes its rows.
  if v_kind not in ('agent', 'agent_runtime') or v_auth is null
     or coalesce(internal.claim_text('tm8.via_link'), '') <> '' then
    raise exception 'MCP audit writer unavailable' using errcode = '42501';
  end if;
  select coalesce(s.runtime_chat_id = p_session, false) into v_chat from public.auth_sessions s
   where s.id = v_auth and s.via_link_id is null
     and (s.work_session_id = p_session or s.runtime_chat_id = p_session);
  if not found then
    raise exception 'MCP audit writer unavailable' using errcode = '42501';
  end if;
  select e.space_id into v_space from public.entities e where e.id = p_session;
  if v_space is null then
    raise exception 'MCP audit session unavailable' using errcode = '42501';
  end if;

  select * into b from internal.mcp_session_bindings where session_id = p_session;
  if b.session_id is not null and b.space_id <> v_space then
    raise exception 'MCP audit binding mismatch' using errcode = '42501';
  end if;
  v_chain := coalesce(p_chain, b.chain);
  if p_chain is not null and p_chain is distinct from b.chain then
    raise exception 'MCP audit chain is not the recorded chain' using errcode = '22023';
  end if;
  -- The recorded root, or for a binding written before 343 the launcher, as
  -- their member row in this Space (whatever its status: a removed root is
  -- exactly the denial worth naming).
  -- B50 (advisor review): the connector must be one of THIS Space's, so a row
  -- can never name another Space's connector. A call that reached the provider
  -- (any outcome but 'denied') must also be on a connector the binding selected;
  -- a refusal is exactly the case where it may not be, and the Space check
  -- above still binds it.
  if not exists(select 1 from public.entities e
      where e.id = p_server and e.space_id = v_space and e.kind = 'mcp_server') then
    raise exception 'MCP audit connector is not one of this space''s' using errcode = '22023';
  end if;
  if b.session_id is not null and p_outcome <> 'denied' and not exists(
      select 1 from jsonb_array_elements(b.selections) sel where sel->>'serverId' = p_server::text) then
    raise exception 'MCP audit connector is not selected on this session' using errcode = '22023';
  end if;

  -- The root as RECORDED. A supplied root must be the recorded root's member
  -- row here (whatever its status: a removed root is exactly the denial worth
  -- naming). Absent one, the binding's own root. The launcher stands in ONLY
  -- for a binding written before 343 by a HUMAN launcher; a rootless binding
  -- (loop executor, no human provenance) records NULL, which means "no human
  -- provenance" — never the node owner the executor ran as (B50).
  if b.session_id is not null then
    v_root_identity := case
      when b.root_identity_id is not null then b.root_identity_id
      when b.launcher_auth_kind in ('browser', 'cli') then b.launcher_identity_id
    end;
  end if;
  if p_root_member is not null then
    if v_root_identity is null or not exists(select 1 from public.members m
        where m.entity_id = p_root_member and m.space_id = v_space and m.identity_id = v_root_identity) then
      raise exception 'MCP audit root is not the recorded root' using errcode = '22023';
    end if;
    v_root := p_root_member;
  elsif v_root_identity is not null then
    v_root := coalesce(case when b.root_identity_id is not null then b.root_member_id end,
      (select m.entity_id from public.members m where m.space_id = v_space and m.identity_id = v_root_identity));
  end if;

  -- B50: a credential, when named, must be an MCP credential of this Space.
  if p_credential is not null then
    select case when c.owner_account_id is null then 'space' else 'member' end into v_scope
      from public.space_credentials c
     where c.id = p_credential and c.space_id = v_space and c.provider = 'mcp';
    if v_scope is null then
      raise exception 'MCP audit credential is not one of this space''s MCP connections' using errcode = '22023';
    end if;
  end if;

  insert into public.mcp_call_audit(space_id, session_id, server_id, credential_id, method, outcome,
    tool, root_member_id, chain, via, chat_id, credential_scope, deny_reason,
    latency_ms, request_bytes, response_bytes)
  values (v_space, p_session, p_server, p_credential, p_method, p_outcome,
    left(nullif(btrim(p_tool), ''), 200), v_root, v_chain,
    case when v_chat then 'chat' else 'session' end, case when v_chat then p_session end,
    v_scope, p_deny_reason, p_latency_ms, p_request_bytes, p_response_bytes);
end
$$;

-- internal.mcp_provenance: 347_triggered_by_provenance_guard.sql verbatim.
create or replace function internal.mcp_provenance(
  p_session uuid, p_source_session uuid default null, p_source_auth_session uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  MAX_DEPTH constant integer := 8;   -- §6.1
  v_entity public.entities;
  v_target uuid;
  v_kind text;
  v_root_member uuid;
  v_root_identity text;
  v_chain uuid[];
  v_spaces uuid[];
  v_source jsonb;
  v_source_entity public.entities;
  v_loop public.loops;
  v_loop_entity uuid;
  v_via text;
  v_root_kind text;
  v_source_space uuid;
begin
  select * into v_entity from public.entities
   where id = p_session and deleted_at is null and kind in ('work_session', 'chat');
  if v_entity.id is null then
    return jsonb_build_object('reason', 'session_unavailable');
  end if;
  v_target := v_entity.space_id;
  v_chain := array[p_session];
  v_spaces := array[v_target];
  v_kind := coalesce(internal.claim_text('tm8.auth_kind'), '');

  -- §6.5. A session started through a space link gets NO connectors, and the
  -- rule is stated here too so no caller of this function has to remember it.
  if coalesce(internal.claim_text('tm8.via_link'), '') <> '' or v_kind = 'link' then
    return jsonb_build_object('reason', 'link_session');
  end if;

  if p_source_session is not null and p_source_auth_session is not null
     and v_kind in ('agent', 'agent_runtime') then
    -- HOP: the spawning bearer's own session. Every liveness and membership
    -- check lives in read_mcp_session_binding; a refusal there means the
    -- delegated launch has no verifiable human behind it any more.
    begin
      v_source := public.read_mcp_session_binding(p_source_session, p_source_auth_session);
    exception when others then
      v_source := null;
    end;
    if v_source is null then
      return jsonb_build_object('reason', 'source_unavailable');
    end if;
    v_via := 'bearer_source';
    if v_source ? 'chain' and jsonb_array_length(v_source -> 'chain') > 0 then
      v_chain := v_chain || array(select (value #>> '{}')::uuid from jsonb_array_elements(v_source -> 'chain'));
      v_spaces := v_spaces || array(select (value #>> '{}')::uuid from jsonb_array_elements(v_source -> 'chainSpaceIds'));
      v_root_identity := v_source ->> 'rootIdentityId';
      v_root_kind := nullif(v_source ->> 'rootAuthKind', '');
    else
      -- A binding written before 343 records no chain. Its launcher identity
      -- WAS checked against the human auth kinds when it was written, and that
      -- kind is stored, so it is still a sound one-hop root — but a stored kind
      -- that is not human is exactly a binding written with no root, and it
      -- must not become one now.
      if not (coalesce(v_source ->> 'launcherAuthKind', '') in ('browser', 'cli')) then
        return jsonb_build_object('reason', 'no_human_provenance');
      end if;
      v_chain := v_chain || array[p_source_session];
      -- Into a scalar, then appended: `select into` an array SUBSCRIPT would
      -- leave the slot silently null if the row were missing, and a null hop
      -- Space is a hop §6.2 then cannot check.
      select e.space_id into v_source_space from public.entities e where e.id = p_source_session;
      if v_source_space is null then
        return jsonb_build_object('reason', 'source_unavailable');
      end if;
      v_spaces := v_spaces || array[v_source_space];
      v_root_identity := v_source ->> 'launcherIdentityId';
      v_root_kind := v_source ->> 'launcherAuthKind';
      v_via := 'bearer_source_legacy';
    end if;
    if array_length(v_chain, 1) > MAX_DEPTH then
      return jsonb_build_object('reason', 'depth_exceeded', 'depth', array_length(v_chain, 1));
    end if;
    if v_root_identity is null then
      -- B19's chat terminal: a chat's requester is a server fact written at the
      -- human-gated `start_chat`, so a chat hop still has a root even when its
      -- own binding predates this migration and carried none.
      select * into v_source_entity from public.entities where id = p_source_session;
      if v_source_entity.kind = 'chat' then
        select internal.mcp_provenance_root_identity(c.configured_by_member_id, v_source_entity.space_id)
          into v_root_identity from public.chats c where c.entity_id = p_source_session;
        v_via := 'chat_requester';
      end if;
    end if;
    if v_root_identity is null then
      return jsonb_build_object('reason', 'no_human_provenance');
    end if;

  elsif v_kind in ('browser', 'cli') then
    -- TERMINAL: a human bearer is the root. `current_member_id` is pinned
    -- (227), so a space-pinned human session can only ever be the root of a
    -- launch in its own pinned Space.
    v_root_member := internal.current_member_id(v_target);
    v_root_identity := internal.mcp_provenance_root_identity(v_root_member, v_target);
    v_root_kind := v_kind;
    v_via := 'human_bearer';
    if v_root_identity is null then
      return jsonb_build_object('reason', 'root_not_in_space');
    end if;

  elsif v_kind in ('agent', 'agent_runtime') then
    -- An agent bearer that cannot name its own session has nothing to hop to.
    return jsonb_build_object('reason', 'source_unavailable');

  else
    -- NO BEARER AT ALL: the in-process shapes. Only §6's two new terminals can
    -- give one a root, and the order matters — see the header on why a schedule
    -- firing must never fall through to the persona's owner.
    /*
     * 347 (B46/B49). ONLY A SERVER-WRITTEN PROVENANCE EDGE COUNTS.
     *
     * 343 joined ANY `triggered_by` edge, and that was a privilege escalation:
     * `public.write_edge` authorizes on Space MEMBERSHIP alone (129:98) and
     * `triggered_by` has no writer guard (091:138, unlike `launched_by`'s
     * 330:55), so any member could attach their own session to a loop ARMED BY
     * SOMEONE ELSE and have this branch root them at that human. The marker,
     * and the trigger above that only `w1_writer() = 'spawn'` may set it, are
     * what make the edge an authority rather than a claim.
     *
     * Run history keeps working: the executor's unmarked task and dispatcher
     * edges are still written and still read as history — they simply no
     * longer root anything.
     */
    select l.* into v_loop from public.loops l
      join public.edges e on e.src_id = p_session and e.type = 'triggered_by' and e.dst_id = l.entity_id
      join public.entities le on le.id = l.entity_id
     where le.space_id = v_target and le.deleted_at is null
       and e.props ->> 'provenance' = 'true'
     order by l.entity_id limit 1;
    if v_loop.entity_id is not null then
      v_loop_entity := v_loop.entity_id;
      v_root_identity := internal.mcp_provenance_root_identity(v_loop.armed_by_member_id, v_target);
      v_via := 'schedule_armed_by';
      if v_root_identity is null then
        -- An unarmed loop, or one armed by a member who has since left. Fails
        -- closed: `entities.created_by` is NOT consulted (B19).
        return jsonb_build_object('reason', 'no_human_provenance', 'loopId', v_loop_entity);
      end if;
    else
      /*
       * THERE IS NO TEAMMATE-AUTONOMOUS TERMINAL (ruling B21, which overrules
       * B19's persona-owner clause). A no-bearer session whose only facts are
       * about a persona gets no root and no connection that needs an account.
       * Three verified facts decided it, any one of which makes a persona-owner
       * tier fail OPEN:
       *
       *  1. It would be the fallback for EVERY loop firing, not a rare
       *     residual. `createLoopExecutorPort.fire` writes the session's
       *     `triggered_by` edge AFTER `spawnService.spawn` returns
       *     (execution-handlers.ts:3063 vs :3020), and `bind` runs INSIDE that
       *     spawn — so at bind time a firing has no edge to its loop and the
       *     schedule branch above cannot see it. Every firing would land here.
       *  2. That edge write is best-effort and its failure is swallowed
       *     (`writeTriggeredBy` catches everything), so even once the ordering
       *     is fixed, a failed edge write would silently fall through to this
       *     branch instead of refusing.
       *  3. `create_loop` requires only that the persona be live in the Space
       *     (091:196) — not `can_act_as` — so a member can arm a loop on a
       *     persona owned by SOMEONE ELSE. The persona's owner is therefore not
       *     a safe stand-in for "who armed this", and lending their connections
       *     to a prompt another member wrote is exactly the laundering §6 is
       *     for. It would also re-open the node-owner defect #1316 closed, by a
       *     second door.
       *
       * So a schedule roots ONLY through `armed_by`, with no second tier. If a
       * real teammate-autonomous path appears, it needs its own armed-by-style
       * human fact, written at the moment a human authorised it (B21).
       *
       * Making the schedule branch REACHABLE on a FIRST firing is an ordering
       * fix in the loop executor, filed as follow-up work rather than papered
       * over here: the loop id must reach bind as a server fact, the session's
       * `triggered_by` edge must be written inside `execution_spawn`'s own
       * transaction like `launched_by`, and a failed write must abort a firing
       * rather than be swallowed. Until then a firing simply gets no auth
       * connectors, which is #1316's behaviour and fails closed.
       */
      return jsonb_build_object('reason', 'no_human_provenance');
    end if;
  end if;

  -- §6.2, every hop. Also covers the target Space, which is always chain[1]'s.
  if not internal.mcp_root_in_every_space(v_root_identity, v_spaces) then
    return jsonb_build_object('reason', 'root_not_in_space');
  end if;
  -- §6.3/§6.4 need the root as a member ENTITY of the connector's Space, which
  -- is the target Space for every selection bind accepts.
  v_root_member := internal.mcp_root_member_in(v_root_identity, v_target);
  if v_root_member is null then
    return jsonb_build_object('reason', 'root_not_in_space');
  end if;
  return jsonb_build_object('reason', 'ready', 'rootMemberId', v_root_member,
    'rootIdentityId', v_root_identity, 'chain', to_jsonb(v_chain),
    'chainSpaceIds', to_jsonb(v_spaces), 'depth', array_length(v_chain, 1), 'via', v_via,
    -- The HUMAN auth kind of the root, when the root came from a bearer at all.
    -- `bind` replays it on the synthesized root claims so a door that gates on
    -- `tm8.auth_kind` sees the kind the human actually held — never a fabricated
    -- one: a schedule or teammate root has no bearer, so this is null and every
    -- human gate refuses, which is the intended answer for those two.
    'rootAuthKind', case when v_root_kind in ('browser', 'cli') then v_root_kind else null end)
    || case when v_loop_entity is null then '{}'::jsonb
            else jsonb_build_object('loopId', v_loop_entity) end;
end
$$;

comment on function internal.require_human_auth_kind() is
  'Refuses any caller that is not a browser or cli auth session. Fails closed: '
  'a missing or empty tm8.auth_kind claim refuses. Defence in depth behind the '
  'facade guard, not a replacement for it.';

reset role;

-- public.work_session_about: 330_launched_by.sql verbatim.
CREATE OR REPLACE FUNCTION public.work_session_about(p_session_id uuid, p_about_id uuid, p_from_chat uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  s public.entities;
  target uuid := p_about_id;
  caller_kind text := internal.claim_text('tm8.auth_kind');
  chat_about uuid;
begin
  select * into s from public.entities where id = p_session_id and kind = 'work_session' and deleted_at is null;
  if s.id is null then
    raise exception 'no such work session' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(s.space_id);
  if p_from_chat is not null then
    -- The caller itself must be a chat runtime: a worker token carries the same
    -- identity and could otherwise pass the craft chat as both parent and p_from_chat.
    if caller_kind is distinct from 'agent_runtime' then
      raise exception 'only a chat runtime binds its sessions to what the chat is about' using errcode = '42501';
    end if;
    select e.dst_id into chat_about
      from public.entities c
      join public.chats ch on ch.entity_id = c.id
      join public.edges e on e.src_id = c.id and e.type = 'about' and e.created_at = c.created_at
     where c.id = p_from_chat and c.kind = 'chat' and c.deleted_at is null
       and internal.launched_by(s.id) = c.id
       and ch.configured_by_identity_id = internal.identity_id()
     order by e.created_at, e.id
     limit 1;
    if target is null then
      target := chat_about;
    end if;
    if target is null then
      return;
    end if;
    if chat_about is distinct from target then
      raise exception 'a chat binds its sessions only to what it is about' using errcode = '42501';
    end if;
  elsif caller_kind is null or caller_kind not in ('browser', 'cli') then
    raise exception 'only a person, or a chat for its own sessions, binds a session at spawn' using errcode = '42501';
  end if;
  if target is null then
    return;
  end if;
  if exists (select 1 from public.edges e where e.type = 'about' and e.src_id = p_session_id and e.dst_id = target) then
    return;
  end if;
  if s.created_at <> now() then
    raise exception 'an about edge binds only at spawn' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.entities t where t.id = target and t.space_id = s.space_id and t.deleted_at is null
  ) or not internal.entity_readable(target) then
    raise exception 'no entity % to be about', target using errcode = 'P0002';
  end if;
  perform internal.w1_set_writer('spawn');
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (s.space_id, p_session_id, target, 'about', s.created_by);
  perform internal.w1_set_writer(null);
end;
$function$

;
