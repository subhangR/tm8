import { useCallback, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useDismissable } from '../useDismissable';

/**
 * THE REFUSAL HAS TO BE REACHABLE BY A FINGER.
 *
 * The honesty vocabulary's whole claim is that an unavailable control still
 * carries its reason. That claim was true for a mouse and a keyboard and false
 * for a thumb, in a way no test in this repo could see:
 *
 *   `.hon-tip` / `.auth-tip` are revealed by `:hover` and `:focus-visible`.
 *   A touch device has no hover. And `:focus-visible` is deliberately NOT
 *   matched for a pointer interaction — that is the entire difference between
 *   `:focus` and `:focus-visible` — so tapping a refused control focuses it and
 *   still reveals nothing.
 *
 * So on a phone EVERY refusal in this product was silent: a dead control and no
 * reason, which is the precise failure L6 exists to forbid. This hook is the
 * missing third trigger — an explicit tap — added ALONGSIDE hover and
 * focus-visible rather than replacing them, so the mouse and keyboard paths are
 * untouched.
 *
 * Dismissal rides on `useDismissable`, which means an outside `pointerdown`
 * closes it. That matters here more than anywhere: a reason a user cannot get
 * rid of is a reason that has taken the screen hostage.
 */
export function useReasonDisclosure(): {
  open: boolean;
  /* React 19 widened `useRef<T>(null)` to `RefObject<T | null>`; a prop typed
     `RefObject<T>` can no longer receive one. The null is real — the ref is
     null before mount — so the type is corrected to admit it rather than
     cast at the call sites, which would move a real case into a blind spot. */
  ref: RefObject<HTMLSpanElement | null>;
  /** Spread onto the refused control. */
  triggerProps: {
    onClick: (e: { stopPropagation: () => void }) => void;
    onKeyDown: (e: KeyboardEvent) => void;
    'aria-expanded': boolean;
  };
  /** Spread onto the wrapper that CSS keys the open state off. */
  hostProps: { ref: RefObject<HTMLSpanElement | null>; 'data-reason-open': 'true' | undefined };
} {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissable(open, ref, close);

  const toggle = useCallback((e: { stopPropagation: () => void }) => {
    /* The refused control frequently sits inside a row that navigates on click.
       Opening the reason must not also open the thing the reason is about. */
    e.stopPropagation();
    setOpen((v) => !v);
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      /* `role="button"` promises Enter and Space. The element is a span, so
         nothing supplies that for free. */
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggle(e);
    },
    [toggle],
  );

  return {
    open,
    ref,
    triggerProps: { onClick: toggle, onKeyDown, 'aria-expanded': open },
    hostProps: { ref, 'data-reason-open': open ? 'true' : undefined },
  };
}
