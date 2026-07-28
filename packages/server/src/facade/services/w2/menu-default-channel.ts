import {
  CollabError,
  isCollabError,
  MenuConfigSchema,
  SetDefaultChannelInputSchema,
  SpaceSettingsViewSchema,
  UpdateMenuInputSchema,
  type MenuConfig,
  type SpaceSettingsView,
} from '@tm8/contract';

import type { OperationHandler } from '../../../http/types.js';
import { claimsFor, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';

export interface MenuUpdatedEventEffect {
  type: 'menu.updated';
  menu: MenuConfig;
  clientMutationId?: string;
}

export interface W2MenuDefaultChannelEffects {
  /**
   * Optional tranche-integration seam. PostgreSQL returns this only for the
   * first committed attempt; ledger replays deliberately omit it.
   */
  readonly publishMenuUpdated?: (
    spaceId: string,
    effect: MenuUpdatedEventEffect,
  ) => void | Promise<void>;
}

interface MenuUpdateRpcResult {
  menu: unknown;
  eventEffect?: unknown;
}

function invalidInput(message: string): CollabError {
  return new CollabError('invalid_input', message);
}

function parseUpdateMenuInput(body: unknown) {
  const parsed = UpdateMenuInputSchema.safeParse(body);
  if (!parsed.success) {
    throw invalidInput(parsed.error.issues[0]?.message ?? 'invalid menu update input');
  }
  return parsed.data;
}

function parseSetDefaultChannelInput(body: unknown) {
  const parsed = SetDefaultChannelInputSchema.safeParse(body);
  if (!parsed.success) {
    throw invalidInput(parsed.error.issues[0]?.message ?? 'invalid default-channel input');
  }
  return parsed.data;
}

function parseMenu(value: unknown, context: string): MenuConfig {
  const parsed = MenuConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new CollabError('upstream_unavailable', `${context} violates the frozen MenuConfig contract`);
  }
  return parsed.data;
}

function parseMenuEffect(value: unknown, menu: MenuConfig): MenuUpdatedEventEffect | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new CollabError('upstream_unavailable', 'menu update effect is malformed');
  }
  const effect = value as Record<string, unknown>;
  const keys = Object.keys(effect).sort();
  const allowed = effect.clientMutationId === undefined
    ? ['menu', 'type']
    : ['clientMutationId', 'menu', 'type'];
  if (
    JSON.stringify(keys) !== JSON.stringify(allowed)
    || effect.type !== 'menu.updated'
    || (effect.clientMutationId !== undefined && typeof effect.clientMutationId !== 'string')
  ) {
    throw new CollabError('upstream_unavailable', 'menu update effect is malformed');
  }
  const effectMenu = parseMenu(effect.menu, 'menu update effect');
  if (JSON.stringify(effectMenu) !== JSON.stringify(menu)) {
    throw new CollabError('upstream_unavailable', 'menu update effect does not match the command result');
  }
  return {
    type: 'menu.updated',
    menu: effectMenu,
    ...(typeof effect.clientMutationId === 'string'
      ? { clientMutationId: effect.clientMutationId }
      : {}),
  };
}

function normalizeMenuError(error: unknown): never {
  if (isCollabError(error)) {
    const details = error.details as Record<string, unknown> | undefined;
    const reason = details?.reason;
    if (
      error.code === 'version_conflict'
      && (reason === 'menu_revision_conflict' || reason === 'menu_upgrade_required')
    ) {
      throw new CollabError('conflict', error.message, {
        details,
        current: error.current,
      });
    }
  }
  throw error;
}

function parseSpaceSettings(value: unknown): SpaceSettingsView {
  const parsed = SpaceSettingsViewSchema.safeParse(value);
  if (!parsed.success) {
    throw new CollabError(
      'upstream_unavailable',
      'default-channel result violates the frozen SpaceSettingsView contract',
    );
  }
  return parsed.data;
}

export class W2MenuDefaultChannelService {
  constructor(
    private readonly deps: FacadeDeps,
    private readonly effects: W2MenuDefaultChannelEffects = {},
  ) {}

  readonly spacesMenuGet: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const result = await this.deps.db.rpc<unknown>(
      claimsFor(owner, ctx),
      'get_space_menu',
      [spaceId],
    );
    return parseMenu(result, 'stored Space menu');
  };

  readonly spacesMenuUpdate: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const input = parseUpdateMenuInput(ctx.body);
    try {
      const result = await this.deps.db.rpc<MenuUpdateRpcResult>(
        claimsFor(owner, ctx, { clientMutationId: input.clientMutationId }),
        'update_space_menu',
        [spaceId, input.payload, input.expectedRevision, input.clientMutationId],
      );
      const menu = parseMenu(result.menu, 'menu update result');
      const effect = parseMenuEffect(result.eventEffect, menu);
      if (effect && this.effects.publishMenuUpdated) {
        await this.effects.publishMenuUpdated(spaceId, effect);
      }
      return menu;
    } catch (error) {
      normalizeMenuError(error);
    }
  };

  readonly spacesDefaultChannelSet: OperationHandler = async (ctx) => {
    const owner = await this.deps.owner();
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const input = parseSetDefaultChannelInput(ctx.body);
    const result = await this.deps.db.rpc<unknown>(
      claimsFor(owner, ctx, { clientMutationId: input.clientMutationId }),
      'set_space_default_channel',
      [spaceId, input.channelId, input.expectedSettingsRevision, input.clientMutationId],
    );
    return parseSpaceSettings(result);
  };
}
