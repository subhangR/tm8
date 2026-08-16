/** True only when neither the terminal nor one of its ancestors hides it. */
export function isElementPaintable(element: HTMLElement | undefined): boolean {
  if (!element || !element.isConnected) return false;
  let current: HTMLElement | null = element;
  while (current) {
    const style = getComputedStyle(current);
    if (
      style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse'
    ) return false;
    current = current.parentElement;
  }
  return true;
}

