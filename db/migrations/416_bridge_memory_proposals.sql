-- =============================================================================
-- 416 — Bridges R: `/remember` proposals (D29, D61-D63). (Provisional number;
-- the merger assigns the final one.)
-- (Authored as 403; renumbered to 416 on the rebase onto main 556b8cc5a: main's max is 407 and B3 takes 408.)
-- (Authored as 403, then 409; renumbered to 416 at merge by the bridges merger: next free above main's 412.)
--
-- Design of record: docs/features/bridges/BRIDGE-ENTITY-DESIGN.md (FINAL v4)
-- D29's last bullet and D61-D63; BRIDGES-V2-DESIGN.md §2.1 and V3. Task
-- 01a189db-36d1-7b13-8d37-f9a076d91254. Builds on 395 (B0a: bridges,
-- participants, identity links, bridge_resolve_author) and 399 (B1b-3: the
-- D22/D31 provenance stamp, `authored_from -> message`).
--
-- `/remember <text>` from a bridged group creates a memory PROPOSAL, never a
-- memory (D61). Nothing persistent changes from WhatsApp alone (v2 V3): a
-- proposal is accepted in tm8, by a human, from the inbox item it raised.
--
-- WHAT THIS FILE DOES
--   §1  public.bridge_memory_proposals: one row per (bridge, provider message),
--       so the executor's re-run of a command adds none.
--   §2  who: internal.bridge_group_members (the group's linked members, each
--       with its best trust), internal.bridge_memory_secret_scan, and
--       internal.bridge_memory_proposal_can_decide (D62).
--   §3  propose (the bridges worker only): resolves the sender itself, refuses
--       guests and credential-pattern hits (stored nowhere, D61), and raises
--       one `decide` inbox item on the bridge per recipient: the proposer and
--       the group's linked members (assignee_id).
--   §4  resolve (human-only, browser or cli): accept creates the memory as the
--       decider, `bridge remembers memory`, and stamps D22 provenance with
--       399's internal.bridge_stamp (command '/remember', the proposer, the
--       WhatsApp message); drop closes it. Both settle every inbox item.
--   §5  expiry (D63): 14 days after it was proposed, by the scheduler job
--       (node admin), and refused at decision time even before the job ran.
--   §6  reads: list for any member who can read the bridge, with canDecide.
--
-- No sender phone number leaves this file: the row keeps the participant's
-- display name and member id, never the provider id (§6 PII).
--
-- REFUSALS. TBC01 -> `conflict` with details.reason: proposal_expired,
-- proposal_decided, too_many_proposals, bridge_ended. 42501 with a reason:
-- remember_needs_link (a guest), proposal_holds_secret (a credential value),
-- proposal_not_decider, bridges_worker_only. Not found is P0002.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. The table.
-- -----------------------------------------------------------------------------
create table public.bridge_memory_proposals (
  id                  uuid primary key default internal.new_id(),
  space_id            uuid not null references public.spaces(id) on delete cascade,
  bridge_id           uuid not null references public.bridges(entity_id) on delete cascade,
  statement           text not null check (char_length(btrim(statement)) between 1 and 4000),
  -- The proposer as bridge_resolve_author saw them at the time: a member, and
  -- whether that member's link was verified (code, invite) or admin-asserted.
  proposed_by         uuid not null references public.entities(id),
  proposer_trust      text not null check (proposer_trust in ('linked', 'asserted')),
  proposer_name       text not null default '',
  message_id          uuid references public.entities(id) on delete set null,
  provider_message_id text not null check (char_length(provider_message_id) between 1 and 512),
  -- A word like "password" in the text: shown to the decider, not refused.
  -- A credential VALUE never gets here (propose refuses it, D61).
  mentions_secret     boolean not null default false,
  status              text not null default 'pending'
    check (status in ('pending', 'accepted', 'dropped', 'expired')),
  memory_id           uuid references public.entities(id) on delete set null,
  decided_by          uuid references public.entities(id),
  decided_at          timestamptz,
  decision_note       text check (decision_note is null or char_length(decision_note) <= 1000),
  expires_at          timestamptz not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             integer not null default 1 check (version > 0),
  constraint bridge_memory_proposals_decided_check
    check ((status = 'pending') = (decided_at is null)),
  constraint bridge_memory_proposals_decider_check
    check ((status in ('accepted', 'dropped')) = (decided_by is not null)),
  constraint bridge_memory_proposals_memory_check
    check (memory_id is null or status = 'accepted')
);
create unique index bridge_memory_proposals_one_per_message
  on public.bridge_memory_proposals(bridge_id, provider_message_id);
create index bridge_memory_proposals_bridge_idx
  on public.bridge_memory_proposals(bridge_id, created_at desc, id);
create index bridge_memory_proposals_pending_idx
  on public.bridge_memory_proposals(expires_at) where status = 'pending';

create trigger bridge_memory_proposals_touch_updated_at
before update on public.bridge_memory_proposals
for each row execute function internal.touch_updated_at();

alter table public.bridge_memory_proposals enable row level security;
-- Readable when the bridge is (218's shape, as 395's bridge tables).
create policy bridge_memory_proposals_select on public.bridge_memory_proposals for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = bridge_memory_proposals.bridge_id
                     and readable_entity.deleted_at is null offset 0)));
