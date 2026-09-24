/**
 * NODE INSPECTOR — the selected node, read closely: what it is, whether it
 * exists yet, who owns it, what flows in and out of it, and what the
 * coherence check says about it.
 *
 * It REPLACES region C rather than joining it (coordinator ruling on the
 * design audit: never four columns). "Open entity" swaps this body for the
 * hosted entity column with a back arrow — the host does that swap; this
 * component only asks for it.
 *
 * Edges are listed in the words the canvas draws them with (`line.label`,
 * which already reads along the drawn arrow), and every neighbour is a
 * button on the same selection — walking the plan from here moves the canvas.
 */
import type { CoherenceFinding, EntityId } from '@tm8/contract';
import type { BlueprintLine, BlueprintView } from './blueprint-types';
import { neighbourhood, nodeByKey, titleOf, drawnEnds } from './canvas-nav';
import { assignmentLabel, humanStatus, initials, statusTone } from './presentation';

export interface NodeInspectorProps {
  view: BlueprintView;
  selectedKey: string;
  onSelect(key: string | null): void;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /** "Ask about this" — seeds the composer with a reference to the node. */
  onAsk?: ((key: string) => void) | undefined;
  onClose(): void;
}

export function NodeInspector({ view, selectedKey, onSelect, onOpenEntity, onAsk, onClose }: NodeInspectorProps) {
  const found = nodeByKey(view, selectedKey);
  if (!found) {
    return (
      <div className="crf-insp" data-testid="crf-inspector">
        <InspectorBar title="Node" onClose={onClose} />
        <p className="crf-insp__hollow">This node is no longer on the blueprint.</p>
      </div>
    );
  }

  const hood = neighbourhood(view, selectedKey);
  const findings: readonly CoherenceFinding[] = found.type === 'card' ? found.card.findings : found.attached.findings;
  const refId = found.type === 'card' ? found.card.refId : found.attached.refId;
  const isSpec = found.type === 'card' ? found.card.isSpec : found.attached.isSpec;
  const materialized = found.type === 'card' ? found.card.materialized : found.attached.materialized;
  const kindLabel = found.type === 'card' ? found.card.kindLabel : 'Teammate';
  const title = found.type === 'card' ? found.card.title : found.attached.title;
  const existence = isSpec ? 'Spec — not created yet' : materialized ? 'Built from spec' : 'Existing entity';

  return (
    <div className="crf-insp" data-testid="crf-inspector" aria-label={`${kindLabel}: ${title}`}>
      <InspectorBar title={kindLabel} onClose={onClose} />
      <div className="crf-insp__body">
        <h2 className="crf-insp__title">{title}</h2>
        <p className="crf-insp__state">
          <span className="crf-ol__tag" data-built={materialized || undefined} data-spec={isSpec || undefined}>
            {existence}
          </span>
          {found.type === 'card' && (found.card.status || found.card.live) ? (
            <span className="crf-ol__status" data-tone={statusTone(found.card.status, found.card.live)}>
              {found.card.live ? 'running' : humanStatus(found.card.status)}
            </span>
          ) : null}
          {found.type === 'card' && found.card.phase ? <span className="crf-insp__phase">{`Phase: ${found.card.phase}`}</span> : null}
        </p>
        {found.type === 'card' && found.card.hint ? <p className="crf-insp__hint">{found.card.hint}</p> : null}

        <div className="crf-insp__actions">
          {onAsk ? (
            <button type="button" className="crf-btn crf-btn--primary" data-testid="crf-ask" onClick={() => onAsk(selectedKey)}>
              Ask about this
            </button>
          ) : null}
          {refId && onOpenEntity ? (
            <button type="button" className="crf-btn" data-testid="crf-open-entity" onClick={() => onOpenEntity(refId as EntityId)}>
              Open entity
            </button>
          ) : null}
        </div>

        {findings.length > 0 ? (
          <section className="crf-insp__section" aria-label="Issues">
            <h3 className="crf-insp__h">Issues</h3>
            <ul className="crf-findings">
              {findings.map((finding, index) => <FindingRow key={`${finding.code}:${index}`} finding={finding} />)}
            </ul>
          </section>
        ) : null}

        {found.type === 'card' && found.card.assignees.length > 0 ? (
          <section className="crf-insp__section" aria-label={assignmentLabel()}>
            <h3 className="crf-insp__h">{capitalise(assignmentLabel())}</h3>
            <ul className="crf-insp__list">
              {found.card.assignees.map((assignee) => (
                <li key={assignee.key}>
                  <button type="button" className="crf-insp__link" onClick={() => onSelect(assignee.key)}>
                    <span className="crf-insp__avatar" aria-hidden>{initials(assignee.title)}</span>
                    {assignee.title}
                    {assignee.isSpec ? <span className="crf-ol__tag">spec</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {found.type === 'attached' ? (
          <section className="crf-insp__section" aria-label="Works on">
            <h3 className="crf-insp__h">Works on</h3>
            <ul className="crf-insp__list">
              {found.attached.tasks.map((key) => (
                <li key={key}>
                  <button type="button" className="crf-insp__link" onClick={() => onSelect(key)}>{titleOf(view, key)}</button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <EdgeList title="In" lines={hood.incoming} view={view} end="from" onSelect={onSelect} />
        <EdgeList title="Out" lines={hood.outgoing} view={view} end="to" onSelect={onSelect} />
      </div>
    </div>
  );
}

function InspectorBar({ title, onClose }: { title: string; onClose(): void }) {
  return (
    <div className="crf-insp__bar">
      <span className="crf-insp__eyebrow">{title}</span>
      <button type="button" className="crf-insp__close" aria-label="Close the inspector" title="Close (Esc)" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

function EdgeList({
  title,
  lines,
  view,
  end,
  onSelect,
}: {
  title: string;
  lines: readonly BlueprintLine[];
  view: BlueprintView;
  end: 'from' | 'to';
  onSelect(key: string): void;
}) {
  if (lines.length === 0) return null;
  return (
    <section className="crf-insp__section" aria-label={title === 'In' ? 'Incoming' : 'Outgoing'}>
      <h3 className="crf-insp__h">{title === 'In' ? 'Comes in' : 'Goes out'}</h3>
      <ul className="crf-insp__list">
        {lines.map((line) => {
          const other = drawnEnds(line)[end];
          return (
            <li key={line.key} className="crf-insp__edge" data-role={line.back ? 'back' : line.role} title={line.sentence}>
              <span className="crf-insp__rel">{line.label}</span>
              <button type="button" className="crf-insp__link" onClick={() => onSelect(other)}>
                {titleOf(view, other)}
              </button>
              {line.note ? <span className="crf-insp__note">{line.note}</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function FindingRow({ finding, onSelect }: { finding: CoherenceFinding; onSelect?: (key: string) => void }) {
  return (
    <li className="crf-finding" data-severity={finding.severity}>
      <span className="crf-finding__sev">{finding.severity}</span>
      <span className="crf-finding__msg">{finding.message}</span>
      {onSelect && finding.nodes.length > 0 ? (
        <button type="button" className="crf-insp__link crf-finding__go" onClick={() => onSelect(finding.nodes[0]!)}>
          Show
        </button>
      ) : null}
    </li>
  );
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
