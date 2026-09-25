#!/usr/bin/env node
// Per-lane context measurement (integrated design 01a0d348 §7.1 / §7.2).
//
//   node measure.mjs --manifest <dataDir>/manifests/<sid>.json --transcript <file.jsonl> [--linked <id,id,...>]
//
// Prints ONE JSON row. Everything is read from two files the lane already
// writes: the tm8 manifest (what the launch selected, rendered and dropped)
// and the Claude Code transcript (what the model was actually sent, and what
// the agent went on to read).
//
// Bytes, first request:
//   - `system.tm8Bytes`: UTF-8 bytes of <tm8_system_prompt>…</tm8_system_prompt>
//     in the transcript's `prompt_snapshot` attachment, i.e. the prompt as
//     sent, not as tm8 thinks it rendered it.
//   - `system.harnessChars`: every other system-prompt char (Claude Code's own
//     prompt, plus blocks such as Claude in Chrome's).
//   - `firstUserBytes`: the task prompt (turn 1).
//   - `attachments`: chars per attachment type sent before the first answer.
//     The payload text only (skill_listing.content, *_delta lines/blocks), so
//     numbers compare with task 01a0d31a's method.
//   - `firstRequestTokens`: input + cache_creation + cache_read of the first
//     API response.
//
// Reads (§7.2): a Bash `tm8 entity context|get <id>`, `tm8 file download
// <id>`, `tm8 skill show <id>` or a Skill tool call is a READ. A read is:
//   - an EXPAND when its id is an entry of manifest.context.entries;
//   - a MISS when its id is in manifest.context.dropped, or is a linked
//     entity (--linked) that the index did not carry at all. `missLevels`
//     says which drop level (header / entry / body / not-selected) it hit;
//   - a BLIND FETCH when it read a collapsed entry larger than 20 KB without
//     paging (`--cursor` / `--limit` / `--sections`); its result bytes count.

import { readFileSync } from 'node:fs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

export function measureLane({ manifest, transcriptLines, linked = [] }) {
  const ctx = manifest.context ?? {};
  const entries = new Map((ctx.entries ?? []).map((e) => [e.entityId, e]));
  const dropped = new Map();
  for (const d of ctx.dropped ?? []) if (!dropped.has(d.entityId)) dropped.set(d.entityId, d);
  const linkedSet = new Set(linked);

  const records = [];
  for (const line of transcriptLines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* a torn last line while the lane still writes */
    }
  }

  const utf8 = (s) => Buffer.byteLength(s ?? '', 'utf8');
  const row = {
    session: manifest.sessionId,
    model: manifest.launch?.model ?? null,
    surface: manifest.launch?.harness?.surface ?? null,
    contextIndex: manifest.contextIndex ? 'on' : 'off',
    manifestContextIndexBytes: ctx.index?.bytes ?? null,
    entries: { total: entries.size, byGroup: countBy([...entries.values()], (e) => e.group), byState: countBy([...entries.values()], (e) => e.state) },
    dropped: { total: (ctx.dropped ?? []).length, byLevel: countBy(ctx.dropped ?? [], (d) => `${d.reason}:${d.level ?? '-'}`) },
    system: null,
    firstUserBytes: null,
    attachments: {},
    firstRequestTokens: null,
    requests: 0,
    usage: { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 },
    reads: [],
  };

  let answered = false;
  const seenMsg = new Map();
  const toolUses = new Map();
  for (const r of records) {
    if (r.type === 'attachment' && r.attachment?.type === 'prompt_snapshot' && !row.system) {
      const all = (r.attachment.systemPrompt ?? []).join('\n');
      const a = all.indexOf('<tm8_system_prompt');
      const b = all.indexOf('</tm8_system_prompt>');
      const tm8 = a >= 0 && b > a ? all.slice(a, b + '</tm8_system_prompt>'.length) : '';
      const chrome = (r.attachment.systemPrompt ?? []).find((p) => p.includes('# Claude in Chrome')) ?? '';
      const chromeBlock = chrome.slice(chrome.indexOf('# Claude in Chrome'), chrome.indexOf('<tm8_system_prompt') >= 0 ? chrome.indexOf('<tm8_system_prompt') : undefined);
      row.system = {
        totalChars: all.length,
        tm8Bytes: utf8(tm8),
        harnessChars: all.length - tm8.length,
        chromeChars: chrome ? chromeBlock.length : 0,
        tm8HasContextIndex: tm8.includes('<context_index'),
        tm8HasSkills: tm8.includes('<skills'),
      };
    } else if (r.type === 'attachment' && !answered) {
      const t = r.attachment?.type;
      const text = attachmentText(r.attachment);
      if (t && t !== 'prompt_snapshot') row.attachments[t] = (row.attachments[t] ?? 0) + text.length;
    } else if (r.type === 'user' && row.firstUserBytes === null && !r.isMeta) {
      const c = r.message?.content;
      row.firstUserBytes = utf8(typeof c === 'string' ? c : JSON.stringify(c));
    } else if (r.type === 'assistant' && r.message?.usage) {
      const id = r.message.id ?? r.uuid;
      seenMsg.set(id, r.message.usage);
      if (!answered) {
        const u = r.message.usage;
        row.firstRequestTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        answered = true;
      }
      for (const block of r.message.content ?? []) if (block.type === 'tool_use') toolUses.set(block.id, block);
    }
    if (r.type === 'user' && Array.isArray(r.message?.content)) {
      for (const block of r.message.content) {
        if (block.type !== 'tool_result') continue;
        const use = toolUses.get(block.tool_use_id);
        if (!use) continue;
        const resultBytes = utf8(typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
        for (const read of readsOf(use)) row.reads.push({ ...read, resultBytes });
      }
    }
  }
  row.requests = seenMsg.size;
  for (const u of seenMsg.values()) {
    row.usage.input += u.input_tokens ?? 0;
    row.usage.cacheCreation += u.cache_creation_input_tokens ?? 0;
    row.usage.cacheRead += u.cache_read_input_tokens ?? 0;
    row.usage.output += u.output_tokens ?? 0;
  }
  const harnessAttach = ['skill_listing', 'deferred_tools_delta', 'mcp_instructions_delta', 'agent_listing_delta'].reduce((s, k) => s + (row.attachments[k] ?? 0), 0);
  row.residentHarnessChars = (harnessAttach + (row.system?.harnessChars ?? 0)) * row.requests;
  row.residentTm8Bytes = (row.system?.tm8Bytes ?? 0) * row.requests;

  // Classify reads.
  const expanded = new Set();
  const missed = new Map();
  let blindFetchBytes = 0;
  for (const read of row.reads) {
    const entry = read.id ? entries.get(read.id) : null;
    const drop = read.id ? dropped.get(read.id) : null;
    read.class = entry && entry.state !== 'header-dropped' && !drop ? 'expand'
      : drop ? 'miss'
        : entry ? 'miss'
          : read.id && linkedSet.has(read.id) ? 'miss'
            : 'other';
    if (read.class === 'expand' || (entry && read.class === 'miss')) expanded.add(read.id);
    if (read.class === 'miss') missed.set(read.id, drop ? `${drop.reason}:${drop.level ?? '-'}` : entry ? 'byte-budget:header' : 'absent-from-index');
    if (entry && entry.state !== 'expanded' && (entry.bytes ?? 0) > 20_000 && !read.paged) blindFetchBytes += read.resultBytes;
  }
  const collapsed = [...entries.values()].filter((e) => e.state !== 'expanded');
  row.expand = {
    opened: expanded.size,
    collapsedEntries: collapsed.length,
    rate: collapsed.length ? expanded.size / collapsed.length : null,
    byGroup: countBy([...expanded].map((id) => entries.get(id)).filter(Boolean), (e) => e.group),
  };
  row.miss = { count: missed.size, ids: Object.fromEntries(missed), launchMissed: missed.size > 0 };
  row.blindFetchBytes = blindFetchBytes;
  row.omittedFetches = row.reads.filter((r) => r.sections === 'connections').length;
  return row;
}

