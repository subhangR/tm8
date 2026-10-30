import type { ToolView } from '@tm8/contract';
import type { Seam } from '../data/seam';

/*
 * WHAT THE LOOP FORM'S PICKERS READ — a view over the seam's own nouns.
 *
 * Its own module so a seam can build it without importing the form: the
 * seams are imported by every surface, and the form (React, CSS, the picker
 * components) is not something a data module should pull in.
 */

/** What the pickers read. `seam` itself satisfies it. */
export interface LoopFormSources {
  query: Seam['query'];
  entity?: Seam['entity'];
  projects?: Seam['projects'];
  commands?: { tools?: { get(toolId: string): Promise<ToolView> } };
}

/** The seam's reads, bound, so a host holding only `commands` can open the form. */
export function loopFormSourcesOf(seam: Pick<Seam, 'query' | 'entity' | 'projects' | 'commands'>): LoopFormSources {
  return {
    query: input => seam.query(input),
    entity: id => seam.entity(id),
    projects: spaceId => seam.projects(spaceId),
    commands: { get tools() { return seam.commands.tools; } },
  };
}
