-- =============================================================================
-- 226 — Ask Jev's `references` group (integrated design 01a0d348 §8 I7).
--
-- `launch.suggest` gains a fifth group, `references`: docs, artifacts,
-- drawings, files and tasks ranked for the launch, pre-ticked into their byte
-- budget. Every Jev call is one `jev_calls` row, and 201 closed `grp` over the
-- four groups there were, so a references call would be refused at RECORD
-- time. This widens the check by exactly that one value; nothing else about
-- the row changes, and `jev_runs.suggestions` is jsonb keyed by group already.
-- =============================================================================

alter table public.jev_calls drop constraint if exists jev_calls_grp_check;
alter table public.jev_calls
  add constraint jev_calls_grp_check
  check (grp in ('model','teammates','memories','skills','references'));
