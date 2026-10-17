import { useLayoutEffect, useRef, type ReactNode } from 'react';

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
  above,
  field,
  foot,
}: {
  className?: string;
  testId?: string;
  /** Chips, reply strips, refusals — everything that rides INSIDE the card, above the field. */
  above?: ReactNode;
  /** The textarea and its popovers. */
  field: ReactNode;
  /** The one control row: host controls first, Send last. */
  foot: ReactNode;
}) {
  /* THE FIELD GROWS WITH ITS TEXT. The textarea is sized to its content after
     every render — a keystroke, a paste, a cleared draft after Send all
     re-render the host. Reset to `auto` first or it could only ever grow.
     `max-height` in the CSS caps it; only past that does the field scroll, so
     the first line is never scrolled out of a box too short to hold it. */
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const area = host.current?.querySelector('textarea');
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight}px`;
  });
  return (
    <div className={className ? `ri-card ${className}` : 'ri-card'} data-testid={testId}>
      {above}
      <div className="ri-host" ref={host}>{field}</div>
      <div className="ri-card__foot">{foot}</div>
    </div>
  );
}
