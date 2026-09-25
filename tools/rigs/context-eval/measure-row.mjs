// The ONE per-row measurement used by lanes.mjs (live) and remeasure.mjs
// (from the stored manifest + transcript): context-measure's classifier plus
// the needle / memory / tool-call / component / cost fields of a row.
// Throws on anything it cannot measure; the caller records `measureError`.

import { measureLane } from '../context-measure/measure.mjs';
import { componentsOf } from './components.mjs';
import { laneCostUsd } from './pricing.mjs';

/** Tool-use blocks in the transcript. */
export function countToolCalls(transcriptText) {
  let n = 0;
  for (const line of transcriptText.split('\n')) {
    if (!line.includes('"tool_use"')) continue;
    try {
      const r = JSON.parse(line);
      if (r.type === 'assistant') n += (r.message?.content ?? []).filter((b) => b.type === 'tool_use').length;
    } catch {
      /* torn line */
    }
  }
  return n;
}

/**
 * @param manifest  <dataDir>/manifests/<sessionId>.json, parsed
 * @param transcriptText  the lane's Claude Code transcript
 * @param tpl  the template record (linkedIds, needleId) from fixtures/node-<port>.json
 * @param taskKey  for messages only
 */
export function measureRow({ manifest, transcriptText, tpl, taskKey }) {
  const noLinks = tpl.linkedIds.length === 0 && !(manifest.context?.entries ?? []).some((e) => e.group === 'references') && !manifest.context?.groups?.references?.unread;
  if (!tpl.linkedIds.length && !noLinks) throw new Error(`task ${taskKey} has no linked ids, so no absent-from-index miss could be counted`);
  // A lane whose first reply is synthetic ("Not logged in · Please run /login")
  // sent no request: its keychain read failed (a node started without USER).
  // It is set aside, never measured as a 0-token lane.
  if (/"model":"<synthetic>"/.test(transcriptText) && /Not logged in/.test(transcriptText)) throw new Error('auth-error: the lane was not logged in (synthetic reply); start the node with dev-node.sh (USER/SHELL/LANG in its env)');
  const measured = measureLane({ manifest, transcriptLines: transcriptText.split('\n'), linked: tpl.linkedIds });
  measured.needleOpened = tpl.needleId ? measured.reads.some((r) => r.id === tpl.needleId) : null;
  measured.needleMissed = tpl.needleId ? tpl.needleId in measured.miss.ids : null;
  measured.needleState = tpl.needleId ? ((manifest.context?.entries ?? []).find((e) => e.entityId === tpl.needleId)?.state ?? 'absent') : null;
  measured.memoriesCollapsed = (manifest.context?.dropped ?? []).filter((d) => d.level === 'body').length;
  measured.memoryExpands = (manifest.context?.entries ?? []).filter((e) => e.group === 'memories' && measured.reads.some((r) => r.id === e.entityId)).length;
  delete measured.reads;
  measured.toolCalls = countToolCalls(transcriptText);
  measured.modelId = manifest.launch?.model ?? null;
  delete measured.model; // the row's `model` is the matrix key (sonnet5); the launch's id is `modelId`
  measured.components = componentsOf({ measured, manifest });
  measured.costUsd = laneCostUsd(measured.modelId, measured.usage);
  return measured;
}
