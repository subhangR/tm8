import { CollabError, ToolDefinitionSchema, type ToolDefinition, type ToolRun, type ToolView } from '@tm8/contract';
import type { ToolPermissions, ToolPort } from './port';
import type { ToolVersionItem } from './versions-model';

export const fixtureTool: ToolView = {
  id: '00000000-0000-4000-8000-000000000001', spaceId: '00000000-0000-4000-8000-000000000002', version: 1, sourceSha256: 'a'.repeat(64),
  executionVersion: 1, configRevision: 0, sourceChangedSinceViewerLastRun: null,
  definition: {
    name: 'url-check', description: 'Check whether a URL responds.', help: 'Enter the URL to check, then run the tool.', runtime: 'bash',
    source: 'curl --fail --head "$URL"\n', tm8Access: 'none', timeoutSeconds: 900,
    inputs: [{ name: 'url', type: 'string', required: true, description: 'URL to check' }, { name: 'limit', type: 'int', min: 1, max: 200, default: 20 }, { name: 'verbose', type: 'bool', default: false }, { name: 'state', type: 'enum', options: ['open', 'closed'], default: 'open' }, { name: 'token', type: 'secret' }],
  }, config: { url: 'https://example.test' }, secretBindings: [],
};
const fixtureAuthor = { id: '00000000-0000-4000-8000-0000000000a1', kind: 'member' as const, displayName: 'Ada', isAgent: false };
/** A stored snapshot in `internal.entity_snapshot`'s shape: the tools row (definition, execution_version) plus config and secret bindings. */
export function fixtureVersion(tool: ToolView, at = '2026-10-10T12:00:00Z'): ToolVersionItem {
  return { entityId: tool.id, version: tool.version, changedBy: fixtureAuthor, changedAt: at,
    snapshot: { entity: { id: tool.id, kind: 'tool', version: tool.version }, content: { definition: structuredClone(tool.definition),
      execution_version: tool.executionVersion, config_revision: tool.configRevision,
      config: structuredClone(tool.config), secretBindings: tool.secretBindings.map(({ inputName, credentialId }) => ({ inputName, credentialId })) } } };
}
/** The fields whose change makes a new definition version (migration 381): what a run executes. */
const executes = (definition: ToolDefinition) => JSON.stringify([definition.source, definition.runtime, definition.inputs, definition.tm8Access, definition.timeoutSeconds]);
/**
 * The node's answer for a tool header BEFORE migration 380 (PR-E) admits the kind:
 * the write is skipped with a warning. Tests pass `headerStored: false` to exercise
 * that fallback; the default simulates a node that stores it, as a node with 380 does.
 */
export const HEADER_NOT_STORED = 'a tool cannot carry a selection header; nothing was stored';

/**
 * Explicit simulation for UI checks while the tools handlers are built independently.
 * `create` refuses like the node: contract validation as `invalid_input` with
 * zod issues under `definition`, a taken name as `invariant_violation` 23505.
 * Versions follow migration 381: every write stores a row, and a change to what
 * runs takes the new entity version as the execution version runs pin.
 */
