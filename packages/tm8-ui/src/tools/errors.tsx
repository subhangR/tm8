import type { ReactNode } from 'react';
import { CollabError } from '@tm8/contract';

/**
 * A refusal as the server gave it: its taxonomy code and its own message,
 * under a short title for the surface that failed. The server's sentence is
 * the useful part (the session cap and its remedy, the missing input names,
 * the credential it would not lend), so it is never replaced.
 */
export interface ToolErrorView { code: string | null; title: string; message: string }
export type ToolErrorContext = 'run' | 'config' | 'secret' | 'load';

const TITLES: Record<ToolErrorContext, Partial<Record<string, string>> & { fallback: string }> = {
  run: {
    limit_exceeded: 'Tool session cap reached.', invalid_input: 'Check the inputs.', forbidden: 'Not allowed.',
    upstream_unavailable: 'The tool could not start.', version_conflict: 'The tool changed.', not_found: 'Tool unavailable.',
    fallback: 'The run was refused.',
  },
  config: { invalid_input: 'That value was refused.', forbidden: 'Not allowed.', version_conflict: 'The tool changed.', fallback: 'Configuration could not be saved.' },
  secret: { fallback: 'The secret was not changed.' },
  load: { fallback: 'Could not load.' },
};

/** `redact` is a value the user typed (a secret): it never reaches the screen, even if a message echoes it. */
export function toolErrorOf(failure: unknown, context: ToolErrorContext, redact?: string): ToolErrorView {
  const code = failure instanceof CollabError ? failure.code : null;
  const raw = failure instanceof Error && failure.message ? failure.message : 'The request could not be completed.';
  const message = redact ? raw.split(redact).join('••••') : raw;
  const titles = TITLES[context];
  return { code, title: (code && titles[code]) || titles.fallback, message };
}
/** A local check, not a server refusal: the message alone. */
export const localError = (message: string): ToolErrorView => ({ code: null, title: '', message });

export function ToolErrorAlert({ error, children }: { error: ToolErrorView | null; children?: ReactNode }) {
  if (!error) return null;
  return <p role="alert" className="tool-error">
    {error.title && <strong>{error.title} </strong>}{error.message}
    {error.code && <> <code className="tool-error__code">{error.code}</code></>}{children}
  </p>;
}
