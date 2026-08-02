/** Kbd — keyboard hint chip (palette rows, empty states, tooltips). */
import type { ReactNode } from 'react';

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="cv2-kbd">{children}</kbd>;
}
