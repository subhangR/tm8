-- 194: the artifact-preview capability lookup must be readable by the node.
--
-- SYMPTOM. Every artifact preview in every space EXCEPT `Utho Prod` renders
-- the plain text `no such preview` inside the UI's iframe, for a session that
-- exists, is unexpired, is unrevoked, and whose token hash matches.
--
-- WHY. `packages/server/src/http/artifact-preview.ts` resolves the preview
-- session under the NODE OWNER's claims, on purpose — "the viewer is not
-- known until the row is" — and only then re-runs every content read as
-- `viewer_identity_id` under ordinary RLS (§9.5). 055 never granted the node
-- the read that design assumes. Both tables the resolving select touches are
-- gated on `internal.entity_readable(...)`, which demands a literal
-- `public.members` row for `internal.identity_id()` in the artifact's space
-- and carries no node-admin arm — so the lookup is invisible to the very
-- identity the handler performs it with. `entity_readable` still carries its
-- `WAS: internal.is_space_member(...)` comment, so the bypass looks lost in a
-- rewrite rather than withheld on purpose.
--
-- IT IS TWO TABLES, NOT ONE. The lookup is a join, because it needs
-- `r.entrypoint_path`:
--
--     from public.artifact_preview_sessions s
--     join public.artifact_bundle_revisions r on r.id = s.revision_id
--
-- Arming only the first was measured insufficient against prod: sessions went
-- to 6 rows visible, revisions stayed at 0, and the join stayed empty, so the
-- refusal did not change. Both arms below are load-bearing.
--
-- WHY IT LOOKED HEALTHY. The node owner is a member of exactly one of the 19
-- prod spaces — `Utho Prod`, the first one — and prod sets
-- TM8_DISABLE_AUTO_OWNER=1, so the owner is not auto-joined to spaces created
-- later. Previews have therefore only ever worked in that one space. At the
-- time of this migration: 24 artifacts across 3 spaces broken in fact
-- (Office_Space 19, lvlup 3, Raghava's 2), and 18 spaces broken in principle,
-- 15 of which simply hold no artifacts yet.
--
-- WHY THIS SHAPE. The arms go on THESE TWO POLICIES ONLY. Putting a node-admin
-- bypass inside `internal.entity_readable` would widen every entity read on
-- the node for every node admin, which is not a trade this bug justifies.
-- `artifact_bundle_entries` and `stored_blobs` are deliberately NOT armed:
-- they are read under the viewer's claims and were confirmed already passing.
--
-- WHY IT IS SAFE. Neither row holds a credential (the session stores sha256 of
-- the token only), the path-borne capability is what gets you to this lookup
-- at all, and the authorization that matters is untouched: the
-- entity-visibility check and every blob read below still run as the viewer,
-- so a viewer who lost access still loses the preview mid-session. The arms
-- restore a node-internal resolution step, not a browser-reachable one. The
-- residual accepted here is that a node admin can enumerate preview-session
-- and revision METADATA across spaces; bundle bytes stay on the viewer's path.
--
-- FOLLOW-UP (accepted, not shipped here). Replace the whole owner-claims
-- lookup with a `security definer` resolver
-- `resolve_artifact_preview(session_id, token_hash)` granted to `tm8_app`.
-- Strictly tighter — non-enumerable, because the caller must already hold the
-- token — and it lets BOTH arms below be dropped again. Needing a second arm
-- is the argument FOR that resolver, not against it: the owner-claims lookup
-- leaks its table set into the policy layer, and every table it grows tomorrow
-- becomes another arm. A resolver has no such tail.
--
-- ROLLBACK to the exact prior state, both statements:
--
--   drop policy artifact_preview_sessions_select on public.artifact_preview_sessions;
--   create policy artifact_preview_sessions_select on public.artifact_preview_sessions
--     for select to tm8_app
--     using (internal.entity_readable(artifact_entity_id));
--
--   drop policy artifact_bundle_revisions_select on public.artifact_bundle_revisions;
--   create policy artifact_bundle_revisions_select on public.artifact_bundle_revisions
--     for select to tm8_app
--     using (internal.entity_readable(artifact_entity_id));
begin;

drop policy artifact_preview_sessions_select on public.artifact_preview_sessions;

create policy artifact_preview_sessions_select on public.artifact_preview_sessions
  for select to tm8_app
  using (internal.is_node_admin() or internal.entity_readable(artifact_entity_id));

drop policy artifact_bundle_revisions_select on public.artifact_bundle_revisions;

create policy artifact_bundle_revisions_select on public.artifact_bundle_revisions
  for select to tm8_app
  using (internal.is_node_admin() or internal.entity_readable(artifact_entity_id));

commit;
