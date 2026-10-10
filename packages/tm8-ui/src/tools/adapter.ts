import { isRefusedActionRow, type OperationName, type ToolRun, type ToolView } from '@tm8/contract';
import type { HttpClient } from '../data/real/http';
import type { Seam } from '../data/seam';
import type { ToolPort } from './port';

/** All network requests use the operation catalog and the existing authenticated transport. */
export function createToolPort(http: HttpClient, seam: Pick<Seam, 'actions'>): ToolPort {
  const command = () => ({ clientMutationId: `tool-${crypto.randomUUID()}` });
  const versioned = (tool: ToolView) => ({ ...command(), toolId: tool.id, expectedVersion: tool.version });
  async function call<T>(name: OperationName, options: Parameters<HttpClient['call']>[1]): Promise<T> {
    return http.call<T>(name, options);
  }
  return {
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
  };
}
