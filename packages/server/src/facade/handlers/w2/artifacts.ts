import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import {
  W2ArtifactsService,
  type W2ArtifactsServiceOptions,
} from '../../services/w2/artifacts.js';

/**
 * W2 artifacts registration seam (TM8-ARTIFACTS-DESIGN §8.1).
 *
 * All SIX catalog operations are registered together: the conformance taxonomy
 * requires every v1 GET to answer something other than 501, so
 * `artifacts.revisions.list` and `artifacts.export` MUST be mounted alongside
 * the four commands or the catalog would lie about what this node does.
 */
export function registerW2ArtifactHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  options: W2ArtifactsServiceOptions,
): void {
  const service = new W2ArtifactsService(deps, options);
  registry.registerAll({
    'artifacts.create': service.create,
    'artifacts.publish': service.publish,
    'artifacts.revisions.list': service.revisionsList,
    'artifacts.preview.start': service.previewStart,
    'artifacts.export': service.export,
    'artifacts.restore': service.restore,
  });
}
