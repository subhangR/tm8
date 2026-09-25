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

export function componentsOf({ measured, manifest }) {
  const ctx = manifest?.context ?? {};
  const entries = Array.isArray(ctx.entries) ? ctx.entries : [];
  const indexByGroup = {};
  for (const g of INDEX_GROUPS) indexByGroup[g] = 0;
  for (const e of entries) {
    if (e.state === 'expanded') continue; // expanded memories are counted under memoriesExpanded
    indexByGroup[e.group] = (indexByGroup[e.group] ?? 0) + (e.bytes ?? 0);
  }
  const indexBytes = typeof ctx.index?.bytes === 'number' ? ctx.index.bytes : 0;
  const tm8System = measured.system?.tm8Bytes ?? 0;
  const a = measured.attachments ?? {};
  const bytes = {
    tm8Kernel: Math.max(0, tm8System - indexBytes),
    assignmentSnapshot: measured.firstUserBytes ?? 0,
    contextIndex: indexBytes,
    contextIndexByGroup: indexByGroup,
    memoriesExpanded: ctx.budgets?.memoryInjection?.used ?? 0,
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
  const measuredChars = bytes.tm8Kernel + bytes.assignmentSnapshot + bytes.contextIndex + harnessTotal;
  const first = measured.firstRequestTokens ?? 0;
  const estimatedTotalChars = first * CHARS_PER_TOKEN;
  const remainderChars = Math.max(0, Math.round(estimatedTotalChars - measuredChars));
  bytes.remainderEstimated = remainderChars;
  const denom = measuredChars + remainderChars || 1;
  const share = (chars) => Math.round((first * chars) / denom);
  const tokens = {
    firstRequest: first,
    tm8Kernel: share(bytes.tm8Kernel),
    assignmentSnapshot: share(bytes.assignmentSnapshot),
    contextIndex: share(bytes.contextIndex),
    harness: share(harnessTotal),
    remainderEstimated: share(remainderChars),
    estimate: `shares of firstRequestTokens by measured chars; remainder = first × ${CHARS_PER_TOKEN} − measured`,
  };
  return { bytes, tokens, measuredChars, harnessTotal };
}
