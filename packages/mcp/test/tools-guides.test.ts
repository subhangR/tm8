// Tools v2 PR-E (design doc 01a182cb §5): the tm8 MCP surface tells an agent
// that the Space's tools exist and how to use one. Five read rows and five act
// rows; every act example body, sent through the router as a model would send
// it, parses against the contract's own input schema; the two secret rows stay
// off the surface (human-only), and the run row says where the result is.
import { describe, expect, it } from 'vitest';
import {
  getOperation,
  OPERATIONS,
  ToolConfigSetInputSchema,
  ToolConfigUnsetInputSchema,
  ToolCreateInputSchema,
  ToolRunInputSchema,
  ToolUpdateInputSchema,
  type OperationName,
} from '@tm8/contract';
import type { CatalogInvokeOptions, CatalogTransport } from '../src/catalog-client.js';
import { MCP_MAPPED_OPERATIONS, Tm8ToolRouter } from '../src/tools.js';

class RecordingTransport implements CatalogTransport {
  readonly calls: Array<{ operation: OperationName; options: CatalogInvokeOptions }> = [];
  result: unknown = { ok: true };

  async invoke(operation: OperationName, options: CatalogInvokeOptions = {}): Promise<unknown> {
    this.calls.push({ operation, options });
    return this.result;
  }
}

interface Guide {
  operation: string;
  summary: string;
  request: { params?: Record<string, string>; query?: Record<string, string>; body?: Record<string, unknown> };
}

const SPACE = '01a18300-0000-7000-8000-00000000aaaa';
const TOOL = '01a18300-0000-7000-8000-00000000bbbb';
const RUN = '01a18300-0000-7000-8000-00000000cccc';

async function directory(tool: string): Promise<Guide[]> {
  const result = await new Tm8ToolRouter(new RecordingTransport(), { mode: 'build' }).call(tool, {});
  return result.structuredContent.operations as Guide[];
}

/** The path parameters the catalog binds for an operation, which a guide's params must name exactly. */
function pathKeys(operation: string): string[] {
  return [...getOperation(operation as OperationName).path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!).sort();
}

/** A guide's placeholder params as a model would fill them. */
function filled(params: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(params ?? {}).map(([key, value]) => [
    key, value.startsWith('<') ? ({ spaceId: SPACE, toolId: TOOL, sessionId: RUN }[key] ?? value) : value,
  ]));
}

