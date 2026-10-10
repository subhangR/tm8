import { useEffect, useRef, useState } from 'react';
import type { ChatCredentialSelection, EntityId, SpaceId } from '@tm8/contract';
import { ComposerSelect, type ComposerSelectOption } from './ComposerSelect';
import type { ChatHomePort } from './types';

export function credentialValue(selection: ChatCredentialSelection): string {
  return selection.credentialId ? `space:${selection.credentialId}` : selection.source;
}
export function credentialSelection(value: string): ChatCredentialSelection {
  return value.startsWith('space:')
    ? { source: 'space', credentialId: value.slice(6) as EntityId }
    : { source: value as ChatCredentialSelection['source'] };
}

export function ChatCredentialPicker({ port, spaceId, model, value, onChange, disabled, backendKeyOnly }: {
  port: ChatHomePort; spaceId: SpaceId | string; value: ChatCredentialSelection;
  model?: string;
  onChange: (selection: ChatCredentialSelection) => void; disabled: boolean; backendKeyOnly: boolean;
}) {
  const portRef = useRef(port); portRef.current = port;
  const [credentials, setCredentials] = useState<readonly { id: string; label: string }[]>([]);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setCredentials([]);
    setNote(null);
    const load = () => {
      void portRef.current.credentialOptions?.(spaceId, model).then(
        rows => { if (live) { setCredentials(rows); setNote(null); } },
        () => { if (live) setNote('Could not read space credentials. You can retry by reopening this chat.'); },
      );
    };
    load();
    window.addEventListener('focus', load);
    return () => { live = false; window.removeEventListener('focus', load); };
  }, [spaceId, model]);
  const reason = backendKeyOnly ? 'This model requires your own connected provider key' : undefined;
  const options: ComposerSelectOption[] = [
    { id: 'auto', label: 'Auto', hint: 'Your default → connected login → space default → allowed server login' },
    { id: 'member', label: 'Mine', hint: 'Use my connected account; refuse if unavailable' },
    { id: 'space', label: 'Space default', hint: 'Use this space’s default model credential', disabledReason: reason },
    { id: 'node', label: 'Server', hint: 'Use the server’s account, when policy allows', disabledReason: reason },
    ...credentials.map(row => ({ id: `space:${row.id}`, label: row.label, group: 'Space credentials', disabledReason: reason })),
  ];
  // A saved reference remains visible if it is later revoked or unreadable.
  if (value.credentialId && !credentials.some(row => row.id === value.credentialId)) {
    options.push({ id: credentialValue(value), label: 'Selected space credential', disabledReason: 'Unavailable or no longer accessible' });
  }
  return <ComposerSelect label="Chat credentials" testId="tch-credentials" options={options}
    value={credentialValue(value)} onChange={next => onChange(credentialSelection(next))}
    disabled={disabled} emptyNote="No credentials available."
    note={note ?? 'Changes apply to the next turn. The conversation carries across models and accounts.'} tall />;
}
