/**
 * PromptsOverlay — the full-screen host for PromptsScreen.
 *
 * Follows the CommandPalette contract rather than inventing a fourth overlay
 * pattern: `if (!open) return null`, Esc handled on the container with
 * `stopPropagation` so it does not also close whatever is behind it, and a
 * mousedown-on-scrim dismiss that ignores drags that merely END on the scrim.
 *
 * It renders INSIDE the shell subtree, not through a portal — the whole app's
 * theming and UI scale hang off `.cv2-root`, and nothing in this codebase
 * mounts on document.body. The host is responsible for placing it in that tree.
 */
import { useEffect, useRef } from 'react';
import { PromptsScreen } from './PromptsScreen';

export interface PromptsOverlayProps {
  open: boolean;
  onClose(): void;
}

export function PromptsOverlay(props: PromptsOverlayProps) {
  const { open, onClose } = props;
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const downOnScrim = useRef(false);

  // Move focus in on open so Esc and Tab land here rather than on whatever the
  // user was last touching in the shell behind.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="pr-scrim"
      ref={scrimRef}
      data-testid="prompts-overlay"
      onMouseDown={(e) => {
        downOnScrim.current = e.target === scrimRef.current;
      }}
      onMouseUp={(e) => {
        if (downOnScrim.current && e.target === scrimRef.current) onClose();
        downOnScrim.current = false;
      }}
    >
      <div
        className="pr-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="System prompts"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <PromptsScreen onClose={onClose} />
      </div>
    </div>
  );
}
