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
