// Candidate assembly only. Loaders decide eligibility and access; this module
// does not read the graph or depend on execution, and does not apply selection caps.
import type { ContextCandidate, ContextIntent, ContextSource } from './context.js';

export interface ContextEntity {
  readonly entityId: string;
  readonly entityVersion: number;
  readonly text: string;
  readonly name?: string;
}
export interface ContextPersona {
  readonly memories?: readonly (string | ContextEntity)[];
  readonly skills?: readonly ContextEntity[];
}
export interface ContextTask {
  readonly memories?: readonly ContextEntity[];
  readonly graph?: readonly ContextEntity[];
}
export interface ContextSheet {
  readonly memories?: readonly ContextEntity[];
  readonly skills?: readonly ContextEntity[];
}

/** Structural migration seam for the existing spawn helper, without importing it. */
export interface LegacyContextInput {
  readonly teamMember: { readonly memories?: readonly unknown[] };
  readonly skills?: readonly {
    readonly body: string;
    readonly name: string;
    readonly entityId?: string;
    readonly entityVersion?: number;
  }[];
  readonly tasks: readonly {
    readonly id?: string;
    readonly version?: number;
    readonly title: string;
    readonly description?: string | null;
  }[];
}

export function contextIntentFor(context: LegacyContextInput): ContextIntent;
export function contextIntentFor(
  persona: ContextPersona, task?: ContextTask | null, sheet?: ContextSheet,
  eligibleSkills?: readonly ContextEntity[],
): ContextIntent;
export function contextIntentFor(
  persona: ContextPersona | LegacyContextInput, task: ContextTask | null = null,
  sheet: ContextSheet = {}, eligibleSkills: readonly ContextEntity[] = [],
): ContextIntent {
  if ('teamMember' in persona) {
    const memories: ContextCandidate[] = [];
    (persona.teamMember.memories ?? []).forEach((memory, i) => {
      if (typeof memory === 'string' && memory.trim()) memories.push({
        id: `m${i}`, text: memory, entityId: null, entityVersion: null, widened: false, source: 'persona',
      });
    });
    const skills: ContextCandidate[] = (persona.skills ?? []).map((skill, i) => ({
      id: `s${i}`, text: skill.body, name: skill.name,
      entityId: skill.entityId ?? null, entityVersion: skill.entityVersion ?? null,
      widened: false, source: 'persona',
    }));
    const graph: ContextCandidate[] = persona.tasks.slice(1).flatMap((row, i) => {
      const text = row.description?.trim();
      return text ? [{ id: `t${i + 1}`, text, name: row.title,
        entityId: row.id ?? null, entityVersion: row.version ?? null, widened: false, source: 'task' }] : [];
    });
    return { memories, skills, ...(graph.length ? { graph, graphSubject: 'other task assigned to the same agent' } : {}) };
  }

  // Earlier sources win provenance on duplicates. New multi-source candidates
  // are numbered after deduplication; the legacy overload preserves old indexes.
  const collect = (
    groups: readonly { rows: readonly (string | ContextEntity)[]; source: ContextSource }[],
    prefix: string, equipped?: ReadonlySet<string>,
  ): ContextCandidate[] => {
    const seen = new Set<string>();
    const out: ContextCandidate[] = [];
    for (const group of groups) for (const row of group.rows) {
      const entityId = typeof row === 'string' ? null : row.entityId;
      const text = typeof row === 'string' ? row : row.text;
      if (!text.trim() || (entityId !== null && seen.has(entityId))) continue;
      if (entityId !== null) seen.add(entityId);
      out.push({
        id: `${prefix}${out.length}`, text, ...(typeof row === 'string' ? {} : { name: row.name }),
        entityId, entityVersion: typeof row === 'string' ? null : row.entityVersion,
        widened: equipped !== undefined && entityId !== null && !equipped.has(entityId),
        source: group.source,
      });
    }
    return out;
  };
  const memories = collect([
    { rows: persona.memories ?? [], source: 'persona' },
    { rows: task?.memories ?? [], source: 'task' },
    { rows: sheet.memories ?? [], source: 'sheet' },
  ], 'm');
  const skills = collect([
    { rows: persona.skills ?? [], source: 'persona' },
    { rows: sheet.skills ?? [], source: 'sheet' },
    { rows: eligibleSkills, source: 'jev' },
  ], 's', new Set((persona.skills ?? []).map((row) => row.entityId)));
  const graph = collect([{ rows: task?.graph ?? [], source: 'task' }], 't');
  return { memories, skills, ...(graph.length ? { graph } : {}) };
}
