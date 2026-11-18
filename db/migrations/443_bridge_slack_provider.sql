-- =============================================================================
-- 443 — Bridges: a second provider (Slack). Provider generalisation only.
--
-- Design of record: Slack bridge design doc 01a1ed5f-40af (§2, §3, §6 step 1),
-- protocol v4 (packages/contract/src/bridge-runtime-protocol.ts, PR #1504).
-- Task 01a1eddf-2b73 (lane A). Thread mode is 444's (lane F), not this file's.
--
-- WHAT THIS FILE DOES
--   §1  Credentials: `slack` is a server-only credential provider with the shape
--       `connection` (421), and begin_bridge_connection accepts it. The pasted
--       tokens never reach SQL: the server forwards them on the runtime's
--       `connect` frame only, and the runtime seals them under the connection's
--       stateKey in its own state directory (D38).
--   §2  The connection keeps the workspace `auth.test` answered
--       (bridge_connections.provider_account) and shows it on the owner's list. The bot's
--       user id joins self_ids, so a Slack @mention of the bot matches like the
--       WhatsApp number's own JIDs do.
--   §3  420's address check learns Slack user ids (`U…`, or `W…` org-wide on
--       Enterprise Grid).
--   §4  Email auto-link (design default 5), see TRUST below.
--   §5  Edits and deletes at the provider (inbound.edit / inbound.deleted): the
--       stored copies follow the edit, a delete tombstones them. Never routed.
--   §6  Outbound: bridge_outbox.thread_ts (444 fills it) becomes send.threadTs;
--       a perUserVoice provider gets send.voice instead of the `Title (handle):`
--       prefix; a provider's Retry-After is honoured; a react on a slash
--       command (`cmd:` id, it has no message to react to) is never sent.
--   §7  427's progress reactions for every provider whose runtime reacts.
--
-- FIX FOR MAIN (WhatsApp, live): through 442 public.bridge_runtime_state
-- raised 42702 ("self_ids" is ambiguous: its plpgsql local shadowed the
-- column) on EVERY state frame, with or without `self`. The runtime swallowed
-- the 503 and heartbeat also writes status, so nothing showed, but a live
-- runtime never recorded self_ids or external_account_id (429's own number,
-- @-mentions of the number). §2's restatement names the local v_self.
-- Regression: test/db/bridge-runtime.pg.test.ts 'connection.state'.
--
-- RESTATED HERE (444 must start from these bodies if it touches them):
--   internal.is_server_only_credential_provider (421)
--   public.begin_bridge_connection (421)
--   internal.bridge_connection_json (432)
--   internal.bridge_valid_external_id (420)
--   public.bridge_runtime_state (398)
--   public.bridge_runtime_conversation_state (398)
--   public.bridge_runtime_sent (398)
--   internal.bridge_signed (413)
--   internal.bridge_outbox_take (434)
--   internal.bridge_progress_advance (427)
-- NEW: internal.bridge_provider_reacts, internal.bridge_provider_voices,
--   internal.bridge_outbox_voice, public.bridge_runtime_sender_email,
--   public.bridge_runtime_inbound_change.
-- NOT TOUCHED: public.bridge_runtime_inbound (425), bridge_message_audience,
--   bridge_outbox_enqueue, bridge_outbound_after_message.
--
-- TRUST (§4). A Slack sender is linked to a tm8 member automatically when the
-- email Slack supplies (users:read.email) equals, case-insensitively, the
-- email on exactly one ACTIVE tm8 ACCOUNT (public.accounts.email) whose
-- identity is an active member of the bridge's space. Chosen level: a
-- SPACE-SCOPED link (method 'email', space_id = the bridge's space), which the
-- resolver reports as trust 'asserted', the same standing as a space admin's
-- assertion, never the identity-scoped 'linked' that a code proves. Why:
--   * accounts.email is written only by account creation (signup, node claim,
--     an admin creating the account); user_profiles.email is self-written via
--     identity.profile.update and is NOT read here, so a member cannot claim
--     someone's Slack address by editing their own profile;
--   * the Slack side is the workspace's directory: Slack confirms an email
--     change, and on Enterprise Grid the IdP owns it. A space admin chose to
--     bridge that workspace, so its directory vouches for people in THIS space
--     only, the way an admin assertion does, and nowhere else (D5);
--   * a code, invite or admin link always wins: an email link is never written
--     beside a live link on the address, and never replaces one;
--   * an admin's revoke sticks: an email link revoked for (address, space,
--     identity) is never written again (the admin can assert by hand);
--   * the email follows Slack: when Slack's email for the user stops matching,
--     the email link is revoked (and, if it now matches someone else, made for
--     them); bots never link; the email is never stored.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. Credentials and begin.
-- -----------------------------------------------------------------------------

create or replace function internal.is_server_only_credential_provider(p_provider text)
returns boolean language sql immutable as $$
  select coalesce(p_provider in ('typesafe','mcp','tool','whatsapp','slack'),false)
$$;

