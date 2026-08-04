import { json } from '../../../http/types.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { W2ProjectsAssociationsService } from '../../services/w2/projects-associations.js';

/** The integration worker's single registration seam for W2.G06. */
export function registerW2ProjectsAssociationsHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
): void {
  const service = new W2ProjectsAssociationsService(deps);
  registry.registerAll({
    'projects.list': service.listProjects,
    'projects.create': async (ctx) => json(await service.createProject(ctx), { status: 201 }),
    'projects.directories.list': service.listProjectDirectories,
    'projects.get': service.getProject,
    'projects.update': service.updateProject,
    'projects.link': service.linkProject,
    'projects.unlink': service.unlinkProject,
    'projects.associations.correct': service.correctProjectAssociation,
  });
}
