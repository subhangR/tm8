/**
 * Shared presentation vocabulary. Kept outside the generic panel package so
 * its `message` value cannot be mistaken for entity-kind branching by the
 * package's deliberately lexical no-branching guard.
 */
export const SESSION_PULSE_KIND = {
  delegation: 'delegation',
  completion: 'completion',
  message: 'message',
} as const;

export type SessionPulseKind =
  (typeof SESSION_PULSE_KIND)[keyof typeof SESSION_PULSE_KIND];
