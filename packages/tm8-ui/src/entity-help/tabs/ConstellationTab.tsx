/**
 * CONSTELLATION — the kind among its neighbours.
 *
 * The graph is built from the vendored edge-type registry
 * (`domain/edge-kinds`): every edge type that admits the kind at either end
 * becomes a wire to the kinds at the other end, labelled with the verb from
 * `EDGE_VERBS` read from THIS kind's side. Relations that NAME the kind are
 * drawn solid; relations that only admit it through a `*` endpoint are drawn
 * faint and listed after, so `relates_to` (`* → *`) never crowds out
 * `assigned_to`. A wildcard peer is one "Any entity" star.
 *
 * Below the graph, the same relations as a ledger: one row per edge type and
 * direction, with the author's gloss when there is one. The graph is the
 * picture; the ledger is the sentence — and the ledger is what a screen
 * reader gets in full.
 */
import { edgeVerb, getKind, type KindRelation } from '../../domain';
import { ConstellationGraph, type ConstellationNode } from '../motion/ConstellationGraph';
import { Reveal, Stagger } from '../motion/Reveal';
import { rankedRelations, type HelpPage } from '../resolve';

const ANY = '*';

interface Neighbour {
  kind: string;
  label: string;
  verbs: string[];
  named: boolean;
  /** Number of named relations reaching this neighbour — the default spotlight rank. */
  weight: number;
}

/** Fold relations into neighbours: one star per kind, every verb on its wire. */
export function neighboursOf(kind: string, relations: readonly KindRelation[]): Neighbour[] {
  const byKind = new Map<string, Neighbour>();
  for (const relation of relations) {
    const verb = edgeVerb(relation.type, relation.direction);
    for (const peer of relation.peers) {
      if (peer === kind && relation.peers.length > 1) continue;
      const id = peer === ANY ? ANY : peer;
      const label = id === ANY ? 'Any entity' : getKind(id).labelPlural;
      const entry = byKind.get(id) ?? { kind: id, label, verbs: [], named: false, weight: 0 };
      if (!entry.verbs.includes(verb)) entry.verbs.push(verb);
      if (!relation.viaWildcard) {
        entry.named = true;
        entry.weight += 1;
      }
      byKind.set(id, entry);
    }
  }
  const all = [...byKind.values()];
  /* Named neighbours first, heaviest first; the wildcard star last. */
  return all.sort((a, b) => {
    if (a.kind === ANY) return 1;
    if (b.kind === ANY) return -1;
    if (a.named !== b.named) return a.named ? -1 : 1;
    return b.weight - a.weight || a.label.localeCompare(b.label);
  });
}

export function ConstellationTab({ page, onPick }: { page: HelpPage; onPick: (kind: string) => void }) {
  const relations = rankedRelations(page.kind);
  const neighbours = neighboursOf(page.kind, relations);
  const nodes: ConstellationNode[] = neighbours.map((n) => ({
    kind: n.kind,
    label: n.label,
    verbs: n.verbs,
    faint: !n.named,
  }));
  const spotlight =
    page.constellation.spotlight && page.constellation.spotlight.length > 0
      ? page.constellation.spotlight
      : neighbours.filter((n) => n.named && n.kind !== ANY).slice(0, 4).map((n) => n.kind);
  const notes = page.constellation.notes ?? {};
  const noteFor = (relation: KindRelation) =>
    notes[`${relation.type}:${relation.direction}`] ?? notes[relation.type] ?? null;

  return (
    <div className="eh-constellation-tab" data-testid="entity-help-constellation">
      <Reveal className="eh-prose" delay={80}>
        {page.constellation.intro}
      </Reveal>

      {nodes.length > 0 ? (
        <ConstellationGraph centre={{ kind: page.kind, label: page.labelPlural }} nodes={nodes} spotlight={spotlight} onPick={onPick} />
      ) : (
        <p className="eh-prose">No edge type admits this kind at either end.</p>
      )}

      <Reveal as="section" className="eh-relations" delay={360} data-testid="relation-ledger">
        <span className="eh-eyebrow">The relations</span>
        <Stagger as="ul" itemAs="li" className="eh-relations__list" itemClassName="eh-relation" step={45} start={420}>
          {relations.map((relation) => {
            const peers = relation.peers.filter((peer) => peer !== page.kind || relation.peers.length === 1);
            const note = noteFor(relation);
            return (
              <div key={`${relation.type}:${relation.direction}`} className={relation.viaWildcard ? 'eh-relation__row eh-relation__row--faint' : 'eh-relation__row'}>
                <span className="eh-relation__verb">{edgeVerb(relation.type, relation.direction)}</span>
                <span className="eh-relation__peers">
                  {peers.map((peer, index) => (
                    <span key={peer}>
                      {index > 0 ? ', ' : ''}
                      {peer === ANY ? (
                        <em>any entity</em>
                      ) : (
                        <button type="button" className="eh-relation__peer" onClick={() => onPick(peer)}>
                          {getKind(peer).labelPlural}
                        </button>
                      )}
                    </span>
                  ))}
                </span>
                <code className="eh-relation__type">{relation.type}</code>
                <span className="eh-relation__desc">{note ?? relation.description}</span>
              </div>
            );
          })}
        </Stagger>
      </Reveal>
    </div>
  );
}
