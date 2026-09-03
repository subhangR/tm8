/**
 * The container MCP surface (TM8-CONTAINERS-DESIGN §14.1, §7.1).
 *
 * §7.1's rule is that the CLI and MCP are TWO PROJECTIONS OF ONE CATALOG, with
 * no hand-written third API. So the assertions that matter here are not "the
 * tool exists" but "the tool reaches a real catalog row, and adds none":
 * `MCP_MAPPED_OPERATIONS` is checked against `OPERATIONS`, and every direct
 * tool is checked to dispatch through `CatalogTransport.invoke` with a catalog
 * operation name rather than a URL of its own.
 *
 * THE IMAGE BLOCK IS TESTED FOR WHAT IT REMOVES, not only for what it adds. A
 * screenshot is ~1 MB of base64; leaving it in `structuredContent` as well as
 * in the image block would ship it twice to a model that can read it as text
 * in neither. The test therefore asserts the base64 is ABSENT from the
 * structured half — an assertion that passes trivially if you only ever check
 * that the image block is present.
 */
import { describe, expect, it } from 'vitest';
import { getOperation, OPERATIONS, type OperationName } from '@tm8/contract';
import type { CatalogInvokeOptions, CatalogTransport } from '../src/catalog-client.js';
import { MCP_MAPPED_OPERATIONS, MCP_TOOL_NAMES, TM8_MCP_TOOLS, Tm8ToolRouter } from '../src/tools.js';
import { DIRECT_TOOL_NAMES } from '../src/modes.js';

const CTR = '88888888-8888-7888-8888-888888888888';
/** The direct tools confine their target to the thread's Space (`assertThreadSpace`),
 *  so the router is built with the spaceId a real session supplies. */
const SPACE = 'sp_1';

/** Answers `entities.get` as a container so the kind confinement passes, and
 *  records everything else. */
class ContainerTransport implements CatalogTransport {
  readonly calls: Array<{ operation: OperationName; options: CatalogInvokeOptions }> = [];
  result: unknown = { ok: true };
  kind = 'container';

  async invoke(operation: OperationName, options: CatalogInvokeOptions = {}): Promise<unknown> {
    this.calls.push({ operation, options });
    if (operation === 'entities.get') {
      return { id: CTR, kind: this.kind, spaceId: SPACE };
    }
    return this.result;
  }
}

describe('the three direct container tools', () => {
  it('are published, in the order §14.1 names them', () => {
    expect(DIRECT_TOOL_NAMES).toContain('container_computer');
    expect(DIRECT_TOOL_NAMES).toContain('container_run');
    expect(DIRECT_TOOL_NAMES).toContain('container_screenshot');
    // The definition array and the name list are compared elementwise by
    // `tools.test.ts`, so a reordering of one without the other is a failure
    // there; this pins the intended ORDER so the two cannot drift together.
    const names = TM8_MCP_TOOLS.map((t) => t.name);
    expect(names.filter((n) => n.startsWith('container_')))
      .toEqual(['container_computer', 'container_run', 'container_screenshot']);
  });

  it('are the ONLY direct container tools — everything else is a guide', () => {
    expect(MCP_TOOL_NAMES.filter((n) => n.startsWith('container_'))).toHaveLength(3);
  });

  it('container_run dispatches containers.run and returns a TYPED result', async () => {
    const transport = new ContainerTransport();
    transport.result = { exitCode: 0, stdout: 'hi\n', stderr: '', truncated: false, durationMs: 12, timedOut: false };
    const result = await new Tm8ToolRouter(transport, { spaceId: SPACE }).call('container_run', {
      containerId: CTR, argv: ['echo', 'hi'],
    });

    expect(result.isError).toBeUndefined();
    const run = transport.calls.find((c) => c.operation === 'containers.run');
    expect(run, 'container_run did not reach containers.run').toBeDefined();
    expect(run?.options.params).toEqual({ containerId: CTR });
    expect((run?.options.body as Record<string, unknown>).argv).toEqual(['echo', 'hi']);
    // TYPED: `exitCode` is a number an agent can branch on, not a blob.
    expect(result.structuredContent.exitCode).toBe(0);
    expect(result.structuredContent.stdout).toBe('hi\n');
    expect(result.structuredContent.stderr).toBe('');
  });

  it('container_run refuses a non-container entity', async () => {
    const transport = new ContainerTransport();
    transport.kind = 'task';
    const result = await new Tm8ToolRouter(transport, { spaceId: SPACE }).call('container_run', {
      containerId: CTR, argv: ['echo'],
    });
    expect(result.isError).toBe(true);
    expect(transport.calls.some((c) => c.operation === 'containers.run')).toBe(false);
  });

  it('container_run requires an argv ARRAY — never a shell string', async () => {
    const transport = new ContainerTransport();
    const result = await new Tm8ToolRouter(transport, { spaceId: SPACE }).call('container_run', {
      containerId: CTR, argv: 'sh -c "echo hi"',
    });
    expect(result.isError).toBe(true);
    expect(transport.calls.some((c) => c.operation === 'containers.run')).toBe(false);
  });

  it('container_computer returns the screenshot as an IMAGE block and drops it from the structured half', async () => {
    const base64 = 'AAAABBBBCCCCDDDD';
    const transport = new ContainerTransport();
    transport.result = {
      ok: true,
      screenshot: { mime: 'image/png', base64, w: 1280, h: 800, scale: 0.5 },
    };
    const result = await new Tm8ToolRouter(transport, { spaceId: SPACE }).call('container_computer', {
      containerId: CTR, action: 'click', x: 10, y: 20,
    });

    const image = result.content.find((c) => c.type === 'image');
    expect(image, 'no image content block').toBeDefined();
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png', data: base64 });

    // The removal, which is the point: ~1 MB of base64 must not ride in both
    // halves. Asserting only that the image block exists would pass either way.
    expect(JSON.stringify(result.structuredContent)).not.toContain(base64);
    expect(result.structuredContent.imageContent).toBeUndefined();
    const text = result.content.find((c) => c.type === 'text');
    expect(text && 'text' in text ? text.text : '').not.toContain(base64);

    // …while the dimensions and the scale STAY, because they are what the model
    // needs to convert its next click's coordinates.
    expect(result.structuredContent.screenshot).toMatchObject({ w: 1280, h: 800, scale: 0.5 });
  });

  it('container_computer refuses an action outside the shared vocabulary', async () => {
    const transport = new ContainerTransport();
    const result = await new Tm8ToolRouter(transport, { spaceId: SPACE }).call('container_computer', {
      containerId: CTR, action: 'swipe',
    });
    expect(result.isError).toBe(true);
    expect(transport.calls.some((c) => c.operation === 'containers.computer')).toBe(false);
  });

  it('container_screenshot is the same operation with the action fixed', async () => {
    const transport = new ContainerTransport();
    const result = await new Tm8ToolRouter(transport, { spaceId: SPACE }).call('container_screenshot', { containerId: CTR });
    expect(result.isError).toBeUndefined();
    const call = transport.calls.find((c) => c.operation === 'containers.computer');
    expect(call, 'container_screenshot did not reach containers.computer').toBeDefined();
    expect((call?.options.body as Record<string, unknown>).action).toBe('screenshot');
    // It adds NO catalog row of its own.
    expect(OPERATIONS.some((o) => o.name === ('containers.screenshot' as string))).toBe(false);
  });

  it('bounds scale to 0.25..1 rather than forwarding whatever arrives', async () => {
    const transport = new ContainerTransport();
    const result = await new Tm8ToolRouter(transport, { spaceId: SPACE }).call('container_screenshot', {
      containerId: CTR, scale: 4,
    });
    expect(result.isError).toBe(true);
    expect(transport.calls.some((c) => c.operation === 'containers.computer')).toBe(false);
  });
});

