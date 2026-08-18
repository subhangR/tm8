/**
 * THE BLUEPRINT BLOCK — a `graph` row's canvas, in the detail panel.
 *
 * WHY THIS EXISTS. A graph used to render two ways: the Craft studio drew the
 * picture, and every other surface drew a fields list. Same entity, two
 * answers, and the answer you got depended on which screen you happened to be
 * standing on. This block is the second answer deleted.
 *
 * WHY IT IS ALMOST NOTHING. R1 put the vertices AND the edges in ONE row, so
 * `blueprintView` is a pure fold from `detail.content` to a placement — no
 * seam, no per-node connections read, no cap, and therefore no host prop to
 * thread through five mount sites. The panel already has the content; the
 * picture is a function of it.
 *
 * READ-ONLY, DELIBERATELY. Craft is where a blueprint is built — it owns the
 * chat that grows it, the diff glow, the orchestrate verb. This is the place
 * you SEE one while doing something else, so it draws and navigates and
 * nothing more. The registry keeps `edit` as the door.
 *
 * NO KIND LITERAL (§15.2). The registry declares this block for the kind that
 * has blueprints; this file never asks what kind it is holding. It asks the
 * CONTENT what it is — a `graphType` the fold reports — which is data about
 * the row, not a branch on the kind.
 */
import { useMemo } from 'react';
import type { EntityDetail } from '@tm8/contract';
import { BlueprintCanvas } from '../../craft/BlueprintCanvas';
import { blueprintView } from '../../craft/blueprint-model';

export function BlueprintBlock({
  detail,
  onOpenEntity,
}: {
  detail: EntityDetail;
  onOpenEntity?: ((id: string) => void) | undefined;
}) {
  const view = useMemo(() => blueprintView(detail.content), [detail.content]);

  /*
   * ONLY THE TYPE THIS BLOCK CAN DRAW. `graphType` is content-discriminated
   * (R3): `entity` is the orchestratable blueprint and the one with a
   * placement. A `mermaid` row's body is its SOURCE, which the fields block
   * below already shows honestly — drawing an empty canvas over it would
   * claim the row has no nodes, when the truth is that this renderer does not
   * speak its type. Returning null lets the block below tell the truth.
   */
  if (view.graphType !== 'entity' || view.cards.length === 0) return null;

  return (
    <div className="pn-blueprint" data-testid="panel-blueprint">
      <BlueprintCanvas
        view={view}
        ariaLabel={`Blueprint ${detail.title}: ${view.cards.length} nodes, ${view.lines.length} edges`}
        onOpenEntity={onOpenEntity}
      />
      {/* THE NO-SILENT-CAPS LAW, kept here too: an edge naming a key no node
          carries is counted where it was dropped, never quietly discarded. */}
      {view.danglingEdgeCount > 0 ? (
        <p className="pn-blueprint__note" data-testid="panel-blueprint-dangling">
          {`${view.danglingEdgeCount} edge${view.danglingEdgeCount === 1 ? '' : 's'} name keys no node carries — not drawn.`}
        </p>
      ) : null}
    </div>
  );
}
