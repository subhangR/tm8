import { isRefusedActionRow, type OperationName, type ToolRun, type ToolView } from '@tm8/contract';
import type { HttpClient } from '../data/real/http';
import type { Seam } from '../data/seam';
import type { ToolPort } from './port';
import type { ToolVersionsPage } from './versions-model';

/** A space holds a handful of tools; the bound only stops a cursor that never ends. */
const LIST_PAGES = 50;

/**
 * All network requests use the operation catalog and the existing authenticated transport.
 * The selection header goes through the seam's own `setEntityHeader` door.
 */
export function createToolPort(http: HttpClient, seam: Pick<Seam, 'actions'> & { commands: Pick<Seam['commands'], 'setEntityHeader'> }): ToolPort {
  const command = () => ({ clientMutationId: `tool-${crypto.randomUUID()}` });
  const versioned = (tool: ToolView) => ({ ...command(), toolId: tool.id, expectedVersion: tool.version });
  async function call<T>(name: OperationName, options: Parameters<HttpClient['call']>[1]): Promise<T> {
    return http.call<T>(name, options);
  }
  return {
    create: (spaceId, definition) => call<ToolView>('tools.create', { params: { spaceId }, body: { ...command(), definition } }),
    async setHeader(toolId, header) {
      const result = await seam.commands.setEntityHeader(toolId, { ...command(), ...header });
      if (result.header) return { stored: true };
      return { stored: false, reason: result.warnings?.map(warning => warning.message).join('; ') || 'the node returned no header' };
    },
    async list(spaceId) {
      const tools: ToolView[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < LIST_PAGES; page += 1) {
        const result: { items: ToolView[]; nextCursor: string | null } = await call('tools.list', { params: { spaceId }, query: { limit: 100, ...(cursor ? { cursor } : {}) } });
        tools.push(...result.items);
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return tools;
    },
    get: toolId => call<ToolView>('tools.get', { params: { toolId } }),
    async permissions(toolId) {
      const actions = await seam.actions.list(toolId);
      const allowed = new Set<string>(actions.rows.filter(row => !isRefusedActionRow(row)).map(row => row[0]));
      return { edit: allowed.has('tools.update'), configure: allowed.has('tools.config.set'), setSecret: actions.human && allowed.has('tools.secrets.bind'), run: allowed.has('tools.run') };
    },
    update: (tool, definition) => call('tools.update', { params: { toolId: tool.id }, body: { ...versioned(tool), definition } }),
    setConfig: (tool, inputName, value) => call('tools.config.set', { params: { toolId: tool.id }, body: { ...versioned(tool), inputName, value } }),
    unsetConfig: (tool, inputName) => call('tools.config.unset', { params: { toolId: tool.id }, body: { ...versioned(tool), inputName } }),
    setSecret: (tool, inputName, secret) => call('tools.secrets.bind', { params: { toolId: tool.id }, body: { ...versioned(tool), inputName, value: secret } }),
    unsetSecret: (tool, inputName) => call('tools.secrets.unbind', { params: { toolId: tool.id }, body: { ...versioned(tool), inputName } }),
    history: (toolId, cursor) => call<{ items: ToolRun[]; nextCursor: string | null }>('tools.runs.list', { params: { toolId }, query: { limit: 20, ...(cursor ? { cursor } : {}) } }),
    async sourceChange(tool) {
      const current = await call<ToolView>('tools.get', { params: { toolId: tool.id } });
      if (current.sourceSha256 !== tool.sourceSha256) throw new Error('The source changed while the Run dialog was open. Reload the tool and review the source before running.');
      const change = current.sourceChangedSinceViewerLastRun;
      return change ? { changedBy: change.byActor?.displayName ?? 'an unknown author' } : null;
    },
    async run(input) {
      const { sessionId } = await call<{ sessionId: string }>('tools.run', { params: { toolId: input.toolId }, body: input });
      return { sessionId };
    },
    runGet: sessionId => call<ToolRun>('tools.runs.get', { params: { sessionId } }),
    versions: (toolId, cursor) => call<ToolVersionsPage>('entities.versions', { params: { id: toolId }, query: { limit: 20, ...(cursor ? { cursor } : {}) } }),
  };
}
