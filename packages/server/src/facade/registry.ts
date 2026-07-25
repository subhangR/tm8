/**
 * The handler registry — the seam W2 plugs into.
 *
 * The frame routes every catalog operation. The registry decides which of
 * them are actually BUILT. An operation with no registered handler answers an
 * honest `501 not_implemented` (DEV-13) — never a 404, never a fake 200.
 *
 * This is the entire reason the skeleton is useful before the graph engine
 * exists: the router, envelope, error taxonomy, WS frame and static seam are
 * real and testable today, and W2 lands semantics one `register()` call at a
 * time. The conformance suite's shape stays meaningful throughout — each
 * handler that lands turns exactly one red assertion green.
 *
 * TODAY THE REGISTRY IS DELIBERATELY EMPTY. That is not an oversight: it is
 * the acceptance criterion. An empty registry reproduces the conformance
 * stub's profile exactly (taxonomy/envelope/501-honesty assertions pass, v1
 * semantics red), which is how we prove the frame replaces the stub honestly
 * rather than papering over it.
 */
import { RESERVED_OPERATIONS, isOperationName, type OperationName } from '@tm8/contract';
import type { OperationHandler } from '../http/types.js';

const RESERVED = new Set<string>(RESERVED_OPERATIONS.map((op) => op.name));

export class HandlerRegistry {
  private readonly handlers = new Map<OperationName, OperationHandler>();

  /**
   * Bind an implementation to a catalog operation.
   *
   * Two tripwires, both deliberate:
   * - registering an unknown operation name throws — handlers cannot invent
   *   surface the catalog does not declare (T-L12);
   * - registering a `reserved` operation throws — `search.query` and
   *   `bridge.fetchBlob` are contractually unbuilt in v1 and must answer 501
   *   forever until they are un-reserved by a contract amendment. Quietly
   *   implementing one would make the deployment lie about its own contract.
   */
  register(name: OperationName, handler: OperationHandler): this {
    if (!isOperationName(name)) {
      throw new Error(`cannot register handler: ${name} is not an operation in the catalog`);
    }
    if (RESERVED.has(name)) {
      throw new Error(
        `cannot register handler for reserved operation ${name} — reserved ops must answer ` +
          `501 not_implemented (DEV-13) until un-reserved by a contract amendment`,
      );
    }
    if (this.handlers.has(name)) {
      throw new Error(`duplicate handler registration for ${name}`);
    }
    this.handlers.set(name, handler);
    return this;
  }

  registerAll(handlers: Partial<Record<OperationName, OperationHandler>>): this {
    for (const [name, handler] of Object.entries(handlers)) {
      if (handler) this.register(name as OperationName, handler);
    }
    return this;
  }

  get(name: OperationName): OperationHandler | undefined {
    return this.handlers.get(name);
  }

  has(name: OperationName): boolean {
    return this.handlers.has(name);
  }

  /** Operations with a handler — the honest answer to "what does this node do?". */
  implemented(): OperationName[] {
    return [...this.handlers.keys()].sort();
  }

  get size(): number {
    return this.handlers.size;
  }
}
