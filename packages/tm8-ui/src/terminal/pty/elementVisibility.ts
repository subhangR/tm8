/**
 * Whether an element is actually paintable in the document.
 *
 * Reading only the element's own `visibility` is insufficient: a terminal can
 * sit below an ancestor with `display:none` while its own computed visibility
 * still says `visible`. That is exactly how the retained Terminal surface is
 * hidden behind Chat/Debug/Graph. Treating that xterm as visible makes it parse
 * and paint into a zero-sized box and prevents the activation path from doing
 * the authoritative fit when the surface is shown again.
 */
export function isElementPaintable(element: HTMLElement | undefined): boolean {
  if (!element || !element.isConnected) return false;

  let current: HTMLElement | null = element;
  while (current) {
    const style = getComputedStyle(current);
    if (
      style.display === 'none'
      || style.visibility === 'hidden'
      || style.contentVisibility === 'hidden'
    ) {
      return false;
    }
    current = current.parentElement;
  }
  return true;
}
