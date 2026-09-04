import type { ReactNode } from 'react';

/**
 * Eyebrow — uppercase mono micro-label heading a small section
 * ("SUBTREE · 2", "RUNS · 1 LIVE", "SERVER URL"). `faint` is the ink-4
 * variant the canvases use inside detail panels.
 */
export function Eyebrow({ faint = false, children }: { faint?: boolean; children: ReactNode }) {
  return <span className={faint ? 'kit-eyebrow kit-eyebrow--faint' : 'kit-eyebrow'}>{children}</span>;
}
