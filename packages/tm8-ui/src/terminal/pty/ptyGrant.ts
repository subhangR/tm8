/** Mint a fresh, single-use PTY capability over authenticated HTTPS. */
import { CollabError, type StreamAttachGrant } from '@tm8/contract';

import { spaceSessionFor } from '../../auth/space-sessions.js';
import { readActiveServerId } from '../../servers/server-key.js';
import { PtyAttachRefused, type PtyAttachRefusalReason } from './ptyAttachRefusal.js';
import { createHttpClient } from '../../data/real/http.js';

export type PtyAttachMode = 'view' | 'drive';

function grantClient(serverBaseUrl: string) {
  return createHttpClient({
    baseUrl: serverBaseUrl,
    fetch: window.fetch.bind(window),
    // Transitional bearer support for the HTTPS mint. Browser WebSockets use
    // the HttpOnly cookie and never receive this long-lived value.
    // W3: the space session picks the pinned token on an enforcing server
    // and re-enters on the gate's refusal; elsewhere it defers to the pass.
    getAuthToken: () => spaceSessionFor(readActiveServerId()).requestToken(),
    spaceSession: spaceSessionFor(readActiveServerId()),
  });
}

async function requestGrant(
  sessionId: string,
  serverBaseUrl: string,
  mode: PtyAttachMode,
): Promise<StreamAttachGrant> {
  return await grantClient(serverBaseUrl).call<StreamAttachGrant>(
    'execution.streams.attach',
    { params: { id: sessionId }, body: { mode } },
  );
}

/**
 * The three refusals that are DECISIONS rather than failures. Everything else —
 * a dropped connection, a 500, a timeout — stays an ordinary error and keeps
 * the transport's retry, because those do get better by being retried.
 */
const REFUSAL_CODES: Record<string, PtyAttachRefusalReason> = {
  forbidden: 'forbidden',
  not_found: 'not_found',
  unauthorized: 'unauthorized',
};

function asRefusal(error: unknown, mode: PtyAttachMode): unknown {
  if (!(error instanceof CollabError)) return error;
  const reason = REFUSAL_CODES[error.code];
  return reason === undefined ? error : new PtyAttachRefused(reason, mode, error.message);
}

/**
 * Drive is preferred for an interactive surface. If policy permits only view,
 * retry with a separately minted view grant; a refused drive grant is never
 * reused or widened client-side.
 *
 * A `view` that is ALSO refused is the end of the road: there is nothing
 * narrower to ask for, so it is re-thrown as a `PtyAttachRefused` — the one
 * shape the transport treats as final rather than as something to retry
 * forever behind an empty canvas.
 */
export async function mintPtyAttachGrant(
  sessionId: string,
  serverBaseUrl: string,
  mode: PtyAttachMode,
): Promise<StreamAttachGrant> {
  try {
    return await requestGrant(sessionId, serverBaseUrl, mode);
  } catch (error) {
    if (mode !== 'drive' || !(error instanceof CollabError) || error.code !== 'forbidden') {
      throw asRefusal(error, mode);
    }
    try {
      return await requestGrant(sessionId, serverBaseUrl, 'view');
    } catch (viewError) {
      throw asRefusal(viewError, 'view');
    }
  }
}
