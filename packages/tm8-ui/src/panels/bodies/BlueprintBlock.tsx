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
import { useMemo, type CSSProperties } from 'react';
import type { EntityDetail } from '@tm8/contract';
import { BlueprintCanvas } from '../../craft/BlueprintCanvas';
import { blueprintView } from '../../craft/blueprint-model';

/**
 * The smallest scale at which a node title still reads. MEASURED, not chosen:
 * at the panel's 320px minimum a 1080-unit fold lands at 0.30 and draws a 4px
 * title against 23.1px body text; 0.60 (the 2-node case) draws 9px, which is
 * small but legible. Below this the block scrolls rather than shrinks.
 */
const LEGIBLE_SCALE = 0.6;

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

  /*
   * THE BOX IS THE FOLD'S SHAPE, NOT A CONSTANT.
   *
   * A fixed height was wrong in both directions, measured in Chrome at the
   * panel's documented 320px minimum: `PER_ROW = 4` pins the fold at 1080
   * user units wide for ANY graph with 4+ nodes, and `preserveAspectRatio`
   * fits by the constrained axis — always width in a panel. So a 4-node graph
   * drew 36px tall inside a 320px box (~90% of it empty) while its titles
   * rendered 4px against 23.1px body text.
   *
   * Handing the fold's own aspect ratio to CSS fixes the empty half exactly:
   * the box is as tall as the drawing actually is, and no taller. The
   * `min-width` floor fixes the other half — below it the drawing would scale
   * past legibility, so the block scrolls sideways at a readable size instead
   * of shrinking to nothing. Both numbers come from `view.bounds`, which is
   * what is genuinely DRAWN, so the box can never disagree with its contents.
   */
  const { width: boxW, height: boxH } = view.bounds;

  return (
    <div
      className="pn-blueprint"
      data-testid="panel-blueprint"
      style={
        {
          '--pn-bp-aspect': `${boxW} / ${boxH}`,
          /* The width at which the fold still reads. Below it, scroll. */
          '--pn-bp-floor': `${Math.round(boxW * LEGIBLE_SCALE)}px`,
        } as CSSProperties
      }
    >
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
