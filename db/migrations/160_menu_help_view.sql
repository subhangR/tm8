-- 160 — the Help view ref: the curated shelf of Help artifacts becomes a view
-- the server will accept in a menu (Help v1, task 01a01b15, 2026-08-19).
--
-- NUMBERED 160: measured 2026-08-19 against origin/main, whose chain head is
-- 159. Re-measure at merge time as always — this chain has raced more than
-- once, and the union of every remote ref plus outstanding reservations is the
-- measure, never previous+1.
--
-- THIS MIGRATION DOES NOT REDEFINE THE DEFAULT MENU, and that is the whole
-- shape of the change. 045/096/102/117/130/137 are four-step migrations
-- because each of them put a new GROUP in the shipped spine. Help does not
-- join it: the seven default groups (Home | Work | Board | Craft | Graph |
-- Files | Settings) are surfaces you INHABIT, and Help is a reference you
-- consult and leave — its door in tm8-ui is a `?` control on the tab bar,
-- which is the posture Inbox has held since its rail row retired. So
-- `internal.w1_default_menu_payload()` is untouched, no space's payload is
-- rewritten, no revision is bumped, and the contract's
-- DEFAULT_MENU_GROUP_SPINE — which menu-seeder-parity.pg.test.ts pins this
-- function against — is unchanged. Two steps, not four.
--
-- IT SHIPS ANYWAY, and skipping it would have been the dishonest option. Help
-- IS a full `MenuViewRef` in the contract with a route (#/s/{s}/help), a
-- VIEW_PRESENTATION row and a mounted screen, so tm8-ui's menu editor offers
-- it to an operator (`availableViewRefs` reads that table). Without the
-- registry row and the widened constraint, 029's validator would refuse the
-- save — an operator placing a view the product renders and the server denies.
-- The client half without this half is a control that presses and fails.
--
-- `help` is a VIEW over an existing kind, not a kind move: the shelf lists
-- `artifact` rows and renders them through the artifact preview path, so the
-- artifact kind row stays exactly where it is — the same two-doors posture R9
-- set for files and 130 kept for board.
--
-- Caps hold trivially: no group is added, so group/item/depth counts and the
-- settings-present rule are all as 137 left them.

set role tm8_graph_owner;

-- The validator introduced by 029 accepts a view only when both its closed ref
-- constraint and its registry row know about it (045's wording — same move).
-- Drafted against the CURRENT head of this constraint, 137: re-authoring from
-- an older migration would silently revoke refs that already shipped.
alter table public.menu_view_registry
  drop constraint menu_view_registry_ref_check;

alter table public.menu_view_registry
  add constraint menu_view_registry_ref_check check (
    ref in ('dashboard','feed','inbox','workspace','graph','channels','files','settings','git','messages','board','craft','help')
    or ref ~ '^v:[a-z0-9][a-z0-9_-]{0,48}$'
  );

-- `menu_eligible` true, `required` false: an operator MAY place Help in their
-- menu and no space is made to carry it. `implemented` true because the screen
-- exists on both the desktop and the phone — claiming otherwise would be the
-- registry lying about a surface a reader can open today.
insert into public.menu_view_registry(
  ref, route_template, menu_eligible, required, implemented
)
values ('help', '#/s/{s}/help', true, false, true)
on conflict (ref) do update
set route_template = excluded.route_template,
    menu_eligible = excluded.menu_eligible,
    required = excluded.required,
    implemented = excluded.implemented;

reset role;
