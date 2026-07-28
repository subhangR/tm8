/**
 * Compatibility exports for the W1 composition root. W2.G06's complete
 * registration seam lives in handlers/w2/projects-associations.ts; these
 * factories keep the already-frozen shared root compiling until integration
 * switches to that seam.
 */
import type { OperationHandler } from '../../http/types.js';
import { json } from '../../http/types.js';
import type { FacadeDeps } from '../deps.js';
import { W2ProjectsAssociationsService } from '../services/w2/projects-associations.js';

export function projectsList(deps: FacadeDeps): OperationHandler {
  return new W2ProjectsAssociationsService(deps).listProjects;
}

export function projectsGet(deps: FacadeDeps): OperationHandler {
  return new W2ProjectsAssociationsService(deps).getProject;
}

export function projectsCreate(deps: FacadeDeps): OperationHandler {
  const service = new W2ProjectsAssociationsService(deps);
  return async (ctx) => json(await service.createProject(ctx), { status: 201 });
}

export function projectsUpdate(deps: FacadeDeps): OperationHandler {
  return new W2ProjectsAssociationsService(deps).updateProject;
}

export function projectsLink(deps: FacadeDeps): OperationHandler {
  return new W2ProjectsAssociationsService(deps).linkProject;
}