alter table public.space_credentials
  drop constraint space_credentials_provider_check,
  add constraint space_credentials_provider_check
    check (provider in ('anthropic','openai','github','typesafe','mcp','tool','whatsapp','slack')),
  drop constraint space_credentials_provider_shape_check,
  add constraint space_credentials_provider_shape_check check (
    (provider='github' and shape='token') or (provider in ('anthropic','openai') and shape in ('login','api_key'))
    or (provider='typesafe' and shape='api_key') or (provider='mcp' and shape in ('api_key','token'))
    or (provider='tool' and shape='api_key') or (provider in ('whatsapp','slack') and shape='connection'));

-- The providers a connector runtime exists for. Their capability sheets live in
-- the protocol (WHATSAPP_CAPABILITIES, SLACK_CAPABILITIES); these two mirror
-- the parts SQL decides on.
create or replace function internal.bridge_provider_reacts(p_provider text)
returns boolean language sql immutable as $$ select coalesce(p_provider in ('whatsapp','slack'), false) $$;
revoke all on function internal.bridge_provider_reacts(text) from public;

-- perUserVoice: each message carries its own name and icon (Slack
-- chat:write.customize), so no `Title (handle):` prefix goes in the text.
create or replace function internal.bridge_provider_voices(p_provider text)
returns boolean language sql immutable as $$ select coalesce(p_provider = 'slack', false) $$;
revoke all on function internal.bridge_provider_voices(text) from public;

-- bridges.connections.begin (human-only): 421's, with Slack. The tokens are not
-- an argument: they ride the runtime's `connect` frame only.
create or replace function public.begin_bridge_connection(
  p_provider text,
  p_label text default null,
  p_connection_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; account uuid; conn public.bridge_connections;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'bridges.connections.begin');
  if replay is not null then return replay; end if;
  account := internal.current_account_id();
  if account is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  if p_provider is null or p_provider not in ('whatsapp', 'slack') then
    raise exception 'no connector runtime for % yet; whatsapp and slack are the providers today', coalesce(p_provider, 'null')
      using errcode = '22023';
  end if;
  if p_connection_id is null then
    insert into public.bridge_connections(provider, owner_account_id, label, status)
    values (p_provider, account,
            coalesce(nullif(btrim(p_label), ''), case p_provider when 'slack' then 'Slack' else 'WhatsApp' end),
            'connecting')
    returning * into conn;
  else
    conn := internal.bridge_own_connection(p_connection_id);
    if conn.provider <> p_provider then
      raise exception 'this connection is a % connection', conn.provider using errcode = '22023';
    end if;
    update public.bridge_connections
       set status = 'connecting', label = coalesce(nullif(btrim(p_label), ''), label)
     where id = conn.id
    returning * into conn;
  end if;
  return internal.ledger_record(p_client_mutation_id, 'bridges.connections.begin',
    internal.bridge_connection_json(conn));
end
$$;
revoke all on function public.begin_bridge_connection(text, text, uuid, text) from public;
grant execute on function public.begin_bridge_connection(text, text, uuid, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- §2. The connected workspace.
-- -----------------------------------------------------------------------------

alter table public.bridge_connections add column provider_account jsonb
  check (provider_account is null or jsonb_typeof(provider_account) = 'object');
alter table public.bridge_connections add column state_detail text
  check (state_detail is null or char_length(state_detail) between 1 and 200);
grant select (provider_account, state_detail) on public.bridge_connections to tm8_app;
comment on column public.bridge_connections.provider_account is
  '443 (Slack): the workspace the tokens belong to, as the runtime''s auth.test answered it (protocol v4 SlackAccount). '
  'No secret. Null until linked, and on WhatsApp.';
comment on column public.bridge_connections.state_detail is
  '443: the runtime''s last state.detail (on Slack the auth.test error behind logged_out, e.g. invalid_auth). '
  'Display only; anything shaped like a token is never kept.';

-- 432's view, with `account` (null on WhatsApp). state_ref is never in it.
create or replace function internal.bridge_connection_json(c public.bridge_connections)
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', c.id, 'provider', c.provider, 'ownerAccountId', c.owner_account_id, 'label', c.label,
    'externalAccountId', c.external_account_id, 'status', c.status, 'runtimeId', c.runtime_id,
    'createdAt', c.created_at, 'lastSeenAt', c.last_seen_at,
    'account', c.provider_account, 'detail', c.state_detail,
    'offers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'credentialId', sc.id, 'spaceId', sc.space_id, 'visibility', sc.visibility,
               'status', sc.status, 'createdAt', sc.created_at, 'agentGroups', sc.agent_groups,
               'bridges', (select count(*) from public.bridges b
                            where b.credential_id = sc.id and b.ended_at is null))
             order by sc.created_at, sc.id)
        from public.space_credentials sc
       where sc.bridge_connection_id = c.id and sc.status <> 'revoked'), '[]'::jsonb))
$$;
revoke all on function internal.bridge_connection_json(public.bridge_connections) from public;

