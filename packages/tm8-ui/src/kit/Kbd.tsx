import type { ReactNode } from 'react';

/**
 * Kbd — keyboard hint chrome. Boxed form is the T0-1 tab-bar palette hint
 * ("/ palette · ⌘K"); `bare` is the unboxed faint form ("esc") used in
 * overlay headers.
 */
export function Kbd({ bare = false, children }: { bare?: boolean; children: ReactNode }) {
  return <kbd className={bare ? 'kit-kbd kit-kbd--bare' : 'kit-kbd'}>{children}</kbd>;
}
