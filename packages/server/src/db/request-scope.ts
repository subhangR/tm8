/**
 * THE AMBIENT ANSWER TO "IS ANYONE STILL WAITING FOR THIS?"
 *
 * One `AbortSignal` per HTTP request, established by the frame
 * (`http/server.ts`) and read by the database layer (`db/client.ts`) to cancel
 * reads whose caller has hung up.
 *
 * WHY ASYNCLOCALSTORAGE AND NOT A PARAMETER, since a parameter is what this
 * codebase reaches for everywhere else. There are ~150 `db.tx` / `db.rpc` /
 * `db.query` call sites across the handlers. Threading a signal through all of
 * them is not merely a large diff — it is a diff that DOES NOT STAY DONE. Every
 * handler written afterwards has to remember, nothing fails when it does not,
 * and the failure is invisible: the request works, it just also wastes fifteen
 * seconds of a pooled connection when the tab closes. That is the same shape of
 * bug as the two timeout constants this change also fixes — a relationship held
 * by nothing but everyone's memory. Ambient scope makes it hold by
 * construction, for every call site that exists and every one that will.
 *
 * WHAT IT COSTS, stated plainly so the trade is visible: the coupling is now
 * invisible at the call site. `db.query(claims, sql)` is cancellable and reading
 * that line does not say so. The mitigations are that the behaviour is gated to
 * READS ONLY (see `db/client.ts` — a command is never cancelled), that the
 * escape hatch below is explicit and named, and that both are tested.
 *
 * WHAT MUST NOT INHERIT THE SIGNAL. Work started inside a request that
 * deliberately OUTLIVES it — waking an agent, dispatching a delivery, a
 * background sweep kicked off opportunistically — would otherwise be cancelled
 * by the poster's browser tab closing, which is nonsense: the poster is not the
 * one waiting for it. Those sites call `runDetached` and say why. There is no
 * automatic detection for this and there cannot be; a promise the request does
 * not await is still, as far as the runtime is concerned, part of the request.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestScope {
  /**
   * Aborted when the caller stops waiting — the client hung up, or the response
   * was destroyed. NOT aborted merely because the response finished normally.
   */
  readonly signal: AbortSignal;
}

const storage = new AsyncLocalStorage<RequestScope>();

/** Run `fn` with `scope` visible to everything it awaits. */
export function runInRequestScope<T>(scope: RequestScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/**
 * The ambient scope, or `undefined` outside a request.
 *
 * `undefined` is the correct answer for the scheduler, the boot path and the
 * tests, and it means exactly one thing to every caller: nobody is waiting on a
 * socket, so nothing is cancellable.
 */
export function currentRequestScope(): RequestScope | undefined {
  return storage.getStore();
}

/**
 * Run `fn` OUTSIDE any request scope — for work that deliberately outlives the
 * request that started it.
 *
 * Use it wherever a handler kicks off a promise it does not await. The caller's
 * disconnect must not reach that work, because the caller was never what it was
 * for: a message poster closing their tab has not withdrawn the message, and an
 * agent being woken is not waiting on the poster's socket.
 *
 * Pass the whole fire-and-forget expression, not just its first statement — the
 * scope is exited for the synchronous call and everything it goes on to await.
 */
export function runDetached<T>(fn: () => T): T {
  return storage.exit(fn);
}
