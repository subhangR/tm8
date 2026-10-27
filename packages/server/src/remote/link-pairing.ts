/**
 * W9c: the HOME server's two other calls to a target (link-client.ts guards
 * both): claiming a pairing code at sign-in, and the best-effort revoke at
 * logout/remove. Plus this node's stable id, which it names itself by when it
 * claims (the target records it on the inbound link with the public origin).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CollabError,
  REMOTE_SPACE_LINK_PATHS,
  REMOTE_SPACE_LINKS_UNSUPPORTED_MESSAGE,
  type RemoteSpaceLinkClaimResponse,
} from '@tm8/contract';

import { dataOf, errorEnvelopeOf, postRemoteLink, type RemoteLinkClientOptions } from './link-client.js';
import { isRemoteLinkAnswer } from './link-forwarder.js';

const NODE_ID_FILE = 'remote-node-id';
const NODE_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

/** This node's stable id for remote links: created once under the data dir. Not a secret. */
export async function loadOrCreateRemoteNodeId(dataDir: string): Promise<string> {
  const path = join(dataDir, NODE_ID_FILE);
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (NODE_ID_RE.test(existing)) return existing;
  } catch {
    // absent: create below
  }
  const id = randomUUID();
  await mkdir(dataDir, { recursive: true });
  try {
    await writeFile(path, `${id}\n`, { flag: 'wx', mode: 0o644 });
    return id;
  } catch {
    // A concurrent boot wrote it first.
    return (await readFile(path, 'utf8')).trim();
  }
}

/**
 * Claim a pairing code on the target. Every failure is a typed CollabError
 * with a closed `details.reason`; nothing from the target is trusted beyond
 * the four fields read here.
 */
export async function claimRemoteLink(
  input: { baseUrl: string; pairingCode: string; homeSpaceId: string; homeServerId: string; homeBaseUrl: string | null },
  client: RemoteLinkClientOptions = {},
): Promise<RemoteSpaceLinkClaimResponse> {
  const result = await postRemoteLink({
    baseUrl: input.baseUrl,
    path: REMOTE_SPACE_LINK_PATHS.claim,
    body: {
      pairingCode: input.pairingCode,
      homeSpaceId: input.homeSpaceId,
      homeServerId: input.homeServerId,
      homeBaseUrl: input.homeBaseUrl,
    },
  }, client);
  if (result.kind !== 'response') {
    throw new CollabError('upstream_unavailable', `the linked server is ${result.kind} (${result.reason})`, {
      details: { reason: result.kind === 'unreachable' ? 'space_link_unreachable' : 'space_link_offline', cause: result.reason },
      retryable: result.kind === 'offline',
    });
  }
  const marked = isRemoteLinkAnswer(result.body);
  if (result.status === 404 && !marked) {
    throw new CollabError('upstream_unavailable', REMOTE_SPACE_LINKS_UNSUPPORTED_MESSAGE, {
      details: { reason: 'space_link_remote_unsupported' }, retryable: false,
    });
  }
  if (result.status < 200 || result.status >= 300 || !marked) {
    const envelope = errorEnvelopeOf(result.body);
    // invalid_input, not forbidden: the code was refused, not the caller's session kind.
    throw new CollabError(result.status === 429 ? 'rate_limited' : 'invalid_input',
      envelope?.message ?? `the linked server refused the pairing code (${result.status})`,
      { details: { reason: 'space_link_pairing_refused', status: result.status } });
  }
  let claimed: Partial<RemoteSpaceLinkClaimResponse>;
  try {
    claimed = dataOf(result.body) as Partial<RemoteSpaceLinkClaimResponse>;
  } catch {
    claimed = {};
  }
  if (typeof claimed.token !== 'string' || typeof claimed.sessionId !== 'string'
      || typeof claimed.expiresAt !== 'string' || typeof claimed.targetSpaceId !== 'string'
      || typeof claimed.remoteLinkId !== 'string') {
    throw new CollabError('upstream_unavailable', 'the linked server answered a malformed claim', {
      details: { reason: 'space_link_pairing_refused' },
    });
  }
  return claimed as RemoteSpaceLinkClaimResponse;
}

/** Tell the target the link session ends. Best effort: true when the target confirmed. */
export async function revokeRemoteLink(
  input: { baseUrl: string; token: string },
  client: RemoteLinkClientOptions = {},
): Promise<boolean> {
  const result = await postRemoteLink({
    baseUrl: input.baseUrl, path: REMOTE_SPACE_LINK_PATHS.revoke, body: {}, bearer: input.token, timeoutMs: 5_000,
  }, client);
  return result.kind === 'response' && result.status >= 200 && result.status < 300 && isRemoteLinkAnswer(result.body);
}
