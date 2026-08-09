/**
 * Single-use PTY capability consumption.
 *
 * Authentication is the cryptographically-random tm8g_ bearer offered in the
 * Sec-WebSocket-Protocol request header. The server selects only
 * `tm8-pty-v1`, so the bearer is never echoed in the 101 response. Browser
 * cookies are optional here (the CLI has none); when one is present its
 * verified identity is bound into the consume transaction and must equal the
 * grant's exact subject.
 *
 * Authorization and replay protection are one database UPDATE in
 * public.consume_stream_attach. Invalid, expired, replayed, wrong-session,
 * wrong-mode and wrong-identity credentials all map to the same 403 and log
 * only a coarse reason — never a token, token hash, protocol header, or URL.
 */
import type { IncomingMessage } from 'node:http';

import { isCollabError } from '@tm8/contract';

import type { Db, DbClaims } from '../db/types.js';
import {
  hashPtyGrantToken,
  ptyGrantFromProtocolHeader,
} from './grant-token.js';
import type { PtyAttachAuthorizer, PtyAttachVerdict } from './pty-ws-server.js';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PtyAttachAuthzLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface PtyAttachAuthorizerDeps {
  readonly db: Pick<Db, 'rpc'>;
  /** Resolve a verified browser cookie/header identity when one is present. */
  readonly resolveIdentityId?: (req: IncomingMessage) => Promise<string | undefined>;
  readonly logger?: PtyAttachAuthzLogger;
}

interface ConsumedGrant {
  subjectIdentity: string;
  mode: 'view' | 'drive';
  grantId: string;
}

function requestedMode(req: IncomingMessage): 'view' | 'drive' | null {
  try {
    const mode = new URL(req.url ?? '/', 'http://tm8.invalid').searchParams.get('mode');
    return mode === 'view' || mode === 'drive' ? mode : null;
  } catch {
    return null;
  }
}

export function createPtyAttachAuthorizer(deps: PtyAttachAuthorizerDeps): PtyAttachAuthorizer {
  const refused: PtyAttachVerdict = { ok: false, status: 403, message: 'attach refused' };

  return async (req, sessionId) => {
    if (!UUID_SHAPE.test(sessionId)) {
      return { ok: false, status: 404, message: 'no such session' };
    }

    const offered = ptyGrantFromProtocolHeader(req.headers['sec-websocket-protocol']);
    if (!offered) {
      return { ok: false, status: 401, message: 'authentication required' };
    }
    const mode = requestedMode(req);
    if (!mode) return refused;

    let identityId: string | undefined;
    if (deps.resolveIdentityId) {
      try {
        identityId = await deps.resolveIdentityId(req);
      } catch {
        // A presented but invalid/mismatched cookie is indistinguishable from
        // every other bad grant use. Do not let a valid capability override a
        // conflicting browser principal.
        return refused;
      }
    }

    const claims: DbClaims = identityId ? { identityId } : {};
    try {
      const consumed = await deps.db.rpc<ConsumedGrant>(
        claims,
        'public.consume_stream_attach',
        [sessionId, mode, hashPtyGrantToken(offered.token)],
      );
      if (consumed.mode !== mode || consumed.subjectIdentity.length === 0) return refused;
      return {
        ok: true,
        canDrive: consumed.mode === 'drive',
        subjectIdentity: consumed.subjectIdentity,
      };
    } catch (error) {
      const sqlstate = isCollabError(error) ? error.details?.['sqlstate'] : undefined;
      deps.logger?.warn('PtyAttachAuthz: attach refused', {
        sessionId,
        mode,
        reason: sqlstate === '42501' ? 'credential_refused' : 'authorization_error',
      });
      return refused;
    }
  };
}