-- The SlackAccount a `state` frame carries, checked and reduced to its fields.
create or replace function internal.bridge_slack_account(p jsonb)
returns jsonb language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare k text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return null; end if;
  foreach k in array array['teamId', 'teamName', 'url', 'botUserId', 'botName'] loop
    if jsonb_typeof(p -> k) is distinct from 'string' or char_length(p ->> k) not between 1 and 300 then
      raise exception 'state.account.% must be a string', k using errcode = '22023';
    end if;
  end loop;
  if p ->> 'botUserId' !~ '^[UW][A-Z0-9]{2,}$' then
    raise exception 'state.account.botUserId must be a Slack user id' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'teamId', p ->> 'teamId', 'teamName', p ->> 'teamName', 'url', p ->> 'url',
    'enterpriseId', case when jsonb_typeof(p -> 'enterpriseId') = 'string' then left(p ->> 'enterpriseId', 300) end,
    'enterpriseName', case when jsonb_typeof(p -> 'enterpriseName') = 'string' then left(p ->> 'enterpriseName', 300) end,
    'isEnterpriseInstall', coalesce(jsonb_typeof(p -> 'isEnterpriseInstall') = 'boolean' and (p ->> 'isEnterpriseInstall')::boolean, false)
                           and jsonb_typeof(p -> 'enterpriseId') = 'string',
    'botUserId', p ->> 'botUserId',
    'botId', case when jsonb_typeof(p -> 'botId') = 'string' then left(p ->> 'botId', 300) end,
    'botName', p ->> 'botName',
    'scopes', coalesce((select jsonb_agg(left(s, 100)) from (
                 select s from jsonb_array_elements_text(
                   case when jsonb_typeof(p -> 'scopes') = 'array' then p -> 'scopes' else '[]'::jsonb end) s
                  limit 100) x), '[]'::jsonb));
end
$$;
revoke all on function internal.bridge_slack_account(jsonb) from public;

