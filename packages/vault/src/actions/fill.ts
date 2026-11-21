import type { VaultFillResult } from '@tm8/contract';
import { VaultError, type ApprovalRecord, type ItemRecord, type SecretVersionRecord, type VaultHandler, type VaultTx } from '../core-types.js';
import { decryptSecretVersion } from '../crypto/aead.js';
import { KmsRefusedError, KmsUnavailableError } from '../crypto/kms.js';
import { normalizeOrigin } from '../origin/normalize.js';
import { SecretMaterial } from '../secret-material.js';
import type { FillOutcome, MaskedScreenshot } from '../types.js';
import {
  alert, approvalRequested, audit, consumeApproval, exactOrigin, hashIntent, liveGrants, liveItem,
  lookalike, metadataText, originParams, refuseCanaryInput, replay, requestApproval, reserve,
  storedResult, transaction, usableApproval, useParams, type ActionIntent,
} from './common.js';

function screenshot(image: MaskedScreenshot | null): Extract<VaultFillResult, { state: 'done' }>['screenshot'] {
  return image === null ? null : { mime: image.mime, dataBase64: image.data.toString('base64'),
    width: image.width, height: image.height, maskedRegions: image.maskedRegions };
}

function observedOrigin(input: string | null, item: ItemRecord): string | null {
  if (input === null) return null;
  try { return normalizeOrigin(input, { devMode: item.devMode, allowPath: true }).origin; } catch { return null; }
}

/** The streak lives in the audit trail and is updated in the completing transaction. */
async function failureStreak(tx: VaultTx, itemId: string, origin: string): Promise<number> {
  const recent = await tx.audit.listForItem(itemId, '1970-01-01T00:00:00.000Z', 200);
  const last = recent.find((event) => (event.action === 'fill.done' || event.action === 'fill.refused')
    && event.params.origin === origin && event.params.attempted === true);
  return last?.action === 'fill.refused' && typeof last.params.consecutiveFailures === 'number'
    ? last.params.consecutiveFailures : 0;
}

