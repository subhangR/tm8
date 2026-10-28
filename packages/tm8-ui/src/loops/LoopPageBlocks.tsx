import type { ReactNode } from 'react';
import type { CommandContext, CommandResult, EntityDetail, EntityId } from '@tm8/contract';
import { LoopDefinitionBlock, type LoopDefinitionSection } from './LoopDefinition';
import { LoopFormDialog, type LoopFormSources } from './LoopForm';
import { LoopHeader, type LoopHeaderProps } from './LoopHeader';
import { LoopRuns } from './LoopRuns';
import type { LoopPagePort } from './page-port';
import { errorText, isNotImplemented } from './page-format';
import { useLoopView } from './useLoopView';
import './page.css';

/*
 * The registry blocks of the loop page (`loop-header`, `loop-definition`,
 * `loop-runs`). Each is mounted by GenericBody on its own; they share one
 * `loops.get` read through `useLoopView`, keyed by the loop id and re-read
 * when the panel's entity version moves.
 */

interface BlockProps {
  detail: EntityDetail;
  port: LoopPagePort | null | undefined;
  /** PR5a's bound seam reads: entity titles for the chips, pickers for the Edit form. */
  sources?: LoopFormSources | null;
  onOpenEntity?: (id: string) => void;
}

function Unwired() {
  return <p className="loop-page__hint" role="status">Loop controls are not wired on this surface (no loops client).</p>;
}

function useView({ detail, port }: BlockProps) {
  return useLoopView(port, detail.id, detail.version);
}

function ViewState({ slot, children }: { slot: ReturnType<typeof useView>; children: ReactNode }) {
  if (slot.view) return <>{children}</>;
  if (slot.error) {
    return (
      <div role="alert" className="loop-page__error">
        <p>{isNotImplemented(slot.error)
          ? 'This server does not serve loops.get yet (501 not implemented).'
          : errorText(slot.error, 'The loop could not be loaded.')}</p>
        <button type="button" className="pn-btn" onClick={() => void slot.reload()}>Retry</button>
      </div>
    );
  }
  return <p className="loop-page__hint" role="status">Loading loop…</p>;
}

export function LoopHeaderBlock(props: BlockProps & {
  deleteEntity?: (id: EntityId, ctx?: CommandContext) => Promise<CommandResult>;
}) {
  const slot = useView(props);
  const { port, sources } = props;
  if (!port) return <Unwired />;
  /* Edit opens PR5a's form over the view this page already holds, so the
     version it guards is the one the header is showing. */
  const renderEditor: LoopHeaderProps['renderEditor'] = sources
    ? ({ view, onClose, onSaved }) => (
      <LoopFormDialog mode="edit" spaceId={view.spaceId} client={port} sources={sources} view={view} onSaved={onSaved} onClose={onClose} />
    )
    : undefined;
  return (
    <ViewState slot={slot}>
      {slot.view ? (
        <LoopHeader
          view={slot.view}
          port={port}
          onView={slot.setView}
          onReload={slot.reload}
          onRunsChanged={slot.bumpRuns}
          onOpenEntity={props.onOpenEntity}
          deleteEntity={props.deleteEntity}
          renderEditor={renderEditor}
        />
      ) : null}
    </ViewState>
  );
}

export function LoopDefinitionHost(props: BlockProps & { section: LoopDefinitionSection }) {
  const slot = useView(props);
  if (!props.port) return null;
  // The header draws the load error once; the definition sections stay quiet until there is a view.
  if (!slot.view) return null;
  const reader = props.sources?.entity ? (props.sources as { entity: NonNullable<LoopFormSources['entity']> }) : null;
  return <LoopDefinitionBlock section={props.section} view={slot.view} reader={reader} onOpenEntity={props.onOpenEntity} />;
}

export function LoopRunsBlock(props: BlockProps) {
  const slot = useView(props);
  if (!props.port) return <Unwired />;
  return (
    <LoopRuns
      loopId={props.detail.id}
      port={props.port}
      canControl={slot.view?.capabilities.canControl ?? false}
      epoch={slot.runsEpoch}
      onOpenEntity={props.onOpenEntity}
      onChanged={() => void slot.reload()}
    />
  );
}

export function definitionSection(value: unknown): LoopDefinitionSection {
  return value === 'schedule' || value === 'settings' ? value : 'what';
}
