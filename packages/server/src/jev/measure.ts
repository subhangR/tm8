/**
 * `promptBytes` — what one ranked entity adds to the launch prompt when it is
 * ticked (design 01a0d348 §10 Q5.8).
 *
 * THE SAME SERIALIZERS SPAWN USES, ON THE SAME TEXT. A memory is its whole
 * `<entry>` (`serializeMemoryEntry` over `renderMemoryText`, redacted as the
 * manifest redacts it). Anything else is its `<context_index>` entry, built by
 * the spawn path's own builders (`skillIndexEntry`, `referenceIndexEntry`)
 * from the same resolved header and measured by `contextEntryBytes`. So for an
 * unchanged graph the set the launch sheet ticks within a budget is the set
 * spawn keeps whole (`jev-suggest-equals-spawn.pg.test.ts`).
 *
 * NEVER BYTES THAT DO NOT REACH THE PROMPT. With `<context_index>` off (the
 * node's `TM8_CONTEXT_INDEX`, else the profile's `contextIndex`), a skill is
 * its `<skills>` line and a reference or teammate is not in the prompt at all
 * (the snapshot's linked names are there either way), so it measures 0.
 *
 * Two approximations, both declared: a project or nested skill is measured
 * as indexed, because whether it is native depends on the launch's working
 * directory, which Ask Jev does not know; and plugin skills follow the scan's
 * `enabled` flag, not a minimal lane's allow set.
 */
import type { SelectionHeader } from '@tm8/contract';
import {
  computeEffectiveSkills,
  redactSecretsDeep,
  referenceIndexEntry,
  skillIndexEntry,
  type ContextVia,
  type ResolvedSkillRow,
} from '@tm8/execution';
import { contextEntryBytes, serializeMemoryEntry, serializeSkillIndexEntry, utf8Bytes, type ContextIndexVia } from '@tm8/prompt';

export interface MeasureContext {
  /** The launch renders `<context_index>` (`contextIndexSwitch`). */
  contextIndex: boolean;
  /** The harness the launch runs: whether a skill is native, and so its load pointer. */
  agentTool: string;
}

/** A memory's whole `<entry>`: injected whole, with `<context_index>` or without. */
export function memoryPromptBytes(renderedText: string): number {
  return utf8Bytes(serializeMemoryEntry(redactSecretsDeep(renderedText)));
}

/**
 * A skill's entry. `row` is the skill as spawn resolves it (equipment row or
 * by-id read); `via` is how the launch would carry it. A row the launch would
 * skip (missing, disabled for the tool) measures 0: it never renders.
 */
export function skillPromptBytes(
  row: ResolvedSkillRow,
  via: ContextVia,
  header: SelectionHeader | undefined,
  measure: MeasureContext,
): number {
  // One row at a time: no native-shadow pass between candidates that will
  // not all be ticked. The working directory is unknown here (see above).
  const effective = computeEffectiveSkills({ agentTool: measure.agentTool, workdir: '/', projectRoot: null, equips: [row] });
  const skill = effective.native[0] ?? effective.indexed[0];
  if (!skill) return 0;
  const shipped = redactSecretsDeep(skill);
  // The legacy `<skills>` trim charges each entry plus its joining newline.
  if (!measure.contextIndex) return utf8Bytes(serializeSkillIndexEntry(shipped)) + 1;
  return contextEntryBytes(redactSecretsDeep(skillIndexEntry(shipped, via, header)));
}

/** A reference's (or linked teammate's) entry; 0 while `<context_index>` is off. */
export function referencePromptBytes(
  ref: { entityId: string; kind: string; via: ContextIndexVia; link?: string | null; title: string | null },
  header: SelectionHeader | undefined,
  measure: MeasureContext,
): number {
  if (!measure.contextIndex) return 0;
  return contextEntryBytes(redactSecretsDeep(referenceIndexEntry(ref, header)));
}
