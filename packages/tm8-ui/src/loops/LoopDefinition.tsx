import type { ReactNode } from 'react';
import type { EntityDetail, EntityId } from '@tm8/contract';
import { KindIcon } from '../domain/KindIcon';
import { Chip } from '../kit/Chip';
import { useNow } from '../kit/time';
import { relTime } from '@tm8/client-core/time';
import type { LoopView } from './page-port';
import { entityRefLabel, useEntityRef } from './use-entity-ref';
import { durationLabel, zonedInstant } from './page-format';

/*
 * THE DEFINITION, READ BACK IN WORDS. The old panel printed `teamMemberId`
 * and `config` as raw ids and JSON; every id here resolves to a named chip
 * (or says it cannot), and every config member reads as a sentence, so a
 * human can tell what a loop does without decoding it.
 */

export type LoopDefinitionSection = 'what' | 'schedule' | 'settings';

/** Reads entity titles for the chips (`commands.loopForm`, PR5a's bound seam reads). */
export type LoopEntityReader = { entity(id: EntityId): Promise<EntityDetail> };

/** A named chip for an entity id; never the id itself. */
export function LoopEntityChip({
  id,
  reader,
  onOpenEntity,
  fallback,
}: {
  id: string;
  reader: LoopEntityReader | null | undefined;
  onOpenEntity?: (id: string) => void;
  /** What to call it while unresolved ("Teammate", "Tool"). */
  fallback: string;
}) {
  const state = useEntityRef(reader, id as EntityId);
  const ref = state.status === 'ready' ? state.ref : null;
  return (
    <span data-testid="loop-entity-chip">
      <Chip
        glyph={ref ? <KindIcon kind={ref.kind} /> : undefined}
        kind={ref?.kind}
        title={ref ? `Open ${ref.title}` : undefined}
        onClick={onOpenEntity ? () => onOpenEntity(id) : undefined}
      >
        {entityRefLabel(state, fallback)}
      </Chip>
    </span>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  );
}

function inputValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '—';
  return JSON.stringify(value);
}

function WhatItRuns({ view, reader, onOpenEntity }: SectionProps) {
  const d = view.definition;
  const chip = (id: string, fallback: string) => (
    <LoopEntityChip id={id} reader={reader} onOpenEntity={onOpenEntity} fallback={fallback} />
  );
  const inputs = Object.entries(d.toolInputs ?? {});
  return (
    <dl className="loop-page__dl" data-testid="loop-what">
      {d.action === 'spawn' ? (
        <Row term="Runs">{d.teamMemberId ? chip(d.teamMemberId, 'Teammate') : 'A teammate (none set — the loop cannot fire)'}</Row>
      ) : d.action === 'dispatch' ? (
        <Row term="Runs">Dispatcher decides — the Dispatcher picks a teammate on each firing</Row>
      ) : (
        <>
          <Row term="Runs tool">{d.toolId ? chip(d.toolId, 'Tool') : 'A tool (none set — the loop cannot fire)'}</Row>
          <Row term="Runs as">{d.teamMemberId ? chip(d.teamMemberId, 'Teammate') : 'No persona (the tool runs without tm8 access)'}</Row>
          <Row term="Inputs">
            {inputs.length === 0 ? 'None' : (
              <ul className="loop-page__inputs">
                {inputs.map(([name, value]) => <li key={name}><code>{name}</code> = {inputValue(value)}</li>)}
              </ul>
            )}
          </Row>
        </>
      )}
      <Row term="About">{d.subjectId ? chip(d.subjectId, 'Subject') : 'This loop itself'}</Row>
      <Row term="Instructions">
        {d.prompt ? <span className="loop-page__prompt">{d.prompt}</span> : 'None — the firing carries only the loop title'}
      </Row>
    </dl>
  );
}

function Schedule({ view }: SectionProps) {
  const now = useNow();
  const zone = view.definition.timezone || 'UTC';
  const preview = view.schedule;
  return (
    <div data-testid="loop-schedule">
      <p className="loop-page__line">
        <strong>{preview.summary || view.definition.schedule}</strong>
        <span className="loop-page__hint"> · <code>{view.definition.schedule}</code> · {zone}</span>
      </p>
      {!preview.valid ? (
        <p role="alert" className="loop-page__error">{`This schedule cannot fire: ${preview.problem ?? 'it did not parse'}`}</p>
      ) : preview.next.length === 0 ? (
        <p className="loop-page__hint">No upcoming firings.</p>
      ) : (
        <ol className="loop-page__next" aria-label="Next runs">
          {preview.next.slice(0, 5).map((at) => (
            <li key={at} title={at}>{zonedInstant(at, zone)} <span className="loop-page__hint">({relTime(at, now)})</span></li>
          ))}
        </ol>
      )}
    </div>
  );
}

const CONCURRENCY: Record<string, string> = {
  skip: 'Skip a firing while the previous run is still live',
  queue: 'Wait for the previous run, then fire',
};

function Settings({ view, reader, onOpenEntity }: SectionProps) {
  const d = view.definition;
  const c = d.config ?? {};
  const def = 'Persona default';
  const retries = d.retry?.attempts ?? 0;
  return (
    <dl className="loop-page__dl" data-testid="loop-settings">
      {d.action !== 'tool' ? (
        <>
          <Row term="Model">{c.model ?? def}</Row>
          <Row term="Agent tool">{c.agentTool ?? def}</Row>
          <Row term="Reasoning effort">{c.reasoningEffort ?? def}</Row>
          <Row term="Access mode">{c.accessMode ?? def}</Row>
          <Row term="Mode">{c.mode ?? def}</Row>
          <Row term="Project">{c.projectId ? <LoopEntityChip id={c.projectId} reader={reader} onOpenEntity={onOpenEntity} fallback="Project" /> : 'None'}</Row>
          <Row term="Working directory">{c.workdir ? `${c.workdir.mode}${c.workdir.baseRef ? ` from ${c.workdir.baseRef}` : ''}` : def}</Row>
          <Row term="Memories">
            {c.memoryIds && c.memoryIds.length > 0
              ? c.memoryIds.map((id) => <LoopEntityChip key={id} id={id} reader={reader} onOpenEntity={onOpenEntity} fallback="Memory" />)
              : 'None'}
          </Row>
          <Row term="Credentials">{c.credentialSource ? inputValue(c.credentialSource) : def}</Row>
          <Row term="Interaction profile">{c.interactionProfileId ? <LoopEntityChip id={c.interactionProfileId} reader={reader} onOpenEntity={onOpenEntity} fallback="Profile" /> : def}</Row>
        </>
      ) : null}
      <Row term="Concurrency">{CONCURRENCY[d.concurrency] ?? d.concurrency}</Row>
      <Row term="Max runtime">{d.maxRuntimeSeconds ? durationLabel(d.maxRuntimeSeconds * 1000) : 'No limit'}</Row>
      <Row term="Retry">
        {retries === 0 ? 'No retries' : `${retries} ${retries === 1 ? 'retry' : 'retries'}, ${durationLabel(d.retry.delaySeconds * 1000)} apart, when a firing fails to launch`}
      </Row>
    </dl>
  );
}

interface SectionProps {
  view: LoopView;
  reader: LoopEntityReader | null | undefined;
  onOpenEntity?: (id: string) => void;
}

export function LoopDefinitionBlock({ section, ...props }: SectionProps & { section: LoopDefinitionSection }) {
  if (section === 'what') return <WhatItRuns {...props} />;
  if (section === 'schedule') return <Schedule {...props} />;
  return <Settings {...props} />;
}
