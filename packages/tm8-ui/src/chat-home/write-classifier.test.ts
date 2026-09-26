/**
 * THE EIGHT OPERATIONS THE VERB REGEX COULD NOT SEE.
 *
 * `isWriteCall` was created because a verb regex over TOOL NAMES missed chat's
 * whole write path (`tm8_act`, `tm8_delegate` — no verb in either). The same
 * defect recurred one layer down: the regex over OPERATIONS missed every write
 * whose verb it never listed ("react", "add", "work", "pull", "apply",
 * "resolve", "resume"), so on every shipped surface a turn that only reacted
 * to or pulled a task filed it as merely read. The closed WRITE_OPS set is
 * the fix; these cases pin it, and pin the conservative direction that must
 * survive it: an operation in neither the set nor the regex is a READ.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isWriteCall, WRITE_OPS } from './write-classifier';

const act = (operation: string) => ({ operation, params: {}, body: {} });

describe('the closed write-op set', () => {
  it.each([
    'entities.react',
    'entities.points.add',
    'entities.commands.work',
    'entities.commands.pull',
    'placements.apply',
    'attentionRequests.resolveEntity',
    'collections.addItem',
    'execution.resume',
  ])('classifies %s as a write — the regex alone could not', (operation) => {
    expect(WRITE_OPS.has(operation)).toBe(true);
    expect(isWriteCall('mcp__tm8__tm8_act', act(operation))).toBe(true);
  });

  it('still classifies the verb-bearing operations as writes', () => {
    for (const operation of ['entities.create', 'entities.commands.complete', 'entities.move']) {
      expect(isWriteCall('mcp__tm8__tm8_act', act(operation))).toBe(true);
    }
  });

  it('keeps every read operation a read', () => {
    for (const operation of [
      'entities.get',
      'entities.context',
      'entities.children',
      'collections.query',
      'graph.query',
      'edges.list',
      'events.poll',
    ]) {
      expect(isWriteCall('mcp__tm8__tm8_read', act(operation))).toBe(false);
    }
  });

  it('an operation in neither the set nor the regex is a READ — conservative direction', () => {
    // A false "edited here" is a lie about authorship; a false "read" is only
    // an understatement. Unknown verbless operations must keep understating.
    expect(isWriteCall('mcp__tm8__tm8_act', act('entities.frobnicate'))).toBe(false);
  });

  it('a future verb-bearing operation still classifies by the regex', () => {
    // The set names today's catalog; the regex catches tomorrow's writes
    // whose names carry their verb, so the set going stale degrades softly.
    expect(isWriteCall('mcp__tm8__tm8_act', act('widgets.create'))).toBe(true);
  });
});

describe('direct tools, unchanged', () => {
  it('classifies by tool name when no operation is present', () => {
    expect(isWriteCall('Edit', {})).toBe(true);
    expect(isWriteCall('mcp__tm8__tm8_entity_create', {})).toBe(true);
    expect(isWriteCall('Bash', {})).toBe(false);
    expect(isWriteCall('repo_bash', {})).toBe(false);
  });
});

/**
 * THE SET AGAINST THE CATALOG IT NAMES, READ FROM SOURCE — so the next
 * operation `@tm8/mcp` adds to `tm8_act` without a regex verb reds here rather
 * than folding as a read on every surface (it happened: thirteen forms and
 * containers operations, found 2026-09-26). The extractor is proven non-empty
 * and to hold known members, so a parse that silently shrank cannot pass.
 */
describe('every operation the MCP groups expose is classified as its group says', () => {
  const tools = readFileSync(fileURLToPath(new URL('../../../mcp/src/tools.ts', import.meta.url)), 'utf8');
  const guidesOf = (name: string): string[] => {
    const start = tools.indexOf(`const ${name}`);
    const end = tools.indexOf('\nconst ', start + 1);
    if (start < 0 || end < 0) return [];
    return [...tools.slice(start, end).matchAll(/guide\('([^']+)'/g)].map((match) => match[1]!);
  };
  const act = [...guidesOf('ACT_GUIDES'), ...guidesOf('CONTAINER_GUIDES')];
  const reads = guidesOf('READ_GUIDES');

  it('reads the group lists it checks', () => {
    expect(act.length).toBeGreaterThanOrEqual(40);
    expect(act).toEqual(expect.arrayContaining(['entities.create', 'forms.transition', 'containers.fork']));
    expect(reads.length).toBeGreaterThanOrEqual(15);
    expect(reads).toEqual(expect.arrayContaining(['entities.get', 'graph.query']));
  });

  it('classifies every tm8_act operation as a write', () => {
    expect(act.filter((operation) => !isWriteCall('mcp__tm8__tm8_act', { operation }))).toEqual([]);
  });

  it('classifies every tm8_read operation as a read', () => {
    expect(reads.filter((operation) => isWriteCall('mcp__tm8__tm8_read', { operation }))).toEqual([]);
  });
});
