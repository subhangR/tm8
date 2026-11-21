import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollabError, type EntityId } from '@tm8/contract';
import { loadTaskAccess, readAccess, repositoryLabel } from './load';
import { CREDENTIAL, PROJECT, RUN, TASK, edge, projectPeer, record, seamFor, session, task } from './test-kit';

afterEach(() => vi.useRealTimers());

describe('task access reads', () => {
  it('uses effective launch sources and exact pins, with current gated metadata and no secret fields', async () => {
    const h = seamFor();
    const result = await loadTaskAccess(h.seam, TASK);
    expect(h.entity).toHaveBeenCalledWith(TASK);
    expect(result.capabilities.canEdit).toBe(true);
    expect(result.projects[0]).toEqual({ id: PROJECT, title: 'App', repoUrl: 'https://example.com/app.git', workingDir: null });
    expect(result.runs[0]).toMatchObject({ accessMode: 'plan', accessModeSource: 'inherited', workingDirectory: '/worktrees/run',
      credentials: [{ provider: 'github', source: 'space', pinned: true, credential: { id: CREDENTIAL, label: 'Git a***@example.com' } }] });
    const serialized = JSON.stringify(result);
    for (const value of ['MANIFEST_SECRET', 'PROMPT_SECRET', 'ENV_SECRET', 'KEY_HINT_SECRET', 'PRIVATE_PASSWORD', 'PRIVATE_QUERY', 'alice@example.com', 'CURRENT_DEFAULT_MUST_NOT_BE_USED', 'Do not trust snapshot name']) expect(serialized).not.toContain(value);
    expect(result.issues).toEqual([]);
  });

  it('reads every typed page and deduplicates sessions and projects', async () => {
    const h = seamFor();
    const second = session('session-page-2' as EntityId);
    h.connections.mockImplementation(async (_id, opts) => ({
      items: opts?.direction === 'incoming'
        ? opts?.cursor ? [edge(session(), task()), edge(second, task())] : [edge(session(), task())]
        : [edge(task(), projectPeer)],
      nextCursor: !opts?.cursor ? 'next-page' : null,
    }));
    const result = await loadTaskAccess(h.seam, TASK);
    expect(result.runs.map((row) => row.session.id)).toEqual([RUN, second.id]);
    expect(result.projects).toHaveLength(1);
    expect(h.connections.mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining([
      expect.objectContaining({ types: ['working_on'], direction: 'incoming', cursor: 'next-page' }),
      expect.objectContaining({ types: ['in_project'], direction: 'outgoing', cursor: 'next-page' }),
    ]));
  });

  it('preserves successful pages and other groups when a later page is forbidden', async () => {
    const h = seamFor();
    h.connections.mockImplementation(async (_id, opts) => {
      if (opts?.cursor) throw new CollabError('forbidden', 'DO_NOT_RENDER_ERROR_PAYLOAD');
      return { items: opts?.direction === 'incoming' ? [edge(session(), task())] : [edge(task(), projectPeer)], nextCursor: opts?.direction === 'incoming' ? 'unreadable-page' : null };
    });
    const result = await loadTaskAccess(h.seam, TASK);
    expect(result.runs).toHaveLength(1);
    expect(result.projects).toHaveLength(1);
    expect(result.issues).toContain('Run links are incomplete.');
    expect(h.connections.mock.calls.filter((call) => call[1]?.cursor)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('DO_NOT_RENDER_ERROR_PAYLOAD');
  });

  it('does not treat repeated cursors as a complete or infinite read', async () => {
    const h = seamFor();
    h.connections.mockResolvedValue({ items: [], nextCursor: 'repeated' });
    const result = await loadTaskAccess(h.seam, TASK);
    expect(h.connections).toHaveBeenCalledTimes(4);
    expect(result.issues).toEqual(['Project links are incomplete.', 'Run links are incomplete.']);
  });

  it('keeps a run visible with unknown fields when its manifest is absent or old', async () => {
    const h = seamFor();
    h.launch.mockResolvedValue(record({ available: false, unavailableReason: 'no_manifest_row', manifest: null, connectorAccounts: undefined }));
    const result = await loadTaskAccess(h.seam, TASK);
    expect(result.runs[0]).toMatchObject({ available: false, accessMode: null, credentials: [], connectorAccounts: undefined });
    expect(h.credentialList).not.toHaveBeenCalled();
  });

  it('shows unknown account identities when only requested credential sources were recorded', async () => {
    const h = seamFor();
    h.launch.mockResolvedValue(record({ manifest: { launch: { credentialSources: { github: 'space' }, spaceCredentialIds: { github: CREDENTIAL } } } }));
    expect((await loadTaskAccess(h.seam, TASK)).runs[0]?.credentials).toEqual([]);
    expect(h.credentialList).not.toHaveBeenCalled();
  });

  it('limits concurrent launch reads to four', async () => {
    const h = seamFor();
    h.connections.mockImplementation(async (_id, opts) => ({ items: opts?.direction === 'incoming'
      ? Array.from({ length: 9 }, (_, i) => edge(session(`run-${i}` as EntityId), task())) : [], nextCursor: null }));
    let active = 0; let maximum = 0;
    h.launch.mockImplementation(async () => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1)); active -= 1;
      return record({ manifest: null });
    });
    expect((await loadTaskAccess(h.seam, TASK)).runs).toHaveLength(9);
    expect(maximum).toBe(4);
  });

  it('refuses the whole reading if the task itself is no longer readable', async () => {
    const h = seamFor();
    h.entity.mockRejectedValue(new CollabError('forbidden', 'task unavailable'));
    await expect(loadTaskAccess(h.seam, TASK)).rejects.toMatchObject({ code: 'forbidden' });
    expect(h.connections).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
  });
});

describe('access read recovery', () => {
  it('retries a wire upstream_unavailable once', async () => {
    const read = vi.fn().mockRejectedValueOnce(new CollabError('upstream_unavailable', 'wire unavailable')).mockResolvedValue('recovered');
    expect(await readAccess(read, { retryDelayMs: 0 })).toBe('recovered');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(['forbidden', 'unauthenticated', 'version_conflict', 'invalid_input'] as const)('does not retry permanent %s even if retryable is incorrectly true', async (code) => {
    const read = vi.fn().mockRejectedValue(new CollabError(code, 'permanent', { retryable: true }));
    await expect(readAccess(read)).rejects.toMatchObject({ code });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('honors explicit non-retryable transient responses', async () => {
    const read = vi.fn().mockRejectedValue(new CollabError('upstream_unavailable', 'do not retry', { retryable: false }));
    await expect(readAccess(read)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('times out both attempts and releases all display timers', async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => new Promise<string>(() => {}));
    const outcome = readAccess(read, { timeoutMs: 10, retryDelayMs: 1 }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(25);
    expect(await outcome).toMatchObject({ code: 'access_timeout' });
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels timeout and retry waits when the task view closes', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const read = vi.fn().mockRejectedValue(new CollabError('upstream_unavailable', 'offline'));
    const outcome = readAccess(read, { signal: controller.signal }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect(await outcome).toMatchObject({ code: 'access_cancelled' });
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sanitizes repository URL credentials and rejects executable protocols', () => {
    expect(repositoryLabel('https://user:secret@example.com/repo?token=private#private')).toBe('https://example.com/repo');
    expect(repositoryLabel('git@example.com:org/repo.git')).toBe('git@example.com:org/repo.git');
    expect(repositoryLabel('javascript:alert(1)')).toBeNull();
  });
});
