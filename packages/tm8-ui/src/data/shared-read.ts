/**
 * A SHARED READ — one keyed read at a time, its answer reused while fresh.
 * The launch card's opening reads go through it (lane E of "Tm8 Session
 * Launch Improvements"): a card that opens, closes and opens again, or two
 * hooks asking the same thing in one open, cost one request, not one each.
 *
 * CONTRACT
 *  - `sharedRead(read, keyOf, policy)` returns a reader with `read`'s own
 *    call signature. A call JOINS a read already in flight for the same key.
 *  - `freshForMs` (default 0: always ask): a call within that long of the
 *    last KEPT answer for its key resolves with that answer and asks nothing.
 *  - `keep(answer)` (default: every answer) says whether an answer may be
 *    reused at all — e.g. a "no key yet" answer is never reused, because the
 *    person may be adding one right now.
 *  - A failure is never kept; the caller sees it.
 *  - `forget(input)` / `forgetAll()` are for an explicit CHANGE event (a
 *    revocation, a window focus), never an age: the kept answer goes, a read
 *    in flight is no longer joined, and an answer asked for before the forget
 *    is never kept when it lands — it may describe the world before the change.
 *
 * Memory only, per instance: the host builds one per space (or per scope),
 * so nothing here outlives what it was asked in.
 */
export interface SharedReadPolicy<R> {
  readonly freshForMs?: number;
  readonly keep?: (answer: R) => boolean;
  /** The clock; tests pass their own. */
  readonly now?: () => number;
}

export interface SharedRead<I, R> {
  (input: I): Promise<R>;
  /** Drop what is kept, and stop sharing what is in flight, for this input. */
  forget(input: I): void;
  /** `forget`, for every input. */
  forgetAll(): void;
}

export function sharedRead<I, R>(
  read: (input: I) => Promise<R>,
  keyOf: (input: I) => string,
  policy: SharedReadPolicy<R> = {},
): SharedRead<I, R> {
  const { freshForMs = 0, keep = () => true, now = Date.now } = policy;
  const inFlight = new Map<string, Promise<R>>();
  const kept = new Map<string, { at: number; answer: R }>();
  /* Which forget a request was asked under. Bumped per key by `forget` and
     for all keys by `forgetAll`; only an answer whose stamp is unchanged when
     it lands may be kept. */
  const forgotten = new Map<string, number>();
  let forgottenAll = 0;
  const stampOf = (key: string) => `${String(forgottenAll)}:${String(forgotten.get(key) ?? 0)}`;

  const call = (input: I): Promise<R> => {
    const key = keyOf(input);
    const last = kept.get(key);
    if (last && now() - last.at < freshForMs) return Promise.resolve(last.answer);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const asked = stampOf(key);
    const settle = () => { if (inFlight.get(key) === request) inFlight.delete(key); };
    const request: Promise<R> = read(input).then(
      (answer) => {
        settle();
        if (stampOf(key) === asked) {
          if (keep(answer)) kept.set(key, { at: now(), answer });
          else kept.delete(key);
        }
        return answer;
      },
      (error: unknown) => { settle(); throw error; },
    );
    inFlight.set(key, request);
    return request;
  };

  return Object.assign(call, {
    forget(input: I) {
      const key = keyOf(input);
      forgotten.set(key, (forgotten.get(key) ?? 0) + 1);
      kept.delete(key);
      inFlight.delete(key);
    },
    forgetAll() {
      forgottenAll += 1;
      kept.clear();
      inFlight.clear();
    },
  });
}
