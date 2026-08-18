// @tm8/execution — credential-shaped token redaction for launch artifacts.
//
// WHY THIS EXISTS. The S15 invariant says provider secrets never enter
// Postgres, and migration 006/073 enforce it with a trigger on
// `session_manifests`: any credential-shaped string in the manifest or the
// recorded launch prompts raises `manifest appears to contain a credential
// value` and the spawn dies. That guard is correct — but it fires AFTER the
// manifest is composed, so a member who pastes an API key into a task
// description (measured on utho-prod 2026-08-09: a real `sk-ant-oat…` OAuth
// token in a task body made every launch of that task unspawnable) gets a
// refusal that points nowhere near the cause, and the raw key would otherwise
// have travelled into the manifest FILE, the child argv, and the graph row.
//
// So the pipeline redacts FIRST: `composeManifest` scrubs every string in the
// manifest it returns, which means the prompts composed from it, the manifest
// file, the argv, and the `record_session_manifest` row all carry
// `[credential-redacted]` where the token was. The DB guard remains as
// defence in depth behind this seam — after redaction it can only fire on a
// composer bug, which is exactly what a tripwire is for.
//
// PATTERN PARITY WITH THE GUARD. The token grammar here MUST match
// `internal.guard_manifest_secrets` (086, previously 073/006): if the
// redactor is narrower than the guard, a string the redactor passes still
// kills the spawn at the insert. Postgres has no lookbehind, so both sides
// use the same explicit left-boundary group `(^|[^A-Za-z0-9_-])` — that is
// what stops `task-0123456789abcdef…` (an ordinary branch/slug, where `sk-`
// is the tail of "task") matching while `"sk-ant-…"` (preceded by a quote,
// a space, or a `=`) still does. Whoever changes one side must change both.
export const SECRET_TOKEN_SOURCE =
  '(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|tm8[sacr]_[A-Za-z0-9_-]{20,})';

const LEFT_BOUNDARY_SOURCE = '(^|[^A-Za-z0-9_-])';

/** What a scrubbed token is replaced with, everywhere. */
export const REDACTION_MARKER = '[credential-redacted]';

function secretTokenRegExp(): RegExp {
  return new RegExp(`${LEFT_BOUNDARY_SOURCE}${SECRET_TOKEN_SOURCE}`, 'g');
}

/** True when `text` contains a credential-shaped token at a token boundary. */
export function containsSecretToken(text: string): boolean {
  return secretTokenRegExp().test(text);
}

/**
 * Replace every credential-shaped token in `text` with the redaction marker.
 *
 * The boundary character (group 1) is text, not secret, and is kept; the
 * token (group 2) is dropped in full — a marker that preserved a recognisable
 * prefix would leak the very bytes rotation exists to retire.
 */
export function redactSecretTokens(text: string): string {
  return text.replace(secretTokenRegExp(), (_match, boundary: string) => {
    return `${boundary}${REDACTION_MARKER}`;
  });
}

/**
 * Deep-copy `value` with every string field redacted.
 *
 * Applied to the composed manifest as a whole rather than to a hand-picked
 * field list, because the leak path is "any free text a member controls" —
 * task descriptions today, persona memories or promptExtra tomorrow — and a
 * field list is a hole waiting for the next field. The manifest is plain
 * JSON-shaped data (it is written to disk with JSON.stringify), so walking
 * objects/arrays/strings covers it exactly.
 */
export function redactSecretsDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return redactSecretTokens(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretsDeep(entry)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactSecretsDeep(entry);
    }
    return out as unknown as T;
  }
  return value;
}
