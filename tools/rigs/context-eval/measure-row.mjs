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
 * A lane whose FIRST assistant record is synthetic sent no API request (its
 * usage is all zero), so measure.mjs would report firstRequestTokens 0: a start
 * failure, never a measured lane. "Not logged in" is the keychain case (a node
 * started from a sandboxed shell); anything else (an API error) is set aside too.
 */
export function syntheticStart(transcriptText) {
  for (const line of transcriptText.split('\n')) {
    if (!line.includes('"assistant"')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type !== 'assistant') continue;
    if (r.message?.model !== '<synthetic>') return null;
    const content = r.message?.content;
    const text = (Array.isArray(content) ? content.map((b) => b.text ?? '').join(' ') : String(content ?? '')).trim();
    return /Not logged in/.test(text)
      ? { ended: 'auth-error', reason: 'auth-error: the lane was not logged in (synthetic reply); start the node with dev-node.sh (USER/SHELL/LANG in its env)' }
      : { ended: 'synthetic-start', reason: `synthetic first reply, no API request sent: ${text.slice(0, 160)}` };
  }
  return null;
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
  // Set aside, never measured as a 0-token lane: the error carries `startFailure`.
  const start = syntheticStart(transcriptText);
  if (start) throw Object.assign(new Error(start.reason), { startFailure: start });
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
