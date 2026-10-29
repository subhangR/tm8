/**
 * A SHARED READ — the one mechanism for a keyed read the UI repeats: one
 * request in flight per key, the last answer kept for the next first frame,
 * and that answer reused while fresh. The launch card's reads go through it
 * (lane E of "Tm8 Session Launch Improvements"), and the connector catalog
 * will (lane F), so no hook hides a second cache with other rules.
 *
 * CONTRACT
 *  - `sharedRead(read, keyOf, policy)` returns a reader with `read`'s own call
 *    signature. A call JOINS a read already in flight for the same key.
 *  - `peek(input)`: the last kept answer for the input, WHATEVER ITS AGE, else
 *    `seed(input)`; null with neither. No I/O — a host draws it on its first
 *    frame and confirms it with a call.
 *  - `freshForMs` (default 0): a call within that long of the last kept answer
 *    resolves with it and asks nothing. At 0 every call asks, and kept answers
 *    serve `peek` alone.
 *  - `keep(answer)` (default: every answer) says whether an answer may be kept
 *    at all — for reuse and for `peek`. A failure is never kept.
 *  - `maxKept` (default 32) bounds what is kept: the least recently answered
 *    key goes first.
 *  - `forget(input)` / `forgetAll()` are for an explicit CHANGE event (a
 *    revocation, a window focus, a sign-out), never an age: the kept answer
 *    goes, a read in flight is no longer joined, and an answer asked for
 *    before the forget is never kept when it lands — it may describe the world
 *    before the change. A `seed` is the host's own, and is not touched.
 *
 * Memory only, per reader: the host builds one per space (or per scope), so
 * nothing kept here outlives what it was asked in.
 */
export interface SharedReadPolicy<I, R> {
  readonly freshForMs?: number;
  readonly keep?: (answer: R) => boolean;
  /** The first-frame answer when nothing is kept for an input yet — e.g. one a previous page stored. */
  readonly seed?: (input: I) => R | null;
  readonly maxKept?: number;
  /** The clock; tests pass their own. */
  readonly now?: () => number;
}

export interface SharedRead<I, R> {
  (input: I): Promise<R>;
  /** The last kept answer whatever its age, else the seed's; null with neither. */
  peek(input: I): R | null;
  /** Drop what is kept, and stop sharing what is in flight, for this input. */
  forget(input: I): void;
  /** `forget`, for every input. */
  forgetAll(): void;
}

const DEFAULT_MAX_KEPT = 32;

export function sharedRead<I, R>(
  read: (input: I) => Promise<R>,
  keyOf: (input: I) => string,
  policy: SharedReadPolicy<I, R> = {},
): SharedRead<I, R> {
  const { freshForMs = 0, keep = () => true, seed, maxKept = DEFAULT_MAX_KEPT, now = Date.now } = policy;
  const inFlight = new Map<string, Promise<R>>();
  /** Oldest answer first (Map insertion order); re-keeping moves a key to the young end. */
  const kept = new Map<string, { at: number; answer: R }>();
  /* Which forget a request was asked under. Bumped per key by `forget` and
     for all keys by `forgetAll`; only an answer whose stamp is unchanged when
     it lands may be kept. */
  const forgotten = new Map<string, number>();
  let forgottenAll = 0;
  const stampOf = (key: string) => `${String(forgottenAll)}:${String(forgotten.get(key) ?? 0)}`;

  const remember = (key: string, answer: R) => {
    kept.delete(key);
    if (!keep(answer)) return;
    kept.set(key, { at: now(), answer });
    while (kept.size > maxKept) kept.delete(kept.keys().next().value!);
  };

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
        if (stampOf(key) === asked) remember(key, answer);
        return answer;
      },
      (error: unknown) => { settle(); throw error; },
    );
    inFlight.set(key, request);
    return request;
  };

  return Object.assign(call, {
    peek(input: I): R | null {
      return kept.get(keyOf(input))?.answer ?? seed?.(input) ?? null;
    },
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
