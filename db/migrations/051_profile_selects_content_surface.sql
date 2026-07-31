-- =============================================================================
-- 051 — an Interaction Profile can choose which Content surface it opens on.
--
-- WHAT WAS WRONG. `initialContentSurface` existed in the contract and in the
-- browser, but NOTHING could ever set it. 027's two snapshot builders wrote a
-- `browserProjection` carrying only templateKey/templateVersion/feedPolicy/
-- composerPolicy, so `projectInteractionProfileForBrowser` read
-- `browser?.initialContentSurface` as `undefined` on EVERY pin and always fell
-- through to the static template constant. Selecting a different profile could
-- not change the surface, because no profile had anywhere to say so.
--
-- THE ABSENT-KEY DISCIPLINE. A draft written before this field existed has no
-- opinion, and `->` yields JSON null for those. The server treats anything that
-- is not exactly 'terminal'/'chat' as "no opinion" and defers to the template,
-- so old pins keep their behaviour byte for byte. This migration therefore does
-- NOT rewrite a single existing pin: pins are immutable and auditable, and a
-- backfill would forge history to make a new feature look retroactive.
--
-- SECOND FIX, INDEPENDENT AND OLDER. `internal.ensure_core_interaction_pin`
-- (015) stamped `template_key = 'core'` while the launch resolver's core
-- default returns `'tm8.chat.core'`. 'core' is not in the server's closed
-- STATIC_CHAT_TEMPLATE_REGISTRY, so any session whose newest pin was the
-- trigger's projected `compatibility: 'unknown_template'` — which FORCES
-- Terminal and shows a "not registered in this build" banner. That is 23 of
-- 101 sessions in this database, all created on or before 2026-07-29. The
-- snapshot that trigger already writes says 'tm8.chat.core' internally, so the
-- column was simply disagreeing with its own payload.
--
-- WHY `w2g12_core_draft()` IS NOT TOUCHED. Its body is a 30-line JSON literal.
-- Re-typing it to insert one key is a transcription risk with no upside — the
-- only consumer that needs the surface is the browserProjection arm below, and
-- a literal there says the same thing without copying anything.
-- =============================================================================

-- --- 1. profile pins carry the draft's choice --------------------------------
-- Only the browserProjection arm changes from 027. agentProjection is untouched:
-- the surface is a presentation fact and must not cross into the agent-facing
-- half of the snapshot. The `validation_status = 'valid'` guard is preserved
-- exactly — an unvalidated draft must never resolve into a pin.
create or replace function internal.w2g12_profile_snapshot(
  p_profile_id uuid, p_profile_version integer, p_source text
) returns jsonb language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'projectorVersion', 1,
    'profile', jsonb_build_object(
      'id', version_row.profile_id, 'version', version_row.version, 'source', p_source,
      'validationHash', version_row.validated_hash,
      'generatedByTeamMemberId', profile_row.generated_by_team_member_id
    ),
    'template', internal.w2g12_static_chat_template(
      version_row.draft_json ->> 'templateKey',
      (version_row.draft_json ->> 'templateVersion')::integer
    ),
    'draft', version_row.draft_json,
    'terminal', jsonb_build_object('alwaysAvailable', true),
    'agentProjection', jsonb_build_object(
      'promptPolicy', version_row.draft_json -> 'promptPolicy',
      'toolDiscoveryPolicy', version_row.draft_json -> 'toolDiscoveryPolicy',
      'feedPolicy', version_row.draft_json -> 'feedPolicy',
      'providerCaptureMode', version_row.draft_json -> 'providerCaptureMode'
    ),
    'browserProjection', jsonb_build_object(
      'templateKey', version_row.draft_json -> 'templateKey',
      'templateVersion', version_row.draft_json -> 'templateVersion',
      'initialContentSurface', version_row.draft_json -> 'initialContentSurface',
      'feedPolicy', version_row.draft_json -> 'feedPolicy',
      'composerPolicy', version_row.draft_json -> 'composerPolicy'
    )
  )
  from public.interaction_profile_versions version_row
  join public.interaction_profiles profile_row on profile_row.entity_id = version_row.profile_id
  where version_row.profile_id = p_profile_id
    and version_row.version = p_profile_version
    and version_row.validation_status = 'valid'
$$;

-- --- 2. the core fallback pin states its surface instead of implying it ------
-- Identical to 027's definition except for the one added browserProjection key.
create or replace function internal.w1_core_pin_snapshot() returns jsonb
language sql immutable parallel safe as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'projectorVersion', 1,
    'profile', jsonb_build_object('source', 'core_default'),
    'template', internal.w2g12_static_chat_template('tm8.chat.core', 1),
    'draft', internal.w2g12_core_draft(),
    'terminal', jsonb_build_object('alwaysAvailable', true),
    'agentProjection', jsonb_build_object(
      'promptPolicy', internal.w2g12_core_draft() -> 'promptPolicy',
      'toolDiscoveryPolicy', internal.w2g12_core_draft() -> 'toolDiscoveryPolicy',
      'feedPolicy', internal.w2g12_core_draft() -> 'feedPolicy',
      'providerCaptureMode', 'explicit-only'
    ),
    'browserProjection', jsonb_build_object(
      'templateKey', 'tm8.chat.core', 'templateVersion', 1,
      'initialContentSurface', 'chat',
      'feedPolicy', internal.w2g12_core_draft() -> 'feedPolicy',
      'composerPolicy', internal.w2g12_core_draft() -> 'composerPolicy'
    )
  )
$$;

-- --- 3. the trigger pin stops disagreeing with its own snapshot --------------
-- Guarded by the same "no pin yet" check as 015, so this can only ever affect
-- work sessions created from here on. Existing rows are left alone.
create or replace function internal.ensure_core_interaction_pin(target_session uuid)
returns integer language plpgsql set search_path = public, internal, pg_temp as $$
declare next_revision integer;
begin
  if exists (select 1 from public.work_session_interaction_pins where work_session_id = target_session) then
    return (select max(pin_revision) from public.work_session_interaction_pins
             where work_session_id = target_session);
  end if;
  select coalesce(max(pin_revision), 0) + 1 into next_revision
    from public.work_session_interaction_pins where work_session_id = target_session;
  perform internal.w1_set_writer('profile_pin');
  insert into public.work_session_interaction_pins(
    work_session_id, pin_revision, profile_id, profile_version,
    template_key, template_version, resolved_hash, resolved_snapshot)
  values (target_session, next_revision, null, null, 'tm8.chat.core', 1,
          'core-profile-v1', internal.w1_core_pin_snapshot());
  perform internal.w1_set_writer(null);
  return next_revision;
end
$$;
