// Pinned stable app-server v2 subset, generated/checked against codex-cli 0.161.0.
// Unknown optional fields are tolerated; consumed identities/discriminants are validated.
import { harnessFailure } from './HarnessRegistry.js';
export const CODEX_PROTOCOL_REVISION = 'app-server-v2/0.161.0';
export type WireObject = Record<string, unknown>;
export function object(value: unknown): WireObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw harnessFailure(
      'protocol_error',
      'stream',
      'Expected a protocol object',
      'reconcile_before_retry',
    );
  return value as WireObject;
}
export function string(value: unknown): string {
  if (typeof value !== 'string' || !value)
    throw harnessFailure(
      'protocol_error',
      'stream',
      'Expected a protocol identity',
      'reconcile_before_retry',
    );
  return value;
}
export function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
export function turn(
  value: unknown,
): WireObject & { id: string; status: string; items: unknown[] } {
  const data = object(value),
    id = string(data['id']),
    status = string(data['status']);
  if (
    !['inProgress', 'completed', 'failed', 'interrupted'].includes(status) ||
    !Array.isArray(data['items'])
  )
    throw harnessFailure(
      'protocol_error',
      'stream',
      'Invalid turn status or items',
      'reconcile_before_retry',
    );
  return { ...data, id, status, items: data['items'] };
}
