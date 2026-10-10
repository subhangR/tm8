import { CollabError, ToolDefinitionSchema, type ToolRun, type ToolView } from '@tm8/contract';
import type { ToolPermissions, ToolPort } from './port';

export const fixtureTool: ToolView = {
  id: '00000000-0000-4000-8000-000000000001', spaceId: '00000000-0000-4000-8000-000000000002', version: 1, sourceSha256: 'a'.repeat(64),
  definition: {
    name: 'url-check', description: 'Check whether a URL responds.', help: 'Enter the URL to check, then run the tool.', runtime: 'bash',
    source: 'curl --fail --head "$URL"\n', tm8Access: 'none', timeoutSeconds: 900,
    inputs: [{ name: 'url', type: 'string', required: true, description: 'URL to check' }, { name: 'limit', type: 'int', min: 1, max: 200, default: 20 }, { name: 'verbose', type: 'bool', default: false }, { name: 'state', type: 'enum', options: ['open', 'closed'], default: 'open' }, { name: 'token', type: 'secret' }],
  }, config: { url: 'https://example.test' }, secretBindings: [],
};
/** Explicit simulation for UI checks while the tools handlers are built independently. */
export function createToolFixture(initial: ToolView = fixtureTool, permissions: Partial<ToolPermissions> = {}) {
  let tool = structuredClone(initial);
  const runs: ToolRun[] = [];
  let sequence = 10;
  const bump = () => { tool = { ...tool, version: tool.version + 1 }; };
  const current = (version: number) => { if (version !== tool.version) throw new CollabError('version_conflict', 'The tool changed. Reload before saving.'); };
  const port: ToolPort = {
    async get() { return structuredClone(tool); },
    async permissions() { return { edit: true, configure: true, setSecret: true, run: true, ...permissions }; },
    async update(view, definition) { current(view.version); tool.definition = ToolDefinitionSchema.parse(definition); bump(); },
    async setConfig(view, name, value) { current(view.version); tool.config[name] = value; bump(); },
    async unsetConfig(view, name) { current(view.version); delete tool.config[name]; bump(); },
    async setSecret(view, name, secret) {
      if (permissions.setSecret === false) throw new Error('Only a human can set secrets.');
      current(view.version); tool.secretBindings = tool.secretBindings.filter(binding => binding.inputName !== name);
      tool.secretBindings.push({ inputName: name, credentialId: '00000000-0000-4000-8000-000000000003', keyHint: `…${secret.slice(-4)}` }); bump();
    },
    async unsetSecret(view, name) { current(view.version); tool.secretBindings = tool.secretBindings.filter(binding => binding.inputName !== name); bump(); },
    async history() { return { items: structuredClone(runs), nextCursor: null }; },
    async sourceChange() { return null; },
    async run(input) {
      const run: ToolRun = { id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, spaceId: tool.spaceId, toolId: tool.id, toolVersion: tool.version, sourceSha256: tool.sourceSha256,
        inputs: { ...tool.config, ...input.inputs }, state: 'running', keepOpen: input.keepOpen, exitCode: null, startedAt: '2026-10-10T12:00:00Z', exitedAt: null, outputTail: '', parentSessionId: null };
      runs.unshift(run); return { sessionId: run.id };
    },
    async runGet(id) { const run = runs.find(item => item.id === id); if (!run) throw new Error('Run not found'); return structuredClone(run); },
  };
  return { port, finish(id: string, state: ToolRun['state'], exitCode: number | null) { const run = runs.find(item => item.id === id); if (run) Object.assign(run, { state, exitCode, exitedAt: '2026-10-10T12:00:03Z' }); } };
}
