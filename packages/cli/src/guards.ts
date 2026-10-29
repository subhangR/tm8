// Shared type guards for reading untyped JSON (server DTOs, stored files) in
// the CLI. One definition, imported everywhere, so "a plain object" means the
// same thing in every reader.

/** A plain object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
