/**
 * Bridges S (§7.3 S, D73): a group with 2,000 messages keeps its chat context
 * within budget, and the summary still names open asks. The pure fold and
 * render, driven the way the turn assembly drives them; the stored round trip
 * is in summary.pg.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJson, projectHistory, type HistoricalTurn } from '../../src/chat/continuity.js';
import {
  EMPTY_SUMMARY, GROUP_CONTEXT_MAX_BYTES, REFRESH_BYTES, REFRESH_MESSAGES, TAIL_MESSAGES,
  foldSummary, isAsk, needsRefresh, renderGroupContext, type LogMessage, type StoredSummary,
} from '../../src/bridges/summary.js';

const people = ['Asha', 'Ben', 'Chen', 'Dara', 'Eli'];
const at = (i: number) => new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
function msg(i: number, body: string, extra: Partial<LogMessage> = {}): LogMessage {
  const name = people[i % people.length]!;
  return { id: `m${i}`, createdAt: at(i), authorKey: `ext:${name}`, authorName: name, body,
    parentId: null, rootId: null, direction: 'in', ...extra };
}

/** 2,000 messages: chatter, asks every 40th message (every other one answered in its thread), long pastes. */
function groupLog(): LogMessage[] {
  const log: LogMessage[] = [];
  for (let i = 0; i < 2000; i += 1) {
    if (i === 3) log.push(msg(i, 'Can someone rotate the staging database password before Friday?'));
    else if (i % 40 === 0) log.push(msg(i, `question ${i}: who can look at the flaky deploy ${i}?`));
    else if (i % 40 === 1 && (i - 1) % 80 === 0) log.push(msg(i, `on it, deploy ${i - 1} is fixed`, { parentId: `m${i - 1}`, rootId: `m${i - 1}` }));
    else if (i % 97 === 0) log.push(msg(i, `log paste ${'x'.repeat(5000)}`));
    else log.push(msg(i, `chatter ${i} about lunch and the weather`));
  }
  return log;
}

/** What `assembleGroupContext` does turn after turn: fold beyond the tail once the threshold passes. */
function rollThrough(log: readonly LogMessage[]): { summary: StoredSummary | null; tail: LogMessage[]; folds: number } {
  let summary: StoredSummary | null = null;
  let start = 0;
  let folds = 0;
  for (let end = 1; end <= log.length; end += 1) {
    const unsummarized = log.slice(start, end);
    const beyond = unsummarized.slice(0, Math.max(0, unsummarized.length - TAIL_MESSAGES));
    const bytes = beyond.reduce((n, m) => n + Buffer.byteLength(m.body, 'utf8'), 0);
    if (!needsRefresh(unsummarized.length, bytes)) continue;
    const state = foldSummary(summary?.state ?? EMPTY_SUMMARY, beyond);
    start += beyond.length;
    folds += 1;
    summary = { policyVersion: 'tm8-bridge-summary-v1', throughMessageId: beyond.at(-1)!.id,
      coveredMessages: start, state, refreshedAt: at(end) };
  }
  return { summary, tail: log.slice(start), folds };
}

const turn = (ordinal: number): HistoricalTurn => ({ turnId: `t${ordinal}`, ordinal, userMessageId: `u${ordinal}`,
  agentMessageId: `a${ordinal}`, input: { body: `@tm8 request ${ordinal} ${'y'.repeat(400)}` }, assistantBody: null,
  parts: [{ seq: 0, kind: 'text', payload: { text: `answer ${ordinal} ${'z'.repeat(800)}` } }],
  state: 'completed', failure: null, model: 'm' });