grant select on public.bridge_memory_proposals to tm8_app;

comment on table public.bridge_memory_proposals is
  '416 (Bridges D29, D61): a /remember from a bridged group. Never a memory until '
  'a linked member of that group accepts it in tm8 (D62); expires after 14 days '
  '(D63). Writes only through the definer doors.';

-- The pending cap per bridge: a group cannot bury its members' inbox.
create or replace function internal.bridge_memory_pending_cap() returns integer
language sql immutable set search_path = public, internal, pg_temp as $$ select 20 $$;
revoke all on function internal.bridge_memory_pending_cap() from public;

-- -----------------------------------------------------------------------------
-- §2. Who.
-- -----------------------------------------------------------------------------

-- The group's linked members (D29): active members of the bridge's space whose
-- unrevoked link (identity-scoped, or asserted for THIS space) names someone
-- who has appeared in the group. trust is the member's best link: 'linked'
-- when any is verified (code, invite), else 'asserted'.
create or replace function internal.bridge_group_members(p_bridge_id uuid)
returns table(member_id uuid, identity_id text, trust text)
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select m.entity_id, m.identity_id,
         case when bool_or(l.space_id is null) then 'linked' else 'asserted' end
    from public.bridges b
    join public.bridge_participants p on p.bridge_id = b.entity_id
    join public.bridge_identity_links l
      on l.provider = b.provider and l.revoked_at is null
     and l.external_id = any(array[p.external_id] || p.alt_external_ids)
     and (l.space_id is null or l.space_id = b.space_id)
    join public.members m on m.space_id = b.space_id and m.identity_id = l.identity_id and m.status = 'active'
    join public.entities me on me.id = m.entity_id and me.deleted_at is null
   where b.entity_id = p_bridge_id
   group by m.entity_id, m.identity_id
$$;
revoke all on function internal.bridge_group_members(uuid) from public;

