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

  /**
   * §4.2 / G8. The bridge ENTRY NAME is the connector's server key, so the
   * model reads `mcp__gmail__search_messages`. Both launchers are asserted
   * because they build their MCP arguments independently (one `--mcp-config`
   * JSON object, one `-c mcp_servers.<name>.…` per entry) and only the entry
   * name is shared.
   */
  it('names Claude and Codex bridge entries by the resolved server key, not the connector id', () => {
    // Set on the RESOLVED config, not on the request: a server key is written
    // by `McpSessionBindings.bind` after resolution (SpawnService replaces
    // `launch.mcpSelections` with what bind answered), and `SpawnRequest` has
    // no such field on purpose — a client must not be able to choose the prefix
    // its tools appear under.
    const selections = [
      { serverId: '00000000-0000-4000-8000-00000000000a', serverKey: 'gmail' },
      { serverId: '00000000-0000-4000-8000-00000000000b', serverKey: 'figma' },
    ];
    const claudeLaunch = resolveLaunchConfig(request, context({}), {});
    claudeLaunch.mcpSelections = selections;
    const claude = buildAgentCommand(claudeLaunch, {});
    expect(claude).toContain('"gmail"');
    expect(claude).toContain('"figma"');
    expect(claude).not.toContain('connector_');
    // `--connector <id>` stays a UUID: no definition and no account in argv.
    expect(claude).toContain('00000000-0000-4000-8000-00000000000a');

    const codexLaunch = resolveLaunchConfig({ ...request, agentTool: 'codex', model: 'gpt-5.6-sol' }, context({}), {});
    codexLaunch.mcpSelections = selections;
    const codex = buildCodexArgs(codexLaunch).join(' ');
    expect(codex).toContain('mcp_servers.gmail.command=');
    expect(codex).toContain('mcp_servers.figma.args=');
    expect(codex).not.toContain('connector_');
  });

  it('keeps Codex isolated from ambient MCP and carries only bridge references', () => {
    const launch = resolveLaunchConfig({ ...request, agentTool: 'codex', model: 'gpt-5.6-sol', mcpSelections: [{ serverId: '00000000-0000-4000-8000-000000000001' }] }, context({}), {});
    const args = buildCodexArgs(launch).join(' ');
    expect(args).toContain('00000000-0000-4000-8000-000000000001');
    expect(args).not.toContain(CANARY);
  });
});
