/**
 * MOTION — one answer to "may this surface move?", read by every primitive.
 *
 * THE RULE: rich motion by default, and a FULL fallback when the reader has
 * asked for less. `prefers-reduced-motion: reduce` is the OS-level ask; the
 * `reduced` prop is the host's (a test, a harness, a screenshot run). Either
 * one wins. Under reduced motion nothing in Entity Help animates: reveals are
 * already revealed, the terminal is already typed, the constellation is
 * already drawn — the CONTENT is identical, only the choreography is gone.
 *
 * Read once at the provider, not per primitive, so a page never mixes a
 * typed terminal with a still reveal because two components asked the media
 * query at different moments.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

interface MotionState {
  /** True ⇒ no animation anywhere below this provider. */
  readonly reduced: boolean;
}

const MotionContext = createContext<MotionState>({ reduced: false });

const QUERY = '(prefers-reduced-motion: reduce)';

/** The OS preference, live. Environments without `matchMedia` (jsdom) read as "no preference". */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY).matches : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(QUERY);
    const onChange = () => setReduced(media.matches);
    onChange();
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

export function MotionProvider({ reduced, children }: { reduced?: boolean | undefined; children: ReactNode }) {
  const preference = usePrefersReducedMotion();
  const value: MotionState = { reduced: reduced ?? preference };
  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
}

export function useMotion(): MotionState {
  return useContext(MotionContext);
}
