/**
 * An agent's requests the human must answer (API doc 01a115c4 §5.11–§5.12,
 * D8): "<agent> wants to switch to Billing" [Switch] [Stay], and "<agent>
 * wants to delete Scratch" [Delete] [Keep]. Non-modal, in the notice region,
 * one card per open prompt, oldest first. They arrive as `workspace.prompt`
 * frames (and with `workspace.list`), so only a capable window shows them.
 *
 * The answer is `workspace.prompts.resolve`; the node's frames are what take
 * the card away, but an answered card goes at once. F1: Delete on a workspace
 * with unsaved drafts comes back `unsaved_changes`; the card then asks
 * "Discard unsaved changes and delete?" and re-sends with `discard`. A prompt
 * the node no longer knows (`prompt_not_found`) or already answered
 * (`prompt_resolved`) is dropped quietly. Disabled while offline (S13).
 */
import { useState } from 'react';
import { useStore } from 'zustand';
import type { WorkspacePrompt } from '@tm8/contract';

import type { WorkspaceManagePort } from '../../data/seam';
import { actorLabel } from '../bridge/notices';
import { WORKSPACE_SWITCHER_OFFLINE, type WorkspaceListStore } from '../bridge/workspaceList';
import { manageRefusalCopy, reasonOf } from './WorkspaceSwitcher';

export interface WorkspacePromptsProps {
  store: WorkspaceListStore;
  spaceId: string;
  manage: WorkspaceManagePort | undefined;
  notify(text: string): void;
}

/** The prompt's question, as the card reads. */
export function promptLine(prompt: WorkspacePrompt): string {
  const actor = actorLabel('agent', prompt.actorName);
  return prompt.kind === 'switch'
    ? `${actor} wants to switch to ${prompt.workspaceName}`
    : `${actor} wants to delete ${prompt.workspaceName}`;
}

const QUIET = new Set(['prompt_not_found', 'prompt_resolved']);

export function WorkspacePrompts(props: WorkspacePromptsProps) {
  const { store, spaceId, manage, notify } = props;
  const capable = useStore(store, (s) => s.capable);
  const online = useStore(store, (s) => s.online);
  const prompts = useStore(store, (s) => s.prompts);
  /** F1: prompts whose Delete came back `unsaved_changes`, with the draft count. */
  const [confirming, setConfirming] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);

  if (!capable || prompts.length === 0) return null;

  const forget = (promptId: string) => {
    setConfirming(({ [promptId]: _gone, ...rest }) => rest);
    store.getState().dropPrompt(promptId);
  };

  const answer = async (prompt: WorkspacePrompt, choice: 'accept' | 'decline', discard = false) => {
    if (!manage || !store.getState().online) return;
    const id = prompt.promptId;
    setBusy(id);
    try {
      const result = await manage.resolvePrompt(spaceId, id, choice, discard);
      if (result.status === 'rejected' && result.reason === 'unsaved_changes') {
        setConfirming((current) => ({ ...current, [id]: result.dirtyDraftIds?.length ?? 0 }));
        return;
      }
      if (result.status === 'rejected' || result.status === 'conflict') notify(manageRefusalCopy(reasonOf(result)));
      forget(id);
    } catch (error) {
      const reason = reasonOf(error);
      if (!reason || !QUIET.has(reason)) notify(manageRefusalCopy(reason));
      forget(id);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="tws-prompts" data-testid="workspace-prompts">
      {prompts.map((prompt) => {
        const id = prompt.promptId;
        const dirty = confirming[id];
        const disabled = !online || busy === id;
        const title = online ? undefined : WORKSPACE_SWITCHER_OFFLINE;
        const [yes, no] = prompt.kind === 'switch' ? ['Switch', 'Stay'] : ['Delete', 'Keep'];
        return (
          <div key={id} className="shell-notice shell-notice--info tws-prompt" role="alertdialog" aria-label={promptLine(prompt)}>
            <span className="shell-notice__glyph" aria-hidden="true">◬</span>
            <div className="shell-notice__text">
              <span className="shell-notice__title">
                {dirty === undefined ? promptLine(prompt) : 'Discard unsaved changes and delete?'}
              </span>
              {dirty !== undefined ? (
                <span className="shell-notice__body">
                  {dirty === 1 ? `1 unsaved draft in ${prompt.workspaceName}` : `${dirty} unsaved drafts in ${prompt.workspaceName}`}
                </span>
              ) : null}
            </div>
            <div className="tws-prompt__choices">
              <button
                type="button"
                className="shell-notice__action"
                disabled={disabled}
                title={title}
                onClick={() => void answer(prompt, 'accept', dirty !== undefined)}
              >
                {dirty === undefined ? yes : 'Discard and delete'}
              </button>
              <button type="button" className="shell-notice__action" disabled={disabled} title={title} onClick={() => void answer(prompt, 'decline')}>
                {no}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
