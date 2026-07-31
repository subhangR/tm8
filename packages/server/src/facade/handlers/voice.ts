/**
 * `voice.token.create` registration seam. All the judgement lives in
 * `../services/voice.ts`; this file only binds the operation name.
 */
import type { HandlerRegistry } from '../registry.js';
import type { LiveKitConfig } from '../../http/config.js';
import type { FacadeDeps } from '../deps.js';
import { VoiceService } from '../services/voice.js';

export function registerVoiceHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  livekit: LiveKitConfig | undefined,
): void {
  const service = new VoiceService(deps, livekit);
  // Registered even when LiveKit is unconfigured. An unregistered operation
  // answers a blanket 501 "not implemented on this node" (DEV-13), which would
  // say the node cannot do voice at all; the service's own refusal says the
  // node can, but has not been given a server to point at. The second is
  // actionable and the first is not.
  registry.register('voice.token.create', service.createToken);
}
