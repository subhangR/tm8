/**
 * Live semantic-suite setup: point the W2/W3 gate at
 * TM8_CONFORMANCE_BASE_URL if set. With no reachable default Server, start the
 * honest 501 stub so `test:live` fails loudly instead of being skipped.
 */
import type { Server } from 'node:http';
import { startStubServer, stopStubServer } from './stub-server.js';

const DEFAULT_URL = 'http://localhost:4610';

let stub: Server | undefined;

export async function setup(): Promise<void> {
  const explicit = process.env.TM8_CONFORMANCE_BASE_URL;
  const target = explicit ?? DEFAULT_URL;
  try {
    await fetch(new URL('/health', target), { signal: AbortSignal.timeout(1000) });
    console.log(`[conformance] running against live server at ${target}`);
    return;
  } catch {
    if (explicit) {
      throw new Error(`[conformance] TM8_CONFORMANCE_BASE_URL=${explicit} is not reachable`);
    }
  }
  stub = await startStubServer(4610);
  console.log('[conformance:live] no server at :4610 — started the honest 501 stub; semantic run must stay red');
}

export async function teardown(): Promise<void> {
  if (stub) await stopStubServer(stub);
}
