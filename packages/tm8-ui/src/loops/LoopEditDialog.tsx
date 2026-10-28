import { useEffect, useState } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import type { LoopsClient, LoopView } from './api';
import { LoopFormDialog, type LoopFormSources } from './LoopForm';

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
 * same form the create flow uses, prefilled.
 */
export function LoopEditDialog({ editor, onClose }: { editor: LoopEditor; onClose(): void }) {
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
    <LoopFormDialog
      mode="edit"
      spaceId={editor.spaceId}
      client={client}
      sources={editor.sources}
      view={state.view}
      onClose={onClose}
      onSaved={view => { editor.onSaved(view); onClose(); }}
    />
  );
}