export function createToolFixture(initial: ToolView = fixtureTool, permissions: Partial<ToolPermissions> = {}, options: { headerStored?: boolean } = {}) {
  let tool = structuredClone(initial);
  const created: ToolView[] = [];
  const headers = new Map<string, unknown>();
  const runs: ToolRun[] = [];
  // Newest first, as `entities.versions` returns them.
  const versions: ToolVersionItem[] = [fixtureVersion(tool)];
  let sequence = 10;
  const bump = (definition = false) => {
    const version = tool.version + 1;
    tool = { ...tool, version, executionVersion: definition ? version : tool.executionVersion, configRevision: tool.configRevision + Number(!definition) };
    versions.unshift(fixtureVersion(tool));
  };
  const current = (version: number) => { if (version !== tool.version) throw new CollabError('version_conflict', 'The tool changed. Reload before saving.'); };
  const lastRun = () => { const run = runs[0]; return run ? { sessionId: run.id, state: run.state, exitCode: run.exitCode, startedAt: run.startedAt, exitedAt: run.exitedAt } : null; };
  const port: ToolPort = {
    async create(spaceId, definition) {
      const parsed = ToolDefinitionSchema.safeParse(definition);
      if (!parsed.success) throw new CollabError('invalid_input', 'request body failed contract validation', { details: { issues: parsed.error.issues.map(issue => ({ ...issue, path: ['definition', ...issue.path] })) } });
      if ([tool, ...created].some(item => item.definition.name === parsed.data.name)) throw new CollabError('invariant_violation', 'a live tool already has this name', { details: { sqlstate: '23505' } });
      const view: ToolView = { id: `00000000-0000-4000-9000-${String(++sequence).padStart(12, '0')}`, spaceId, version: 1, sourceSha256: 'b'.repeat(64),
        executionVersion: 1, configRevision: 0, sourceChangedSinceViewerLastRun: null, definition: parsed.data, config: {}, secretBindings: [] };
      created.push(view); return structuredClone(view);
    },
    async setHeader(toolId, header) {
      if (options.headerStored === false) return { stored: false, reason: HEADER_NOT_STORED };
      headers.set(toolId, structuredClone(header)); return { stored: true };
    },
    async list() { return structuredClone([tool, ...created]); },
    async get(id) { const found = created.find(item => item.id === id); return structuredClone(found ?? { ...tool, lastRun: lastRun() }); },
    async permissions() { return { edit: true, configure: true, setSecret: true, run: true, ...permissions }; },
    async update(view, definition) {
      current(view.version); const next = ToolDefinitionSchema.parse(definition);
      const changed = executes(next) !== executes(tool.definition); tool.definition = next; bump(changed);
    },
    async setConfig(view, name, value) { current(view.version); tool.config[name] = value; bump(); },
    async unsetConfig(view, name) { current(view.version); delete tool.config[name]; bump(); },
    async setSecret(view, name, secret) {
      if (permissions.setSecret === false) throw new Error('Only a human can set secrets.');
      current(view.version); tool.secretBindings = tool.secretBindings.filter(binding => binding.inputName !== name);
      tool.secretBindings.push({ inputName: name, credentialId: '00000000-0000-4000-8000-000000000003', keyHint: `…${secret.slice(-4)}`, boundBy: null, boundAt: '2026-10-10T12:00:00Z' }); bump();
    },
    async unsetSecret(view, name) { current(view.version); tool.secretBindings = tool.secretBindings.filter(binding => binding.inputName !== name); bump(); },
    async history() { return { items: structuredClone(runs), nextCursor: null }; },
    async sourceChange() { return null; },
    async run(input) {
      // A run pins the execution version (381): the definition it executes, not the concurrency token.
      const run: ToolRun = { id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, spaceId: tool.spaceId, toolId: tool.id, toolVersion: tool.executionVersion, sourceSha256: tool.sourceSha256,
        inputs: { ...tool.config, ...input.inputs }, state: 'running', keepOpen: input.keepOpen, exitCode: null, startedAt: '2026-10-10T12:00:00Z', exitedAt: null, outputTail: '', parentSessionId: null, invoker: fixtureAuthor, triggeredBy: null };
      runs.unshift(run); return { sessionId: run.id };
    },
    async runGet(id) { const run = runs.find(item => item.id === id); if (!run) throw new Error('Run not found'); return structuredClone(run); },
    async versions() { return { items: structuredClone(versions), nextCursor: null }; },
  };
  return {
    port, created, headers,
    finish(id: string, state: ToolRun['state'], exitCode: number | null, outputTail = '') { const run = runs.find(item => item.id === id); if (run) Object.assign(run, { state, exitCode, exitedAt: '2026-10-10T12:00:03Z', outputTail }); },
    /** Pre-381 history: one author's quick second edit folded into the open snapshot, so the earlier version left no row of its own. */
    fold() {
      const [latest] = versions.splice(0, 1); const version = tool.version + 1;
      tool = { ...tool, version, executionVersion: tool.executionVersion === tool.version ? version : tool.executionVersion };
      versions.unshift({ ...fixtureVersion(tool), changedAt: latest!.changedAt });
    },
  };
}
