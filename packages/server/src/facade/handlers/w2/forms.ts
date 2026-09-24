import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { W2FormsService, type W2FormsServiceOptions } from '../../services/w2/forms.js';

/**
 * Forms registration seam (FORMS-DESIGN §6; migration 211). All thirteen
 * catalog rows register together: a v1 row with no handler would answer 501
 * and make the catalog lie about what this node does.
 */
export function registerW2FormHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  options: W2FormsServiceOptions = {},
): W2FormsService {
  const service = new W2FormsService(deps, options);
  registry.registerAll({
    'forms.create': service.create,
    'forms.update': service.update,
    'forms.questions.add': service.questionsAdd,
    'forms.questions.update': service.questionsUpdate,
    'forms.questions.remove': service.questionsRemove,
    'forms.questions.move': service.questionsMove,
    'forms.transition': service.transition,
    'forms.responses.save': service.responsesSave,
    'forms.responses.submit': service.responsesSubmit,
    'forms.responses.discard': service.responsesDiscard,
    'forms.responses.list': service.responsesList,
    'forms.responses.get': service.responsesGet,
    'forms.responses.mine': service.responsesMine,
  });
  return service;
}
