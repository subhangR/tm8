import { useEffect, useState } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import type { FileUploadTask } from '../files/upload';
import type { TriggerOption } from '../rich-input';
import type { LoopsClient, LoopView } from './api';
import { LoopForm } from './LoopForm';
import type { LoopFormSources } from './sources';

/** What `useEntityEdit` hands the edit dialog for a loop. */
export interface LoopEditor {
  loopId: EntityId;
  spaceId: SpaceId;
  client: LoopsClient;
  sources: LoopFormSources;
  onSaved(view: LoopView): void;
}

/**
 * The panel's Edit verb for a loop: read the loop through `loops.get` (the
 * form needs the whole definition and the version it guards), then open the
 * same form the create flow uses, prefilled. The form owns Escape once it is
 * open (it refuses it mid-save); until then this dialog does.
 */
export function LoopEditDialog({ editor, onClose, skillOptions, attach, onAttached }: {
  editor: LoopEditor;
  onClose(): void;
  /** The instructions field's `/` skills and uploader, as the generic edit dialog's prose fields get them. */
  skillOptions?: readonly TriggerOption[];
  attach?: (file: File) => FileUploadTask;
  onAttached?: () => void;
}) {
  const [state, setState] = useState<{ phase: 'loading' } | { phase: 'ready'; view: LoopView } | { phase: 'error'; message: string }>({ phase: 'loading' });
  const { client, loopId } = editor;
  useEffect(() => {
    let live = true;
    client.get(loopId).then(
      view => { if (live) setState({ phase: 'ready', view }); },
      (error: unknown) => { if (live) setState({ phase: 'error', message: error instanceof Error ? error.message : 'The loop could not be read.' }); },
    );
    return () => { live = false; };
  }, [client, loopId]);

  const reading = state.phase !== 'ready';
  useEffect(() => {
    if (!reading) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [reading, onClose]);

  if (state.phase !== 'ready') {
    return (
      <div className="au-dialog__backdrop" role="presentation" onMouseDown={onClose}>
        <div className="au-dialog" role="dialog" aria-modal="true" aria-label="Edit loop" onMouseDown={event => event.stopPropagation()}>
          <h2 className="au-dialog__title">Edit loop</h2>
          {state.phase === 'loading'
            ? <p className="loop-form__muted">Reading the loop…</p>
            : <p className="au-dialog__missing" role="alert">{state.message}</p>}
          <div className="au-dialog__actions"><button type="button" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }
  return (
    <LoopForm
      mode="edit"
      spaceId={editor.spaceId}
      client={client}
      sources={editor.sources}
      view={state.view}
      onClose={onClose}
      onSaved={view => { editor.onSaved(view); onClose(); }}
      {...(skillOptions ? { skillOptions } : {})}
      {...(attach ? { attach } : {})}
      {...(onAttached ? { onAttached } : {})}
    />
  );
}
