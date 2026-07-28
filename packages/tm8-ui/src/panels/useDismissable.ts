import { useEffect, type RefObject } from 'react';

/**
 * Dismiss a popover on Escape or an outside pointer-down.
 *
 * Shared rather than written twice: the filter picker and the kind selector
 * are the same affordance shape, and the real-browser pass caught BOTH
 * trapping the user — a popover that closes only by re-clicking its own
 * trigger is a control the user has to already know how to escape. Fixing
 * the instance I had just built would have left its twin two files away,
 * which is the class-not-instance lesson from earlier today.
 *
 * Escape is CONSUMED here (C6 layer 2: the topmost surface takes it), so
 * dismissing a picker never also pops the panel stack underneath it.
 */
export function useDismissable(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
    };
    const onPointerDown = (e: MouseEvent) => {
      const el = ref.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) onDismiss();
    };

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onPointerDown, true);
    };
  }, [open, ref, onDismiss]);
}
