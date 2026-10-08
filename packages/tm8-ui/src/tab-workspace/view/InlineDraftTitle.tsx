import { useEffect, useRef, useSyncExternalStore } from 'react';
import { subscribeDrafts } from '../runtime/draftStore';
import { requestDraftSubmit } from '../runtime/draftSubmit';
import type { DraftTabRecord } from '../runtime/types';
import { useWorkspace } from './context';

/** The provisional row and detail tab edit the same existing draft record. */
export function InlineDraftTitle({ tab }: { tab: DraftTabRecord }) {
  const { runtime } = useWorkspace();
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => field.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  useSyncExternalStore(subscribeDrafts, () => runtime.drafts.revisionOf(tab.draftId) + runtime.drafts.remoteVersionOf(tab.draftId));
  const values = runtime.drafts.get(tab.draftId) ?? {};
  const title = typeof values.title === 'string' ? values.title : '';
  const cancel = () => {
    if (tab.submitting) return;
    runtime.dispatch({ command: 'workspace.drafts.markDirty', args: { tabId: tab.id, dirty: false }, source: 'system' });
    runtime.dispatch({ command: 'workspace.tabs.close', args: { tabId: tab.id }, source: 'system' });
  };
  return <form className="tws-inline-draft" aria-label="New entity title" onSubmit={(event) => {
    event.preventDefault(); if (title.trim()) requestDraftSubmit(tab.id);
  }} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } }}>
    <input ref={field} aria-label="New entity title" autoFocus value={title} disabled={tab.submitting}
      placeholder={`New ${tab.kind.replaceAll('_', ' ')} title`} onChange={(event) => {
        runtime.drafts.set(tab.draftId, { ...values, title: event.target.value });
        runtime.dispatch({ command: 'workspace.drafts.markDirty', args: { tabId: tab.id, dirty: true }, source: 'keyboard' });
      }} />
    <button type="submit" disabled={!title.trim() || tab.submitting}>Save</button>
    <button type="button" disabled={tab.submitting} onClick={cancel}>Cancel</button>
  </form>;
}