-- connection.state: 398's, plus v4's account and detail. A Slack connection's
-- externalAccountId is the org on an org-wide Enterprise Grid install
-- (isEnterpriseInstall), else the team; the bot's user id is its self id; a
-- label still at begin's default becomes the workspace's (or org's) name.
-- `detail` is kept for display (Slack's error code on bad tokens), never
-- anything shaped like a token.
create or replace function public.bridge_runtime_state(p_frame jsonb) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare conn public.bridge_connections; st text := p_frame ->> 'status'; v_self text[]; acct jsonb;
        v_detail text := left(nullif(btrim(coalesce(p_frame ->> 'detail', '')), ''), 200);
begin
  perform internal.bridge_runtime_session();
  if st not in ('connecting', 'linked', 'logged_out', 'offline') then
    raise exception 'unknown connection status' using errcode = '22023';
  end if;
  select * into conn from public.bridge_connections
   where id = (p_frame ->> 'connectionId')::uuid and status <> 'removed' for update;
  if conn.id is null then raise exception 'bridge connection not found' using errcode = 'P0002'; end if;
  if v_detail ~* '(xox[a-z]-|xapp-|[A-Za-z0-9_-]{32,})' then v_detail := '[redacted]'; end if;
  if conn.provider = 'slack' then
    acct := internal.bridge_slack_account(p_frame -> 'account');
    v_self := case when acct is not null then array[acct ->> 'botUserId'] else '{}' end;
  else
    select array_remove(array[p_frame #>> '{self,id}', p_frame #>> '{self,lid}'], null) into v_self;
  end if;
  update public.bridge_connections
     set status = st, last_seen_at = now(),
         self_ids = case when cardinality(v_self) > 0 then v_self else bridge_connections.self_ids end,
         provider_account = coalesce(acct, bridge_connections.provider_account),
         state_detail = v_detail,
         external_account_id = case
           when acct is not null then case when (acct ->> 'isEnterpriseInstall')::boolean
                                           then acct ->> 'enterpriseId' else acct ->> 'teamId' end
           else coalesce(p_frame #>> '{self,id}', external_account_id) end,
         label = case
           when acct is not null and bridge_connections.label = 'Slack'
             then left(case when (acct ->> 'isEnterpriseInstall')::boolean
                            then coalesce(nullif(btrim(acct ->> 'enterpriseName'), ''), acct ->> 'teamName')
                            else acct ->> 'teamName' end, 80)
           else bridge_connections.label end
   where id = conn.id
  returning * into conn;
  return jsonb_build_object('connectionId', conn.id, 'status', conn.status);
end
$$;
revoke all on function public.bridge_runtime_state(jsonb) from public;
grant execute on function public.bridge_runtime_state(jsonb) to tm8_app;

-- conversation-state: 398's (an admins-only group falls back to `direction:
-- in`, D28), plus v4: a renamed Slack channel renames the bridge's
-- conversation; an archived one (canSend false) is `direction: in` as well.
create or replace function public.bridge_runtime_conversation_state(p_frame jsonb) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare n integer := 0; renamed integer := 0; v_name text := nullif(btrim(coalesce(p_frame ->> 'name', '')), '');
begin
  perform internal.bridge_runtime_session();
  if coalesce((p_frame ->> 'canSend')::boolean, true) = false then
    update public.bridges
       set policy = jsonb_set(policy, '{direction}', '"in"')
     where connection_id = (p_frame ->> 'connectionId')::uuid
       and external_conversation_id = p_frame ->> 'conversationId'
       and ended_at is null and policy ->> 'direction' <> 'in';
    get diagnostics n = row_count;
  end if;
  if v_name is not null then
    update public.bridges
       set conversation = jsonb_set(conversation, '{title}', to_jsonb(left(v_name, 200)))
     where connection_id = (p_frame ->> 'connectionId')::uuid
       and external_conversation_id = p_frame ->> 'conversationId'
       and ended_at is null and conversation ->> 'title' is distinct from left(v_name, 200);
    get diagnostics renamed = row_count;
  end if;
  return jsonb_build_object('updated', n, 'renamed', renamed);
end
$$;
revoke all on function public.bridge_runtime_conversation_state(jsonb) from public;
grant execute on function public.bridge_runtime_conversation_state(jsonb) to tm8_app;

-- -----------------------------------------------------------------------------
-- §3. Slack user ids are people.
-- -----------------------------------------------------------------------------

create or replace function internal.bridge_valid_external_id(p_provider text, p_external_id text)
returns void language plpgsql immutable set search_path = public, internal, pg_temp as $$
begin
  if p_external_id is null or char_length(p_external_id) not between 1 and 256 or p_external_id ~ '\s' then
    raise exception 'externalId must be one provider address, without spaces' using errcode = '22023';
  end if;
  if p_provider = 'whatsapp' and p_external_id !~ '^[0-9]{5,20}@(s\.whatsapp\.net|lid)$' then
    raise exception 'a WhatsApp link names a person: <digits>@s.whatsapp.net or <digits>@lid' using errcode = '22023';
  end if;
  if p_provider = 'slack' and p_external_id !~ '^[UW][A-Z0-9]{2,}$' then
    raise exception 'a Slack link names a person: a user id such as U0123ABCD (or W… on Enterprise Grid)' using errcode = '22023';
  end if;
end
$$;
revoke all on function internal.bridge_valid_external_id(text, text) from public;

-- -----------------------------------------------------------------------------
-- §4. Email auto-link (see TRUST in the header).
-- -----------------------------------------------------------------------------

alter table public.bridge_identity_links
  drop constraint bridge_identity_links_method_check,
  add constraint bridge_identity_links_method_check check (method in ('code', 'invite', 'admin', 'email')),
  drop constraint bridge_identity_links_check,
  add constraint bridge_identity_links_check check ((method in ('admin', 'email')) = (space_id is not null));

-- Called by the inbound door in the same transaction, BEFORE
-- bridge_runtime_inbound, so the resolver there already sees the link. Reads
-- the frame's sender.email and stores it nowhere.
create or replace function public.bridge_runtime_sender_email(p_frame jsonb) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  conn public.bridge_connections;
  b public.bridges;
  sender text := p_frame #>> '{sender,externalId}';
  v_email text := lower(btrim(coalesce(p_frame #>> '{sender,email}', '')));
  who text;
  n integer;
  cur public.bridge_identity_links;
begin
  perform internal.bridge_runtime_session();
  if sender is null or coalesce((p_frame #>> '{sender,bot}')::boolean, false)
     or coalesce((p_frame #>> '{sender,fromMe}')::boolean, false) then
    return jsonb_build_object('status', 'ignored', 'reason', 'no_person');
  end if;
  select * into conn from public.bridge_connections where id = (p_frame ->> 'connectionId')::uuid;
  if conn.id is null or conn.status = 'removed' or conn.provider <> 'slack' then
    return jsonb_build_object('status', 'ignored', 'reason', 'provider');
  end if;
  if sender !~ '^[UW][A-Z0-9]{2,}$' then
    return jsonb_build_object('status', 'ignored', 'reason', 'not_a_person');
  end if;
  select br.* into b from public.bridges br join public.entities e on e.id = br.entity_id and e.deleted_at is null
   where br.connection_id = conn.id and br.external_conversation_id = p_frame ->> 'conversationId'
     and br.ended_at is null and br.paused_at is null;
  if b.entity_id is null then
    return jsonb_build_object('status', 'ignored', 'reason', 'not_on_allowlist');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('bridge-email-link:' || b.space_id || ':' || sender, 0));

  -- The one active account with this email whose identity is an active member here.
  if v_email <> '' and v_email ~ '^[^@\s]+@[^@\s]+$' then
    select min(a.identity_id), count(*) into who, n
      from public.accounts a
     where lower(btrim(a.email)) = v_email and a.status = 'active'
       and exists (select 1 from public.members m join public.entities me on me.id = m.entity_id
                    where m.identity_id = a.identity_id and m.space_id = b.space_id
                      and m.status = 'active' and me.deleted_at is null);
    if n <> 1 then who := null; end if;
  end if;

  -- A code, invite or admin link on the address wins; email never writes beside it.
  if exists (select 1 from public.bridge_identity_links l
              where l.provider = 'slack' and l.external_id = sender and l.revoked_at is null
                and l.method <> 'email' and (l.space_id is null or l.space_id = b.space_id)) then
    return jsonb_build_object('status', 'kept', 'reason', 'linked_otherwise');
  end if;

  select * into cur from public.bridge_identity_links l
   where l.provider = 'slack' and l.external_id = sender and l.revoked_at is null
     and l.method = 'email' and l.space_id = b.space_id
   for update;
  if cur.id is not null and cur.identity_id is not distinct from who then
    return jsonb_build_object('status', 'kept', 'reason', 'same');
  end if;
  -- Slack's email no longer names that member: the email link follows it.
  if cur.id is not null then
    update public.bridge_identity_links set revoked_at = now() where id = cur.id;
  end if;
  if who is null then
    return jsonb_build_object('status', case when cur.id is null then 'ignored' else 'revoked' end, 'reason', 'no_match');
  end if;
  -- An admin's revoke of this email link sticks.
  if exists (select 1 from public.bridge_identity_links l
              where l.provider = 'slack' and l.external_id = sender and l.space_id = b.space_id
                and l.method = 'email' and l.identity_id = who and l.revoked_at is not null
                and l.id is distinct from cur.id) then
    return jsonb_build_object('status', 'ignored', 'reason', 'revoked_before');
  end if;
  begin
    insert into public.bridge_identity_links(provider, external_id, identity_id, method, space_id,
                                             asserted_by_member_id, verified_at)
    values ('slack', sender, who, 'email', b.space_id, null, now());
  exception when unique_violation then
    return jsonb_build_object('status', 'kept', 'reason', 'concurrent');
  end;
  return jsonb_build_object('status', 'linked');
end
$$;
revoke all on function public.bridge_runtime_sender_email(jsonb) from public;
grant execute on function public.bridge_runtime_sender_email(jsonb) to tm8_app;

-- -----------------------------------------------------------------------------
-- §5. Edits and deletes at the provider. Never routed: no copy, no turn, no wake.
-- -----------------------------------------------------------------------------

create or replace function public.bridge_runtime_inbound_change(p_frame jsonb) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  conn public.bridge_connections;
  b public.bridges;
  ext text := p_frame ->> 'externalMessageId';
  conv text := p_frame ->> 'conversationId';
  deleting boolean := coalesce((p_frame ->> 'deleted')::boolean, false);
  v_body text := coalesce(p_frame ->> 'body', '');
  log_id uuid;
  ids uuid[];
  n integer;
begin
  perform internal.bridge_runtime_session();
  if ext is null or conv is null or char_length(ext) > 256 then
    raise exception 'inbound needs a conversationId and an externalMessageId' using errcode = '22023';
  end if;
  if not deleting and jsonb_typeof(p_frame -> 'edit') is distinct from 'object' then
    raise exception 'an inbound change is an edit or a delete' using errcode = '22023';
  end if;
  select * into conn from public.bridge_connections where id = (p_frame ->> 'connectionId')::uuid;
  if conn.id is null or conn.status = 'removed' then
    return jsonb_build_object('status', 'refused', 'reason', 'unknown_connection');
  end if;
  -- A paused bridge still mirrors a delete (retention); an ended one is history.
  select br.* into b from public.bridges br join public.entities e on e.id = br.entity_id and e.deleted_at is null
   where br.connection_id = conn.id and br.external_conversation_id = conv and br.ended_at is null;
  if b.entity_id is null then
    update public.bridge_connections
       set allowlist_dirty = true,
           runtime_counters = jsonb_set(coalesce(runtime_counters, '{}'::jsonb), '{serverRefused}',
             to_jsonb(coalesce((runtime_counters ->> 'serverRefused')::integer, 0) + 1))
     where id = conn.id;
    return jsonb_build_object('status', 'refused', 'reason', 'not_on_allowlist');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('bridge-in:' || b.entity_id || ':' || ext, 0));
  select message_id into log_id from public.message_origins
   where bridge_id = b.entity_id and external_message_id = ext and direction = 'in';
  if log_id is null then
    return jsonb_build_object('status', 'ignored', 'reason', 'unknown_message', 'bridgeId', b.entity_id);
  end if;
  -- The log copy and every routed copy of it (one batch).
  select array_agg(m.entity_id) into ids from public.messages m
   where m.entity_id = log_id or m.message_batch_id = 'bridge-in:' || b.entity_id || ':' || ext;

  if deleting then
    update public.messages
       set body = '[deleted]', mentions = '[]'::jsonb, attachments = '[]'::jsonb, redacted_at = now()
     where entity_id = any(ids) and redacted_at is null;
    get diagnostics n = row_count;
    update public.entities set deleted_at = now(), updated_at = now()
     where id = any(ids) and deleted_at is null;
    -- Its files go with it, and nothing still waiting is fetched or delivered.
    update public.entities set deleted_at = now(), updated_at = now()
     where id in (select file_id from public.bridge_media where message_id = log_id and file_id is not null)
       and deleted_at is null;
    delete from public.bridge_media where message_id = log_id and status in ('pending', 'fetching', 'failed');
    update public.session_message_deliveries
       set status = 'cancelled', failure_reason = 'message_deleted', settled_at = now()
     where message_id = any(ids) and status = 'pending';
    update public.message_origins set sender_display = null, media = null where message_id = log_id;
    return jsonb_build_object('status', 'deleted', 'messageId', log_id, 'bridgeId', b.entity_id, 'copies', n);
  end if;

  if v_body = '' then
    v_body := coalesce((select string_agg(coalesce(m ->> 'caption', '[' || coalesce(m ->> 'kind', 'media') || ']'), E'\n')
                        from jsonb_array_elements(coalesce(p_frame -> 'media', '[]'::jsonb)) m), '');
  end if;
  if v_body = '' then v_body := '[message]'; end if;
  v_body := left(v_body, 10000);
  update public.messages set body = v_body
   where entity_id = any(ids) and redacted_at is null and messages.body is distinct from v_body;
  get diagnostics n = row_count;
  return jsonb_build_object('status', 'edited', 'messageId', log_id, 'bridgeId', b.entity_id, 'copies', n);
end
$$;
revoke all on function public.bridge_runtime_inbound_change(jsonb) from public;
grant execute on function public.bridge_runtime_inbound_change(jsonb) to tm8_app;

-- -----------------------------------------------------------------------------
-- §6. Outbound: threads, voice, Retry-After.
-- -----------------------------------------------------------------------------

alter table public.bridge_outbox add column thread_ts text
  check (thread_ts is null or char_length(thread_ts) between 1 and 256);
comment on column public.bridge_outbox.thread_ts is
  '443 (Slack, native threads): the root message id of the provider thread this send goes into (send.threadTs). '
  'Filled by 444''s thread mode; null posts to the conversation.';

-- 413's signature, but a perUserVoice provider's text carries no prefix: the
-- name rides send.voice (§2.2 "Voice"). A worker's handle is still assigned on
-- its first post, so the voice can name it.
create or replace function internal.bridge_signed(b public.bridges, p_author uuid, p_session uuid, p_poster text, p_text text)
returns text language plpgsql volatile set search_path = public, internal, pg_temp as $$
declare who text; handle jsonb; title text;
begin
  if b.policy ->> 'voice' = 'plain' then return p_text; end if;
  if internal.bridge_provider_voices(b.provider) then
    if p_poster = 'worker' and p_session is not null then
      perform internal.bridge_try('public.bridge_poster_handle', 'uuid,uuid', b.entity_id::text, p_session::text);
    end if;
    return p_text;
  end if;
  if p_poster = 'notice' then return 'tm8: ' || p_text; end if;
  if p_poster = 'chat' then
    select tm.name into who from public.team_members tm where tm.entity_id = coalesce(b.teammate_id, p_author);
    return coalesce(nullif(btrim(who), ''), 'tm8') || ': ' || p_text;
  end if;
  if p_poster = 'worker' and p_session is not null then
    handle := internal.bridge_try('public.bridge_poster_handle', 'uuid,uuid', b.entity_id::text, p_session::text);
    select ws.title into title from public.work_sessions ws where ws.entity_id = p_session;
    title := coalesce(handle ->> 'title', title, 'tm8');
    return case when handle ->> 'handle' is not null then title || ' (' || (handle ->> 'handle') || '): ' else title || ': ' end
           || p_text;
  end if;
  select coalesce(m.display_name, 'tm8') into who from public.members m where m.entity_id = p_author;
  return coalesce(who, 'tm8') || ': ' || p_text;
end
$$;
revoke all on function internal.bridge_signed(public.bridges, uuid, uuid, text, text) from public;

-- send.voice for one outbox row: the same name bridge_signed would have put in
-- front, and a public https avatar when the author has one. Null under
-- `voice: plain` (the app's own name and icon).
create or replace function internal.bridge_outbox_voice(p_bridge uuid, p_poster text, p_teammate uuid, p_session uuid, p_message uuid)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare b public.bridges; who text; title text; handle text; icon text; author uuid;
begin
  select * into b from public.bridges where entity_id = p_bridge;
  if b.entity_id is null or b.policy ->> 'voice' = 'plain' then return null; end if;
  select m.author_id into author from public.messages m where m.entity_id = p_message;
  if p_poster = 'chat' then
    select tm.name into who from public.team_members tm where tm.entity_id = coalesce(b.teammate_id, p_teammate, author);
  elsif p_poster = 'worker' and p_session is not null then
    select h.title, h.handle into title, handle from public.bridge_handles h
     where h.space_id = b.space_id and h.entity_id = p_session;
    title := coalesce(title, (select ws.title from public.work_sessions ws where ws.entity_id = p_session));
    who := case when handle is not null and title is not null then title || ' (' || handle || ')'
                else coalesce(title, handle) end;
  elsif p_poster = 'worker' then
    select tm.name into who from public.team_members tm where tm.entity_id = coalesce(p_teammate, author);
  elsif p_poster = 'member' then
    select m.display_name, p.avatar into who, icon
      from public.members m left join public.user_profiles p on p.identity_id = m.identity_id
     where m.entity_id = author;
  end if;
  return jsonb_build_object(
    'username', left(coalesce(nullif(btrim(who), ''), 'tm8'), 80),
    'iconUrl', case when icon ~ '^https://[^\s]{1,2000}$' then icon end);
end
$$;
revoke all on function internal.bridge_outbox_voice(uuid, text, uuid, uuid, uuid) from public;

-- 434's take, plus: send.threadTs from thread_ts; send.voice on a perUserVoice
-- provider; nothing names a slash command's `cmd:` id as a thread or a quote,
-- and a reaction on one is never sent (it is not a message the provider holds).
create or replace function internal.bridge_outbox_take(p_runtime_ids text[], p_limit integer) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare r record; frames jsonb := '[]'::jsonb; reason text;
begin
  perform internal.require_bridges_worker();
  for r in
    select ob.*, c.runtime_id, c.status as conn_status, c.provider as conn_provider, b.paused_at, b.ended_at, b.muted_until,
           b.policy ->> 'direction' as direction, b.policy ->> 'voice' as policy_voice, b.external_conversation_id as conv
      from public.bridge_outbox ob
      join public.bridge_connections c on c.id = ob.connection_id
      join public.bridges b on b.entity_id = ob.bridge_id
     where (ob.status = 'pending' or (ob.status = 'failed_retryable' and coalesce(ob.next_attempt_at, now()) <= now()))
       and c.runtime_id = any(p_runtime_ids) and c.status = 'linked'
       and not exists (select 1 from public.bridge_outbox active
                       where active.connection_id = ob.connection_id and active.status = 'dispatching')
     order by ob.created_at
     limit greatest(least(p_limit, 100), 1)
     for update of ob skip locked
  loop
    -- Do not let queued frames expire behind a long media upload. One active
    -- send per connection; the runtime renews its lease until settlement.
    -- Row locks alone protect only this outbox row. Another taker may have
    -- locked a different row for the same number before either dispatch is
    -- committed, so serialize admission per connection without waiting.
    if not pg_try_advisory_xact_lock(hashtextextended('bridge-outbox-dispatch:' || r.connection_id::text, 0)) then
      continue;
    end if;
    if exists (select 1 from public.bridge_outbox active
                where active.connection_id = r.connection_id and active.status = 'dispatching') then
      continue;
    end if;
    reason := case
      when r.ended_at is not null then 'bridge_ended'
      when r.paused_at is not null or r.muted_until > now() then 'bridge_paused'
      when r.direction = 'in' then 'direction_in'
      when not (r.conv = any(internal.bridge_allowlist_ids(r.connection_id))) then 'not_connected'
      -- 443: a slash command (`cmd:<trigger_id>`) is not a message at the provider.
      when r.kind = 'react' and coalesce(r.payload #>> '{target,externalMessageId}', '') like 'cmd:%' then 'not_reactable'
      -- 427: WhatsApp keeps one reaction per sender; a lower one sent now would replace a higher one.
      when r.kind = 'react' and internal.bridge_reaction_rank(r.reaction) < 100 and exists (
             select 1 from public.bridge_outbox x
              where x.message_id = r.message_id and x.kind = 'react' and x.id <> r.id
                and internal.bridge_reaction_rank(x.reaction) > internal.bridge_reaction_rank(r.reaction))
        then 'superseded' end;
    if reason is not null then
      update public.bridge_outbox set status = 'failed_permanent', settled_at = now(), last_error = reason where id = r.id;
      continue;
    end if;
    update public.bridge_outbox set status = 'dispatching', attempts = attempts + 1, dispatched_at = now() where id = r.id;
    frames := frames || jsonb_build_array(jsonb_build_object('runtimeId', r.runtime_id, 'frame',
      case r.kind
        when 'send' then jsonb_strip_nulls(jsonb_build_object('type', 'send', 'outboxId', r.id,
          'connectionId', r.connection_id, 'conversationId', r.conv, 'text', r.payload ->> 'text',
          'replyTo', case when coalesce(r.payload #>> '{replyTo,externalMessageId}', '') not like 'cmd:%'
                          then r.payload -> 'replyTo' end,
          'threadTs', case when r.thread_ts not like 'cmd:%' then r.thread_ts end,
          -- SERVER-ONLY metadata. The hub emits only a file entity reference;
          -- the authenticated HTTP door resolves the storage path when read.
          'files', (select jsonb_agg(jsonb_build_object('fileEntityId', f.entity_id, 'spaceId', e.space_id,
                        'storagePath', f.storage_path, 'name', f.name, 'mime', f.mime_type, 'size', f.size_bytes)
                        order by a.ord)
                      from jsonb_array_elements(r.payload -> 'files') with ordinality a(item, ord)
                      join public.files f on f.entity_id = (a.item ->> 'fileEntityId')::uuid
                      join public.entities e on e.id = f.entity_id and e.deleted_at is null)))
          -- After the strip: SendVoice keeps `iconUrl: null` (the app's icon).
          || case when internal.bridge_provider_voices(r.conn_provider) and r.policy_voice is distinct from 'plain'
               then jsonb_build_object('voice',
                      internal.bridge_outbox_voice(r.bridge_id, r.poster, r.teammate_id, r.session_id, r.message_id))
               else '{}'::jsonb end
        else jsonb_build_object('type', 'react', 'outboxId', r.id, 'connectionId', r.connection_id,
          'conversationId', r.conv, 'target', r.payload -> 'target', 'emoji', r.payload ->> 'emoji') end));
  end loop;
  return frames;
end
$$;
revoke all on function internal.bridge_outbox_take(text[], integer) from public;
grant execute on function internal.bridge_outbox_take(text[], integer) to tm8_app;

-- sent: 398's, plus v4's failed.retryAfterSec: the next try waits at least as
-- long as the provider asked (capped at an hour), and a provider's rate limit
-- gets ten tries rather than five.
create or replace function public.bridge_runtime_sent(p_frame jsonb) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare ob public.bridge_outbox; ok boolean := p_frame ? 'externalMessageId'; retryable boolean; retry_after numeric;
begin
  perform internal.bridge_runtime_session();
  select * into ob from public.bridge_outbox where id = (p_frame ->> 'outboxId')::uuid for update;
  if ob.id is null or ob.connection_id is distinct from (p_frame ->> 'connectionId')::uuid then
    raise exception 'outbox row not found for this connection' using errcode = 'P0002';
  end if;
  if ob.status in ('sent', 'failed_permanent') then
    return jsonb_build_object('outboxId', ob.id, 'status', ob.status, 'replayed', true);
  end if;
  if ok then
    update public.bridge_outbox
       set status = 'sent', external_message_id = p_frame ->> 'externalMessageId', settled_at = now(), last_error = null
     where id = ob.id;
    if ob.kind = 'send' then
      insert into public.message_origins(message_id, bridge_id, connection_id, direction, external_message_id,
        external_conversation_id, external_sender_id, external_reply_to_id, external_ts, provider_payload)
      values (ob.message_id, ob.bridge_id, ob.connection_id, 'out', p_frame ->> 'externalMessageId',
              ob.external_conversation_id, null, ob.external_reply_to, now(), p_frame -> 'message')
      on conflict do nothing;
    end if;
  else
    retry_after := case when jsonb_typeof(p_frame #> '{failed,retryAfterSec}') = 'number'
                        then least(greatest((p_frame #>> '{failed,retryAfterSec}')::numeric, 0), 3600) end;
    retryable := coalesce((p_frame #>> '{failed,retryable}')::boolean, false)
                 and ob.attempts < case when retry_after is not null then 10 else 5 end;
    update public.bridge_outbox
       set status = case when retryable then 'failed_retryable' else 'failed_permanent' end,
           settled_at = case when retryable then null else now() end,
           next_attempt_at = case when retryable then now() + make_interval(secs => greatest(
             case when retry_after is not null then 1 else 5 * power(2, ob.attempts) end, coalesce(retry_after, 0))) end,
           last_error = left(coalesce(p_frame #>> '{failed,reason}', 'failed'), 300)
     where id = ob.id;
  end if;
  select * into ob from public.bridge_outbox where id = ob.id;
  return jsonb_strip_nulls(jsonb_build_object('outboxId', ob.id, 'status', ob.status, 'nextAttemptAt', ob.next_attempt_at));
end
$$;
revoke all on function public.bridge_runtime_sent(jsonb) from public;
grant execute on function public.bridge_runtime_sent(jsonb) to tm8_app;

-- -----------------------------------------------------------------------------
-- §7. 427's progress reactions, for every provider whose runtime reacts.
-- -----------------------------------------------------------------------------

create or replace function internal.bridge_progress_advance(p_message uuid, p_stage text) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  o public.message_origins; b public.bridges;
  v_key text := 'tm8:' || p_stage;
  v_emoji text := case p_stage when 'delivered' then '📨' when 'seen' then '👀' when 'replied' then '✅' end;
  v_top integer; v_started boolean; v_row uuid;
begin
  if v_emoji is null then raise exception 'progress is delivered, seen or replied' using errcode = '22023'; end if;
  select * into o from public.message_origins where message_id = p_message and direction = 'in';
  if o.message_id is null or o.command_state is not null or o.external_message_id like 'cmd:%' then
    return jsonb_build_object('status', 'ignored', 'reason', 'not_inbound');
  end if;
  select * into b from public.bridges where entity_id = o.bridge_id;
  if b.entity_id is null or not internal.bridge_provider_reacts(b.provider) then
    return jsonb_build_object('status', 'ignored', 'reason', 'provider');
  end if;

  -- One stage decision per message at a time.
  perform pg_advisory_xact_lock(hashtextextended('bridge-progress:' || p_message, 0));
  select max(internal.bridge_reaction_rank(reaction)), coalesce(bool_or(reaction like 'tm8:%'), false)
    into v_top, v_started
    from public.bridge_outbox where message_id = p_message and kind = 'react';
  if v_top >= 100 then
    return jsonb_build_object('status', 'ignored', 'reason', 'explicit_reaction');
  end if;
  if coalesce(v_top, 0) >= internal.bridge_reaction_rank(v_key) then
    return jsonb_build_object('status', 'ignored', 'reason', 'behind');
  end if;
  if not v_started and not internal.bridge_progress_addressed(o, b) then
    return jsonb_build_object('status', 'ignored', 'reason', 'not_addressed');
  end if;

  -- A stage still waiting to go is rewritten to this one: WhatsApp would
  -- replace it anyway, and the buckets count rows. A row a dispatch holds is
  -- no longer pending once its lock is released, and gets a new row below.
  update public.bridge_outbox
     set reaction = v_key, payload = jsonb_set(payload, '{emoji}', to_jsonb(v_emoji))
   where message_id = p_message and kind = 'react' and status = 'pending' and reaction like 'tm8:%'
  returning id into v_row;
  if v_row is not null then
    return jsonb_build_object('status', 'pending', 'outboxId', v_row, 'stage', p_stage, 'coalesced', true);
  end if;
  return internal.bridge_outbox_enqueue(b.entity_id, p_message, 'react',
           jsonb_build_object('target', internal.bridge_quote_ref(p_message), 'emoji', v_emoji),
           jsonb_build_object('poster', 'system', 'reaction', v_key))
         || jsonb_build_object('stage', p_stage);
end
$$;
revoke all on function internal.bridge_progress_advance(uuid, text) from public;

reset role;
