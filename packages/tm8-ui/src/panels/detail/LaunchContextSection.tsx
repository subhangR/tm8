import type { LaunchContextEntry, SessionLaunchRecord } from '@tm8/contract';
import { Chip, Eyebrow } from '../../kit';
import {
  KindIcon,
  LAUNCH_CONTEXT_ROLE_LABEL,
  LAUNCH_CONTEXT_SOURCE_LABEL,
  launchContextFacts,
  launchHarnessFacts,
  type ManifestFact,
} from '../../domain';

export type LaunchContextState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; record: SessionLaunchRecord };

/**
 * LAUNCH CONTEXT — every selection that went into a session's launch, at the
 * top of its Connections tab: the entities it loaded (each with where it came
 * from), the launch facts, and the harness (as recorded, else as declared).
 *
 * Presentational: the host-wired surface (`views/launchContextSurface.tsx`)
 * reads the launch record once and hands its state in. Entity rows are
 * already filtered for the viewer by the server; what they cannot read
 * arrives as a count and is shown as one.
 */
export function LaunchContextSection({
  state,
  onOpenEntity,
}: {
  state: LaunchContextState;
  onOpenEntity?: (id: string) => void;
}) {
  if (state.phase !== 'ready') {
    return (
      <section className="pn-section pn-launch" data-testid="launch-context">
        <Eyebrow faint>LAUNCH CONTEXT</Eyebrow>
        {state.phase === 'loading' ? (
          <p className="pn-launch__note" role="status">Reading the launch record…</p>
        ) : (
          <p className="pn-launch__note" role="alert">{`Launch context unavailable: ${state.message}`}</p>
        )}
      </section>
    );
  }

  const { record } = state;
  const context = record.launchContext;
  if (!record.available || !context) {
    return (
      <section className="pn-section pn-launch" data-testid="launch-context">
        <Eyebrow faint>LAUNCH CONTEXT</Eyebrow>
        <p className="pn-launch__note" data-testid="launch-context-not-recorded">
          Launch context not recorded for this session.
        </p>
      </section>
    );
  }

  const titles = new Map(context.entries.map((e) => [e.entityId, e.title]));
  const count = context.entries.length + context.unlinkedMemories.length + context.hiddenCount;
  const facts = [
    ...launchContextFacts(record.manifest).filter(hasValue),
    // No graph entity, so no row; counted so nothing drops silently.
    ...(context.unlinkedSkillCount > 0
      ? [{ label: 'File-only skills', value: String(context.unlinkedSkillCount), mono: true }]
      : []),
  ];
  // The declared harness is the teammate's own configuration: shown only when
  // the viewer can read that teammate, i.e. when its row came back.
  const teammateVisible = context.entries.some((e) => e.role === 'teammate');
  const harness = launchHarnessFacts(record.manifest);
  const harnessFacts = teammateVisible ? harness.facts.filter(hasValue) : [];

  return (
    <section className="pn-section pn-launch" data-testid="launch-context">
      <Eyebrow faint>{`LAUNCH CONTEXT · ${count}`}</Eyebrow>
      {count > 0 ? (
        <ul className="pn-peers">
          {context.entries.map((entry) => (
            <EntryRow
              key={`${entry.role}:${entry.entityId}`}
              entry={entry}
              viaTitle={entry.viaTaskId ? titles.get(entry.viaTaskId) ?? null : null}
              onOpenEntity={onOpenEntity}
            />
          ))}
          {context.unlinkedMemories.map((text, index) => (
            <li className="pn-peers__row" key={`memory-text:${index}`} data-testid="launch-context-memory-text">
              <span className="pn-launch__text">{text}</span>
              <div className="pn-peers__rels">
                <span className="pn-peers__rel">memory</span>
                <span className="pn-peers__rel pn-launch__badge" title="Recorded as text, with no entity id">
                  text only
                </span>
              </div>
            </li>
          ))}
          {context.hiddenCount > 0 ? (
            <li className="pn-launch__note" data-testid="launch-context-hidden">
              {`${context.hiddenCount} more not shown: you can't read ${context.hiddenCount === 1 ? 'it' : 'them'}, or ${context.hiddenCount === 1 ? 'it was' : 'they were'} deleted`}
            </li>
          ) : null}
        </ul>
      ) : null}
      <FactStrip label="LAUNCH" facts={facts} testId="launch-context-facts" />
      <FactStrip
        label={harness.recorded ? 'HARNESS' : 'HARNESS · DECLARED'}
        facts={harnessFacts}
        testId="launch-context-harness"
      />
    </section>
  );
}

function EntryRow({
  entry,
  viaTitle,
  onOpenEntity,
}: {
  entry: LaunchContextEntry;
  viaTitle: string | null;
  onOpenEntity?: (id: string) => void;
}) {
  const source = LAUNCH_CONTEXT_SOURCE_LABEL[entry.source];
  const role = entry.skillLoad ? `${LAUNCH_CONTEXT_ROLE_LABEL[entry.role]} · ${entry.skillLoad}` : LAUNCH_CONTEXT_ROLE_LABEL[entry.role];
  return (
    <li className="pn-peers__row" data-testid="launch-context-entry">
      <Chip glyph={<KindIcon kind={entry.kind} />} onClick={() => onOpenEntity?.(entry.entityId)} title={entry.title}>
        {entry.title}
      </Chip>
      <div className="pn-peers__rels">
        <span className="pn-peers__rel">{role}</span>
        <span
          className="pn-peers__rel pn-launch__badge"
          data-source={entry.source}
          title={viaTitle ? `${source.title}: ${viaTitle}` : source.title}
        >
          {source.text}
        </span>
        {entry.jev ? (
          <span className="pn-peers__rel" title={`Ask Jev score ${entry.jev.score}`}>
            {entry.jev.level}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function FactStrip({ label, facts, testId }: { label: string; facts: ManifestFact[]; testId: string }) {
  if (facts.length === 0) return null;
  return (
    <div className="pn-launch__facts" data-testid={testId}>
      <Eyebrow faint>{label}</Eyebrow>
      <dl>
        {facts.map((fact) => (
          <div className="pn-launch__fact" key={fact.label}>
            <dt>{fact.label}</dt>
            <dd className={fact.mono ? 'pn-launch__mono' : undefined}>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function hasValue(fact: ManifestFact): boolean {
  return fact.value !== null;
}
