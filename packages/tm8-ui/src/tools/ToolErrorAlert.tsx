import type { ReactNode } from 'react';
import type { ToolErrorView } from './errors';

/** A refusal on screen: its title, the server's own sentence, and its code for the bug report. */
export function ToolErrorAlert({ error, children }: { error: ToolErrorView | null; children?: ReactNode }) {
  if (!error) return null;
  return <p role="alert" className="tool-error">
    {error.title && <strong>{error.title} </strong>}{error.message}
    {error.code && <> <code className="tool-error__code">{error.code}</code></>}{children}
  </p>;
}
