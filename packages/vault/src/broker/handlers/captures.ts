import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { VAULT_CAPTURE_LINK_TTL_SECONDS, VAULT_MAX_CAPTURE_CIPHERTEXT } from '@tm8/contract';
import { memberScope, VaultError, type HandlersFor, type VaultTx, type HandlerContext, type CaptureLinkRecord } from '../../core-types.js';
import { CaptureSealError } from '../../capture/seal.js';
import { CapturePayloadError, parseCapturePayload } from '../../capture/payload.js';
import { encryptSecretVersion } from '../../crypto/aead.js';
import { SecretMaterial } from '../../secret-material.js';
import { appendAudit, assertOwnerSession, assertPreReviewCapacity, getItem, itemView, metadataFields, scanItemMetadata, scanMetadata } from './shared.js';

type CaptureOp = 'vault.captureLinks.create' | 'vault.captures.open' | 'vault.captures.submit';
const tokenHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

async function usable(ctx: HandlerContext, tx: VaultTx, captureId: string, token: string): Promise<CaptureLinkRecord> {
  const link = await tx.captureLinks.getUsable(captureId, tokenHash(token));
  if (!link) throw VaultError.reason('capture_link_invalid');
  if (link.captureKid !== ctx.components.captureKeys.kid) throw VaultError.reason('capture_key_rotated');
  return link;
}

/** Commits refusal evidence separately, so throwing does not roll the refusal audit back. */
async function captureCall<T>(ctx: HandlerContext, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (error) {
    if (error instanceof VaultError && (error.reason === 'capture_link_invalid' || error.reason === 'capture_key_rotated')) {
      await ctx.store.transaction(memberScope(ctx.caller), (tx) => appendAudit(ctx, tx, 'capture.link_refused', null, { reason: error.reason }));
    }
    throw error;
  }
}

export function createCaptureHandlers(): HandlersFor<CaptureOp> {
  return {
    'vault.captureLinks.create': async (ctx, { input }) => {
      if (!ctx.config.features.capture) throw VaultError.reason('vault_disabled');
      scanMetadata(ctx, [input.name]);
      const id = randomUUID();
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(ctx.clock.now().getTime() + VAULT_CAPTURE_LINK_TTL_SECONDS * 1000).toISOString();
      await ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        if (input.purpose === 'replace') {
          const item = await getItem(ctx, tx, input.itemId!, true);
          if (item.type !== input.itemType) throw VaultError.reason('wrong_item_type');
        }
        await tx.captureLinks.create({ id, itemType: input.itemType, purpose: input.purpose, itemId: input.itemId?.toLowerCase() ?? null,
          name: input.name ?? null, tokenHash: tokenHash(token), captureKid: ctx.components.captureKeys.kid,
          expiresAt, createdBy: { ...ctx.actor, name: null } });
        await appendAudit(ctx, tx, 'capture.link_created', input.itemId ?? null, { purpose: input.purpose, itemType: input.itemType });
      });
      return { data: { captureId: id, url: `${ctx.config.publicOrigin}/vault/capture/${id}#t=${token}`, itemType: input.itemType, purpose: input.purpose, expiresAt } };
    },
    'vault.captures.open': async (ctx, { params, input }) => {
      assertOwnerSession(ctx);
      return captureCall(ctx, () => ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        const link = await usable(ctx, tx, params.captureId, input.linkToken);
        await tx.captureLinks.markOpened(link.id);
        return { data: { captureId: link.id, itemType: link.itemType, purpose: link.purpose, itemId: link.itemId,
          itemName: link.name, expiresAt: link.expiresAt, publicKey: ctx.components.captureKeys.publicKey(), maxCiphertextBytes: VAULT_MAX_CAPTURE_CIPHERTEXT } };
      }));
    },
    'vault.captures.submit': async (ctx, { params, input }) => {
      assertOwnerSession(ctx, true);
      return captureCall(ctx, () => ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        const link = await usable(ctx, tx, params.captureId, input.linkToken);
        let plaintext: SecretMaterial | null = null;
        let parsed: ReturnType<typeof parseCapturePayload> | null = null;
        try {
          plaintext = SecretMaterial.adopt(ctx.components.captureKeys.open(input.sealed, link.id));
          parsed = plaintext.use((bytes) => parseCapturePayload(bytes, link.itemType));
          scanItemMetadata(ctx, parsed.metadata);
          const existing = link.purpose === 'replace' ? await getItem(ctx, tx, link.itemId!, true) : null;
          if (existing && existing.type !== link.itemType) throw VaultError.reason('wrong_item_type');
          // A rotation changes the value and its metadata; origin/dev-mode changes have their own step-up door.
          if (existing && (Boolean(parsed.metadata.devMode) !== existing.devMode
            || (parsed.metadata.origin !== undefined && !existing.origins.includes(parsed.metadata.origin)))) throw VaultError.reason('origin_refused');
          if (!existing) await assertPreReviewCapacity(ctx, tx, 1);
          const id = existing?.id ?? randomUUID();
          const secret = await encryptSecretVersion(ctx.components.kms, parsed.secret,
            { itemId: id, ownerId: ctx.caller.memberId, version: (existing?.secretVersion ?? 0) + 1 });
          if (ctx.signal.aborted) throw VaultError.reason('vault_unavailable');
          if (!await tx.captureLinks.consume(link.id, tokenHash(input.linkToken))) throw VaultError.reason('capture_link_invalid');
          const fields = metadataFields(parsed.metadata);
          const item = existing ? await tx.items.replaceSecret(id, existing.version, secret, fields)
            : await tx.items.create({ id, ...fields, type: link.itemType, state: 'active', exposureTier: null,
              origins: parsed.metadata.origin ? [parsed.metadata.origin] : [], devMode: parsed.metadata.devMode ?? false,
              createdBy: { ...ctx.actor, name: null } }, secret);
          await appendAudit(ctx, tx, existing ? 'item.replaced' : 'item.captured', id, { type: item.type, secretVersion: item.secretVersion });
          return { data: await itemView(ctx, tx, item) };
        } catch (error) {
          if (error instanceof CaptureSealError) {
            if (error.code === 'unknown_kid') throw VaultError.reason('capture_key_rotated');
            throw new VaultError(error.code === 'too_large' ? 'payload_too_large' : 'invalid_input');
          }
          if (error instanceof CapturePayloadError) {
            if (error.code === 'origin_refused') throw VaultError.reason('origin_refused');
            if (error.code === 'type_mismatch') throw VaultError.reason('wrong_item_type');
            throw new VaultError('invalid_input');
          }
          throw error;
        } finally {
          parsed?.secret.dispose();
          plaintext?.dispose();
        }
      }));
    },
  };
}
