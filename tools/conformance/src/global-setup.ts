/**
 * Vitest global setup: point the suite at TM8_CONFORMANCE_BASE_URL if set;
 * otherwise probe the default target (http://localhost:4610) and, when nothing
 * is listening there, start the in-package stub so the suite always executes
 * end-to-end (red against the stub — the G0 posture).
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
  console.log('[conformance] no server at :4610 — started the in-package stub (expect a red run)');
}

export async function teardown(): Promise<void> {
  if (stub) await stopStubServer(stub);
}