describe('bridge rolling summary', () => {
  it('detects asks and leaves chatter alone', () => {
    expect(isAsk('Can someone rotate the key')).toBe(true);
    expect(isAsk('is prod down?')).toBe(true);
    expect(isAsk('@tm8 summarise the thread')).toBe(true);
    expect(isAsk('pls review #12')).toBe(true);
    expect(isAsk('lunch was great')).toBe(false);
  });

  it('closes an ask on another member\'s reply in its thread, not on the asker\'s own follow-up', () => {
    const asked = foldSummary(EMPTY_SUMMARY, [msg(0, 'who can review the PR?')]);
    const followUp = foldSummary(asked, [msg(5, 'bumping this', { parentId: 'm0', rootId: 'm0' })]);
    expect(followUp.openAsks.map(a => a.messageId)).toEqual(['m0']);
    const answered = foldSummary(followUp, [msg(1, 'I will', { parentId: 'm0', rootId: 'm0' })]);
    expect(answered.openAsks).toEqual([]);
    expect(answered.closedAsks).toBe(1);
    expect(answered.recentlyClosed[0]).toMatchObject({ messageId: 'm0', closedBy: 'Ben' });
    const selfClosed = foldSummary(asked, [msg(5, 'never mind, done', { parentId: 'm0', rootId: 'm0' })]);
    expect(selfClosed.openAsks).toEqual([]);
  });

  it('never opens an ask from an outbound message', () => {
    const state = foldSummary(EMPTY_SUMMARY, [msg(0, 'Shall I open a task?', { direction: 'out' })]);
    expect(state.openAsks).toEqual([]);
  });

  it('refreshes on the message threshold and on the byte threshold', () => {
    expect(needsRefresh(TAIL_MESSAGES + REFRESH_MESSAGES - 1, 0)).toBe(false);
    expect(needsRefresh(TAIL_MESSAGES + REFRESH_MESSAGES, 0)).toBe(true);
    expect(needsRefresh(TAIL_MESSAGES + 2, REFRESH_BYTES)).toBe(true);
    expect(needsRefresh(TAIL_MESSAGES, REFRESH_BYTES * 4)).toBe(false);
  });

  it('S (§7.3): 2,000 messages keep the chat context within budget and the summary still names open asks', () => {
    const log = groupLog();
    const { summary, tail, folds } = rollThrough(log);
    expect(folds).toBeGreaterThan(20);
    expect(summary!.coveredMessages + tail.length).toBe(2000);
    expect(tail.length).toBeGreaterThanOrEqual(TAIL_MESSAGES);
    expect(tail.length).toBeLessThan(TAIL_MESSAGES + REFRESH_MESSAGES);

    const budget = 32_768;
    const groupMax = Math.min(GROUP_CONTEXT_MAX_BYTES, Math.floor(budget / 2));
    const group = renderGroupContext({ bridgeId: 'b1', title: 'Infra', purpose: 'infra on-call', summary, tail,
      onWhat: [{ taskId: 't1', title: 'Rotate staging password', status: 'working', assignees: ['Ben'] }], maxBytes: groupMax });
    expect(Buffer.byteLength(canonicalJson(group.content), 'utf8')).toBeLessThanOrEqual(groupMax);

    const projected = projectHistory(Array.from({ length: 60 }, (_, i) => turn(i + 1)), {
      snapshotId: 's', currentTurnOrdinal: 61, captureHighWater: 1, authorityScopeDigest: 'a', maxBytes: budget, groupContext: group });
    expect(Buffer.byteLength(projected.renderedContext, 'utf8')).toBeLessThanOrEqual(budget);
    const rendered = projected.renderedContext;
    // The oldest open ask (message 3 of 2,000) survives 30+ folds.
    expect(rendered).toContain('rotate the staging database password');
    // Unanswered asks are named; answered ones are not.
    expect(rendered).toContain('question 1960: who can look at the flaky deploy 1960?');
    expect(summary!.state.openAsks.map(a => a.messageId)).not.toContain('m1920');
    expect(summary!.state.recentlyClosed[0]).toMatchObject({ messageId: 'm1920', closedBy: 'Ben' });
    // Every unanswered ask the fold covered is still open: m3 plus each 40 mod 80 before the tail.
    const covered = log.slice(0, summary!.coveredMessages);
    const expected = covered.filter(m => m.id === 'm3' || (Number(m.id.slice(1)) % 80 === 40)).map(m => m.id);
    expect(summary!.state.openAsks.map(a => a.messageId)).toEqual(expected);
    expect(rendered).toContain('Rotate staging password');
    // The newest message is verbatim, and the newest turn survives beside the group record.
    expect(rendered).toContain('chatter 1999 about lunch');
    expect(rendered).toContain('request 60');
    expect(projected.manifest[0]).toMatchObject({ sourceId: 'bridge-summary:b1', treatment: 'summarized' });
    const content = group.content as { summary: { coveredMessages: number; openAsks: unknown[]; openAsksNotNamed: number } };
    expect(content.summary.coveredMessages).toBe(summary!.coveredMessages);
    expect(content.summary.openAsks.length + content.summary.openAsksNotNamed).toBe(summary!.state.openAsks.length + summary!.state.droppedAsks);
  });

  it('keeps the group record within a small budget by trimming the tail before the asks', () => {
    const { summary, tail } = rollThrough(groupLog());
    const group = renderGroupContext({ bridgeId: 'b1', title: 'Infra', purpose: null, summary, tail, onWhat: [], maxBytes: 6_000 });
    expect(Buffer.byteLength(canonicalJson(group.content), 'utf8')).toBeLessThanOrEqual(6_000);
    expect(canonicalJson(group.content)).toContain('rotate the staging database password');
  });

  it('is deterministic: the same log folds to the same summary', () => {
    const a = rollThrough(groupLog());
    const b = rollThrough(groupLog());
    expect(canonicalJson(a.summary!.state)).toBe(canonicalJson(b.summary!.state));
  });
});
