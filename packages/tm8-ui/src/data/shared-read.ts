/**
 * A SHARED READ — one keyed read at a time, its answer reused while fresh.
 * The launch card's opening reads go through it (lane E of "Tm8 Session
 * Launch Improvements"): a card that opens, closes and opens again, or two
 * hooks asking the same thing in one open, cost one request, not one each.
 *
 * CONTRACT
 *  - `sharedRead(read, keyOf, policy)` returns a function with `read`'s own
 *    signature. A call JOINS a read already in flight for the same key.
 *  - `freshForMs` (default 0: always ask): a call within that long of the
 *    last KEPT answer for its key resolves with that answer and asks nothing.
 *  - `keep(answer)` (default: every answer) says whether an answer may be
 *    reused at all — e.g. a "no key yet" answer is never reused, because the
 *    person may be adding one right now.
 *  - A failure is never kept; the caller sees it.
 *
 * Memory only, per instance: the host builds one per space, so nothing here
 * outlives the space it was asked in.
 */
export interface SharedReadPolicy<R> {
  readonly freshForMs?: number;
  readonly keep?: (answer: R) => boolean;
  /** The clock; tests pass their own. */
  readonly now?: () => number;
}

export function sharedRead<I, R>(
  read: (input: I) => Promise<R>,
  keyOf: (input: I) => string,
  policy: SharedReadPolicy<R> = {},
): (input: I) => Promise<R> {
  const { freshForMs = 0, keep = () => true, now = Date.now } = policy;
  const inFlight = new Map<string, Promise<R>>();
  const kept = new Map<string, { at: number; answer: R }>();
  return (input: I): Promise<R> => {
    const key = keyOf(input);
    const last = kept.get(key);
    if (last && now() - last.at < freshForMs) return Promise.resolve(last.answer);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const request = read(input).then(
      (answer) => {
        inFlight.delete(key);
        if (keep(answer)) kept.set(key, { at: now(), answer });
        else kept.delete(key);
        return answer;
      },
      (error: unknown) => { inFlight.delete(key); throw error; },
    );
    inFlight.set(key, request);
    return request;
  };
}
