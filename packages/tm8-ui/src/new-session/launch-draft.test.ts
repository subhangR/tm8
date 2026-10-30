// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { clearDraft, readDraft, writeDraft } from './launch-draft';

describe('launch draft', () => {
  beforeEach(() => window.localStorage.clear());

  it('keeps a connector pick across a close, even with no notes', () => {
    writeDraft('task-1', { notes: '', mcpSelections: [{ serverId: 'qa_beta', credentialId: 'work' }] });
    expect(readDraft('task-1')?.mcpSelections).toEqual([{ serverId: 'qa_beta', credentialId: 'work' }]);
  });

  it('keeps an explicit "none" ([]) and drops an untouched selection', () => {
    writeDraft('task-1', { notes: '', mcpSelections: [] });
    expect(readDraft('task-1')?.mcpSelections).toEqual([]);
    writeDraft('task-1', { notes: '' });
    expect(readDraft('task-1')).toBeNull();
  });

  it('is cleared with the rest of the draft', () => {
    writeDraft('task-1', { notes: 'x', mcpSelections: [{ serverId: 'qa_alpha' }] });
    clearDraft('task-1');
    expect(readDraft('task-1')).toBeNull();
  });
});
