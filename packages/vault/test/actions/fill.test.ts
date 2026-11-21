import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AGENT_ACTION_OPS, actorOf } from '../../src/core-types.js';
import { otherCaller, RecordingAlertSink, scopeOf, testCaller } from '../support/kit.js';
import { NEW_ORIGIN, ORIGIN, apiKey, approve, events, fillInput, handlers, harness, invoke, login, share } from './fixtures.js';

describe('agent fills', () => {
  it('covers the complete 9-operation partition', () => {
    expect(Object.keys(handlers).sort()).toEqual([...AGENT_ACTION_OPS].sort());
  });

  it('hands the driver only the password, propagates the signal, and disposes material', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    const signal = new AbortController().signal;
    const input = fillInput();
    const result = await invoke(broker, 'vault.fill', { itemId: item.id }, input, { signal });
    expect(result.data.state).toBe('done');
    expect(fill).toHaveBeenCalledTimes(1);
    const received = fill.mock.calls[0]![0];
    expect(received.signal).toBe(signal);
    expect(received.material.password.disposed).toBe(true);
    expect(received.material.totp).toBeNull();
    expect(received.intent.origin).toBe(ORIGIN);
    expect(JSON.stringify(result)).not.toContain('test-only');
    expect((await events(broker)).map((event) => event.action)).toEqual(['fill.started', 'fill.done']);
  });

  it('test 5: consumes one-use origin approval, never adds the origin, and asks again for the next use', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    const first = fillInput({ origin: NEW_ORIGIN });
    const { data: requested } = await invoke(broker, 'vault.fill', { itemId: item.id }, first);
    if (requested.state !== 'approval_required') throw new Error('expected approval');
    expect(fill).not.toHaveBeenCalled();
    const { data: approved } = await approve(broker, requested.approvalId);
    expect(approved.boundParams).toMatchObject({ kind: 'new_origin', itemId: item.id,
      origin: NEW_ORIGIN, requesterMemberId: testCaller.memberId, expiresAt: approved.expiresAt });
    const use = fillInput({ origin: NEW_ORIGIN });
    expect((await invoke(broker, 'vault.fill', { itemId: item.id }, use)).data.state).toBe('done');
    expect((await invoke(broker, 'vault.approvals.get', { approvalId: approved.id }, {})).data.state).toBe('consumed');
    const stored = await broker.store.transaction(scopeOf(testCaller), (tx) => tx.items.get(item.id));
    expect(stored!.origins).toEqual([ORIGIN]);
    expect((await invoke(broker, 'vault.fill', { itemId: item.id }, first)).data).toEqual(requested);
    expect((await invoke(broker, 'vault.fill', { itemId: item.id }, use)).data.state).toBe('done');
    const { data: second } = await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput({ origin: NEW_ORIGIN }));
    expect(second.state).toBe('approval_required');
    if (second.state === 'approval_required') expect(second.approvalId).not.toBe(approved.id);
    expect(fill).toHaveBeenCalledTimes(1);
    expect((await events(broker)).filter((event) => event.action === 'approval.consumed')).toHaveLength(1);
  });

  it.each(['https://sub.login.example.test', 'https://logln.example.test'])('never fills an unbound subdomain or lookalike: %s', async (origin) => {
    const { broker, fill } = harness();
    const item = await login(broker);
    expect((await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput({ origin }))).data.state).toBe('approval_required');
    expect(fill).not.toHaveBeenCalled();
  });

  it('refuses a different start URL origin before reservation', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    const input = fillInput({ startUrl: `${NEW_ORIGIN}/login?test=metadata` });
    await expect(invoke(broker, 'vault.fill', { itemId: item.id }, input)).rejects.toMatchObject({ reason: 'origin_refused' });
    expect(fill).not.toHaveBeenCalled();
    expect(await broker.store.transaction(scopeOf(testCaller), (tx) => tx.operations.get(input.operationId))).toBeNull();
  });

  it('enforces the current pre-review exact-origin allowlist even after approval', async () => {
    const { broker, fill } = harness({ config: { mode: 'pre_review', preReview: {
      maxItemsPerMember: 20, allowedFillOrigins: [NEW_ORIGIN], allowedApiHosts: [] } } });
    const item = await login(broker);
    const { data } = await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput({ origin: NEW_ORIGIN }));
    if (data.state !== 'approval_required') throw new Error('expected approval');
    await approve(broker, data.approvalId);
    broker.config.preReview.allowedFillOrigins = [ORIGIN];
    const input = fillInput({ origin: NEW_ORIGIN });
    await expect(invoke(broker, 'vault.fill', { itemId: item.id }, input)).rejects.toMatchObject({ reason: 'pre_review_limit' });
    expect(fill).not.toHaveBeenCalled();
    expect(await broker.store.transaction(scopeOf(testCaller), (tx) => tx.operations.get(input.operationId))).toBeNull();
  });

  it('treats an expired approved origin as unusable before the sweeper runs', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    const { data } = await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput({ origin: NEW_ORIGIN }));
    if (data.state !== 'approval_required') throw new Error('expected approval');
    await approve(broker, data.approvalId);
    broker.clock.advanceSeconds(16 * 60);
    const next = await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput({ origin: NEW_ORIGIN }));
    expect(next.data.state).toBe('approval_required');
    if (next.data.state === 'approval_required') expect(next.data.approvalId).not.toBe(data.approvalId);
    expect(fill).not.toHaveBeenCalled();
  });

  it('alerts on three consecutive actual failures, resets after success, and excludes replays', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    fill.mockResolvedValue({ ok: false, code: 'fields_not_found', observedOrigin: ORIGIN, screenshot: null });
    const first = fillInput();
    await invoke(broker, 'vault.fill', { itemId: item.id }, first);
    await invoke(broker, 'vault.fill', { itemId: item.id }, first);
    await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput());
    expect((broker.components.alerts as RecordingAlertSink).kinds()).not.toContain('fill_repeated_failures');
    await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput());
    await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput());
    expect((await events(broker)).filter((event) => event.action === 'fill.repeated_failures')).toHaveLength(1);
    fill.mockResolvedValueOnce({ ok: true, finalOrigin: ORIGIN, submitted: false, screenshot: null });
    await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput());
    for (let i = 0; i < 3; i++) await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput());
    expect((await events(broker)).filter((event) => event.action === 'fill.repeated_failures')).toHaveLength(2);
    expect((broker.components.alerts as RecordingAlertSink).kinds().filter((kind) => kind === 'fill_repeated_failures')).toHaveLength(2);
  });

  it('test 12 at use: a revoked grant refuses the next fill', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    const grant = await share(broker, item.id, otherCaller);
    await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput(), { caller: otherCaller });
    await broker.store.transaction(scopeOf(testCaller), (tx) => tx.grants.revoke(grant.id, actorOf(testCaller)));
    await expect(invoke(broker, 'vault.fill', { itemId: item.id }, fillInput(), { caller: otherCaller })).rejects.toMatchObject({ code: 'not_found' });
    expect(fill).toHaveBeenCalledTimes(1);
  });

  it('checks grant expiry at use and refuses a grant origin constraint', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    await share(broker, item.id, otherCaller, { origins: [NEW_ORIGIN], hosts: null, requireApprovalPerUse: false }, broker.clock.iso(1000));
    const refused = await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput(), { caller: otherCaller });
    expect(refused.data).toMatchObject({ state: 'refused', code: 'grant_constraint' });
    broker.clock.advanceSeconds(2);
    await expect(invoke(broker, 'vault.fill', { itemId: item.id }, fillInput(), { caller: otherCaller })).rejects.toMatchObject({ code: 'not_found' });
    expect(fill).not.toHaveBeenCalled();
  });

  it('binds per-use approvals to the complete fill intent', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    await share(broker, item.id, otherCaller, { origins: null, hosts: null, requireApprovalPerUse: true });
    const original = fillInput();
    const { data } = await invoke(broker, 'vault.fill', { itemId: item.id }, original, { caller: otherCaller });
    if (data.state !== 'approval_required') throw new Error('expected approval');
    expect(data.approvalKind).toBe('use');
    await approve(broker, data.approvalId);
    const changed = await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput({ submit: true }), { caller: otherCaller });
    expect(changed.data.state).toBe('approval_required');
    expect((await invoke(broker, 'vault.fill', { itemId: item.id }, { ...original, operationId: randomUUID() }, { caller: otherCaller })).data.state).toBe('done');
    expect(fill).toHaveBeenCalledTimes(1);
  });

  it('refuses blocked items and the wrong item type without reserving', async () => {
    const { broker, fill } = harness();
    const blocked = await login(broker, { state: 'blocked_until_rotated' });
    const key = await apiKey(broker);
    await expect(invoke(broker, 'vault.fill', { itemId: blocked.id }, fillInput())).rejects.toMatchObject({ reason: 'item_blocked' });
    await expect(invoke(broker, 'vault.fill', { itemId: key.id }, fillInput())).rejects.toMatchObject({ reason: 'wrong_item_type' });
    expect(fill).not.toHaveBeenCalled();
    expect(await events(broker)).toEqual([]);
  });

  it('does not propagate driver exceptions and strips query strings from observed origins', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    fill.mockRejectedValueOnce(new Error('test-only private driver error'));
    const failed = await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput());
    expect(JSON.stringify(failed)).not.toContain('private driver');
    expect(fill.mock.calls[0]![0].material.password.disposed).toBe(true);
    fill.mockResolvedValueOnce({ ok: false, code: 'cross_origin_redirect', observedOrigin: `${NEW_ORIGIN}/page?private=test-only`, screenshot: null });
    const redirected = await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput());
    expect(redirected.data).toMatchObject({ state: 'refused', observedOrigin: NEW_ORIGIN });
    expect(JSON.stringify(await events(broker))).not.toContain('?private');
  });
});
