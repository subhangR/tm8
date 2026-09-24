/**
 * Configs — every knob that shapes tm8's behaviour, with its current value.
 *
 * READ-ONLY, AND IT HOLDS NO LIST OF ITS OWN. Everything drawn here is what
 * `spaces.configs` answers, and that answer is built from the server's config
 * registry (`packages/server/src/configs/registry.ts`). A new knob is one
 * registry entry and appears here without a UI edit.
 *
 * Secrets arrive already redacted — `{ kind: 'secret', present }` — so there
 * is no value in the browser to hide. Node env arrives only for a node admin;
 * anyone else gets the server's reason, drawn as it is.
 */
import { useEffect, useState } from 'react';
import type { ConfigKnobView, ConfigSubjectView, ConfigValue, SpaceConfigsView } from '@tm8/contract';
import { SectionAbsent, SectionFrame } from './SectionFrame';
import './configs-section.css';

export interface ConfigsSectionProps {
  heading: string;
  load?: () => Promise<SpaceConfigsView>;
}

export function valueLabel(value: ConfigValue): string {
  switch (value.kind) {
    case 'value':
      return value.text;
    case 'unset':
      return 'unset';
    case 'secret':
      return value.present ? 'set (value hidden)' : 'not set';
    case 'unobservable':
      return 'not visible to the server';
  }
}

const SOURCE_LABEL: Record<ConfigKnobView['source'], string> = {
  env: 'env',
  persona: 'persona',
  profile: 'profile',
  default: 'default',
  code: 'code constant',
};

function changeLabel(knob: ConfigKnobView, cli: boolean): string {
  switch (knob.change) {
    case 'env':
      return cli ? `set ${knob.name} in your shell` : `set ${knob.name} in the server environment and restart`;
    case 'persona':
      return 'edit the teammate';
    case 'profile':
      return 'edit the interaction profile draft, then validate and activate it';
    case 'code':
      return 'code change';
  }
}

function KnobRow({ knob, cli = false }: { knob: ConfigKnobView; cli?: boolean }) {
  const value = valueLabel(knob.value);
  return (
    <li className="set-configs__knob" data-testid={`config-${knob.name}`}>
      <div className="set-configs__line">
        <code className="set-configs__name">{knob.name}</code>
        <code className={`set-configs__value set-configs__value--${knob.value.kind}`}>{value}</code>
        <span className={`set-configs__source set-configs__source--${knob.source}`}>{SOURCE_LABEL[knob.source]}</span>
      </div>
      <p className="set-configs__summary">{knob.summary}</p>
      <p className="set-configs__meta">
        {knob.default !== null ? <span>default <code>{knob.default}</code> · </span> : null}
        <span>defined at <code>{knob.definedAt}</code> · </span>
        <span>{changeLabel(knob, cli)}</span>
      </p>
    </li>
  );
}

function grouped(knobs: readonly ConfigKnobView[]): [string, ConfigKnobView[]][] {
  const out = new Map<string, ConfigKnobView[]>();
  for (const k of knobs) out.set(k.group, [...(out.get(k.group) ?? []), k]);
  return [...out];
}

function Group({ title, knobs, cli }: { title: string; knobs: readonly ConfigKnobView[]; cli?: boolean }) {
  return (
    <div className="set-configs__group">
      <h4 className="set-configs__group-title">{title}</h4>
      <ul className="set-configs__list">
        {knobs.map((k) => <KnobRow key={k.name} knob={k} cli={cli} />)}
      </ul>
    </div>
  );
}

function Subjects({ subjects, empty }: { subjects: readonly ConfigSubjectView[]; empty: string }) {
  if (subjects.length === 0) return <p className="set-configs__note">{empty}</p>;
  return (
    <>
      {subjects.map((s) => <Group key={s.id} title={s.name} knobs={s.knobs} />)}
    </>
  );
}

export function ConfigsSection({ heading, load }: ConfigsSectionProps) {
  const [view, setView] = useState<SpaceConfigsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!load) return;
    let live = true;
    load().then(
      (next) => { if (live) setView(next); },
      (err: unknown) => { if (live) setError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { live = false; };
  }, [load]);

  if (!load) {
    return (
      <SectionFrame title={heading}>
        <SectionAbsent head="Configs are not wired on this surface." why="this settings host passed no configs reader" />
      </SectionFrame>
    );
  }
  if (error) {
    return (
      <SectionFrame title={heading}>
        <SectionAbsent head="Configs could not be read." why={error} />
      </SectionFrame>
    );
  }
  if (!view) {
    return (
      <SectionFrame title={heading}>
        <p className="set-configs__note">Reading configs…</p>
      </SectionFrame>
    );
  }

  return (
    <SectionFrame title={heading} bodyTestId="configs-body">
      <div className="set-configs">
        <p className="set-configs__lede">
          Every setting and policy constant that shapes how tm8 behaves, with its current value and
          where it comes from. Read-only. Secrets show only whether they are set.
        </p>

        <section className="set-configs__part">
          <h3 className="set-configs__part-title">Node environment</h3>
          {view.node.visible ? (
            grouped(view.node.knobs).map(([group, knobs]) => <Group key={group} title={group} knobs={knobs} />)
          ) : (
            <p className="set-configs__note" data-testid="configs-node-hidden">{view.node.reason}</p>
          )}
        </section>

        <section className="set-configs__part">
          <h3 className="set-configs__part-title">Teammate launch</h3>
          <Subjects subjects={view.teammates} empty="No teammates in this space." />
        </section>

        <section className="set-configs__part">
          <h3 className="set-configs__part-title">Interaction profiles</h3>
          <Subjects subjects={view.profiles} empty="No interaction profiles in this space; sessions use the core default." />
        </section>

        <section className="set-configs__part">
          <h3 className="set-configs__part-title">Code constants</h3>
          {grouped(view.code).map(([group, knobs]) => <Group key={group} title={group} knobs={knobs} />)}
        </section>

        {view.cli.length > 0 ? (
          <section className="set-configs__part">
            <h3 className="set-configs__part-title">CLI environment</h3>
            <Group title="Read by tm8 in your own shell" knobs={view.cli} cli />
          </section>
        ) : null}
      </div>
    </SectionFrame>
  );
}
