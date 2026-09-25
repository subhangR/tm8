// Context size by COMPONENT for one lane, in bytes and in an estimated share of
// the first request's tokens. Pure: takes the measure.mjs row and the manifest.
//
// Bytes are measured. Tokens are the first request's real total split by each
// component's share of measured chars; whatever the measured chars do not
// account for (tool schemas, harness framing) is the `remainder`, and it is an
// estimate (pricing.mjs CHARS_PER_TOKEN). Nothing here is a second source of
// truth for the totals: `firstRequestTokens` stays measure.mjs's number.

import { CHARS_PER_TOKEN } from './pricing.mjs';

export const INDEX_GROUPS = ['references', 'skills', 'teammates', 'memories'];
// 2: memoriesExpanded comes from the entries on EVERY arm and is taken OUT of
// tm8Kernel (v1 read it from the index-only memoryInjection budget, 0 on
// index-off arms, and left it inside the kernel).
// 3: on an index-OFF arm the legacy `<skills>` block (the skills listing the
// context index replaces) is taken out of tm8Kernel as `skillsListing`, so the
// kernel compares across arms. report.mjs refuses a mix.
export const COMPONENTS_SCHEMA = 3;

export function componentsOf({ measured, manifest }) {
  const ctx = manifest?.context ?? {};
  const entries = Array.isArray(ctx.entries) ? ctx.entries : [];
  const indexByGroup = {};
  for (const g of INDEX_GROUPS) indexByGroup[g] = 0;
  const indexBytes = typeof ctx.index?.bytes === 'number' ? ctx.index.bytes : 0;
  // Index ON lists skills inside <context_index> (counted there); index OFF
  // renders them as their own <skills> block, measured from the prompt as sent.
  const skillsListing = indexBytes > 0 ? 0 : (measured.system?.skillsBlockBytes ?? 0);
  // With the index OFF the manifest still records the selected entries (what
  // the launch would have listed), but nothing was rendered: the groups stay 0.
  if (indexBytes > 0) {
    for (const e of entries) {
      if (e.state === 'expanded') continue; // expanded memories are counted under memoriesExpanded
      indexByGroup[e.group] = (indexByGroup[e.group] ?? 0) + (e.bytes ?? 0);
    }
  }
  const tm8System = measured.system?.tm8Bytes ?? 0;
  // Memories inlined whole, on every arm: each expanded entry's bytes are its
  // rendered <entry> (the index-on budget's `used` is the same sum).
  const memoriesExpanded = entries.filter((e) => e.group === 'memories' && e.state === 'expanded').reduce((s, e) => s + (e.bytes ?? 0), 0);
  const a = measured.attachments ?? {};
  const bytes = {
    tm8Kernel: Math.max(0, tm8System - indexBytes - memoriesExpanded - skillsListing),
    assignmentSnapshot: measured.firstUserBytes ?? 0,
    contextIndex: indexBytes,
    contextIndexByGroup: indexByGroup,
    memoriesExpanded,
    skillsListing,
    harness: {
      systemOther: Math.max(0, (measured.system?.harnessChars ?? 0) - (measured.system?.chromeChars ?? 0)),
      chrome: measured.system?.chromeChars ?? 0,
      skillListing: a.skill_listing ?? 0,
      deferredToolsDelta: a.deferred_tools_delta ?? 0,
      mcpInstructionsDelta: a.mcp_instructions_delta ?? 0,
      agentListingDelta: a.agent_listing_delta ?? 0,
    },
  };
  const harnessTotal = Object.values(bytes.harness).reduce((s, x) => s + x, 0);
  const measuredChars = bytes.tm8Kernel + bytes.memoriesExpanded + bytes.skillsListing + bytes.assignmentSnapshot + bytes.contextIndex + harnessTotal;
  const first = measured.firstRequestTokens ?? 0;
  const estimatedTotalChars = first * CHARS_PER_TOKEN;
  const remainderChars = Math.max(0, Math.round(estimatedTotalChars - measuredChars));
  bytes.remainderEstimated = remainderChars;
  const denom = measuredChars + remainderChars || 1;
  const share = (chars) => Math.round((first * chars) / denom);
  const tokens = {
    firstRequest: first,
    tm8Kernel: share(bytes.tm8Kernel),
    memoriesExpanded: share(bytes.memoriesExpanded),
    skillsListing: share(bytes.skillsListing),
    assignmentSnapshot: share(bytes.assignmentSnapshot),
    contextIndex: share(bytes.contextIndex),
    harness: share(harnessTotal),
    remainderEstimated: share(remainderChars),
    estimate: `shares of firstRequestTokens by measured chars; remainder = first × ${CHARS_PER_TOKEN} − measured`,
  };
  return { schema: COMPONENTS_SCHEMA, bytes, tokens, measuredChars, harnessTotal };
}
