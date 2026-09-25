// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { EntityId, SessionLaunchRecord } from '@tm8/contract';
import { fixtureDetails } from '../../fixtures';
import { LaunchContextSection } from './LaunchContextSection';
import { ConnectionsTab } from './tabs';

/**
 * The LAUNCH CONTEXT section: every selection that went into a session's
 * launch, drawn from the server's viewer-filtered projection. The assertions
 * are about what a reader must be able to trust: each row says where it came
 * from, what the viewer cannot read is a count and never a name, id-less
 * memories still show, and graph-authored text renders as text.
 */

const TEAMMATE = '01900000-0000-7000-8000-0000000000b1' as EntityId;
const TASK = '01900000-0000-7000-8000-0000000000aa' as EntityId;
const MEMORY = '01900000-0000-7000-8000-0000000000m1' as EntityId;
const SKILL = '01900000-0000-7000-8000-0000000000s1' as EntityId;

function record(overrides: Partial<SessionLaunchRecord> = {}): SessionLaunchRecord {
  return {
    sessionId: '01900000-0000-7000-8000-0000000000e1' as EntityId,
    available: true,
    unavailableReason: null,
    manifest: {
      mode: 'worker',
      agent: {
        capabilities: { launch: { harnessSurface: 'minimal', plugins: ['sales'], mcpServers: { github: { command: 'gh-mcp' } } } },
      },
      launch: {
        tool: 'claude-code',
        model: 'opus',
        reasoningEffort: 'high',
        permissionMode: 'bypassPermissions',
        accessMode: 'full',
        jevRunId: '01900000-0000-7000-8000-0000000000f1',
        credentialSources: { anthropic: 'space' },
        spaceCredentialIds: { anthropic: 'cred-should-not-show' },
      },
      interactionProfile: { templateKey: 'tm8.chat.core', source: 'core_default' },
      effectiveSkills: { native: [{}], indexed: [{}, {}], skipped: [] },
    },
    envVarNames: [],
    prompts: { system: null, task: null, unavailableReason: null },
    recordedAt: '2026-09-24T12:00:00.000Z',
    launchContext: {
      entries: [
        { entityId: TEAMMATE, role: 'teammate', kind: 'team_member', title: 'Draco', source: 'launch', viaTaskId: null, skillLoad: null, jev: null },
        { entityId: TASK, role: 'task', kind: 'task', title: 'Ship it', source: 'launch', viaTaskId: null, skillLoad: null, jev: null },
        { entityId: MEMORY, role: 'memory', kind: 'memory', title: '<b>not bold</b>', source: 'jev', viaTaskId: null, skillLoad: null, jev: { level: 'critical', score: 3 } },
        { entityId: SKILL, role: 'skill', kind: 'skill', title: 'deploy', source: 'task', viaTaskId: TASK, skillLoad: 'native', jev: null },
      ],
      hiddenCount: 2,
      unlinkedMemories: ['legacy note'],
      unlinkedSkillCount: 1,
    },
    ...overrides,
  };
}

