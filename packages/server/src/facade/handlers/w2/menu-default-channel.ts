import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import {
  W2MenuDefaultChannelService,
  type W2MenuDefaultChannelEffects,
} from '../../services/w2/menu-default-channel.js';

/** W2.G14's complete, tranche-safe registration seam. */
export function registerW2MenuDefaultChannelHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  effects: W2MenuDefaultChannelEffects = {},
): void {
  const service = new W2MenuDefaultChannelService(deps, effects);
  registry.registerAll({
    'spaces.menu.get': service.spacesMenuGet,
    'spaces.menu.update': service.spacesMenuUpdate,
    'spaces.defaultChannel.set': service.spacesDefaultChannelSet,
  });
}

export type {
  MenuUpdatedEventEffect,
  W2MenuDefaultChannelEffects,
} from '../../services/w2/menu-default-channel.js';
