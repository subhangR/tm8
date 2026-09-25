// The ONE per-row measurement used by lanes.mjs (live) and remeasure.mjs
// (from the stored manifest + transcript): context-measure's classifier plus
// the needle / memory / tool-call / component / cost fields of a row.
// Throws on anything it cannot measure; the caller records `measureError`.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * UTF-8 bytes of the index-off `<skills>…</skills>` block inside the tm8
 * system prompt as sent (the first prompt_snapshot), 0 when there is none.
 * Only meaningful with the context index OFF: components.mjs reads it there.
 */
export function skillsBlockBytes(transcriptText) {
  for (const line of transcriptText.split('\n')) {
    if (!line.includes('"prompt_snapshot"')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type !== 'attachment' || r.attachment?.type !== 'prompt_snapshot') continue;
    const all = (r.attachment.systemPrompt ?? []).join('\n');
    const t0 = all.indexOf('<tm8_system_prompt');
    const t1 = all.indexOf('</tm8_system_prompt>');
    const tm8 = t0 >= 0 && t1 > t0 ? all.slice(t0, t1) : '';
    const a = tm8.indexOf('  <skills>');
    const b = tm8.indexOf('</skills>', a);
    return a >= 0 && b > a ? Buffer.byteLength(tm8.slice(a, b + '</skills>'.length), 'utf8') : 0;
  }
  return 0;
}

/**
 * A lane's SUBAGENT transcripts: `<dir>/<native-id>/subagents/agent-*.jsonl`,
 * a sibling of the lane's `<dir>/<native-id>.jsonl`. measure.mjs reads only the
 * main file, so a lane that delegates would under-count its requests, tokens
 * and $ (C4 msg 01a0d98e-3268: two rows wrong by more than 2x). Per file: the
 * API requests (distinct message ids), usage, tool calls, and cost priced by
 * the SUBAGENT's own model (it may differ from the lane's).
 */
export function subagentUsage(transcriptPath) {
  const out = { files: 0, requests: 0, toolCalls: 0, usage: { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 }, costUsd: 0, unpriced: 0 };
  const dir = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
    out.files++;
    const seen = new Map();
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.includes('"assistant"')) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue; // a torn last line
      }
      if (r.type !== 'assistant' || !r.message?.usage) continue;
      out.toolCalls += (r.message.content ?? []).filter((b) => b.type === 'tool_use').length;
      seen.set(r.message.id ?? r.uuid, { usage: r.message.usage, model: r.message.model });
    }
    for (const { usage: u, model } of seen.values()) {
      out.requests++;
      const add = { input: u.input_tokens ?? 0, cacheCreation: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 };
      for (const k of Object.keys(add)) out.usage[k] += add[k];
      const usd = laneCostUsd(model, add);
      if (usd == null) out.unpriced++;
      else out.costUsd += usd;
    }
  }
  return out;
}

/**
 * @param manifest  <dataDir>/manifests/<sessionId>.json, parsed
 * @param transcriptText  the lane's Claude Code transcript
 * @param tpl  the template record (linkedIds, needleId) from fixtures/node-<port>.json
 * @param taskKey  for messages only
 */
export function measureRow({ manifest, transcriptText, transcriptPath, tpl, taskKey }) {
  if (!transcriptPath) throw new Error('measureRow needs transcriptPath: subagent transcripts live beside it');
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
  measured.system.skillsBlockBytes = skillsBlockBytes(transcriptText);
  measured.components = componentsOf({ measured, manifest });
  measured.costUsd = laneCostUsd(measured.modelId, measured.usage);
  // Lane TOTALS include the lane's subagents (requests, usage, $); the main
  // thread's own numbers are kept as main*. Everything else (firstRequestTokens,
  // components, misses, expand, toolCalls, resident*) stays the main thread's.
  const sub = subagentUsage(transcriptPath);
  measured.mainRequests = measured.requests;
  measured.mainUsage = { ...measured.usage };
  measured.mainCostUsd = measured.costUsd;
  measured.subagents = sub;
  if (sub.files) {
    measured.requests += sub.requests;
    for (const k of Object.keys(measured.usage)) measured.usage[k] += sub.usage[k];
    measured.costUsd = measured.costUsd == null ? null : measured.costUsd + sub.costUsd;
  }
  measured.subagentsMeasured = true;
  return measured;
}
