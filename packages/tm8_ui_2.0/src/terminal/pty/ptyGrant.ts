/** Mint a fresh, single-use PTY capability over authenticated HTTPS. */
import { CollabError, type StreamAttachGrant } from '@tm8/contract';

import { readActivePass } from '../../auth/pass-store.js';
import { createHttpClient } from '../../data/real/http.js';

export type PtyAttachMode = 'view' | 'drive';

function grantClient(serverBaseUrl: string) {
  return createHttpClient({
    baseUrl: serverBaseUrl,
    fetch: window.fetch.bind(window),
    // Transitional bearer support for the HTTPS mint. Browser WebSockets use
    // the HttpOnly cookie and never receive this long-lived value.
    getAuthToken: () => readActivePass()?.token ?? null,
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
 * Drive is preferred for an interactive surface. If policy permits only view,
 * retry with a separately minted view grant; a refused drive grant is never
 * reused or widened client-side.
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
      throw error;
    }
    return await requestGrant(sessionId, serverBaseUrl, 'view');
  }
}
