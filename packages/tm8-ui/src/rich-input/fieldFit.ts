/**
 * HOW TALL THE COMPOSER FIELD IS — one pure rule, so it is proved without a
 * layout engine (audit A2, composer-states mockup §2).
 *
 * The field is exactly as tall as its text (`scrollHeight`, padding included,
 * which on the phone's 16px/22px field is `22n + 10`) until the CSS cap, and
 * then it holds the cap and scrolls. `capped` is the ONLY time the field may
 * scroll: below the cap the stylesheet keeps `overflow-y: hidden`, so a
 * sub-pixel rounding between `scrollHeight` and the line box can never draw a
 * scrollbar beside one line of text — which is what the old `16px/1.4`
 * (22.4px) line did.
 *
 * `cap` is the field's computed `max-height`; anything that is not a finite
 * number of pixels (`none`, jsdom's empty string) means "no cap".
 */
export interface FieldFit {
  readonly height: number;
  readonly capped: boolean;
}

export function fieldFit(scrollHeight: number, cap: number): FieldFit {
  const limit = Number.isFinite(cap) && cap > 0 ? cap : Number.POSITIVE_INFINITY;
  const capped = scrollHeight > limit;
  return { height: capped ? limit : scrollHeight, capped };
}

/** The computed `max-height` as pixels, or `Infinity` when there is none. */
export function capOf(maxHeight: string): number {
  const px = Number.parseFloat(maxHeight);
  return Number.isFinite(px) ? px : Number.POSITIVE_INFINITY;
}
