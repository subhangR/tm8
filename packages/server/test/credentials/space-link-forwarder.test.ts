/**
 * W7 × W8 seam: `spaceLinks.invoke` on a link whose `target_server_id` is set
 * runs the home guards, then hands the op to the injected forwarder, and
 * NEVER resolves the stored session on this node (`store.use` would mark a
 * remote link signed_out). Every forwarder result kind is audited and typed.
 *
 * No database: the store is a stub that records audits and fails the test if
 * `use` is reached on a remote row. Each refusal is paired with a positive.
 */
import { describe, expect, it, vi } from 'vitest';
import { CollabError, SPACE_LINK_VIA_HEADER } from '@tm8/contract';

import type { DbClaims } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import {
  SPACE_LINK_OFFLINE,
  SPACE_LINK_REMOTE_DISABLED,
  SPACE_LINK_REMOTE_REFUSED,
  SPACE_LINK_SIGNED_OUT,
  SPACE_LINK_UNREACHABLE,
  createSpaceLinkInvokeHandlers,
  type RemoteInvokeForwarder,
  type RemoteInvokeRequest,
  type RemoteInvokeResult,
} from '../../src/facade/handlers/w2/space-link-invoke.js';
import {
  SpaceLinkUnusable,
  type DbSpaceLinkStore,
  type SpaceLinkAuditInput,
  type SpaceLinkInvokeRow,
} from '../../src/credentials/space-link-store.js';
import type { RequestContext } from '../../src/http/types.js';

const HOME = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const SERVER = '44444444-4444-4444-8444-444444444444';
const DOC = '55555555-5555-4555-8555-555555555555';

function harness(targetServerId: string | null, forward?: (req: RemoteInvokeRequest) => Promise<RemoteInvokeResult>) {
  const audits: SpaceLinkAuditInput[] = [];
  const row: SpaceLinkInvokeRow = {
    linkId: LINK, tokenRowId: 'row-1', memberId: 'member-h', homeSpaceId: HOME, targetSpaceId: TARGET,
    targetServerId, status: 'signed_in', allowSpawn: true, spawnBudget: 3,
  };
  const use = vi.fn(async () => { throw new SpaceLinkUnusable(LINK, 'signed_out'); });
  /** Every store method the handler touches, in order; an unknown one throws. */
  const touched: string[] = [];
  const methods: Record<string, unknown> = {
    resolveInvoke: async () => row,
    recordAudit: async (_claims: DbClaims, entry: SpaceLinkAuditInput) => { audits.push(entry); return `audit-${audits.length}`; },
    use,
  };
  const store = new Proxy({}, {
    get: (_target, name) => {
      touched.push(String(name));
      if (!(String(name) in methods)) throw new Error(`the handler touched store.${String(name)}`);
      return methods[String(name)];
    },
  }) as unknown as DbSpaceLinkStore;
  const forwarder: RemoteInvokeForwarder | undefined = forward ? { forward: vi.fn(forward) } : undefined;
  const registry = new HandlerRegistry();
  const local = vi.fn(async () => ({ id: DOC }));
  registry.register('entities.get', local);
  const { invoke } = createSpaceLinkInvokeHandlers(
    registry, { config: {} } as unknown as FacadeDeps, store, async () => ({ identityId: 'identity-g' }) as DbClaims,
    forwarder ? { forwarder } : {},
  );
  const run = (body: unknown, headers: Record<string, string> = {}) => invoke({
    params: { spaceId: HOME, link: 'b' }, body, headers, query: new URLSearchParams(),
    identity: { kind: 'bearer', workSessionId: 'ws-g' },
  } as unknown as RequestContext) as Promise<{ result: unknown; auditId: string }>;
  return { run, audits, use, forwarder, local, touched };
}

async function failure(promise: Promise<unknown>): Promise<CollabError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(CollabError);
  return error as CollabError;
}

const GET_DOC = { op: 'entities.get', params: { id: DOC } };

