/**
 * DID THIS TOOL CALL WRITE? — ONE classifier, one answer.
 *
 * Three surfaces ask this question about the same thread: the induced graph
 * (a mutated node is emphasised), the entity tray (write-touched entities lead
 * the tabs, "because creation is the strongest claim to a berth") and the
 * fleet fold (a created entity is not merely a referenced one). Two
 * implementations that agree today drift tomorrow, and the disagreement would
 * be visible — the graph calling a node edited while the tray files it as read.
 *
 * IT LIVES HERE BECAUSE ONE OF THOSE ANSWERS WAS WRONG ON EVERY CHAT WRITE.
 * `graph-seeds.ts` matched its verb regex against the TOOL NAME, and chat's
 * entire write path is two GROUP tools — `tm8_act` and `tm8_delegate` — whose
 * names contain no verb from the list. "act" is not in it. "delegate" is not
 * in it. "dispatch" IS in it, which is the near-miss that makes the bug
 * invisible on inspection: the operation is `execution.dispatch`, but the tool
 * is called `tm8_delegate`, so the regex never sees it.
 *
 * The consequence was total rather than partial: on Chat Home EVERY graph
 * mutation the agent made folded as a READ, because chat has no other write
 * path. The graph's "edited here" flag and the tray's created-first ordering
 * were both uniformly dead, each looking deliberate. Verified by executing the
 * shipped fold, not by reading it.
 *
 * THE FIX IS TO ASK THE RIGHT FIELD. The MCP group schema carries the real
 * verb in `args.operation` (`entities.create`, `execution.spawn`, …), so that
 * is what gets classified when it is present. The tool NAME remains the
 * fallback for direct tools (`Edit`, `Bash`, the `tm8_*` direct set), whose
 * names do carry their verb.
 *
 * CONSERVATIVE IN ONE DIRECTION, DELIBERATELY. An unrecognised verb counts as
 * a READ in both branches: a false "edited here" is a lie about authorship,
 * while a false "read" is only an understatement the row survives.
 */

/** Verbs that name a mutation. */
const WRITE_VERB =
  /(create|update|delete|remove|patch|send|post|complete|assign|unlink|link|move|write|edit|spawn|terminate|attach|upload|cancel|start|stop|rename|archive|restore|grant|revoke|dispatch|launch|set_|_set\b)/i;

/**
 * EVERY WRITE OPERATION THE CHAT SURFACE CAN CALL — the closed set, named.
 *
 * The verb regex above MISCLASSIFIED EIGHT OF THESE AS READS (measured
 * 2026-08-21 over the full `@tm8/mcp` guide list): `entities.react`,
 * `entities.points.add`, `entities.commands.work`, `entities.commands.pull`,
 * `placements.apply`, `attentionRequests.resolveEntity`,
 * `collections.addItem`, `execution.resume` — none of whose verbs ("react",
 * "add", "work", "pull", "apply", "resolve", "resume") appear in the pattern.
 * That is the same defect class this module was created to fix, one layer
 * down: on every shipped surface a turn that only reacted to or pulled a task
 * filed it as merely read, so the graph's "edited here" emphasis and the
 * tray's created-first ordering under-claimed.
 *
 * So a call that names an operation is answered by this set FIRST, with the
 * verb regex as a secondary for operations added after this was written whose
 * names do carry a verb. An operation in neither still counts as a READ —
 * the conservative direction is load-bearing: a false "edited here" is a lie
 * about authorship, while a false "read" is only an understatement.
 *
 * ONE COPY. The ledger fold (`ledger.ts`) imports this set rather than owning
 * a twin — two write-op lists that agree today drift tomorrow, which is this
 * file's founding lesson.
 */
export const WRITE_OPS: ReadonlySet<string> = new Set([
  'entities.create',
  'entities.patch',
  'entities.move',
  'entities.delete',
  'entities.restore',
  'entities.react',
  'entities.points.add',
  'entities.commands.work',
  'entities.commands.complete',
  'entities.commands.pull',
  'entities.commands.linkPr',
  'entities.commands.linkCommit',
  'edges.create',
  'edges.patch',
  'edges.delete',
  'placements.apply',
  'attentionRequests.create',
  'attentionRequests.resolveEntity',
  'collections.addItem',
  'collections.removeItem',
  'execution.dispatch',
  'execution.spawn',
  'execution.terminate',
  'execution.resume',
  'messages.post',
]);

/** Strip any MCP server prefix: `mcp__tm8__tm8_delegate` → `tm8_delegate`. */
export function bareToolName(name: string): string {
  return name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
}

/**
 * The `operation` a group tool was called with. The group schema puts it at
 * the top level of args (`{operation, params, query, body}`), but a call that
 * never settled has `args: undefined` and a malformed one can hold anything —
 * so this reads defensively and returns null rather than throwing a render
 * away.
 */
export function operationOf(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const operation = (args as { operation?: unknown }).operation;
  return typeof operation === 'string' ? operation : null;
}

/** Write-ness of one tool call: the closed operation set first, the verb
 *  regex second, the tool name only when no operation is present at all. */
export function isWriteCall(name: string, args: unknown): boolean {
  const operation = operationOf(args);
  if (operation !== null) return WRITE_OPS.has(operation) || WRITE_VERB.test(operation);
  return WRITE_VERB.test(bareToolName(name));
}
