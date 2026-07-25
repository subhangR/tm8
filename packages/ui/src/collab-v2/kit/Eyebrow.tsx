/** Eyebrow — the signature uppercase JetBrains Mono micro-label. */
import type { ReactNode } from 'react';

export function Eyebrow({ children, title }: { children: ReactNode; title?: string }) {
  return <span className="cv2-eyebrow" title={title}>{children}</span>;
}