describe('W7 forward seam — a remote link is forwarded, never resolved here', () => {
  it('ok — forwarded with the server, the op, the input and the chain plus home; audited ok; store.use never reached', async () => {
    const h = harness(SERVER, async () => ({ kind: 'ok', status: 200, body: { id: DOC, title: 'B doc' } }));
    const res = await h.run({ op: 'entities.patch', params: { id: DOC }, input: { title: 'x' } });
    expect(res.result).toEqual({ id: DOC, title: 'B doc' });
    expect(h.use).not.toHaveBeenCalled();
    expect(h.forwarder!.forward).toHaveBeenCalledWith(expect.objectContaining({
      linkId: LINK, serverId: SERVER, op: 'entities.patch', params: { id: DOC }, query: {},
      input: { title: 'x' }, via: [HOME], workSessionId: 'ws-g',
    }));
    expect(h.audits.at(-1)).toMatchObject({ result: 'ok', reason: null, remoteId: DOC, targetSpaceId: TARGET });
  });

  it('positive for the branch — a null target server runs in-process: store.use IS reached, the forwarder is not', async () => {
    const h = harness(null, async () => ({ kind: 'ok', status: 200, body: {} }));
    const error = await failure(h.run(GET_DOC));
    expect(h.use).toHaveBeenCalledTimes(1);
    expect(h.forwarder!.forward).not.toHaveBeenCalled();
    expect(error.details).toMatchObject({ reason: SPACE_LINK_SIGNED_OUT });
  });

  it('signed_out — 401 space_link_signed_out, audited link_signed_out, row not resolved locally', async () => {
    const h = harness(SERVER, async () => ({ kind: 'signed_out' }));
    const error = await failure(h.run(GET_DOC));
    expect(error).toMatchObject({ code: 'unauthenticated', status: 401, details: { reason: SPACE_LINK_SIGNED_OUT } });
    expect(h.use).not.toHaveBeenCalled();
    expect(h.audits.at(-1)).toMatchObject({ result: 'error', reason: 'link_signed_out' });
    // One owner: the forwarder marks the home row; this side touches nothing but resolve + audit.
    expect(new Set(h.touched)).toEqual(new Set(['resolveInvoke', 'recordAudit']));
  });

  it('a read forwards its query string and path params', async () => {
    const h = harness(SERVER, async () => ({ kind: 'ok', status: 200, body: [] }));
    await h.run({ op: 'entities.children', params: { id: DOC }, query: { limit: '5' } });
    expect(h.forwarder!.forward).toHaveBeenCalledWith(expect.objectContaining({
      op: 'entities.children', params: { id: DOC }, query: { limit: '5' },
    }));
  });

  it.each([
    [{ kind: 'unreachable', reason: 'non_public_address' }, SPACE_LINK_UNREACHABLE, false, 'unreachable.non_public_address'],
    [{ kind: 'unreachable', reason: 'dns' }, SPACE_LINK_UNREACHABLE, false, 'unreachable.dns'],
    [{ kind: 'unreachable', reason: 'tls' }, SPACE_LINK_UNREACHABLE, false, 'unreachable.tls'],
    [{ kind: 'unreachable', reason: 'invalid_url' }, SPACE_LINK_UNREACHABLE, false, 'unreachable.invalid_url'],
    [{ kind: 'offline', reason: 'connect_refused' }, SPACE_LINK_OFFLINE, true, 'offline.connect_refused'],
    [{ kind: 'offline', reason: 'timeout' }, SPACE_LINK_OFFLINE, true, 'offline.timeout'],
    [{ kind: 'offline', reason: 'reset' }, SPACE_LINK_OFFLINE, true, 'offline.reset'],
  ] as const)('%o — 503 typed, retryable as the kind says, audited', async (outcome, reason, retryable, audited) => {
    const h = harness(SERVER, async () => outcome as RemoteInvokeResult);
    const error = await failure(h.run(GET_DOC));
    expect(error).toMatchObject({ code: 'upstream_unavailable', status: 503, retryable, details: { reason, cause: outcome.reason } });
    expect(h.audits.at(-1)).toMatchObject({ result: 'error', reason: audited });
  });

  it('remote_links_disabled — 403 typed, audited, never resolved locally', async () => {
    const h = harness(SERVER, async () => ({ kind: 'remote_links_disabled' }));
    const error = await failure(h.run(GET_DOC));
    expect(error).toMatchObject({ code: 'forbidden', details: { reason: SPACE_LINK_REMOTE_DISABLED } });
    expect(h.use).not.toHaveBeenCalled();
    expect(h.audits.at(-1)).toMatchObject({ result: 'error', reason: 'remote_links_disabled' });
  });

  it('refused by B — re-typed with B\'s code, no B text in the audit', async () => {
    const h = harness(SERVER, async () => ({ kind: 'refused', status: 403, code: 'forbidden', message: 'B says no' }));
    const error = await failure(h.run(GET_DOC));
    expect(error).toMatchObject({ code: 'forbidden', details: { reason: SPACE_LINK_REMOTE_REFUSED, status: 403 } });
    expect(h.audits.at(-1)).toMatchObject({ result: 'error', reason: 'remote.forbidden' });
    expect(JSON.stringify(h.audits)).not.toContain('B says no');
  });

  it('refused by B with a code this node does not know — typed by status', async () => {
    const h = harness(SERVER, async () => ({ kind: 'refused', status: 404, code: 'gone_elsewhere', message: 'x' }));
    expect((await failure(h.run(GET_DOC))).code).toBe('not_found');
  });

  it('home guards run FIRST — a refused-set op is never forwarded', async () => {
    const h = harness(SERVER, async () => ({ kind: 'ok', status: 200, body: {} }));
    const error = await failure(h.run({ op: 'credentials.status' }));
    expect(error.details).toMatchObject({ reason: 'space_link_refused', refusal: 'credential_management' });
    expect(h.forwarder!.forward).not.toHaveBeenCalled();
    expect(h.audits.at(-1)).toMatchObject({ result: 'refused', reason: 'credential_management' });
  });

  it('home guards run FIRST — a via chain already holding the target is never forwarded', async () => {
    const h = harness(SERVER, async () => ({ kind: 'ok', status: 200, body: {} }));
    const error = await failure(h.run(GET_DOC, { [SPACE_LINK_VIA_HEADER]: TARGET }));
    expect(error.details).toMatchObject({ refusal: 'via_loop' });
    expect(h.forwarder!.forward).not.toHaveBeenCalled();
  });

  it('positive for the guards — the same op with an empty chain is forwarded', async () => {
    const h = harness(SERVER, async () => ({ kind: 'ok', status: 200, body: { id: DOC } }));
    await h.run(GET_DOC);
    expect(h.forwarder!.forward).toHaveBeenCalledTimes(1);
  });

  it('no forwarder on this node — a remote link is 501, audited remote_not_wired, never resolved locally', async () => {
    const h = harness(SERVER);
    const error = await failure(h.run(GET_DOC));
    expect(error.code).toBe('not_implemented');
    expect(h.use).not.toHaveBeenCalled();
    expect(h.local).not.toHaveBeenCalled();
    expect(h.audits.at(-1)).toMatchObject({ result: 'error', reason: 'remote_not_wired' });
  });

  it('a thrown forwarder is audited as internal and rethrown', async () => {
    const h = harness(SERVER, async () => { throw new Error('boom'); });
    await expect(h.run(GET_DOC)).rejects.toThrow('boom');
    expect(h.audits.at(-1)).toMatchObject({ result: 'error', reason: 'internal' });
  });
});