export const fill: VaultHandler<'vault.fill'> = async (ctx, { params, input }) => {
  ctx.audit.assertHealthy();
  await refuseCanaryInput(ctx, input, params.itemId);
  metadataText(ctx, input.purpose);
  const intent: ActionIntent = { kind: 'fill', itemId: params.itemId, operationId: input.operationId,
    intentHash: hashIntent({ action: 'fill', itemId: params.itemId, origin: input.origin,
      startUrl: input.startUrl ?? null, submit: input.submit, purpose: input.purpose }) };
  const prepared = await transaction(ctx, async (tx) => {
    const previous = await tx.operations.get(input.operationId);
    if (previous) return { result: storedResult('vault.fill', replay(previous, intent, ctx.caller.spaceId)) };
    const item = await liveItem(tx, params.itemId, 'login');
    const grants = await liveGrants(tx, ctx, item);
    const origin = exactOrigin(input.origin, item);
    if (ctx.config.mode === 'pre_review' && !ctx.config.preReview.allowedFillOrigins.includes(origin)) {
      throw VaultError.reason('pre_review_limit');
    }
    if (input.startUrl !== undefined && observedOrigin(input.startUrl, item) !== origin) throw VaultError.reason('origin_refused');
    const eligible = grants?.filter((grant) => grant.constraints.origins === null || grant.constraints.origins.includes(origin)) ?? null;
    const constrained = eligible !== null && eligible.length === 0;
    const originBound = originParams(ctx, item.id, origin);
    const useBound = useParams(ctx, item.id, 'fill', intent.intentHash);
    const originApproval = !item.origins.includes(origin) && !constrained
      ? await usableApproval(tx, item.id, 'new_origin', originBound) : null;
    const needOrigin = !item.origins.includes(origin) && originApproval === null;
    // One unconstrained live grant is enough. Never combine two grants' constraints.
    const needUse = eligible !== null && eligible.length > 0 && eligible.every((grant) => grant.constraints.requireApprovalPerUse);
    const useApproval = needUse ? await usableApproval(tx, item.id, 'use', useBound) : null;
    const approvals = [originApproval, useApproval].filter((row): row is ApprovalRecord => row !== null);
    const secret = await tx.items.currentSecret(item.id);
    if (!secret) throw VaultError.reason('vault_unavailable');
    const already = await reserve(tx, ctx, item, intent, { origin, submit: input.submit }, approvals[0]?.id ?? null);
    if (already) return { result: storedResult('vault.fill', already) };
    if (constrained) {
      const result: VaultFillResult = { state: 'refused', operationId: input.operationId, itemId: item.id,
        code: 'grant_constraint', observedOrigin: null, screenshot: null };
      await tx.operations.complete(input.operationId, { state: 'refused', result });
      await audit(tx, ctx, 'fill.refused', item, { operationId: input.operationId, origin, code: result.code, attempted: false });
      return { result };
    }
    if (needOrigin || (needUse && useApproval === null)) {
      const kind = needOrigin ? 'new_origin' : 'use';
      const requested = await requestApproval(tx, ctx, item, kind, needOrigin ? originBound : useBound,
        { purpose: input.purpose, lookalike: needOrigin ? lookalike(origin, item) : [], operationId: input.operationId });
      const result: VaultFillResult = { state: 'approval_required', operationId: input.operationId, itemId: item.id,
        approvalId: requested.approval.id, approvalKind: kind, origin, lookalike: requested.approval.lookalike };
      await tx.operations.complete(input.operationId, { state: 'approval_required', result, approvalId: requested.approval.id });
      await audit(tx, ctx, 'fill.refused', item, { operationId: input.operationId, origin, code: 'approval_required', attempted: false });
      return { result, requested: requested.created ? requested.approval : undefined, item };
    }
    for (const approval of approvals) await consumeApproval(tx, ctx, item, approval, input.operationId);
    return { item, secret, origin };
  });
  if ('result' in prepared && prepared.result) {
    if ('requested' in prepared && prepared.requested && prepared.item) approvalRequested(ctx, prepared.item, prepared.requested);
    return { data: prepared.result };
  }
  const { item, secret, origin } = prepared as { item: ItemRecord; secret: SecretVersionRecord; origin: string };
  let material: SecretMaterial | undefined;
  let password: SecretMaterial | undefined;
  let outcome: FillOutcome;
  let unavailable = false;
  try {
    material = await decryptSecretVersion(ctx.components.kms, secret, { itemId: item.id, ownerId: item.ownerMemberId, version: secret.version });
    password = material.use((bytes) => {
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || !('password' in parsed) || typeof parsed.password !== 'string') {
        throw VaultError.reason('vault_unavailable');
      }
      return SecretMaterial.fromUtf8(parsed.password);
    });
    outcome = await ctx.components.fillDriver.fill({ intent: { operationId: input.operationId, itemId: item.id,
      origin, ...(input.startUrl === undefined ? {} : { startUrl: input.startUrl }), submit: input.submit, devMode: item.devMode },
      material: { username: item.username, password, totp: null }, signal: ctx.signal });
  } catch (error) {
    unavailable = error instanceof KmsUnavailableError || error instanceof KmsRefusedError;
    outcome = { ok: false, code: ctx.signal.aborted ? 'timeout' : 'browser_unavailable', observedOrigin: null, screenshot: null };
  } finally {
    password?.dispose();
    material?.dispose();
  }
  const finalOrigin = outcome.ok ? observedOrigin(outcome.finalOrigin, item) : observedOrigin(outcome.observedOrigin, item);
  const result: VaultFillResult = outcome.ok && finalOrigin === origin
    ? { state: 'done', operationId: input.operationId, itemId: item.id, finalOrigin: origin,
      submitted: outcome.submitted, screenshot: screenshot(outcome.screenshot) }
    : { state: 'refused', operationId: input.operationId, itemId: item.id,
      code: outcome.ok ? 'origin_mismatch' : outcome.code, observedOrigin: finalOrigin, screenshot: screenshot(outcome.screenshot) };
  const repeated = await transaction(ctx, async (tx) => {
    const streak = result.state === 'refused' ? await failureStreak(tx, item.id, origin) + 1 : 0;
    // Screenshot bytes are returned once. The operation ledger holds metadata only.
    await tx.operations.complete(input.operationId, { state: result.state, result: { ...result, screenshot: null } });
    await audit(tx, ctx, result.state === 'done' ? 'fill.done' : 'fill.refused', item,
      { operationId: input.operationId, origin, attempted: true, consecutiveFailures: streak,
        ...(result.state === 'refused' ? { code: result.code } : {}) });
    if (streak === 3) await audit(tx, ctx, 'fill.repeated_failures', item, { origin, count: 3 });
    return streak === 3;
  });
  if (repeated) alert(ctx, 'fill_repeated_failures', item, { origin, count: 3 });
  if (unavailable) throw VaultError.reason('kms_unavailable');
  return { data: result };
};
