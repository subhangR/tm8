-- 186 — CodeBrain leaves the top row, and the ref goes with it (2026-09-15).
--
-- Migration 173 seated a CODEBRAIN group after Graph and registered the view.
-- Its reasoning was sound while the SCREEN existed: it lived in the 2.0 UI
-- package, and the 1.0 package recorded its own lack of one honestly through
-- `view-ref-screens.ts` (`codebrain: 'unbuilt'`), with the version switch as
-- the way to go see it.
--
-- #610 ("one UI package — delete the 2.0 fork") removed that package. The
-- switch it pointed at is gone and so is the only CodeBrain screen, which left
-- a registered, menu-eligible, `implemented = true` ref whose every render is
-- the notice "this build has no screen for it". That is not a tab; it is a
-- shipped dead end, and every space seeded since 173 has carried it.
--
-- The resulting SERVER payload is migration 164's again, exactly:
--   Home | Work | Craft | Graph | Settings | Help
-- tm8-ui inserts the route-only Board v2 seat after Work.
--
-- Server twin of tm8-ui `SHIPPED_DEFAULT_MENU` revision 24 and of the
-- contract's `DEFAULT_MENU_GROUP_SPINE`, which both parity tests read.
--
-- WHY THIS DELETES THE REF, WHERE 184 DELETED NOTHING.
-- 184 dropped the Chats TAB and kept the `chat` ref, because `chat` was still
-- a core kind with a working list — a rail edit, and a space could put the tab
-- back through the menu editor. Nothing here can be put back: there is no
-- screen behind `codebrain` in any build. Leaving it registered would leave the
-- menu editor offering a seat that can only render its own absence, and would
-- leave `menu_view_registry.implemented = true` asserting something false. So
-- the ref leaves the contract's `MenuViewRef` union, this registry and the
-- check constraint together. Files and legacy Board (revision 20, migration
-- 164) kept their refs when they left the spine for the opposite reason: their
-- screens survived.
--
-- WHY THE CUSTOMIZED-MENU GUARANTEE BENDS HERE, AND ONLY HERE.
-- 173/180/184 each promised never to touch an operator-authored payload, and
-- this file keeps that promise for every group but one. It CANNOT keep it for
-- `codebrain`: `w2_normalize_menu_payload` (071:101-112) rejects a view item
-- whose ref is not `menu_eligible` AND `implemented`, and it runs on every
-- WRITE to `space_menu_configs`. De-registering the ref while a customized
-- payload still seats it would not preserve that space's choice — it would
-- freeze the space's menu, failing its next save with 22023 and giving the
-- operator no way to edit their way out through the UI. So the third arm below
-- strips the codebrain ITEM (and any group left empty by it) from customized
-- payloads, and leaves every other group, label, order and row untouched.
-- Clearing a dangling reference is not overwriting a preference; a seat whose
-- screen no longer exists is not a preference anyone can hold.
--
-- ORDER IS LOAD-BEARING. Payload arms run BEFORE the registry row is removed.
-- Each `update` fires `w2_guard_menu_config`, which normalizes the NEW payload;
-- the new payloads have no codebrain item, so they pass either way — but the
-- registry row must still exist while any row that still seats it is being
-- rewritten, or a concurrent write in the same deploy window hits the 22023
-- this file exists to prevent.
--
-- 173 SHIPPED BROKEN BECAUSE CI COULD NOT SEE IT. `migrations apply clean`
-- builds a FRESH database where no `space_menu_configs` row matches, every
-- guarded update touches ZERO rows, and the trigger never fires — so 173's
-- missing registry insert failed only on a deployed node, aborting mid-deploy
-- and leaving the services stopped (prod, 2026-09-02). The same blind spot
-- covers this file, so the VERIFY block at the end asserts the post-state of
-- everything this migration touches in a way that holds on an empty database
-- too, and the payload arms are written to be re-runnable.

set role tm8_graph_owner;

-- ARM 1 — the seeder's default loses the group. Reproduced from 184 in full
-- with the `codebrain` group removed; what remains is byte-identical to 164's.
create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
    {"id":"chats","label":"Home","items":[
      {"type":"view","ref":"dashboard"}]},
    {"id":"work","label":"Work","items":[{"type":"view","ref":"workspace"}]},
    {"id":"craft","label":"Craft","items":[{"type":"view","ref":"craft"}]},
    {"id":"graph","label":"Graph","items":[{"type":"view","ref":"graph"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]},
    {"id":"help","label":"Help","items":[{"type":"view","ref":"help"}]}
  ]}'::jsonb
$$;

-- ARM 2 — the untouched default moves, byte-guarded exactly as 184 did it.
-- Only a payload equal to 184's default is rewritten wholesale.
do $$
declare
  payload_184 constant jsonb := '{"groups":[
    {"id":"chats","label":"Home","items":[
      {"type":"view","ref":"dashboard"}]},
    {"id":"work","label":"Work","items":[{"type":"view","ref":"workspace"}]},
    {"id":"craft","label":"Craft","items":[{"type":"view","ref":"craft"}]},
    {"id":"graph","label":"Graph","items":[{"type":"view","ref":"graph"}]},
    {"id":"codebrain","label":"CodeBrain","items":[{"type":"view","ref":"codebrain"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]},
    {"id":"help","label":"Help","items":[{"type":"view","ref":"help"}]}
  ]}'::jsonb;
begin
  update public.space_menu_configs
     set payload = internal.w1_default_menu_payload(),
         revision = revision + 1
   where schema_version = 1
     and payload = payload_184;
end
$$;

