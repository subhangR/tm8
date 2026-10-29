// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildSpawnInput, type LaunchPluginFacts } from '../domain/launch';
import { useLaunchComposerState } from './useLaunchComposerState';

/*
 * F3 (design 01a0d348 §3.5) through the hook both composer hosts share: the
 * plugin facts are read for the teammate AND the launch's tasks, and a plugin
 * tick reaches the node as the whole exact skills set — never one that drops
 * an equipped skill.
 */
describe('useLaunchComposerState — plugin picks (F3)', () => {
  const teammates = [{ id: 'tm-1', name: 'Ada', initial: 'A', model: 'claude-opus-5', agentTool: 'claude-code', owner: '' }];
  const facts: LaunchPluginFacts = {
    installed: ['mcp-only@x', 'sales@synced'],
    pluginSkills: { defaults: ['task-skill', 'persona-skill'], byPlugin: { 'sales@synced': ['sales-a'] } },
  };

  it('reads the facts for the launch’s tasks and sends defaults ∪ the plugin’s skills', async () => {
    const load = vi.fn(async () => facts);
    const { result } = renderHook(() => useLaunchComposerState({
      teammates, projects: [], loadInstalledPlugins: load, taskIds: ['task-1'],
    }));
    await waitFor(() => expect(result.current.bind.installedPlugins).toEqual(facts.installed));
    expect(load).toHaveBeenCalledWith('tm-1', ['task-1']);
    expect(result.current.bind.pluginSkillCounts).toEqual({ 'sales@synced': 1 });

    act(() => result.current.bind.onPluginsChange?.(['mcp-only@x', 'sales@synced']));
    const input = buildSpawnInput({ clientMutationId: 'c', spaceId: 's', config: result.current.config });
    expect(input.selection).toEqual({ skillIds: ['task-skill', 'persona-skill', 'sales-a'] });
    expect(input.plugins).toEqual(['mcp-only@x']);
  });

  it('reads nothing while the plugin facts are not wanted yet, and reads them once they are', async () => {
    const load = vi.fn(async () => facts);
    const { result, rerender } = renderHook(({ wanted }) => useLaunchComposerState({
      teammates, projects: [], loadInstalledPlugins: load, taskIds: ['task-1'], pluginsWanted: wanted,
    }), { initialProps: { wanted: false } });
    await act(async () => { await Promise.resolve(); });
    expect(load).not.toHaveBeenCalled();
    rerender({ wanted: true });
    await waitFor(() => expect(result.current.bind.installedPlugins).toEqual(facts.installed));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('holds Launch only while a TICKED plugin’s facts are still being read', async () => {
    let land: ((f: LaunchPluginFacts) => void) | null = null;
    const load = vi.fn(() => new Promise<LaunchPluginFacts>((resolve) => { land = resolve; }));
    const { result } = renderHook(() => useLaunchComposerState({
      teammates, projects: [], loadInstalledPlugins: load, taskIds: ['task-1'], pluginsWanted: true,
    }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(result.current.more.pluginsBlock).toBeNull(); // nothing ticked: an untouched row never holds a launch
    act(() => result.current.bind.onPluginsChange?.(['sales@synced']));
    expect(result.current.more.pluginsBlock).toBe('Reading plugins…');
    await act(async () => { land!(facts); });
    expect(result.current.more.pluginsBlock).toBeNull();
    const input = buildSpawnInput({ clientMutationId: 'c', spaceId: 's', config: result.current.config });
    expect(input.selection).toEqual({ skillIds: ['task-skill', 'persona-skill', 'sales-a'] });
  });

  it('with no plugin→skill facts the pick rides `plugins` whole, as before', async () => {
    const load = vi.fn(async () => ({ installed: facts.installed }));
    const { result } = renderHook(() => useLaunchComposerState({ teammates, projects: [], loadInstalledPlugins: load }));
    await waitFor(() => expect(result.current.bind.installedPlugins).toEqual(facts.installed));
    act(() => result.current.bind.onPluginsChange?.(['sales@synced']));
    const input = buildSpawnInput({ clientMutationId: 'c', spaceId: 's', config: result.current.config });
    expect(input.plugins).toEqual(['sales@synced']);
    expect(input).not.toHaveProperty('selection');
  });
});
