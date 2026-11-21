import type { VaultCallApiResult } from '@tm8/contract';
import { VaultError, type ItemRecord, type PolicyRecord, type SecretVersionRecord, type VaultHandler } from '../core-types.js';
import { decryptSecretVersion } from '../crypto/aead.js';
import { KmsRefusedError, KmsUnavailableError } from '../crypto/kms.js';
import { SecretMaterial } from '../secret-material.js';
import { EgressRefusal, type ApiRequestSpec, type ApiResponseOutcome, type BrokerPolicy } from '../types.js';
import {
  alert, approvalRequested, audit, consumeApproval, hashIntent, liveGrants, liveItem,
  metadataText, refuseCanaryInput, replay, requestApproval, reserve, storedResult,
  transaction, usableApproval, useParams, type ActionIntent,
} from './common.js';

/** Parsing for approval display and grant selection only. The executor is the sole validator. */
function destination(request: ApiRequestSpec): { host: string; path: string } | null {
  let url: URL;
  try { url = new URL(request.url); } catch { return null; }
  return { host: url.hostname, path: url.pathname };
}

export const callApi: VaultHandler<'vault.callApi'> = async (ctx, { params, input }) => {
  ctx.audit.assertHealthy();
  await refuseCanaryInput(ctx, input, params.itemId);
  metadataText(ctx, input.purpose);
  const request: ApiRequestSpec = { method: input.request.method, url: input.request.url,
    ...(input.request.headers === undefined ? {} : { headers: input.request.headers }),
    ...(input.request.body === undefined ? {} : { body: input.request.body.kind === 'json'
      ? { kind: 'json', value: input.request.body.value } : input.request.body }) };
  const intent: ActionIntent = { kind: 'call_api', itemId: params.itemId, operationId: input.operationId,
    intentHash: hashIntent({ action: 'call_api', itemId: params.itemId, request: input.request, purpose: input.purpose }) };
  const prepared = await transaction(ctx, async (tx) => {
    const previous = await tx.operations.get(input.operationId);
    if (previous) return { result: storedResult('vault.callApi', replay(previous, intent)) };
    const item = await liveItem(tx, params.itemId, 'api_key');
    const grants = await liveGrants(tx, ctx, item);
    const storedPolicy = await tx.policies.get(item.id);
    let policy: BrokerPolicy | null = storedPolicy ? { ...storedPolicy, keyId: item.id } : null;
    if (policy && ctx.config.mode === 'pre_review') {
      policy = { ...policy, hosts: policy.hosts.filter((host) => ctx.config.preReview.allowedApiHosts.includes(host)) };
    }
    if (policy && grants !== null) {
      policy = { ...policy, hosts: policy.hosts.filter((host) => grants.some((grant) =>
        grant.constraints.hosts === null || grant.constraints.hosts.includes(host))) };
    }
    if (policy && policy.hosts.length === 0 && ctx.config.mode === 'pre_review') {
      throw VaultError.reason('pre_review_limit');
    }
    let code: Extract<VaultCallApiResult, { state: 'refused' }>['code'] | null = policy === null ? 'policy_missing' : null;
    const parsed = destination(request);
    const host = parsed?.host ?? null;
    const eligible = grants?.filter((grant) => grant.constraints.hosts === null || (host !== null && grant.constraints.hosts.includes(host))) ?? null;
    if (eligible !== null && eligible.length === 0) code = 'grant_constraint';
    const bound = { ...useParams(ctx, item.id, 'call_api', intent.intentHash),
      host, method: input.request.method, path: parsed?.path ?? null };
    if (parsed) metadataText(ctx, parsed.path);
    const needUse = eligible !== null && eligible.length > 0 && eligible.every((grant) => grant.constraints.requireApprovalPerUse);
    const approval = needUse && code === null ? await usableApproval(tx, item.id, 'use', bound) : null;
    const already = await reserve(tx, ctx, item, intent, { method: input.request.method,
      policyVersion: policy?.version ?? null }, approval?.id ?? null);
    if (already) return { result: storedResult('vault.callApi', already) };
    if (code !== null) {
      const result: VaultCallApiResult = { state: 'refused', operationId: input.operationId, itemId: item.id, code };
      await tx.operations.complete(input.operationId, { state: 'refused', result });
      await audit(tx, ctx, 'api.refused', item, { operationId: input.operationId, code });
      return { result, item, refused: true };
    }
    if (needUse && approval === null) {
      const requested = await requestApproval(tx, ctx, item, 'use', bound, { purpose: input.purpose, operationId: input.operationId });
      const result: VaultCallApiResult = { state: 'approval_required', operationId: input.operationId, itemId: item.id,
        approvalId: requested.approval.id, approvalKind: 'use' };
      await tx.operations.complete(input.operationId, { state: 'approval_required', result, approvalId: requested.approval.id });
      await audit(tx, ctx, 'api.refused', item, { operationId: input.operationId, code: 'approval_required' });
      return { result, item, requested: requested.created ? requested.approval : undefined };
    }
    const secret = await tx.items.currentSecret(item.id);
    if (!secret || !policy) throw VaultError.reason('vault_unavailable');
    if (approval) await consumeApproval(tx, ctx, item, approval, input.operationId);
    return { item, secret, policy };
  });
  if ('result' in prepared && prepared.result) {
    if ('requested' in prepared && prepared.requested && prepared.item) approvalRequested(ctx, prepared.item, prepared.requested);
    if ('refused' in prepared && prepared.refused && prepared.item && prepared.result.state === 'refused') {
      alert(ctx, 'egress_refused', prepared.item, { operationId: input.operationId, code: prepared.result.code });
    }
    return { data: prepared.result };
  }
  const { item, secret, policy } = prepared as { item: ItemRecord; secret: SecretVersionRecord; policy: BrokerPolicy };
  let material: SecretMaterial | undefined;
  let response: ApiResponseOutcome | undefined;
  let refusal: EgressRefusal | undefined;
  let unavailable = false;
  try {
    material = await decryptSecretVersion(ctx.components.kms, secret, { itemId: item.id, ownerId: item.ownerMemberId, version: secret.version });
    response = await ctx.components.egress.execute({ operationId: input.operationId, policy, key: material,
      request, canaries: ctx.components.canaries, signal: ctx.signal });
  } catch (error) {
    unavailable = error instanceof KmsUnavailableError || error instanceof KmsRefusedError;
    refusal = error instanceof EgressRefusal ? error : new EgressRefusal(ctx.signal.aborted ? 'timeout' : 'upstream_unreachable');
  } finally {
    material?.dispose();
  }
  const result: VaultCallApiResult = response !== undefined
    ? { state: 'done', operationId: input.operationId, itemId: item.id, response }
    : { state: 'refused', operationId: input.operationId, itemId: item.id, code: refusal!.code };
  const canary = refusal?.code === 'canary_in_request'
    || (response?.body.kind === 'withheld' && response.body.reason === 'canary');
  await transaction(ctx, async (tx) => {
    // Upstream content, including response headers, is never persisted in the ledger.
    const stored = result.state === 'done' ? { ...result,
      response: { ...result.response, headers: {}, body: { kind: 'withheld', reason: 'replayed' } } } : result;
    await tx.operations.complete(input.operationId, { state: result.state, result: stored });
    await audit(tx, ctx, result.state === 'done' ? 'api.done' : 'api.refused', item,
      { operationId: input.operationId, ...(result.state === 'done' ? { status: result.response.status } : { code: result.code }) });
    if (canary) await audit(tx, ctx, 'canary.detected', item, { operationId: input.operationId,
      source: refusal ? 'egress_request' : 'egress_response' });
  });
  if (refusal) alert(ctx, 'egress_refused', item, { operationId: input.operationId, code: refusal.code });
  if (canary) alert(ctx, 'canary_detected', item, { operationId: input.operationId,
    source: refusal ? 'egress_request' : 'egress_response' });
  if (unavailable) throw VaultError.reason('kms_unavailable');
  return { data: result };
};
