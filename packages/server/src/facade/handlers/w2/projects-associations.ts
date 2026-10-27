import { json } from '../../../http/types.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { ProjectCloneService, type ProjectCloneServiceOptions } from '../../services/w2/project-clone.js';
import { W2ProjectsAssociationsService } from '../../services/w2/projects-associations.js';

/** The integration worker's single registration seam for W2.G06. */
export function registerW2ProjectsAssociationsHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  cloneOptions: ProjectCloneServiceOptions = {},
): void {
  const service = new W2ProjectsAssociationsService(deps);
  // One instance per registry: its in-flight jobs and queue live here.
  const clones = new ProjectCloneService(deps, cloneOptions);
  registry.registerAll({
    'projects.list': service.listProjects,
    'projects.create': async (ctx) => json(await service.createProject(ctx), { status: 201 }),
    'projects.directories.list': service.listProjectDirectories,
    'projects.get': service.getProject,
    'projects.branches.list': service.listBranches,
    'projects.file.history': service.fileHistory,
    'projects.file.blame': service.fileBlame,
    'projects.update': service.updateProject,
    'projects.link': service.linkProject,
    'spaces.projects.list': service.listSpaceProjects,
    'spaces.projects.create': async (ctx) => json(await service.createSpaceProject(ctx), { status: 201 }),
    'spaces.projects.clone': async (ctx) => json(await clones.clone(ctx), { status: 202 }),
    'spaces.projects.cloneJobs.get': clones.get,
    'gate.folders.list': service.listGateFolders,
    'gate.folders.create': async (ctx) => json(await service.createGateFolder(ctx), { status: 201 }),
    'projects.unlink': service.unlinkProject,
    'projects.associations.correct': service.correctProjectAssociation,
  });
}