-- D61: a credential VALUE (086's manifest pattern) refuses the proposal; a
-- word that names a secret only warns the decider.
create or replace function internal.bridge_memory_secret_scan(p_text text)
returns text language sql immutable set search_path = public, internal, pg_temp as $$
  select case
    when coalesce(p_text, '') ~ ('(^|[^A-Za-z0-9_-])'
           '(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}'
           '|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)')
      then 'value'
    when coalesce(p_text, '') ~* '(password|passwd|passphrase|secret|token|api[ _-]?key|private key|credential)'
      then 'mention'
  end
$$;
revoke all on function internal.bridge_memory_secret_scan(text) from public;

-- D62: who may accept or drop. A human (browser, cli) who is an active member
-- of the space and a linked member of THAT group. A proposal from an
-- admin-asserted link needs a member whose link is verified, or a space admin.
-- Nobody else: not any admin for every proposal, never an agent, never the
-- bridges worker, never anything from WhatsApp.
create or replace function internal.bridge_memory_proposal_can_decide(p_row public.bridge_memory_proposals)
returns boolean language sql stable security definer set search_path = public, internal, pg_temp as $$
  select coalesce(internal.claim_text('tm8.auth_kind'), '') in ('browser', 'cli')
     and internal.current_member_id(p_row.space_id) is not null
     and (exists (select 1 from internal.bridge_group_members(p_row.bridge_id) g
                   where g.member_id = internal.current_member_id(p_row.space_id)
                     and (p_row.proposer_trust = 'linked' or g.trust = 'linked'))
          or (p_row.proposer_trust = 'asserted' and internal.is_space_admin(p_row.space_id)))
$$;
revoke all on function internal.bridge_memory_proposal_can_decide(public.bridge_memory_proposals) from public;

create or replace function internal.bridge_memory_proposal_json(p_row public.bridge_memory_proposals)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', p_row.id,
    'spaceId', p_row.space_id,
    'bridgeId', p_row.bridge_id,
    'statement', p_row.statement,
    'proposedBy', p_row.proposed_by,
    'proposerName', p_row.proposer_name,
    'proposerTrust', p_row.proposer_trust,
    'messageId', p_row.message_id,
    'mentionsSecret', p_row.mentions_secret,
    'status', p_row.status,
    'memoryId', p_row.memory_id,
    'decidedBy', p_row.decided_by,
    'decidedAt', p_row.decided_at,
    'decisionNote', p_row.decision_note,
    'expiresAt', p_row.expires_at,
    'canDecide', p_row.status = 'pending' and p_row.expires_at > now()
                 and internal.bridge_memory_proposal_can_decide(p_row),
    'createdAt', p_row.created_at,
    'updatedAt', p_row.updated_at,
    'version', p_row.version)
$$;
revoke all on function internal.bridge_memory_proposal_json(public.bridge_memory_proposals) from public;

-- The inbox items of one proposal: one per recipient, keyed so they can be
-- found and settled together.
create or replace function internal.bridge_memory_signal_prefix(p_proposal_id uuid)
returns text language sql immutable set search_path = public, internal, pg_temp as $$
  select 'bridge_memory_proposal:' || p_proposal_id::text || ':'
$$;
revoke all on function internal.bridge_memory_signal_prefix(uuid) from public;

create or replace function internal.bridge_memory_settle_attention(
  p_row public.bridge_memory_proposals, p_status text, p_actor uuid, p_note text)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
begin
  update public.attention_requests
     set status = p_status, resolved_by = p_actor, resolved_at = now(),
         resolution_note = left(p_note, 1000), version = version + 1
   where entity_id = p_row.bridge_id and status in ('open', 'acknowledged')
     and starts_with(signal_key, internal.bridge_memory_signal_prefix(p_row.id));
  update public.entities set activity_at = now(), updated_at = clock_timestamp()
   where id = p_row.bridge_id and deleted_at is null;
end
$$;
revoke all on function internal.bridge_memory_settle_attention(public.bridge_memory_proposals, text, uuid, text) from public;