describe('tools.* on the MCP surface (Tools v2 PR-E, design doc 01a182cb §5)', () => {
  it('tm8_read lists the five tool reads, each naming exactly the path parameters the catalog binds', async () => {
    const rows = (await directory('tm8_read')).filter((g) => g.operation.startsWith('tools.'));
    expect(rows.map((g) => g.operation)).toEqual(['tools.list', 'tools.get', 'tools.help', 'tools.runs.list', 'tools.runs.get']);
    for (const row of rows) {
      expect(getOperation(row.operation as OperationName).kind, row.operation).toBe('read');
      expect(Object.keys(row.request.params ?? {}).sort(), row.operation).toEqual(pathKeys(row.operation));
      expect(row.request.body, row.operation).toBeUndefined();
    }
    const list = rows.find((g) => g.operation === 'tools.list')!;
    expect(list.request).toEqual({ params: { spaceId: '<space-id>' }, query: { limit: '50' } });
    // `words` is described, never templated: a literal placeholder sent as a filter would match no tool.
    expect(list.summary).toContain('query.words');
    expect(list.summary).toContain('toolId');
    const help = rows.find((g) => g.operation === 'tools.help')!;
    expect(help.summary).toContain('expectedVersion');
    const run = rows.find((g) => g.operation === 'tools.runs.get')!;
    for (const word of ['running|exited|timed_out|killed', 'exitCode', 'outputTail', 'tools.run']) expect(run.summary).toContain(word);
  });

  it('tm8_act lists the five tool commands, in the order an agent uses them, and no secret row', async () => {
    const rows = (await directory('tm8_act')).filter((g) => g.operation.startsWith('tools.'));
    expect(rows.map((g) => g.operation)).toEqual(['tools.run', 'tools.create', 'tools.update', 'tools.config.set', 'tools.config.unset']);
    for (const row of rows) {
      expect(getOperation(row.operation as OperationName).kind, row.operation).toBe('command');
      expect(Object.keys(row.request.params ?? {}).sort(), row.operation).toEqual(pathKeys(row.operation));
    }
    // Secrets are bound by a human: the catalog says so, and the curation agrees.
    const secretRows = OPERATIONS.filter((op) => op.name.startsWith('tools.secrets.'));
    expect(secretRows.map((op) => op.name).sort()).toEqual(['tools.secrets.bind', 'tools.secrets.unbind']);
    expect(secretRows.every((op) => op.humanOnly === true)).toBe(true);
    expect(MCP_MAPPED_OPERATIONS.filter((op) => op.startsWith('tools.secrets.'))).toEqual([]);
  });

  it('refuses a secret bind through tm8_act without a server call', async () => {
    const transport = new RecordingTransport();
    const result = await new Tm8ToolRouter(transport, { mode: 'build' }).call('tm8_act', {
      operation: 'tools.secrets.bind', params: { toolId: TOOL }, body: { expectedVersion: 1, inputName: 'token', value: 'x' },
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent.error as { message: string }).message).toContain('tools.secrets.bind is not available through tm8_act');
    expect(transport.calls).toEqual([]);
  });

  it('the run row says what comes back, where the result is, and that a secret is never a literal', async () => {
    const run = (await directory('tm8_act')).find((g) => g.operation === 'tools.run')!;
    expect(run.summary).toContain('sessionId');
    expect(run.summary).toContain('tools.runs.get');
    expect(run.summary).toContain('running|exited|timed_out|killed');
    expect(run.summary).toContain('Never pass a secret value as a literal');
    expect(run.summary).toContain('human-only');
    expect(run.summary).toContain('tm8 tool secret set');
    expect(run.request.body).toEqual({ expectedVersion: 1, inputs: { '<input-name>': '<value>' }, keepOpen: false });
    expect(run.request.body).not.toHaveProperty('secrets');
    for (const operation of ['tools.create', 'tools.config.set']) {
      const row = (await directory('tm8_act')).find((g) => g.operation === operation)!;
      expect(row.summary, operation).toMatch(/secret/);
      expect(JSON.stringify(row.request.body), operation).not.toMatch(/"type":"secret"/);
    }
  });

  it('every act example body, sent through the router as shown, parses against the contract input schema', async () => {
    const schemas = {
      'tools.run': ToolRunInputSchema,
      'tools.create': ToolCreateInputSchema,
      'tools.update': ToolUpdateInputSchema,
      'tools.config.set': ToolConfigSetInputSchema,
      'tools.config.unset': ToolConfigUnsetInputSchema,
    } as const;
    const act = await directory('tm8_act');
    for (const [operation, schema] of Object.entries(schemas)) {
      const row = act.find((g) => g.operation === operation)!;
      const transport = new RecordingTransport();
      const result = await new Tm8ToolRouter(transport, { mode: 'build' }).call('tm8_act', {
        operation, params: filled(row.request.params), body: row.request.body,
      });
      expect(result.isError, operation).toBeUndefined();
      expect(transport.calls.map((c) => c.operation)).toEqual([operation]);
      const sent = transport.calls[0]!.options.body as Record<string, unknown>;
      // A ledgered command: the router fills clientMutationId, which every tools.* input schema requires.
      expect(typeof sent.clientMutationId, operation).toBe('string');
      const parsed = schema.safeParse(sent);
      expect(parsed.success, `${operation}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
      expect(transport.calls[0]!.options.params, operation).toEqual(filled(row.request.params));
    }
  });

  it('the overview names tools in the read and act groups, so a model searching for them finds the groups', async () => {
    const result = await new Tm8ToolRouter(new RecordingTransport(), { mode: 'build' }).call('tm8_overview', {});
    const groups = result.structuredContent.groups as Array<{ tool: string; purpose: string }>;
    expect(groups.find((g) => g.tool === 'tm8_read')?.purpose).toContain('tools.list');
    expect(groups.find((g) => g.tool === 'tm8_act')?.purpose).toContain('tools.run');
    const search = await new Tm8ToolRouter(new RecordingTransport(), { mode: 'build' }).call('tm8_overview', { query: 'tools.run' });
    const matches = search.structuredContent.matches as Array<{ operation: string }>;
    expect(matches.some((m) => m.operation === 'tools.run')).toBe(true);
  });
});
