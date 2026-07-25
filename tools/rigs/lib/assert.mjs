/**
 * Dependency-free assertions + a step recorder.
 *
 * The golden-workflow rigs must run under BOTH `node run.mjs` and vitest, so
 * they cannot assume `expect`. A workflow step records its own outcome here;
 * the plain-node runner prints the record and the vitest wrapper turns the
 * same record into `expect` failures. One source of truth, two harnesses.
 */

export class RigAssertionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'RigAssertionError';
    this.details = details;
  }
}

export function fail(message, details) {
  throw new RigAssertionError(message, details);
}

export function ok(cond, message, details) {
  if (!cond) fail(message, details);
}

export function equal(actual, expected, message) {
  if (actual !== expected) {
    fail(message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`, {
      actual,
      expected,
    });
  }
}

export function isString(v, message) {
  ok(typeof v === 'string' && v.length > 0, message ?? 'expected a non-empty string', { value: v });
}

export function hasKeys(obj, keys, message) {
  ok(obj && typeof obj === 'object', message ?? 'expected an object', { value: obj });
  const missing = keys.filter((k) => !(k in obj));
  ok(
    missing.length === 0,
    message ?? `missing keys: ${missing.join(', ')}`,
    { missing, got: Object.keys(obj) },
  );
}

/**
 * A workflow run: an ordered list of named steps, each PASS / FAIL / SKIP.
 *
 * `expectRed` marks a step we KNOW cannot pass before its milestone (e.g. every
 * golden workflow before M1). A red expected-red step is reported as `red`, not
 * as a surprise — but it still keeps the run's exit code non-zero so nobody can
 * mistake "the gate artifact exists" for "the gate is green".
 */
export class RunRecorder {
  constructor(name, { expectRed = false } = {}) {
    this.name = name;
    this.expectRed = expectRed;
    this.steps = [];
    this.startedAt = Date.now();
  }

  async step(title, fn, { operation, docRef } = {}) {
    const t0 = performance.now();
    try {
      const result = await fn();
      this.steps.push({
        title,
        operation,
        docRef,
        status: 'pass',
        ms: performance.now() - t0,
      });
      return result;
    } catch (error) {
      this.steps.push({
        title,
        operation,
        docRef,
        status: this.expectRed ? 'red' : 'fail',
        ms: performance.now() - t0,
        error: error instanceof Error ? error.message : String(error),
        details: error?.details,
      });
      throw error;
    }
  }

  skip(title, reason, { operation, docRef } = {}) {
    this.steps.push({ title, operation, docRef, status: 'skip', reason });
  }

  get summary() {
    const count = (status) => this.steps.filter((s) => s.status === status).length;
    return {
      workflow: this.name,
      startedAt: new Date(this.startedAt).toISOString(),
      durationMs: Date.now() - this.startedAt,
      total: this.steps.length,
      pass: count('pass'),
      fail: count('fail'),
      red: count('red'),
      skip: count('skip'),
      green: count('fail') === 0 && count('red') === 0 && count('pass') > 0,
    };
  }
}