-- -----------------------------------------------------------------------------
-- §3. Propose: the command executor's door for `/remember` (B1b-4). The
--     executor runs under the bridges worker claim (398's is_bridges_worker():
--     tm8.background_job = 'bridges.runtime', never on a space-pinned
--     session); this door checks the same claim inline so it does not depend
--     on 398's merge order. It resolves the sender itself: the caller names a
--     provider sender, never a member.
-- -----------------------------------------------------------------------------
create or replace function public.propose_bridge_memory(
  p_bridge_id uuid, p_sender_external_id text, p_statement text,
  p_message_id uuid, p_provider_message_id text
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  b public.bridges;
  author jsonb;
  row public.bridge_memory_proposals;
  scan text;
  title text;
  recipient record;
begin
  if not (coalesce(internal.claim_text('tm8.background_job') = 'bridges.runtime', false)
          and nullif(current_setting('tm8.session_space_id', true), '') is null) then
    raise exception 'only the in-process bridges worker may propose a memory' using errcode = '42501',
      detail = jsonb_build_object('reason', 'bridges_worker_only')::text;
  end if;
  select * into b from public.bridges where entity_id = p_bridge_id for share;
  if b.entity_id is null then
    raise exception 'bridge % not found', p_bridge_id using errcode = 'P0002';
  end if;
  if b.ended_at is not null then
    raise exception 'this bridge was removed' using errcode = 'TBC01',
      detail = jsonb_build_object('reason', 'bridge_ended')::text;
  end if;
  if nullif(btrim(coalesce(p_provider_message_id, '')), '') is null then
    raise exception 'a proposal names the provider message it came from' using errcode = '22023';
  end if;

  -- A re-run of the same command answers the proposal it already made.
  select * into row from public.bridge_memory_proposals
   where bridge_id = p_bridge_id and provider_message_id = p_provider_message_id;
  if row.id is not null then
    return internal.bridge_memory_proposal_json(row) || jsonb_build_object('created', false);
  end if;

  author := internal.bridge_resolve_author(p_bridge_id, p_sender_external_id);
  if author ->> 'kind' <> 'member' then
    raise exception '/remember is for linked members of this group' using errcode = '42501',
      detail = jsonb_build_object('reason', 'remember_needs_link')::text;
  end if;
  if char_length(btrim(coalesce(p_statement, ''))) not between 1 and 4000 then
    raise exception 'a memory is 1 to 4000 characters' using errcode = '22023';
  end if;
  scan := internal.bridge_memory_secret_scan(p_statement);
  if scan = 'value' then
    -- D61: refused, and stored nowhere: not in this table, not in an inbox item.
    raise exception 'that looks like a credential: a memory never holds one' using errcode = '42501',
      detail = jsonb_build_object('reason', 'proposal_holds_secret')::text;
  end if;
  if (select count(*) from public.bridge_memory_proposals
       where bridge_id = p_bridge_id and status = 'pending' and expires_at > now())
     >= internal.bridge_memory_pending_cap() then
    raise exception 'this group already has % memory proposals waiting', internal.bridge_memory_pending_cap()
      using errcode = 'TBC01',
            detail = jsonb_build_object('reason', 'too_many_proposals', 'limit', internal.bridge_memory_pending_cap())::text;
  end if;
  if p_message_id is not null and not exists (
       select 1 from public.entities e where e.id = p_message_id and e.kind = 'message' and e.space_id = b.space_id) then
    raise exception 'the origin message is not on this bridge''s space' using errcode = '22023';
  end if;

  insert into public.bridge_memory_proposals(space_id, bridge_id, statement, proposed_by, proposer_trust,
                                             proposer_name, message_id, provider_message_id, mentions_secret,
                                             expires_at)
  values (b.space_id, p_bridge_id, btrim(p_statement), (author ->> 'actorId')::uuid, author ->> 'trust',
          coalesce(nullif(author #>> '{participant,displayName}', ''), ''), p_message_id,
          p_provider_message_id, coalesce(scan = 'mention', false), now() + interval '14 days')
  on conflict (bridge_id, provider_message_id) do nothing
  returning * into row;
  if row.id is null then
    -- A concurrent run of the same command won.
    select * into row from public.bridge_memory_proposals
     where bridge_id = p_bridge_id and provider_message_id = p_provider_message_id;
    return internal.bridge_memory_proposal_json(row) || jsonb_build_object('created', false);
  end if;

  title := coalesce(b.conversation ->> 'title', 'a group');
  for recipient in
    select row.proposed_by as member_id
    union
    select g.member_id from internal.bridge_group_members(p_bridge_id) g
  loop
    insert into public.attention_requests(space_id, entity_id, reason, points, requested_by, origin,
                                          signal_key, level, action_type, assignee_id)
    values (b.space_id, p_bridge_id,
            left(coalesce(nullif(row.proposer_name, ''), 'A member') || ' proposed a memory for ' || title
                 || case when row.mentions_secret then ' (it mentions a secret: accept only if it holds none)' else '' end
                 || ': "' || left(row.statement, 200) || '"', 500),
            40, row.proposed_by, 'system',
            internal.bridge_memory_signal_prefix(row.id) || recipient.member_id::text,
            'normal', 'decide', recipient.member_id);
  end loop;
  update public.entities set activity_at = now(), updated_at = clock_timestamp()
   where id = p_bridge_id and deleted_at is null;

  return internal.bridge_memory_proposal_json(row) || jsonb_build_object('created', true);
end
$$;

-- -----------------------------------------------------------------------------
-- §4. Resolve: accept or drop. Human-only, in tm8 (D29, v2 V3).
-- -----------------------------------------------------------------------------
create or replace function public.resolve_bridge_memory_proposal(
  p_proposal_id uuid, p_decision text, p_statement text default null, p_note text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.bridge_memory_proposals;
  b public.bridges;
  decider uuid;
  final_statement text;
  created jsonb;
  memory uuid;
  title text;
begin
  if p_decision is null or p_decision not in ('accept', 'drop') then
    raise exception 'decision must be accept or drop' using errcode = '22023';
  end if;
  select pr.* into row from public.bridge_memory_proposals pr
   where pr.id = p_proposal_id for update;
  if row.id is null or not internal.is_space_member(row.space_id) then
    raise exception 'memory proposal % not found', p_proposal_id using errcode = 'P0002';
  end if;
  perform internal.require_human_auth_kind();

  -- A retried decision answers what was decided.
  if row.status = (case p_decision when 'accept' then 'accepted' else 'dropped' end) then
    return internal.bridge_memory_proposal_json(row);
  end if;
  if row.status <> 'pending' then
    raise exception 'this proposal is already %', row.status using errcode = 'TBC01',
      detail = jsonb_build_object('reason', 'proposal_decided', 'status', row.status)::text;
  end if;
  if row.expires_at <= now() then
    raise exception 'this proposal expired on %', row.expires_at using errcode = 'TBC01',
      detail = jsonb_build_object('reason', 'proposal_expired')::text;
  end if;
  if not internal.bridge_memory_proposal_can_decide(row) then
    raise exception '%', case when row.proposer_trust = 'asserted'
        then 'a proposal from an admin-asserted link is accepted by a member of the group with a verified link, or a space admin'
        else 'only a linked member of this group can accept or drop its memory proposals' end
      using errcode = '42501',
            detail = jsonb_build_object('reason', 'proposal_not_decider')::text;
  end if;
  decider := internal.current_member_id(row.space_id);
  perform internal.bind_actor(decider);

  if p_decision = 'drop' then
    update public.bridge_memory_proposals
       set status = 'dropped', decided_by = decider, decided_at = now(),
           decision_note = nullif(btrim(coalesce(p_note, '')), ''), version = version + 1
     where id = row.id returning * into row;
    perform internal.bridge_memory_settle_attention(row, 'resolved', decider, 'Dropped');
    return internal.bridge_memory_proposal_json(row);
  end if;

  select * into b from public.bridges where entity_id = row.bridge_id;
  if b.ended_at is not null then
    raise exception 'this bridge was removed' using errcode = 'TBC01',
      detail = jsonb_build_object('reason', 'bridge_ended')::text;
  end if;
  -- The decider may correct the text before accepting it (v2 §2.1 [Edit]);
  -- the corrected text is scanned like a proposal.
  final_statement := btrim(coalesce(nullif(btrim(coalesce(p_statement, '')), ''), row.statement));
  if char_length(final_statement) not between 1 and 4000 then
    raise exception 'a memory is 1 to 4000 characters' using errcode = '22023';
  end if;
  if internal.bridge_memory_secret_scan(final_statement) = 'value' then
    raise exception 'that looks like a credential: a memory never holds one' using errcode = '42501',
      detail = jsonb_build_object('reason', 'proposal_holds_secret')::text;
  end if;
  title := coalesce(b.conversation ->> 'title', 'the group');

  created := public.create_memory(
    row.space_id, final_statement,
    left('Proposed with /remember in the ' || title || ' group by ' || coalesce(nullif(row.proposer_name, ''), 'a member')
         || ', accepted in tm8 by a linked member of the group.', 1000),
    left('Agents working for the ' || title || ' group.', 1000),
    'That it was checked: it is what a member of the group asked tm8 to remember.',
    null, decider, null, null, null);
  memory := (created #>> '{entity,id}')::uuid;

  -- The proposal row's memory_id says which proposal it was: remembers takes no props.
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (row.space_id, row.bridge_id, memory, 'remembers', decider)
  on conflict (src_id, dst_id, type) do nothing;

  -- D22: provenance, through 399's one stamp (→ bridge and → the /remember message).
  perform internal.bridge_stamp(memory, internal.bridge_born_origins(jsonb_build_array(jsonb_build_object(
    'bridgeId', row.bridge_id, 'messageId', row.message_id, 'providerMessageId', row.provider_message_id,
    'command', '/remember',
    'sender', jsonb_build_object('memberId', row.proposed_by, 'participant', row.proposer_name)))));

  update public.bridge_memory_proposals
     set status = 'accepted', memory_id = memory, decided_by = decider, decided_at = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), ''), version = version + 1
   where id = row.id returning * into row;
  perform internal.bridge_memory_settle_attention(row, 'resolved', decider, 'Accepted');
  return internal.bridge_memory_proposal_json(row);
end
$$;

-- -----------------------------------------------------------------------------
-- §5. Expiry (D63): the scheduler job, as the node admin. Each expired
--     proposal's inbox items are cleared, not resolved: nobody decided.
-- -----------------------------------------------------------------------------
create or replace function public.expire_bridge_memory_proposals(p_limit integer default 500)
returns integer language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.bridge_memory_proposals;
  n integer := 0;
begin
  perform internal.require_node_admin();
  for row in
    update public.bridge_memory_proposals
       set status = 'expired', decided_at = now(), version = version + 1
     where id in (select id from public.bridge_memory_proposals
                   where status = 'pending' and expires_at <= now()
                   order by expires_at
                   limit greatest(1, least(coalesce(p_limit, 500), 5000))
                   for update skip locked)
    returning *
  loop
    perform internal.bridge_memory_settle_attention(row, 'cleared', null, 'Expired after 14 days');
    n := n + 1;
  end loop;
  return n;
end
$$;

-- -----------------------------------------------------------------------------
-- §6. Reads: any member who can read the bridge.
-- -----------------------------------------------------------------------------
create or replace function public.list_bridge_memory_proposals(
  p_bridge_id uuid, p_status text default null, p_limit integer default 50
) returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  if not exists (select 1 from public.bridges b join public.entities e on e.id = b.entity_id
                  where b.entity_id = p_bridge_id and e.deleted_at is null
                    and internal.entity_readable(e.id)) then
    raise exception 'bridge % not found', p_bridge_id using errcode = 'P0002';
  end if;
  if p_status is not null and p_status not in ('pending', 'accepted', 'dropped', 'expired') then
    raise exception 'unknown proposal status %', p_status using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(internal.bridge_memory_proposal_json(r) order by r.created_at desc, r.id desc)
      from (select pr.* from public.bridge_memory_proposals pr
             where pr.bridge_id = p_bridge_id and (p_status is null or pr.status = p_status)
             order by pr.created_at desc, pr.id desc
             limit greatest(1, least(coalesce(p_limit, 50), 200))) r
  ), '[]'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- Grants — full signatures.
-- -----------------------------------------------------------------------------
revoke all on function public.propose_bridge_memory(uuid, text, text, uuid, text) from public;
grant execute on function public.propose_bridge_memory(uuid, text, text, uuid, text) to tm8_app;
revoke all on function public.resolve_bridge_memory_proposal(uuid, text, text, text) from public;
grant execute on function public.resolve_bridge_memory_proposal(uuid, text, text, text) to tm8_app;
revoke all on function public.expire_bridge_memory_proposals(integer) from public;
grant execute on function public.expire_bridge_memory_proposals(integer) to tm8_app;
revoke all on function public.list_bridge_memory_proposals(uuid, text, integer) from public;
grant execute on function public.list_bridge_memory_proposals(uuid, text, integer) to tm8_app;

reset role;

-- Never-analyzed tables are estimated at 10 pages (225); 229's precedent.
analyze public.bridge_memory_proposals;
