/**
 * ONE ACTION, ONE SENTENCE — the write wrapper the Connectors page and the
 * `mcp_server` entity page share.
 *
 * `run(action, success)` refuses a second write while one is in flight,
 * reports `success` when it lands and a worded failure when it does not, and
 * refreshes the catalog either way so the screen repaints from what the server
 * now holds.
 *
 * ONLY AUTHORED COPY CROSSES INTO THE VIEW. An upstream message can carry
 * provider detail, so a failure is worded from its CODE (`CollabError.code`),
 * never from its text; `McpUiError` is the marker for text this module wrote.
 */
import { useCallback, useRef, useState } from 'react';
import { CollabError } from '@tm8/contract';
import { McpUiError } from './errors';

export function failureCopy(error: unknown): string {
  if (error instanceof McpUiError) return error.message;
  if (error instanceof CollabError) {
    switch (error.code) {
      case 'forbidden': case 'unauthenticated': return 'You don’t have permission to change this connector.';
      case 'not_found': return 'This connector no longer exists. It may have been deleted.';
      case 'version_conflict': case 'conflict': return 'Someone else changed this connector just now. The page has been refreshed — try again.';
      case 'invalid_input': case 'invariant_violation': return 'tm8 refused these settings. Check the fields and try again.';
      case 'rate_limited': case 'limit_exceeded': return 'Too many requests. Wait a moment and try again.';
      case 'upstream_unavailable': return 'The connector’s server did not answer. Check it is running, then try again.';
      default: break;
    }
  }
  // A `fetch` that never reached tm8 rejects with a TypeError.
  if (error instanceof TypeError) return 'Couldn’t reach tm8. Check your connection and try again.';
  return 'That didn’t work. Try again; if it keeps failing, reload the page.';
}

export function useConnectorRun(refresh: () => void, initialMessage: string | null = null) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(initialMessage);
  const [failure, setFailure] = useState<string | null>(null);
  // A ref as well as state: two clicks in one frame both read `busy === false`.
  const inFlight = useRef(false);
  const run = useCallback(async (action: () => Promise<unknown>, success: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setFailure(null); setMessage(null);
    try { await action(); setMessage(success); }
    catch (error) { setFailure(failureCopy(error)); }
    finally { inFlight.current = false; refresh(); setBusy(false); }
  }, [refresh]);
  const dismiss = useCallback(() => { setMessage(null); setFailure(null); }, []);
  return { busy, run, message, failure, dismiss };
}
