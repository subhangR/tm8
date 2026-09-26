/**
 * The space link this invocation routes through (W7), once `--space` resolved
 * one. run.ts sets it after routing and clears it when the invocation ends;
 * the Tm8Client constructor refuses to build a client without it while it is
 * set. No imports, so run.ts can hold it without loading the client.
 */
import type { SpaceLinkRoute } from './context.js';

let active: SpaceLinkRoute | undefined;

export function setActiveLink(link: SpaceLinkRoute | undefined): void {
  active = link;
}

export function activeLink(): SpaceLinkRoute | undefined {
  return active;
}