function attachmentText(a) {
  if (!a) return '';
  if (typeof a.content === 'string') return a.content;
  if (Array.isArray(a.addedLines)) return a.addedLines.join('\n');
  if (Array.isArray(a.addedBlocks)) return a.addedBlocks.join('\n');
  if (typeof a.text === 'string') return a.text;
  return JSON.stringify(a);
}

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const READ_RES = [
  [new RegExp(`tm8\\s+entity\\s+(context|get)\\s+(${ID})([^|;&\\n]*)`, 'g'), 'entity'],
  [new RegExp(`tm8\\s+file\\s+download\\s+(${ID})()([^|;&\\n]*)`, 'g'), 'file'],
  [new RegExp(`tm8\\s+skill\\s+show\\s+(${ID})()([^|;&\\n]*)`, 'g'), 'skill'],
];

/** Every read one tool call performs (a Bash line can hold several). */
export function readsOf(use) {
  if (use.name === 'Skill') return [{ via: 'Skill', id: null, skill: use.input?.skill ?? null, paged: false }];
  if (use.name !== 'Bash') return [];
  const cmd = String(use.input?.command ?? '');
  const out = [];
  for (const [re, via] of READ_RES) {
    for (const m of cmd.matchAll(re)) {
      const id = via === 'entity' ? m[2] : m[1];
      const rest = via === 'entity' ? m[3] : m[3];
      const sections = /--sections\s+(\S+)/.exec(rest)?.[1] ?? null;
      out.push({ via: via === 'entity' ? `entity ${m[1]}` : via, id, paged: /--cursor|--limit|--sections/.test(rest), sections });
    }
  }
  return out;
}

function countBy(xs, f) {
  const out = {};
  for (const x of xs) {
    const k = f(x);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest = JSON.parse(readFileSync(arg('manifest'), 'utf8'));
  const transcriptLines = readFileSync(arg('transcript'), 'utf8').split('\n');
  const linked = (arg('linked') ?? '').split(',').filter(Boolean);
  const row = measureLane({ manifest, transcriptLines, linked });
  if (!process.argv.includes('--with-reads')) delete row.reads;
  process.stdout.write(JSON.stringify(row) + '\n');
}
