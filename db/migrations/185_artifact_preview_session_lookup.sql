-- =============================================================================
-- 185 — Artifact previews resolve their OWN session row, instead of asking RLS
--       a question only a space member can answer.
--
-- WHAT WAS BROKEN. Every artifact preview outside the node owner's own spaces
-- answered 404 `no such preview`, with a perfectly valid URL. Found live on a
-- prod node 2026-09-12: an artifact published into a second space rendered
-- nothing, while every artifact in the node owner's first space rendered fine.
--
-- THE MECHANISM. `createArtifactPreviewHandler` resolves the preview session by
-- (id, sha256(token)) under the NODE OWNER's claims — deliberately, and the
-- handler comment says why: the viewer is not known until the row is found, so
-- SOMEONE must read it first. But 055 gated that read with
--
--     create policy artifact_preview_sessions_select ... to tm8_app
--       using (internal.entity_readable(artifact_entity_id));
--
-- and `internal.entity_readable` (015, rewritten since — it still carries its
-- own `WAS: internal.is_space_member(...)` note) requires a literal
-- `public.members` row for `internal.identity_id()`. It has NO node_admin
-- arm. So the one identity the handler is obliged to use could not see the
-- row unless the node owner happened to be a member of that space, and the
-- lookup returned zero rows. Measured on the prod node: 482 preview rows
-- visible in the owner's space, 0 in every other space on the node.
--
-- WHY IT LOOKED LIKE A ROUTING BUG. artifact-preview.ts emits the SAME
-- `no such preview` string for a route miss and for a session-not-found, so
-- the failure reads as a malformed URL and is not one.
--
-- WHY IT SURFACED ONLY NOW. A node that auto-joins its owner to new spaces
-- hides this completely. A node running TM8_DISABLE_AUTO_OWNER=1 does not:
-- there the owner belongs to the first space alone, and previews silently work
-- in exactly that one space.
--
-- THE FIX, AND WHY IT GIVES NOTHING AWAY. The session lookup becomes a
-- SECURITY DEFINER function owned by tm8_graph_owner, which therefore bypasses
-- RLS on the two tables it reads (both are `enable`, not `force`, row level
-- security — verified before relying on it). That is sound because the preview
-- session IS the capability, and authorization does not live in this read:
--
--   * MINTING is authorized. `public.start_artifact_preview` (055 §11) runs
--     `internal.require_space_member(e.space_id)` before a row can exist, so a
--     row's existence already proves a member asked for it.
--   * The TOKEN is the secret. The caller must present a 64-hex preimage whose
--     sha256 matches `token_hash`; the column is unique, and the database
--     stores the hash and never the token.
--   * The VIEWER is still checked, unchanged, on every byte. Immediately after
--     this lookup the handler re-reads the artifact entity and each bundle
--     entry under the VIEWER's claims and ordinary RLS, so a viewer who has
--     lost access loses the preview mid-session (§9.5). This function hands
--     back the row; it never decides who may read the bundle.
--   * Revocation and expiry are returned, not applied, exactly as before — the
--     handler refuses on `revoked_at` (403) and `expires_at` (401), and those
--     two refusals stay distinguishable from a miss.
--
-- The alternative — giving `internal.entity_readable` a node_admin arm — was
-- rejected deliberately: that function gates entity reads across the whole
-- graph, and widening it to fix a preview lookup would quietly widen every
-- other caller with it. This change touches the preview path only.
--
-- The 055 policy is deliberately LEFT IN PLACE. Nothing else selects this
-- table through tm8_app, and keeping it means a future direct reader is still
-- held to membership rather than inheriting this function's reach.
-- =============================================================================

-- Owned by tm8_graph_owner, like every other RPC in the chain — this is what
-- makes the definer bypass work at all (055's own note: without it the function
-- runs as the migration user, RLS applies on tables it does not own, and the
-- create succeeds while the runtime call returns nothing). `reset role` below.
set role tm8_graph_owner;

-- Resolve one preview session by its id and the sha256 of its bearer token.
-- Returns zero rows for an unknown id, a wrong token, or a purged artifact —
-- the caller cannot tell those apart, which is the intent.
create or replace function internal.resolve_artifact_preview(
  p_session_id uuid,
  p_token_hash text
) returns table (
  artifact_entity_id uuid,
  revision_id        uuid,
  space_id           uuid,
  viewer_identity_id text,
  revoked_at         timestamptz,
  expires_at         timestamptz,
  entrypoint_path    text
) language sql stable security definer
  set search_path = public, internal, pg_temp as $$
  select s.artifact_entity_id, s.revision_id, s.space_id, s.viewer_identity_id,
         s.revoked_at, s.expires_at, r.entrypoint_path
    from public.artifact_preview_sessions s
    join public.artifact_bundle_revisions r on r.id = s.revision_id
   -- `lower` mirrors the minting RPC, which lower-cases before it stores.
   where s.id = p_session_id
     and s.token_hash = lower(p_token_hash)
$$;

revoke all on function internal.resolve_artifact_preview(uuid, text) from public;
grant execute on function internal.resolve_artifact_preview(uuid, text) to tm8_app;

reset role;
