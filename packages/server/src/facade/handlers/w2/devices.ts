/**
 * `devices.register`, `devices.update`, `devices.unregister` — the phones that
 * get a person's push notifications from this node (migration 392, TM8 Mobile
 * S1; s-lld §11 "Registration").
 *
 * DIVISION OF LABOUR. The database owns WHO: the owner is the bound identity
 * (no input names one), the row is bound to the caller's live root sign-in,
 * the human-only gate and the owner check are repeated in SQL, and revoking
 * the sign-in deletes the row. This file owns the TOKEN: it is sealed under the
 * node key (`devices/device-token.ts`) before anything leaves the process, so
 * SQL, the command ledger and every error only ever see its hash and
 * ciphertext. Nothing here logs, and no result carries the token: the doors
 * answer `{deviceId, device}` from `internal.device_json`, which has no token
 * field.
 *
 * Human-only on all three: `humanOnly` in the catalog ⇔ wrapped below (the
 * human-auth-kinds registration test holds that), and `require_human_auth_kind`
 * again in SQL, so an agent is refused twice.
 */
import {
  CollabError,
  DevicesRegisterInputSchema,
  DevicesUnregisterInputSchema,
  DevicesUpdateInputSchema,
} from '@tm8/contract';
import type { DeviceWriteResult, DevicesUnregisterResult } from '@tm8/contract';

import { loadOrCreateCredentialKey } from '../../../credentials/credential-key.js';
import type { DbClaims } from '../../../db/types.js';
import { sealDeviceToken, type SealedDeviceToken } from '../../../devices/device-token.js';
import type { OperationHandler, RequestContext } from '../../../http/types.js';
import { claimsFor, commandEnvelope } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { requireHumanSession } from './credentials.js';

export interface DeviceHandlerOptions {
  /** The node data directory: where the credential key lives (`credential-key.ts`). */
  readonly dataDir: string;
}

function deviceIdParam(ctx: RequestContext): string {
  const value = ctx.params.deviceId;
  if (!value) throw new CollabError('invalid_input', 'deviceId is required');
  return value;
}

export class W2DevicesService {
  constructor(
    private readonly deps: FacadeDeps,
    private readonly options: DeviceHandlerOptions,
  ) {}

  private async writeClaims(ctx: RequestContext): Promise<DbClaims> {
    return claimsFor(await this.deps.owner(), ctx, commandEnvelope(ctx));
  }

  /**
   * Seal for the identity the transaction binds: the SQL door stores the row
   * under `tm8.identity_id`, which is `claims.identityId`, so the AAD and the
   * row's owner are the same value by construction.
   */
  private async seal(claims: DbClaims, token: string): Promise<SealedDeviceToken> {
    if (!claims.identityId) throw new CollabError('unauthenticated', 'authentication is required');
    return sealDeviceToken(await loadOrCreateCredentialKey(this.options.dataDir), claims.identityId, token);
  }

  readonly register: OperationHandler = async (ctx): Promise<DeviceWriteResult> => {
    const input = DevicesRegisterInputSchema.parse(ctx.body);
    const claims = await this.writeClaims(ctx);
    const sealed = await this.seal(claims, input.token);
    return this.deps.db.rpc<DeviceWriteResult>(claims, 'register_device', [
      input.platform, input.relay,
      sealed.tokenHash, sealed.ciphertext, sealed.nonce,
      input.appVersion, input.locale, input.previews ?? null, input.label,
      input.quietUntil ?? null,
      input.clientMutationId,
    ]);
  };

  readonly update: OperationHandler = async (ctx): Promise<DeviceWriteResult> => {
    const input = DevicesUpdateInputSchema.parse(ctx.body);
    const deviceId = deviceIdParam(ctx);
    const claims = await this.writeClaims(ctx);
    const sealed = input.token === undefined ? undefined : await this.seal(claims, input.token);
    return this.deps.db.rpc<DeviceWriteResult>(claims, 'update_device', [
      deviceId, input.expectedVersion,
      sealed?.tokenHash ?? null, sealed?.ciphertext ?? null, sealed?.nonce ?? null,
      input.appVersion ?? null, input.locale ?? null, input.previews ?? null, input.label ?? null,
      // quietUntil: absent keeps it, null clears it — so SQL gets the presence apart.
      input.quietUntil !== undefined, input.quietUntil ?? null,
      input.clientMutationId,
    ]);
  };

  readonly unregister: OperationHandler = async (ctx): Promise<DevicesUnregisterResult> => {
    const input = DevicesUnregisterInputSchema.parse(ctx.body ?? {});
    return this.deps.db.rpc<DevicesUnregisterResult>(await this.writeClaims(ctx), 'unregister_device', [
      deviceIdParam(ctx), input.expectedVersion ?? null, input.clientMutationId,
    ]);
  };
}

/** Registration. All three are human-only (catalog `humanOnly` ⇔ wrapped here). */
export function registerW2DeviceHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  options: DeviceHandlerOptions,
): void {
  const service = new W2DevicesService(deps, options);
  registry.registerAll({
    'devices.register': requireHumanSession(service.register),
    'devices.update': requireHumanSession(service.update),
    'devices.unregister': requireHumanSession(service.unregister),
  });
}