describe('CONTAINER_GUIDES ride the closed catalog, adding no row', () => {
  it('every mapped container operation is a real catalog row', () => {
    const mapped = MCP_MAPPED_OPERATIONS.filter((o) => o.startsWith('containers.'));
    expect(mapped.length).toBeGreaterThanOrEqual(10);
    for (const operation of mapped) {
      expect(getOperation(operation).name).toBe(operation);
    }
    // No `mcp.` shadow family, and no container row invented for MCP's benefit.
    expect(OPERATIONS.some((o) => o.name.startsWith('mcp.'))).toBe(false);
  });

  it('the guides appear in the tm8_act directory, with their catalog binding', async () => {
    const transport = new ContainerTransport();
    const result = await new Tm8ToolRouter(transport).call('tm8_act', {});
    const operations = (result.structuredContent.operations as Array<{ operation: string; catalog: unknown }>);
    const names = operations.map((o) => o.operation);
    for (const expected of [
      'containers.create', 'containers.start', 'containers.stop', 'containers.destroy',
      'containers.run', 'containers.policy.set', 'containers.expose', 'containers.snapshot',
      'containers.fork', 'containers.attention',
    ]) {
      expect(names, expected).toContain(expected);
    }
    // Opening a directory makes no server call.
    expect(transport.calls).toEqual([]);
  });

  it('a guide dispatch carries a clientMutationId, so a replayed create cannot provision twice', async () => {
    const transport = new ContainerTransport();
    await new Tm8ToolRouter(transport).call('tm8_act', {
      operation: 'containers.create',
      body: { spaceId: 'sp_1', profile: 'shell' },
    });
    const call = transport.calls.find((c) => c.operation === 'containers.create');
    expect(call).toBeDefined();
    expect((call?.options.body as Record<string, unknown>).clientMutationId).toBeTypeOf('string');
  });

  it('a caller-supplied mutation id is passed through, never regenerated', async () => {
    const transport = new ContainerTransport();
    await new Tm8ToolRouter(transport).call('tm8_act', {
      operation: 'containers.create',
      body: { spaceId: 'sp_1', profile: 'shell', clientMutationId: 'replay-1' },
    });
    const call = transport.calls.find((c) => c.operation === 'containers.create');
    expect((call?.options.body as Record<string, unknown>).clientMutationId).toBe('replay-1');
  });

  it('the WS row is not reachable as a tool call — a stream is not an invocation', () => {
    // `containers.stream` is the existing /v2/ws binding re-declared for
    // discoverability. It must not appear as a guide: there is nothing an MCP
    // request/response call can do with a surface socket.
    expect(MCP_MAPPED_OPERATIONS).not.toContain('containers.stream');
    expect(MCP_MAPPED_OPERATIONS).not.toContain('containers.proxy');
  });
});
