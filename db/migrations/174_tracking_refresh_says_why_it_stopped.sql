-- A tracking refresh that stops early says why.
--
-- THE DEFECT, AND WHAT IT COST.
--
--   `runTrackingObserverTick` (packages/server/src/tracking/observer.ts) has
--   three ways to stop in the middle of a request: the GitHub rate limit, the
--   abort signal (shutdown, or the job's 120s timeout), and the tick's target
--   budget. All three take the same branch — `stoppedEarly` — which deliberately
--   does NOT call `public.complete_tracking_refresh`, because completing a
--   request whose targets were never fetched would write a success receipt for
--   work no process did. 081's header opens by naming that as the defect it
--   exists to fix, and leaving the row claimed is correct.
--
--   But leaving it claimed and SILENT is not. `error` is written only by
--   `complete_tracking_refresh`, so an abandoned request carries NULL, and the
--   three stop reasons are indistinguishable from outside: a row sits `running`
--   with no explanation, the stale window hands it back, and it does the same
--   thing again. Nothing anywhere records that GitHub said no.
--
--   Measured cost, on the node this was written for: the observer had been
--   calling GitHub ANONYMOUSLY (see 174's companion change wiring the pollers to
--   `account_git_credentials`), which allows 60 requests/hour for the whole
--   host. A 98-target backfill spent the hour's entire budget on its first
--   tick, and every tick after that stopped on the first target with no row,
--   no log line and no error text to say so. Two workers and four hours went
--   into rediscovering a fact the queue could have simply stated. Reconstructing
--   it needed `curl https://api.github.com/rate_limit` from the host and an
--   arithmetic coincidence — 2 experiments + 58 refreshed = exactly 60.
--
-- THE DOOR.
--
--   One narrow write: set `error` on a request that is still `running`, and
--   touch nothing else. Status stays `running` and `completed_at` stays null, so
--   the stale window still returns the row to the queue and a later tick still
--   resumes it — the recorded reason is a NOTE, not a verdict, and it must not
--   become one by accident. The next `complete_tracking_refresh` overwrites it
--   with the per-target problems, which is the right precedence: a finished
--   request should describe its targets, not its last interruption.
--
--   Entitlement is the same predicate the claim door enforces
--   (`internal.is_space_member`), so this cannot scribble a reason onto another
--   space's request. The `status = 'running'` predicate is the other half: a
--   completed or failed request is a closed record and is not editable here.
--
--   `left(p_reason, 2000)` because this text is written by a code path that
--   interpolates provider messages, and an unbounded provider string is not
--   something to store unclipped in a column an operator reads.

set role tm8_graph_owner;

create or replace function public.note_tracking_refresh_stop(
  p_request_id uuid, p_reason text
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare noted integer;
begin
  perform internal.require_identity();
  if p_request_id is null then
    raise exception 'tracking refresh request id is required' using errcode = '22023';
  end if;

  update public.tracking_refresh_requests r
     set error = left(p_reason, 2000)
   where r.id = p_request_id
     and r.status = 'running'
     and internal.is_space_member(r.space_id);
  get diagnostics noted = row_count;

  -- Not an error when nothing matched. The request may have been completed by
  -- another node between the stop and this note, and a poller that raised on
  -- that race would turn a diagnostic into an outage.
  return jsonb_build_object('requestId', p_request_id, 'noted', noted > 0);
end
$$;

comment on function public.note_tracking_refresh_stop(uuid, text) is
  'Records WHY an observer tick abandoned a still-claimed tracking refresh '
  '(rate limit, abort, target budget) without completing it. Sets error only: '
  'status stays running and completed_at stays null, so the stale window still '
  'returns the row to the queue.';

revoke all on function public.note_tracking_refresh_stop(uuid, text) from public;
grant execute on function public.note_tracking_refresh_stop(uuid, text) to tm8_app;

reset role;
