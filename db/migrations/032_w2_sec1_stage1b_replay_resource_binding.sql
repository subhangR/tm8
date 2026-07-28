-- =============================================================================
-- 032 W2.SEC-1 STAGE 1b — extend the replay principal/resource binding to the
--                         remaining PRE-AUTHORIZATION sites that a caller can
--                         actually reach.
--
-- RELATIONSHIP TO 031, AND WHY THIS IS A SEPARATE FILE
--
--   031 established the law and the two helpers — internal.require_replay_principal
--   (031:172) and internal.require_replay_subject (031:208) — and applied them to
--   six sites. This migration applies the SAME helpers, unchanged, to the sites
--   031 did not reach. It introduces no new helper, no new error code, and no new
--   DTO field. Forward-only: the superseded bodies are left byte-identical in
--   their original files because db/migrate.mjs checksums every applied migration
--   and hard-fails on drift.
--
-- WHAT THIS FILE SUPERSEDES
--
--   * public.create_invite          supersedes 007_rpc_catalog.sql:573
--   * public.revoke_invite          supersedes 007_rpc_catalog.sql:596
--   * public.w2_revoke_invite       supersedes 016_w2_identity_spaces.sql:330
--   * public.update_project_w2      supersedes 021_w2_projects.sql:214
--   * public.w2_edit_message        supersedes 019_w2_messages_handoffs.sql:501
--   * public.w2_tombstone_message   supersedes 019_w2_messages_handoffs.sql:627
--   * public.post_message           supersedes 007_rpc_catalog.sql:1680
--
--   Each body below is the LANDED text verbatim with the guards added, and
--   NOTHING else changed EXCEPT at the three invite sites, where the result
--   construction also changes — see STRIP AT REST below. The landed text was
--   extracted from the applied chain (last definition wins), not from the first
--   file that happens to define the name; public.revoke_invite (007:596) and
--   public.w2_revoke_invite (016:330) are two DIFFERENT functions with different
--   signatures, both present and both granted, not a supersession of one another.
--
-- STRIP AT REST, AND REHYDRATE AFTER BINDING — THE INVITE SITES ONLY
--
--   THE DEFECT. public.create_invite stored jsonb_build_object('invite',
--   to_jsonb(invite)) — the FULL space_invites row INCLUDING THE LIVE CODE — into
--   public.command_ledger, and returned that stored projection BEFORE
--   internal.require_space_admin. public.redeem_invite consumes exactly that code
--   to grant membership, so the stored projection was a BEARER CREDENTIAL: one
--   replayed clientMutationId yielded a working invite code for a foreign Space,
--   after which the attacker never needed the replay path again.
--
--   WHY A BARE STRIP WOULD HAVE BEEN A FEATURE BREAK, NOT A HARDENING. The result
--   is BOTH stored AND returned, and the code is part of the response DTO
--   (services/w2/identity-spaces.ts:145-154 toInvite reads row.code, used by
--   create, revoke and list). Stripping the returned value means the creator never
--   learns the code they exist to share. Storing stripped while returning full is
--   not sufficient either: internal.ledger_record returns
--   coalesce(stored_result, p_result), so a legitimate SAME-PRINCIPAL retry would
--   receive the stored, stripped body — an invite response with no code.
--
--   WHAT THIS FILE DOES INSTEAD. The ledger stores the projection with the code
--   removed, so the live credential is never at rest in public.command_ledger; and
--   the replay branch, AFTER both guards have passed, RE-SELECTS the invite row
--   and builds the response fresh. Fail-closed by construction: the re-read is
--   unreachable until the binding has already refused a stranger.
--
--   ⚠ THIS TRADES BYTE-IDENTICAL REPLAY FOR FRESHNESS, DELIBERATELY. If the invite
--   row changed between the original call and the retry — revoked, expired, uses
--   consumed — the replay now returns the CURRENT row, not the original stored
--   one. That is a real semantic change and it is stated here rather than
--   discovered later. It is ruled correct because the alternative is worse: today
--   a retry returns a STALE code out of a frozen blob, so rehydration also fixes a
--   latent correctness bug. A field that is not stable must not be frozen into a
--   replay snapshot; an invite's code and status are exactly that family.
--
--   ⚠ A VANISHED ROW RAISES. If the re-select finds nothing — invite deleted,
--   Space gone — the function raises P0002. It does NOT return a partial
--   projection, does NOT fall back to the stored blob, and does NOT return
--   null-with-200. A rehydration that silently degraded to the stripped blob would
--   reintroduce the broken endpoint on exactly the path nobody tests.
--
--   ROWS STORED BEFORE THIS MIGRATION still carry the full projection including
--   the code. The replay branch reads only the id and space_id out of them, so it
--   is backward compatible; and because it now returns a freshly-read row, those
--   pre-existing stored codes stop being served even though they remain at rest
--   until the ledger's 24h TTL expires them.
--
-- ⚠ SITE SELECTION WAS CORRECTED AGAINST A LIVE CATALOG, NOT AGAINST THE
--   MIGRATION TEXT. This matters more than it sounds.
--
--   An earlier draft of this work targeted public.post_message (007:1680),
--   public.edit_message (007:1733) and public.redact_message (007:1767).
--   Measured on an applied chain with has_function_privilege('tm8_app', oid,
--   'EXECUTE'), ALL THREE ARE NOT GRANTED TO tm8_app. They are reachable only as
--   nested calls from a granted SECURITY DEFINER RPC, and nested calls pass a
--   NULL clientMutationId, so internal.ledger_replay short-circuits at its own
--   null check and a binding placed there could never fire. Hardening them would
--   have produced a migration that looked like completed security work and closed
--   nothing reachable.
--
--   The RPCs the application role actually holds EXECUTE on, and that therefore
--   take a caller-supplied cmid off the wire, are the 019 ones superseded above.
--
-- WHY public.w2_post_message_batch (019:343) IS DELIBERATELY ABSENT
--
--   It is already bound, by a different and stronger mechanism, and it has no
--   bare return. Its replay branch (019:388-397) recomputes
--   internal.w2_message_batch_hash(...) and refuses unless it equals the stored
--   _stableHash. internal.identity_id() is the FIRST input to that hash
--   (019:330-338), and the full request canonicalization — anchorIds, body,
--   parentMessageId, mentionIds, attachmentIds — is also in it, so it binds the
--   principal AND the resource in one comparison. It is fail-closed on the
--   degenerate case too: a missing _stableHash compares against NULL, `is
--   distinct from` is TRUE, and it raises rather than returning.
--
--   Adding the 031 helpers there would place a second, weaker guard beside a
--   stronger one, which is how a later reader talks themselves into deleting the
--   "duplicate". Left alone on purpose.
--
-- WHY internal.ledger_replay IS NOT TOUCHED HERE
--
--   The 23514 message oracle removal belongs to 033, which redefines that
--   function and LANDS AFTER this file. Anything written here would be silently
--   reverted — no error, no checksum failure, and no test failing unless one
--   specifically asserts the oracle is gone. 033 already carries the removal.
--
-- THE ORDERING IS THE SECURITY PROPERTY, AND IT IS NOT COSMETIC
--
--   The principal pin is called TWICE at every site: once BEFORE
--   internal.ledger_replay as a pre-check, and once INSIDE the replay branch.
--   The pre-check alone is not sufficient — it runs with NO LOCK HELD, so against
--   a victim's UNCOMMITTED ledger row it reads "not found", pins nothing, then
--   blocks inside ledger_replay on the advisory lock, and after the victim
--   commits it proceeds with the comparison already skipped. 031's header proves
--   that race by measurement. The call inside the branch runs with
--   ledger_replay's pg_advisory_xact_lock (016:26) already held and has no such
--   window. The subject binding is only meaningful inside the branch anyway,
--   because it needs the stored projection.
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- SITE 1 — public.update_project_w2 / projects.update.
-- Supersedes 021_w2_projects.sql:214. The bare
-- `if replay is not null then return replay; end if;` at 021:227-228 returned the
-- full Project projection — name, working_dir, repo_url, trust, defaults — before
-- internal.require_node_admin() on the very next line. So node-admin was not
-- required at all on the replay path.
--
-- Is cross-principal replay ever legitimate here? NO. This is a node-admin
-- mutation with no delivery or retry semantics that could involve a second
-- principal; a retry of the same command by the same admin against the same
-- Project is the only legitimate replay, and that is exactly what still passes.
-- The subject is the Project the request ADDRESSES, which is the binding that
-- catches the same-principal case the pin structurally cannot see.
-- -----------------------------------------------------------------------------
create or replace function public.update_project_w2(
  p_project_id uuid, p_patch jsonb, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  patch jsonb := coalesce(p_patch, '{}'::jsonb);
  project public.projects;
  next_name text;
  next_working_dir text;
  next_repo_url text;
  next_trust text;
  next_defaults jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'projects.update');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{project,id}', p_project_id::text, 'project');
    return replay;
  end if;
  perform internal.require_node_admin();
  if jsonb_typeof(patch) <> 'object'
     or patch - array['name','workingDir','repoUrl','trust','defaults']::text[] <> '{}'::jsonb then
    raise exception 'invalid Project update patch' using errcode = '22023';
  end if;

  select * into project from public.projects where id = p_project_id for update;
  if project.id is null then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  if project.link_frozen then
    raise exception 'Project is frozen above the active-link cap'
      using errcode = '53400', detail = 'project_over_cap';
  end if;

  if patch ? 'name' and jsonb_typeof(patch->'name') <> 'string' then
    raise exception 'name must be a string' using errcode = '22023';
  end if;
  if patch ? 'workingDir' and jsonb_typeof(patch->'workingDir') <> 'string' then
    raise exception 'workingDir must be a string' using errcode = '22023';
  end if;
  if patch ? 'repoUrl' and jsonb_typeof(patch->'repoUrl') not in ('string','null') then
    raise exception 'repoUrl must be a string or null' using errcode = '22023';
  end if;
  if patch ? 'trust' and (jsonb_typeof(patch->'trust') <> 'string'
      or patch->>'trust' not in ('trusted','untrusted')) then
    raise exception 'invalid trust level' using errcode = '22023';
  end if;
  if patch ? 'defaults' and jsonb_typeof(patch->'defaults') <> 'object' then
    raise exception 'defaults must be an object' using errcode = '22023';
  end if;

  next_name := case when patch ? 'name' then patch->>'name' else project.name end;
  next_working_dir := case when patch ? 'workingDir' then patch->>'workingDir' else project.working_dir end;
  next_repo_url := case when patch ? 'repoUrl' then patch->>'repoUrl' else project.repo_url end;
  next_trust := case when patch ? 'trust' then patch->>'trust' else project.trust end;
  next_defaults := case when patch ? 'defaults' then patch->'defaults' else project.defaults end;

  update public.projects
     set name = next_name,
         working_dir = next_working_dir,
         repo_url = next_repo_url,
         trust = next_trust,
         defaults = next_defaults
   where id = p_project_id
     and (name, working_dir, repo_url, trust, defaults)
       is distinct from (next_name, next_working_dir, next_repo_url, next_trust, next_defaults)
  returning * into project;
  if project.id is null then
    select * into project from public.projects where id = p_project_id;
  end if;
  return internal.ledger_record(p_client_mutation_id, 'projects.update',
    jsonb_build_object('project', to_jsonb(project), 'patches', '[]'::jsonb));
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 2 — public.w2_edit_message / messages.edit.
-- Supersedes 019_w2_messages_handoffs.sql:501. The bare return at 019:509 ran
-- SIX lines before internal.require_space_member at 019:515, so a caller that was
-- not a member of the Space could obtain the stored projection.
--
-- The stored projection here is jsonb_build_object('messageId', p_message_id), so
-- the subject is the message id the CURRENT request addresses. That is precisely
-- the same-principal resource-confusion axis the pin cannot see: two edits by one
-- author to two different messages carry the identical operation label
-- 'messages.edit'.
--
-- Is cross-principal replay ever legitimate here? NO. Message editing is
-- author-restricted at 019:518 (author, or internal.can_act_as for the
-- Teammate-acting-for-member case). The can_act_as path does not need a
-- cross-PRINCIPAL replay: it resolves an ACTOR within one identity, and 031's
-- header already rules that the pin binds identity_id only and never actor_id,
-- for exactly this reason.
-- -----------------------------------------------------------------------------
create or replace function public.w2_edit_message(
  p_message_id uuid,p_body text,p_mention_ids uuid[],p_expected_version integer,
  p_actor_id uuid default null,p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare replay jsonb; envelope public.entities; message public.messages; actor uuid; resolved_mentions jsonb; result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay:=internal.ledger_replay(p_client_mutation_id,'messages.edit');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{messageId}', p_message_id::text, 'message');
    return replay;
  end if;
  select * into envelope from public.entities where id=p_message_id and kind='message' for update;
  select * into message from public.messages where entity_id=p_message_id for update;
  if envelope.id is null or envelope.deleted_at is not null or message.redacted_at is not null then
    raise exception 'message not found' using errcode='P0002';
  end if;
  perform internal.require_space_member(envelope.space_id);
  actor:=internal.resolve_actor(p_actor_id,envelope.space_id); perform internal.bind_actor(actor);
  perform internal.assert_version(p_message_id,p_expected_version);
  if message.author_id<>actor and not internal.can_act_as(message.author_id,envelope.space_id) then
    raise exception 'only the author may edit this message' using errcode='42501';
  end if;
  resolved_mentions:=internal.w2_resolve_mentions(coalesce(p_mention_ids,'{}'::uuid[]),envelope.space_id);
  update public.messages set body=p_body,mentions=resolved_mentions where entity_id=p_message_id;
  result:=jsonb_build_object('messageId',p_message_id);
  return internal.ledger_record(p_client_mutation_id,'messages.edit',result);
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 3 — public.w2_tombstone_message / messages.delete.
-- Supersedes 019_w2_messages_handoffs.sql:627. The bare return at 019:635 ran
-- five lines before internal.require_space_member at 019:640.
--
-- Same subject as site 2 and for the same reason: the stored projection is
-- jsonb_build_object('messageId', p_message_id) and 'messages.delete' cannot
-- distinguish two deletions by one principal against two different messages.
--
-- Is cross-principal replay ever legitimate here? NO. Tombstoning is restricted
-- to the author, a Teammate acting as the author, or a Space admin (019:644-646).
-- None of those is a second IDENTITY replaying the first one's cmid; each is an
-- actor resolution inside one identity, or an independently authorized admin
-- issuing their OWN command with their OWN cmid.
-- -----------------------------------------------------------------------------
create or replace function public.w2_tombstone_message(
  p_message_id uuid,p_expected_version integer default null,
  p_actor_id uuid default null,p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare replay jsonb; envelope public.entities; message public.messages; actor uuid; delivery record; result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay:=internal.ledger_replay(p_client_mutation_id,'messages.delete');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{messageId}', p_message_id::text, 'message');
    return replay;
  end if;
  select * into envelope from public.entities where id=p_message_id and kind='message' for update;
  select * into message from public.messages where entity_id=p_message_id for update;
  if envelope.id is null or message.entity_id is null then raise exception 'message not found' using errcode='P0002'; end if;
  perform internal.require_space_member(envelope.space_id);
  actor:=internal.resolve_actor(p_actor_id,envelope.space_id); perform internal.bind_actor(actor);
  if message.redacted_at is null then
    perform internal.assert_version(p_message_id,p_expected_version);
    if message.author_id<>actor and not internal.can_act_as(message.author_id,envelope.space_id)
       and not internal.is_space_admin(envelope.space_id) then
      raise exception 'only the author or a space admin may tombstone this message' using errcode='42501';
    end if;
    update public.messages set body='[redacted]',mentions='[]'::jsonb,attachments='[]'::jsonb,
      redacted_at=now() where entity_id=p_message_id;
    perform internal.w1_set_writer('message_attachment');
    delete from public.edges edge where edge.dst_id=p_message_id and edge.type='attached_to'
      and exists(select 1 from public.entities e where e.id=edge.src_id and e.kind='file');
    perform internal.w1_set_writer('');
    for delivery in
      update public.session_message_deliveries set status='cancelled',failure_reason='message_deleted',settled_at=now()
       where message_id=p_message_id and status='pending' returning *
    loop
      insert into public.workspace_events(space_id,seq,event_type,payload,client_mutation_id)
      values(envelope.space_id,internal.next_event_seq(envelope.space_id),'message.delivery_settled',
        jsonb_build_object('deliveryId',delivery.delivery_id,'messageId',p_message_id,
          'targetWorkSessionId',delivery.target_work_session_id,'status',delivery.status,
          'reason',delivery.failure_reason,'attemptNo',delivery.attempt_no),p_client_mutation_id);
      perform internal.w2_delivery_fallback(p_message_id,'cancelled','message_deleted');
    end loop;
    insert into public.workspace_events(space_id,seq,event_type,payload,client_mutation_id)
    values(envelope.space_id,internal.next_event_seq(envelope.space_id),'message.deleted',
      jsonb_build_object('messageId',p_message_id,'anchorId',message.anchor_id),p_client_mutation_id);
  end if;
  result:=jsonb_build_object('messageId',p_message_id);
  return internal.ledger_record(p_client_mutation_id,'messages.delete',result);
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 4 — public.create_invite / spaces.invites.create.  THE INVITE-CODE LEAK.
-- Supersedes 007_rpc_catalog.sql:573. The bare return at 007:584 sat ONE LINE
-- before internal.require_space_admin at 007:585, and handed over a projection
-- containing the live code. Measured at the public HTTP boundary, not inferred:
-- POST /v2/spaces/{B}/invites replaying Space A's clientMutationId returned 201
-- carrying A's code.
--
-- Is cross-principal replay ever legitimate here? NO. Creating an invite is a
-- Space-admin action; a second identity replaying the first's cmid is the attack,
-- not a use case. The subject is the SPACE the request addresses, which is what
-- catches the same-principal case — Phase 1 runs a single loopback auto-owner, so
-- the W3 leak is same-principal and the pin alone cannot see it.
-- -----------------------------------------------------------------------------
create or replace function public.create_invite(
  p_space_id uuid, p_max_uses integer default 1, p_expires_at timestamptz default null,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  invite public.space_invites;
  invite_fresh public.space_invites;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.invites.create');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{invite,space_id}', p_space_id::text, 'space');
    -- REHYDRATE-AFTER-BINDING. The live invite code is deliberately NOT in the
    -- stored projection, so the response is rebuilt from the live row. This is
    -- unreachable until BOTH guards above have passed, so a stranger is refused
    -- before any re-read happens.
    select * into invite_fresh from public.space_invites where id = (replay #>> '{invite,id}')::uuid;
    if invite_fresh.id is null then
      raise exception 'invite no longer exists' using errcode = 'P0002',
        detail = 'the replayed invite row is gone; refusing to return a partial projection or fall back to the stripped ledger blob';
    end if;
    return jsonb_build_object('invite', to_jsonb(invite_fresh), 'patches', '[]'::jsonb);
  end if;
  perform internal.require_space_admin(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  insert into public.space_invites(space_id, code, created_by, max_uses, expires_at)
  values (p_space_id, 'inv_' || replace(internal.new_id()::text, '-', ''),
          actor, coalesce(p_max_uses, 1), p_expires_at)
  returning * into invite;
  -- STRIP AT REST: the live credential never enters public.command_ledger.
  result := jsonb_build_object('invite', to_jsonb(invite) - 'code', 'patches', '[]'::jsonb);
  perform internal.ledger_record(p_client_mutation_id, 'spaces.invites.create', result);
  return jsonb_build_object('invite', to_jsonb(invite), 'patches', '[]'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 5 — public.revoke_invite / spaces.invites.revoke.
-- Supersedes 007_rpc_catalog.sql:596. Bare return at 007:604, six lines before
-- internal.require_space_admin at 007:610.
--
-- ⚠ THIS FUNCTION IS NOT ROUTED TODAY AND IS STILL INCLUDED ON PURPOSE. No
-- facade handler calls it — services/w2/identity-spaces.ts:364 calls
-- public.w2_revoke_invite instead. But it IS granted to tm8_app: 008:234 is a
-- blanket `grant execute on all functions in schema public to tm8_app`, which
-- covers every 007 function, and 015:2172 revokes only from PUBLIC, never from
-- tm8_app. Verified with has_function_privilege on an applied chain, not read off
-- the migration text. "Unreachable through HTTP" is a statement about TODAY and
-- is one route away from being false, so the binding and the strip are taken here
-- while they are free.
-- -----------------------------------------------------------------------------
create or replace function public.revoke_invite(p_invite_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  invite public.space_invites;
  invite_fresh public.space_invites;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.invites.revoke');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{invite,id}', p_invite_id::text, 'invite');
    -- REHYDRATE-AFTER-BINDING. The live invite code is deliberately NOT in the
    -- stored projection, so the response is rebuilt from the live row. This is
    -- unreachable until BOTH guards above have passed, so a stranger is refused
    -- before any re-read happens.
    select * into invite_fresh from public.space_invites where id = p_invite_id;
    if invite_fresh.id is null then
      raise exception 'invite no longer exists' using errcode = 'P0002',
        detail = 'the replayed invite row is gone; refusing to return a partial projection or fall back to the stripped ledger blob';
    end if;
    return jsonb_build_object('invite', to_jsonb(invite_fresh), 'patches', '[]'::jsonb);
  end if;
  select * into invite from public.space_invites where id = p_invite_id;
  if invite.id is null then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_admin(invite.space_id);
  update public.space_invites set revoked_at = coalesce(revoked_at, now()) where id = p_invite_id
  returning * into invite;
  -- STRIP AT REST: the live credential never enters public.command_ledger.
  result := jsonb_build_object('invite', to_jsonb(invite) - 'code', 'patches', '[]'::jsonb);
  perform internal.ledger_record(p_client_mutation_id, 'spaces.invites.revoke', result);
  return jsonb_build_object('invite', to_jsonb(invite), 'patches', '[]'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 6 — public.w2_revoke_invite / spaces.invites.revoke.  THE ROUTED ONE.
-- Supersedes 016_w2_identity_spaces.sql:330. Bare return at 016:341, three lines
-- before internal.require_space_admin at 016:344. This is the invite-revoke RPC
-- the server actually calls (services/w2/identity-spaces.ts:364).
--
-- TWO subject bindings here, not one, because this signature carries both a Space
-- and an invite. Binding the invite id alone would let a replay recorded against
-- Space A's invite be returned to a request addressing Space B; binding the Space
-- alone would not distinguish two invites within one Space. They are independent
-- confusion axes, so both are asserted.
--
-- NOTE it shares the operation label 'spaces.invites.revoke' with SITE 5, so a
-- cmid recorded by one could replay through the OTHER without tripping the
-- operation-label check. The subject binding is what closes that, which is the
-- same third shape 031's header identifies between join_public_space and
-- redeem_invite.
-- -----------------------------------------------------------------------------
create or replace function public.w2_revoke_invite(
  p_space_id uuid,
  p_invite_id uuid,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  invite_row public.space_invites;
  invite_fresh public.space_invites;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.invites.revoke');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{invite,id}', p_invite_id::text, 'invite');
    perform internal.require_replay_subject(
      replay #>> '{invite,space_id}', p_space_id::text, 'space');
    -- REHYDRATE-AFTER-BINDING. The live invite code is deliberately NOT in the
    -- stored projection, so the response is rebuilt from the live row. This is
    -- unreachable until ALL guards above have passed, so a stranger is refused
    -- before any re-read happens.
    select * into invite_fresh from public.space_invites
     where id = p_invite_id and space_id = p_space_id;
    if invite_fresh.id is null then
      raise exception 'invite no longer exists' using errcode = 'P0002',
        detail = 'the replayed invite row is gone; refusing to return a partial projection or fall back to the stripped ledger blob';
    end if;
    return jsonb_build_object('invite', to_jsonb(invite_fresh), 'patches', '[]'::jsonb);
  end if;

  perform internal.require_space_admin(p_space_id);
  perform internal.resolve_actor(internal.actor_id(), p_space_id);
  select * into invite_row
    from public.space_invites
   where id = p_invite_id and space_id = p_space_id
   for update;
  if invite_row.id is null then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;
  update public.space_invites
     set revoked_at = coalesce(revoked_at, now())
   where id = p_invite_id
   returning * into invite_row;

  -- STRIP AT REST: the live credential never enters public.command_ledger.
  perform internal.ledger_record(
    p_client_mutation_id,
    'spaces.invites.revoke',
    jsonb_build_object('invite', to_jsonb(invite_row) - 'code', 'patches', '[]'::jsonb)
  );
  return jsonb_build_object('invite', to_jsonb(invite_row), 'patches', '[]'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- SITE 7 — public.post_message / messages.post.  THE SECOND DOOR.
-- Supersedes 007_rpc_catalog.sql:1680. Bare return at 007:1695, two lines before
-- internal.require_space_member at 007:1697.
--
-- WHY THIS IS HERE WHEN w2_post_message_batch IS NOT. Both functions call
-- internal.ledger_replay with the SAME operation label, 'messages.post'.
-- ledger_replay keys on the clientMutationId and validates only that label; it
-- has no idea which function called it. So a ledger row written by the
-- hash-guarded 019 function is resolvable through THIS function, where the hash
-- comparison at 019:388-397 is never reached because the caller used the other
-- door. A guard protects a FUNCTION; the vulnerability is a property of the SITE,
-- and this site has two doors.
--
-- The binding below closes both cases with one comparison. For a row THIS
-- function recorded, patches[0] is internal.command_entity(p_anchor_id), so the
-- stored anchor is compared against the addressed anchor. For a row the 019
-- function recorded, the projection has no 'patches' key — its shape is
-- messageBatchId / messageIds / _stableHash / _audit — so the stored side reads
-- NULL and the replay is refused outright.
--
-- The reverse direction needs nothing: a cmid recorded HERE and replayed through
-- w2_post_message_batch meets a stored result with no _stableHash, and 019's own
-- comparison against NULL raises.
--
-- ⚠ REACHABILITY, STATED ACCURATELY BECAUSE IT WAS MIS-STATED ONCE. This function
-- is NOT executable by tm8_app. 019:1321 explicitly does
-- `revoke execute on function public.post_message(...) from tm8_app`, which
-- overrides 008:234's blanket grant. Measured on an applied chain: its full ACL is
-- `tm8_graph_owner=X/tm8_graph_owner` and has_function_privilege is FALSE for
-- tm8_app, tm8_delivery_worker and PUBLIC. The in-repo nested caller is clean too
-- — place_entity passes NULL as the cmid at 018:342-343 and 018:381-382, so it
-- neither records nor replays.
-- So this binding closes a LATENT hole, not a currently-open one: it cannot fire
-- until someone re-grants the function. It is taken for the same reason as SITE 5
-- — "unreachable today" is a statement about today, and the guard is free — and
-- NOT because the door is currently open. Anyone citing this file as evidence that
-- a live exploit existed here would be overstating it.
-- -----------------------------------------------------------------------------
create or replace function public.post_message(
  p_anchor_id uuid, p_body text, p_actor_id uuid default null,
  p_parent_message_id uuid default null, p_mentions jsonb default '[]'::jsonb,
  p_attachments jsonb default '[]'::jsonb, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  anchor public.entities;
  actor uuid;
  existing uuid;
  message_id uuid;
  thread_root uuid;
  parent public.messages;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'messages.post');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    -- patches[0] is internal.command_entity(p_anchor_id) for a row THIS function
    -- recorded, so this binds the anchor the request addresses. It ALSO closes the
    -- cross-door case: a row recorded by public.w2_post_message_batch has no
    -- 'patches' key at all, so the stored side reads NULL, `is distinct from` is
    -- TRUE, and the replay is refused rather than served through this door.
    perform internal.require_replay_subject(
      replay #>> '{patches,0,id}', p_anchor_id::text, 'anchor');
    return replay;
  end if;
  anchor := internal.live_entity(p_anchor_id);
  perform internal.require_space_member(anchor.space_id);
  actor := internal.resolve_actor(p_actor_id, anchor.space_id);
  perform internal.bind_actor(actor);

  -- Domain idempotency predates the ledger and stays (04 §5.1).
  if p_client_mutation_id is not null then
    select entity_id into existing from public.messages
     where author_id = actor and client_msg_id = p_client_mutation_id;
    if existing is not null then
      return internal.ledger_record(p_client_mutation_id, 'messages.post',
               internal.command_result(existing, null, null, array[p_anchor_id]));
    end if;
  end if;

  if p_parent_message_id is not null then
    select * into parent from public.messages where entity_id = p_parent_message_id;
    if parent.entity_id is null then
      raise exception 'parent message not found' using errcode = '23503';
    end if;
    thread_root := coalesce(parent.root_message_id, parent.entity_id);
  end if;

  message_id := internal.new_id();
  insert into public.entities(id, space_id, kind, parent_id, created_by)
  values (message_id, anchor.space_id, 'message', p_parent_message_id, actor);
  insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body,
                              mentions, attachments, client_msg_id)
  values (message_id, p_anchor_id, thread_root, actor, p_body,
          coalesce(p_mentions, '[]'::jsonb), coalesce(p_attachments, '[]'::jsonb),
          nullif(p_client_mutation_id, ''));
  -- Deliberately NO activity row: a thread is its own record (01 §S3).
  return internal.ledger_record(p_client_mutation_id, 'messages.post',
           internal.command_result(message_id, null, null, array[p_anchor_id]));
end
$$;

reset role;
