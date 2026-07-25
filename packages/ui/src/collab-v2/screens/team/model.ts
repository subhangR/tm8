/**
 * Team screen model — pure, kind-free selectors over `EntitySummary`.
 *
 * The screen never branches on `kind`: it asks the facade for the member set
 * and the agent set separately (two `CollectionQuery.kinds` filters) and then
 * arranges them. The only state this file touches is the *structural* `owner`
 * / `liveWork` shape that the contract puts on an agent's summary — read by
 * presence of the field, never by comparing a kind literal. Rendering is
 * entirely EntityCard/EntityChip; this file only decides ordering and nesting.
 */
import type { ActorSummary, EntityId, EntitySummary } from '../../types/contract';

/** The structural slice of `EntityState` an agent summary carries. */
interface AgentShape { owner?: ActorSummary; liveWork?: unknown }

/** The human an agent belongs to, when the summary carries one. */
export function ownerOf(entity: EntitySummary): ActorSummary | null {
  return (entity.state as AgentShape).owner ?? null;
}

/** True while the agent has live work attached to its summary. */
export function isWorking(entity: EntitySummary): boolean {
  return (entity.state as AgentShape).liveWork != null;
}

/** One row of an org tree: the agent plus its depth under the owner. */
export interface OrgRow { entity: EntitySummary; depth: number }

/** Agents bucketed by the member who owns them (unowned agents are dropped). */
export function groupByOwner(agents: EntitySummary[]): Map<EntityId, EntitySummary[]> {
  const byOwner = new Map<EntityId, EntitySummary[]>();
  for (const agent of agents) {
    const owner = ownerOf(agent);
    if (!owner) continue;
    const bucket = byOwner.get(owner.id);
    if (bucket) bucket.push(agent);
    else byOwner.set(owner.id, [agent]);
  }
  return byOwner;
}

/**
 * Flatten an owner's agents into depth-tagged rows following the homogeneous
 * `parentId` hierarchy (Forge → Scout, Probe). Agents whose parent is outside
 * the bucket render as roots, so nothing is ever hidden by a missing ancestor.
 */
export function orgRows(agents: EntitySummary[]): OrgRow[] {
  const byPosition = (a: EntitySummary, b: EntitySummary): number =>
    a.position - b.position || a.title.localeCompare(b.title);
  const present = new Set(agents.map((a) => a.id));
  const childrenOf = new Map<EntityId, EntitySummary[]>();
  const roots: EntitySummary[] = [];

  for (const agent of agents) {
    if (agent.parentId && present.has(agent.parentId)) {
      const kids = childrenOf.get(agent.parentId);
      if (kids) kids.push(agent);
      else childrenOf.set(agent.parentId, [agent]);
    } else {
      roots.push(agent);
    }
  }

  const rows: OrgRow[] = [];
  const walk = (entity: EntitySummary, depth: number): void => {
    rows.push({ entity, depth });
    for (const child of (childrenOf.get(entity.id) ?? []).sort(byPosition)) {
      walk(child, depth + 1);
    }
  };
  for (const root of roots.sort(byPosition)) walk(root, 0);
  return rows;
}

/** Header tally: humans · agents · how many of those agents are working. */
export interface TeamTally { humans: number; agents: number; working: number }

export function tally(members: EntitySummary[], agents: EntitySummary[]): TeamTally {
  return {
    humans: members.length,
    agents: agents.length,
    working: agents.filter(isWorking).length,
  };
}
