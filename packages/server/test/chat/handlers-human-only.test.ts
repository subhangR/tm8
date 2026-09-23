/**
 * EVERY operation `registerChatHandlers` mounts refuses a chat-runtime bearer.
 *
 * This file is the price of a lint rule, and it is worth paying. The guard
 * wanted to be a property of the GROUP — map a wrapper over the record, and a
 * new entry cannot be registered without passing through it, which is the shape
 * `credentials.ts` argues for at length. `tools/conformance`'s source inventory
 * forbids it: a registration whose operation name is computed is invisible to
 * the census of what this node mounts, and an unauditable surface is a worse
 * defect than a forgettable wrapper.
 *
 * So the wrapper is per entry, and this walks whatever was actually registered
 * rather than a list written beside it. A second chat operation added without
 * `humanOnly` fails HERE — it does not have to be remembered into this file,
 * which is exactly the property the record shape would have given.
 */
import { describe, expect, it } from 'vitest';
import { CollabError, getOperation, OPERATIONS, type OperationName } from '@tm8/contract';

import { registerChatHandlers } from '../../src/chat/handlers.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { OperationHandler, RequestContext } from '../../src/http/types.js';

/**
 * Deps that THROW if reached. A handler that ran its body before checking the
 * credential would fail here with this error rather than the refusal — which
 * is the distinction that matters: the guard has to come first, not merely
 * exist. `chat.start` mints a scratch directory and calls an RPC, so "it was
 * refused eventually" is not the same as "it was refused".
 */
const unreachable = new Proxy({}, {
  get() { throw new Error('a refused operation must not touch its dependencies'); },
}) as unknown as FacadeDeps;

function registeredHandlers(): Map<OperationName, OperationHandler> {
  const registry = new HandlerRegistry();
  registerChatHandlers(registry, unreachable);
  const found = new Map<OperationName, OperationHandler>();
  // The registry has no public enumeration, so ask it for every chat-shaped
  // operation the catalog knows and keep what answers. Immune to the registry's
  // private map changing shape.
  for (const name of CHAT_OPERATIONS) {
    const handler = registry.get(name);
    if (handler) found.set(name, handler);
  }
  return found;
}

/**
 * Every catalog operation whose name is chat-shaped, READ OFF THE CATALOG.
 *
 * Not a list typed out here, which is the version of this that does nothing: a
 * `chat.stop` added to the contract and mounted unguarded would be absent from
 * a hand-written list and therefore never checked — the exact operation this
 * file exists to catch. Derived, it appears the moment the contract declares
 * it.
 */
const CHAT_OPERATIONS: readonly OperationName[] = OPERATIONS
  .map((operation) => operation.name)
  .filter((name) => name.startsWith('chat.'));

const runtimeBearer: RequestContext['identity'] = {
  kind: 'bearer',
  identityId: 'identity-a',
  authKind: 'agent_runtime',
  runtimeChatId: '019f0000-0000-7000-8000-0000000006a1',
};

function ctx(opName: OperationName): RequestContext {
  const op = getOperation(opName);
  return {
    op,
    opName,
    params: {},
    query: new URLSearchParams(),
    body: {},
    requestId: 'human-only-test',
    identity: runtimeBearer,
    headers: {},
    method: op.method,
    path: op.path,
  };
}

describe('chat operations are human-only, all of them', () => {
  it('mounts at least one operation, so a green run is never vacuous', () => {
    // THE ASSERTION THAT MAKES THE NEXT ONE MEAN SOMETHING. A loop over an
    // empty set passes, and a refactor that stopped registering anything here
    // would otherwise turn this whole file green and silent.
    expect(registeredHandlers().size).toBeGreaterThan(0);
  });

  it('refuses a chat-runtime credential before touching anything', async () => {
    const handlers = registeredHandlers();
    for (const [name, handler] of handlers) {
      await expect(
        handler(ctx(name)),
        `${name} must refuse an agent_runtime bearer`,
      ).rejects.toBeInstanceOf(CollabError);
      await expect(handler(ctx(name))).rejects.toMatchObject({ code: 'forbidden' });
    }
  });

  it('mounts every chat.* operation the catalog declares', () => {
    // Today that is exactly `chat.start`. When the contract grows another, this
    // fails until it is mounted — and the test above then holds it to the same
    // guard, without either being remembered into this file.
    expect([...registeredHandlers().keys()].sort()).toEqual([...CHAT_OPERATIONS].sort());
    expect(CHAT_OPERATIONS).toContain('chat.start');
  });
});
