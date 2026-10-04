/** Independent B1/B2 regression checks against the integrated runtime head. */
import { describe, expect, it } from 'vitest';
import { buildAgentCommand, buildCodexArgs, resolveLaunchConfig } from '../src/spawn/manifest.js';
import type { SpawnContext } from '../src/spawn/types.js';

const CANARY = 'INDEPENDENT_SYNTHETIC_MCP_KEY_8261';
const request = { spaceId: 'space-fixture', teamMemberId: 'teammate-fixture' };
function context(capabilities: Record<string, unknown>): SpawnContext {
  return {
    spaceId: request.spaceId, project: null, tasks: [],
    teamMember: { id: request.teamMemberId, name: 'Fixture', role: '', identity: '', memories: [],
      model: 'opus', agentTool: null, mode: 'worker', permissionMode: null, avatar: null,
      capabilities, commandPermissions: {} },
  };
}

describe('integrated MCP secret and ambient-config regressions', () => {
  it('rejects legacy raw persona MCP config instead of serializing a secret', () => {
    expect(() => resolveLaunchConfig(request, context({ launch: { mcpServers: {
      private: { type: 'http', url: 'https://fixture.invalid', headers: { Authorization: `Bearer ${CANARY}` } },
    } } }), {})).toThrow(/Legacy raw MCP configuration is disabled/);
  });

  it('injects only reference IDs into Claude bridge argv', () => {
    const launch = resolveLaunchConfig({ ...request, mcpSelections: [{ serverId: '00000000-0000-4000-8000-000000000001', credentialId: '00000000-0000-4000-8000-000000000002' }] }, context({}), {});
    const command = buildAgentCommand(launch, {});
    expect(command).toContain('00000000-0000-4000-8000-000000000001');
    expect(command).not.toContain(CANARY);
  });

  it('keeps Codex isolated from ambient MCP and carries only bridge references', () => {
    const launch = resolveLaunchConfig({ ...request, agentTool: 'codex', model: 'gpt-5.6-sol', mcpSelections: [{ serverId: '00000000-0000-4000-8000-000000000001' }] }, context({}), {});
    const args = buildCodexArgs(launch).join(' ');
    expect(args).toContain('00000000-0000-4000-8000-000000000001');
    expect(args).not.toContain(CANARY);
  });
});