describe('LaunchContextSection', () => {
  it('lists every selection with its role and one source badge', () => {
    const onOpen = vi.fn();
    const { getByTestId, getAllByTestId } = render(
      <LaunchContextSection state={{ phase: 'ready', record: record() }} onOpenEntity={onOpen} />,
    );
    // 4 entities + 1 text-only memory + 2 hidden.
    expect(getByTestId('launch-context').textContent).toContain('LAUNCH CONTEXT · 7');
    const rows = getAllByTestId('launch-context-entry');
    expect(rows.map((r) => r.textContent)).toEqual([
      'Dracoteammatelaunch',
      'Ship ittasklaunch',
      '<b>not bold</b>memoryJevcritical',
      'deployskill · nativetask',
    ]);
    // Graph-authored text is data: no element was made from it.
    expect(rows[2]!.querySelector('b')).toBeNull();
    // A row reached through a task names that task on its badge.
    expect(within(rows[3]!).getByText('task').getAttribute('title')).toContain('Ship it');
    fireEvent.click(within(rows[1]!).getByText('Ship it'));
    expect(onOpen).toHaveBeenCalledWith(TASK);
  });

  it('counts what the viewer cannot read and shows id-less memories as text', () => {
    const { getByTestId } = render(<LaunchContextSection state={{ phase: 'ready', record: record() }} />);
    expect(getByTestId('launch-context-hidden').textContent).toBe(
      "2 more not shown: you can't read them, or they were deleted",
    );
    expect(getByTestId('launch-context-memory-text').textContent).toContain('legacy note');
    expect(getByTestId('launch-context-facts').textContent).toContain('File-only skills1');
  });

  it('shows the launch facts and the declared harness, and never a credential id', () => {
    const { getByTestId } = render(<LaunchContextSection state={{ phase: 'ready', record: record() }} />);
    const facts = getByTestId('launch-context-facts').textContent ?? '';
    expect(facts).toContain('opus');
    expect(facts).toContain('high');
    expect(facts).toContain('Ask Jev');
    expect(facts).not.toContain('cred-should-not-show');
    const harness = getByTestId('launch-context-harness').textContent ?? '';
    // Nothing recorded: every row names its source.
    expect(harness).toContain('Harness surfaceminimal (declared)');
    expect(harness).toContain('Pluginssales (declared)');
    expect(harness).toContain('MCP serversgithub (declared)');
    expect(harness).not.toContain('gh-mcp');
    expect(harness).toContain('Harness skillstrimmed (declared)');
    expect(harness).toContain('Native skills1');
    expect(harness).toContain('Indexed skills2');
  });

  it('prefers the recorded harness over the pick and the declaration, and says which it shows', () => {
    const base = record();
    const launch = base.manifest!.launch as Record<string, unknown>;
    const recorded = record({
      manifest: {
        ...base.manifest,
        launch: {
          ...launch,
          harnessChoice: { surface: 'inherit', plugins: ['picked'] },
          harness: {
            plugins: {
              allowed: [{ id: 'figma@market', source: 'equipped' }],
              denied: [{ id: 'slack@market', because: 'not allowlisted' }],
            },
          },
        },
      },
    });
    const { getByTestId, unmount } = render(<LaunchContextSection state={{ phase: 'ready', record: recorded }} />);
    const harness = getByTestId('launch-context-harness').textContent ?? '';
    // #731-era record: plugins only, so the surface is the pick, tagged.
    expect(harness).toContain('Harness surfaceinherit (picked)');
    expect(harness).toContain('Pluginsfigma@market');
    expect(harness).toContain('MCP serversgithub (declared)');
    expect(harness).toContain('Plugins deniedslack@market (not allowlisted)');
    expect(harness).not.toContain('sales');
    unmount();

    // No record: the launch pick replaces the declared list, even when empty.
    const picked = record({
      manifest: { ...base.manifest, launch: { ...launch, harnessChoice: { plugins: [] } } },
    });
    const { getByTestId: getPicked, unmount: unmount2 } = render(<LaunchContextSection state={{ phase: 'ready', record: picked }} />);
    const pickedText = getPicked('launch-context-harness').textContent ?? '';
    expect(pickedText).toContain('Pluginsnone (picked)');
    unmount2();
  });

  it('shows the recorded surface, MCP servers and bundled-skill trim once launch.harness carries them', () => {
    const base = record();
    const launch = base.manifest!.launch as Record<string, unknown>;
    const full = record({
      manifest: {
        ...base.manifest,
        launch: {
          ...launch,
          harnessChoice: { surface: 'inherit' },
          harness: {
            surface: 'minimal',
            surfaceSource: 'env',
            plugins: { allowed: [], denied: [] },
            mcpServers: [{ name: 'linear', source: 'persona' }],
            skillOverrides: {
              off: [{ name: 'init', source: 'builtin-trim' }, { name: 'loop', source: 'builtin-trim' }],
              nameOnly: [{ name: 'graphify', source: 'native-name-only' }],
            },
          },
        },
      },
    });
    const text = render(<LaunchContextSection state={{ phase: 'ready', record: full }} />)
      .getByTestId('launch-context-harness').textContent ?? '';
    expect(text).toContain('Harness surfaceminimal (env)');
    expect(text).toContain('MCP serverslinear');
    expect(text).not.toContain('github');
    expect(text).toContain('Harness skillstrimmed (2 off, 1 name-only)');
    expect(text).not.toMatch(/\((declared|picked)\)/);
  });

  it("hides the declared harness when the viewer cannot read the teammate", () => {
    const base = record();
    const withoutTeammate = record({
      launchContext: { ...base.launchContext!, entries: base.launchContext!.entries.filter((e) => e.role !== 'teammate') },
    });
    const { queryByTestId } = render(<LaunchContextSection state={{ phase: 'ready', record: withoutTeammate }} />);
    expect(queryByTestId('launch-context-harness')).toBeNull();
  });

  it('says so when the launch was not recorded', () => {
    const { getByTestId } = render(
      <LaunchContextSection
        state={{ phase: 'ready', record: record({ available: false, manifest: null, launchContext: null }) }}
      />,
    );
    expect(getByTestId('launch-context-not-recorded')).toBeTruthy();
  });
});

describe('ConnectionsTab with a launch context', () => {
  it('draws the launch context above the edges', () => {
    const detail = Object.values(fixtureDetails).find((d) => d.deletedAt == null)!;
    const { getByTestId } = render(
      <ConnectionsTab
        detail={detail}
        launchContext={<LaunchContextSection state={{ phase: 'ready', record: record() }} />}
      />,
    );
    const panel = getByTestId('launch-context').parentElement!;
    expect(panel.querySelector('.pn-section')).toBe(getByTestId('launch-context'));
  });
});
