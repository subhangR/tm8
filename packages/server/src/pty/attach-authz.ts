/**
 * Socket-level attach authorization — the socket enforces what
 * `public.grant_stream_attach` decides.
 *
 * THE DEFECT THIS CLOSES. There were two independent ways to reach a live
 * terminal and they disagreed:
 *
 *   `execution.streams.attach` -> `public.grant_stream_attach`, which checks
 *       `share_mode`, the creator, and view-versus-drive;
 *   `GET /v2/ws?sessionId=...` -> this authorizer, which checked only that the
 *       entity existed and was visible to the caller.
 *
 * The RPC passes `p_token_hash = null` and hands back a bare
 * `/v2/ws?sessionId=<id>` URL, so nothing bound the grant to the socket and
 * `stream_grants` rows were written but never read for authorization. Skipping
 * the RPC entirely therefore reached the same terminal: any member who could
 * NAME a session id — and ids appear in ordinary CLI and UI responses — got a
 * fully interactive shell on somebody else's `share_mode='none'` session.
 *
 * WHY THIS CALLS THE FUNCTION INSTEAD OF RE-DERIVING THE POLICY. The two
 * predicates the policy turns on, `internal.can_act_as` and
 * `internal.current_member_id`, are SECURITY DEFINER and are NOT reachable
 * from here: every migration runs `revoke all on all functions in schema
 * internal from public`, and the only names granted back to `tm8_app` are
 * `claim_text` (009), `live_work_session_count` (047), `entity_row_visible`
 * (070) and `w2_handoff_view_json` (019). Transcribing the predicates as
 * inline SQL would be wrong twice over: `can_act_as` has already been
 * redefined once (002_identity.sql:254 -> 075_shared_teammate_authority.sql:14),
 * and running its SELECTs as `tm8_app` subjects them to RLS on
 * `public.members` and `public.team_members`, which can yield a DIFFERENT
 * answer than the definer version. A socket that is silently more or less
 * permissive than the RPC is worse than the old hole, because it reads as
 * fixed. Calling the function is faithful by construction; a transcription is
 * faithful only until somebody edits the SQL.
 *
 * VIEW AND DRIVE ARE DIFFERENT ANSWERS. `grant_stream_attach` refuses view iff
 * `share_mode='none'` AND the creator is not the caller's member row AND NOT
 * `can_act_as(creator)`; it refuses drive iff NOT `can_act_as(creator)`. A
 * caller who may view but not drive gets a socket that renders output and
 * whose keystrokes and resizes go nowhere — see `canDrive` on the verdict and
 * its use in pty-ws-server.ts.
 *
 * PROBE ORDER AND TRANSACTIONS. `mode='drive'` runs the view check AND the
 * drive check, so one granted drive probe proves both and costs one round
 * trip. A refused drive probe is ambiguous — it could be either check — so a
 * second probe asks for `view` alone. Each probe MUST run in its own
 * transaction: a 42501 aborts the transaction it is raised in, so the drive
 * probe's rollback would otherwise take the view probe down with it. `Db.rpc`
 * gives each call its own transaction, which is exactly what that requires.
 *
 * REFUSAL MAPPING. Deliberately unchanged where it already existed, so this
 * fix does not alter the enumeration surface: 401 for unauthenticated, and a
 * single 404 `no such session` for both nonexistent and not-visible, so an
 * outsider still learns nothing about which ids are real. The 403 is new
 * because the refusal it names could not previously happen — it is only
 * reachable by a caller who has already proven they can see the entity, so it
 * discloses nothing they did not already know.
 */
import type { IncomingMessage } from 'node:http';

import { isCollabError } from '@tm8/contract';

import type { Db } from '../db/types.js';
import type { PtyAttachAuthorizer, PtyAttachVerdict } from './pty-ws-server.js';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Minimal logger seam, structurally compatible with the execution block's. */
export interface PtyAttachAuthzLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface PtyAttachAuthorizerDeps {
  readonly db: Pick<Db, 'query' | 'rpc'>;
  /**
   * Resolves the caller's identity from the upgrade request, or returns
   * undefined / throws for an anonymous one. Supplied by the composition root
   * because it owns the identity resolver and the browser's `&token=` pass.
   */
  readonly resolveIdentityId: (req: IncomingMessage) => Promise<string | undefined>;
  readonly logger?: PtyAttachAuthzLogger;
}

/** What one `grant_stream_attach` probe answered. */
type ProbeOutcome = 'granted' | 'refused' | 'gone' | 'error';

async function probeGrant(
  deps: PtyAttachAuthorizerDeps,
  identityId: string,
  sessionId: string,
  mode: 'view' | 'drive',
): Promise<ProbeOutcome> {
  try {
    await deps.db.rpc({ identityId }, 'public.grant_stream_attach', [sessionId, mode]);
    return 'granted';
  } catch (err) {
    // SQLSTATE decides, and nothing else — db/errors.ts's rule. Matching on
    // message text would break silently the first time an RPC reworded a RAISE.
    const sqlstate = isCollabError(err) ? err.details?.['sqlstate'] : undefined;
    if (sqlstate === '42501') return 'refused';
    if (sqlstate === 'P0002') return 'gone';
    deps.logger?.warn('PtyAttachAuthz: grant probe failed', {
      sessionId,
      mode,
      ...(typeof sqlstate === 'string' ? { sqlstate } : {}),
    });
    return 'error';
  }
}

export function createPtyAttachAuthorizer(deps: PtyAttachAuthorizerDeps): PtyAttachAuthorizer {
  const notFound: PtyAttachVerdict = { ok: false, status: 404, message: 'no such session' };

  return async (req, sessionId) => {
    if (!UUID_SHAPE.test(sessionId)) return notFound;

    let identityId: string | undefined;
    try {
      identityId = await deps.resolveIdentityId(req);
    } catch {
      return { ok: false, status: 401, message: 'authentication required' };
    }
    if (!identityId) return { ok: false, status: 401, message: 'authentication required' };

    // Visibility first, so a caller who cannot see the entity gets the same
    // 404 as one naming an id that does not exist. Doing this before the grant
    // probes also keeps a non-member out of the 403 branch entirely.
    const visible = await deps.db.query(
      { identityId },
      'select 1 from public.entities where id = $1 and deleted_at is null',
      [sessionId],
    );
    if (visible.length === 0) return notFound;

    const drive = await probeGrant(deps, identityId, sessionId, 'drive');
    if (drive === 'granted') return { ok: true, canDrive: true };
    if (drive === 'gone') return notFound;
    if (drive === 'error') return { ok: false, status: 403, message: 'attach denied' };

    const view = await probeGrant(deps, identityId, sessionId, 'view');
    if (view === 'granted') return { ok: true, canDrive: false };
    if (view === 'gone') return notFound;
    // Refused, or an unexpected failure: fail CLOSED. An authorization path
    // that opens on error is not an authorization path.
    return { ok: false, status: 403, message: 'this session is not shared' };
  };
}
