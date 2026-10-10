import { CollabError } from '@tm8/contract';
import type { RequestIdentity } from '../http/types.js';

/** Shared by catalog commands and authenticated support transports. */
export function requireWriteApiScope(identity: RequestIdentity | undefined): void {
  if (identity?.apiScope === 'read') {
    throw new CollabError('forbidden', 'This tool run token permits read operations only');
  }
}
