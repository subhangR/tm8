import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { capOf, fieldFit } from './fieldFit';

/**
 * THE ONE CHAT BOX — the card every composing surface mounts.
 *
 * Chat Home drew the reference: a bordered card with chips riding on top, the
 * field across the full width under them, and one toolbar row of controls
 * beneath ending in Send — at every width and every draft length. The channel
 * and thread composers used to draw their own flat row beside a bordered well;
 * two chat boxes for one grammar is exactly the drift a shared component
 * exists to stop.
 *
 * The card owns the SHELL only — border, shadow, focus ring, the borderless
 * field treatment, footer geometry. What goes in the footer (mode drop-ups on
 * Chat Home; the @/⌗/file pickers on a channel) stays each host's, because
 * those controls are that surface's real capabilities, not chrome, and a shell
 * that tried to own them would be branching on host by another name.
 *
 * `field` renders inside an `.ri-host`, so a `TriggerPopover` or any
 * absolutely-positioned picker in that slot anchors to the field it serves.
 */
export function ComposerCard({
  className,
  testId,
  draft,
  above,
  field,
  foot,
}: {
  className?: string;
  testId?: string;
  /**
   * The field's text. The card re-measures when THIS changes (and when its
   * width does), not on every render: a host re-renders on every streamed
   * token of a running turn, and each measurement is a forced reflow.
   */
  draft: string;
  /** Chips, reply strips, refusals — everything that rides INSIDE the card, above the field. */
  above?: ReactNode;
  /** The textarea and its popovers. */
  field: ReactNode;
  /** The one control row: host controls first, Send last. */
  foot: ReactNode;
}) {
  /* THE FIELD GROWS WITH ITS TEXT (`fieldFit`). Reset to `auto` first or it
     could only ever grow. The cap is the stylesheet's `max-height`; past it
     the field holds the cap and is marked `data-capped`, the one state in
     which the phone stylesheet lets it scroll — so the first line is never
     scrolled out of a box too short to hold it, and no scrollbar is drawn
     beside text that fits. */
  const host = useRef<HTMLDivElement>(null);
  const fit = useRef(() => {
    const area = host.current?.querySelector('textarea');
    if (!area) return;
    area.style.height = 'auto';
    const next = fieldFit(area.scrollHeight, capOf(getComputedStyle(area).maxHeight));
    area.style.height = `${next.height}px`;
    area.toggleAttribute('data-capped', next.capped);
    if (!next.capped) area.removeAttribute('data-scrolled');
  });
  useLayoutEffect(() => fit.current(), [draft]);
  /* A rotation or a resize rewraps the same text onto a different number of
     lines. Width only: the field's own height change must not re-trigger it. */
  useEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit.current();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div className={className ? `ri-card ${className}` : 'ri-card'} data-testid={testId}>
      {above}
      <div
        className="ri-host"
        ref={host}
        /* "More above" cue for a capped field (mockup 2c): `scroll` does not
           bubble, so it is caught on the way down. */
        onScrollCapture={(event) => {
          const target = event.target;
          if (target instanceof HTMLTextAreaElement) {
            target.toggleAttribute('data-scrolled', target.scrollTop > 0);
          }
        }}
      >
        {field}
      </div>
      <div className="ri-card__foot">{foot}</div>
    </div>
  );
}