-- ARM 3 — customized payloads lose the codebrain SEAT and keep everything
-- else. See the header: this is the arm that prevents a frozen menu, not a
-- tidy-up. A group that held other rows alongside codebrain keeps its id,
-- label and position; only the item goes.
--
-- A group left with NO items is dropped. Not because the guard refuses one —
-- 071 caps `items` at 12 and sets no minimum, so an empty array would pass —
-- but because such a group is a TAB THAT OPENS NOTHING, which is the exact
-- defect this migration exists to remove. Leaving it would trade a tab that
-- says "unbuilt" for a tab that says nothing at all.
--
-- Stripping can never empty the GROUPS array, and the reason is worth naming
-- rather than assuming: 071:181 refuses any payload that does not carry the
-- `settings` view, so every stored menu has a settings group that survives
-- this rewrite. The `coalesce` below therefore falls back to the seeder
-- default only if that invariant is ever relaxed — an empty groups array
-- would pass the guard (there is no minimum) and open the space with no tabs
-- and no way back, the ref being gone. It is a fail-safe, not a live path,
-- and the VERIFY block asserts the invariant rather than trusting it.
do $$
begin
  update public.space_menu_configs
     set payload = jsonb_set(
           payload,
           '{groups}',
           coalesce(
             (
               select jsonb_agg(rebuilt_group order by g.ordinality)
                 from jsonb_array_elements(payload -> 'groups')
                        with ordinality as g(value, ordinality)
                 cross join lateral (
                   select jsonb_set(
                            g.value,
                            '{items}',
                            coalesce(
                              (
                                select jsonb_agg(i.value order by i.ordinality)
                                  from jsonb_array_elements(g.value -> 'items')
                                         with ordinality as i(value, ordinality)
                                 where not (
                                         i.value ->> 'type' = 'view'
                                     and i.value ->> 'ref' = 'codebrain'
                                       )
                              ),
                              '[]'::jsonb
                            )
                          ) as rebuilt_group
                 ) as rebuilt
                where jsonb_array_length(rebuilt.rebuilt_group -> 'items') > 0
             ),
             internal.w1_default_menu_payload() -> 'groups'
           )
         ),
         revision = revision + 1
   where schema_version = 1
     and payload @? '$.groups[*].items[*] ? (@.type == "view" && @.ref == "codebrain")';
end
$$;

-- ARM 4 — the registry row goes. Now that no payload seats the ref, nothing
-- can be frozen by its absence, and the menu editor stops offering it:
-- `availableViewRefs` reads this table.
delete from public.menu_view_registry where ref = 'codebrain';

-- ARM 5 — the check constraint loses the ref. The list below is the contract's
-- `MenuViewRef` union (`contract.ts`) verbatim, now WITHOUT `codebrain`, plus
-- the `v:`-prefixed operator-authored escape hatch the constraint has carried
-- since 102. Same drop-and-re-add 130/137/160/173 each used.
alter table public.menu_view_registry
  drop constraint menu_view_registry_ref_check;

alter table public.menu_view_registry
  add constraint menu_view_registry_ref_check check (
    ref in ('dashboard','feed','inbox','workspace','graph','channels','files','settings','git','messages','board','craft','help')
    or ref ~ '^v:[a-z0-9][a-z0-9_-]{0,48}$'
  );

-- VERIFY — only what THIS file creates, and all of it true on an empty
-- database too. A tranche suite replays this migration mid-chain, so an
-- assertion about anything else here would fail on a position that is not this
-- file's to defend.
do $$
declare
  payload constant jsonb := internal.w1_default_menu_payload();
  group_ids text[];
  stranded bigint;
begin
  select array_agg(value ->> 'id' order by ordinality)
    into group_ids
    from jsonb_array_elements(payload -> 'groups') with ordinality;

  if group_ids is distinct from array[
    'chats','work','craft','graph','settings','help'
  ] then
    raise exception 'VERIFY 186: default menu group spine is %', group_ids;
  end if;

  -- 184's law, still holding: no group in the default names a KIND.
  if exists (
    select 1
      from jsonb_array_elements(payload -> 'groups') g,
           jsonb_array_elements(g.value -> 'items') i
     where i.value ->> 'type' = 'kind'
  ) then
    raise exception 'VERIFY 186: the default menu still names a kind row';
  end if;

  -- The ref is gone from the registry, so the menu editor cannot offer it.
  if exists (select 1 from public.menu_view_registry where ref = 'codebrain') then
    raise exception 'VERIFY 186: menu_view_registry still carries codebrain';
  end if;

  -- The point of ARM 3: no saved payload may still seat the ref, or that
  -- space's next menu write raises 22023 and its menu is frozen.
  select count(*) into stranded
    from public.space_menu_configs config_row
   where config_row.payload @? '$.groups[*].items[*] ? (@.type == "view" && @.ref == "codebrain")';
  if stranded > 0 then
    raise exception 'VERIFY 186: % saved menu payload(s) still seat codebrain', stranded;
  end if;

  -- No payload may have been left with an empty group either.
  if exists (
    select 1
      from public.space_menu_configs c,
           jsonb_array_elements(c.payload -> 'groups') g
     where jsonb_array_length(g.value -> 'items') = 0
  ) then
    raise exception 'VERIFY 186: a saved menu payload has an empty group';
  end if;

  -- ...nor with no groups at all: the guard would accept it and the space
  -- would open with an empty tab bar.
  if exists (
    select 1
      from public.space_menu_configs c
     where jsonb_array_length(c.payload -> 'groups') = 0
  ) then
    raise exception 'VERIFY 186: a saved menu payload has no groups left';
  end if;

  -- The seeder's own payload must survive the guard every WRITE runs it
  -- through. A default the guard would refuse is a default no space can be
  -- created with, and 071 is the migration that learned this the hard way.
  perform internal.w2_normalize_menu_payload(null::uuid, payload);
end
$$;

reset role;
