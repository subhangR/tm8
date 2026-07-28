/**
 * Z4Host (LLD §5.6) — the full-view host for `#/s/{spaceId}/e/{entityId}`, and
 * the landing place for a panel's promote ⤢.
 *
 * Z4 is NOT a special screen (L1): it renders the SAME `EntityDetailPanel` with
 * `host='z4'`, scaling the same archetype (§2.3). This component therefore owns
 * placement and nothing else — anatomy belongs to the panel.
 *
 * Two rules it does enforce, because they are geometry:
 *  - Promote removes the id from BOTH `stack` and `pinned` (§5.2, fixing the
 *    inherited `promotePanel` gap). That is A1a's `promote()`; this host just
 *    must not re-add it.
 *  - The session archetype's Z4 is a first-class terminal host, holding the
 *    same single pool lease (§9.2 single-host law) — so Z4 must not mount a
 *    second copy of a panel that is also rendered in the center.
 */
import type { EntityId } from '@tm8/contract';

export interface Z4HostProps {
  entityId: EntityId;
  /** The panel, rendered with `host='z4'` by the caller. */
  children: React.ReactNode;
  /** Collapse back to the workspace; the id does NOT return to the stack. */
  onCollapse?(): void;
  /**
   * Immersive Z4 (`PanelConfig.z4.immersive`) — the session archetype's
   * full-height terminal. Registry-supplied, never inferred from a kind
   * here (§15.2): the registry decides, this host only renders.
   */
  immersive?: boolean;
}

export function Z4Host({ entityId, children, onCollapse, immersive }: Z4HostProps) {
  return (
    <div
      className={`shell-z4 ${immersive ? 'shell-z4--immersive' : ''}`}
      data-testid="z4-host"
      data-entity-id={entityId}
      data-immersive={immersive || undefined}
      // The stage is dark in both themes, as in the workspace center (§12).
      data-theme="dark"
      role="region"
      aria-label="Full view"
    >
      {onCollapse && (
        <button
          type="button"
          className="shell-z4__collapse"
          onClick={onCollapse}
          aria-label="Collapse full view"
        >
          ⤡
        </button>
      )}
      {children}
    </div>
  );
}
