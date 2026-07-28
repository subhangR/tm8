import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { W2EntityKindsProfileService } from '../../services/w2/entity-kinds-profiles.js';

/** W2.G12's complete, tranche-safe registration seam. */
export function registerW2EntityKindsProfileHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
): void {
  const service = new W2EntityKindsProfileService(deps);
  registry.registerAll({
    'entityKinds.list': service.entityKindsList,
    'entityKinds.create': service.entityKindsCreate,
    'entityKinds.update': service.entityKindsUpdate,
    'interactionProfiles.propose': service.interactionProfilesPropose,
    'interactionProfiles.updateDraft': service.interactionProfilesUpdateDraft,
    'interactionProfiles.validate': service.interactionProfilesValidate,
    'interactionProfiles.preview': service.interactionProfilesPreview,
    'interactionProfiles.activate': service.interactionProfilesActivate,
    'interactionProfiles.retire': service.interactionProfilesRetire,
    'teamMembers.interactionProfile.setDefault': service.teamMembersInteractionProfileSetDefault,
    'spaces.interactionProfile.setDefault': service.spacesInteractionProfileSetDefault,
  });
}
