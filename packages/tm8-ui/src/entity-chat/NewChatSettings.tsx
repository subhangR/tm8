/**
 * `NewChatSettings` — what `+ New` (or a first chat) shows in the chat panel
 * before the first message (design 01a0da4e §3.4). The DEFAULT `newChatGate`
 * of `EntityChatSlot`, so every place the slot renders gets it with no prop.
 *
 *   1. The subject's kind has a default teammate AND model, and both still
 *      resolve (the teammate exists; the model is in this node's launch
 *      catalog) → NO CARD: the composer opens with them, mode = last used,
 *      project = the entity's own → the space's → scratch. Every one of them
 *      stays editable as the composer's chips.
 *   2. Anything else → THE CARD, in the panel: teammate, model, mode, project,
 *      pre-filled by the same rules; "Use for every ‹Kind› chat" writes the
 *      kind's default; "Start chat" collapses it into the composer's chips and
 *      focuses the message box. A default that no longer resolves is NAMED
 *      here, never swapped silently.
 *
 * NOTHING IS CREATED HERE. `chat.start` needs a body, so the chat exists only
 * once the composer sends; the card chooses settings and nothing else.
 *
 * FRESH EVERY TIME. `spaces.chatDefaults.set` emits no event, so a default
 * saved in another tab is invisible to the shared cache; each mount (each new
 * chat the slot opens) re-reads the defaults before deciding card-vs-skip.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChatMode, EntityId, EntitySummary, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { getKind } from '../domain';
import { modelCatalog } from '../domain/model-catalog';
import {
  customKindLabel,
  lastChatMode,
  lastChatPicks,
  rememberChatStart,
  resolveChatDefault,
  useChatDefaults,
} from '../chat-defaults';
import { MODE_SPECS } from '../chat-home/composer/composer-model';
import type { NewChatSeed } from '../chat-home/types';

export type NewChatSettingsSeam = Pick<
  Seam,
  'chatDefaults' | 'setChatDefaults' | 'query' | 'projects' | 'connections' | 'entity'
>;

export interface NewChatSettingsProps {
  seam: NewChatSettingsSeam;
  spaceId: SpaceId | string;
  nodeKey: string;
  subject: { id: EntityId; kind: string | null };
  /** The composer, started with these chips. */
  composerFor: (seed: NewChatSeed) => ReactNode;
}

interface Option {
  id: string;
  label: string;
}

/** The reads the card and the skip rule both need, taken once per mount. */
interface Facts {
  /** `null` when the roster read failed: nothing can be proven gone. */
  teammates: Option[] | null;
  /** Chat-bindable projects (`projects.id`), as the composer lists them. */
  projects: Option[];
  /** The rule's pick: the entity's own → the space's → `null` (scratch). */
  projectId: EntityId | null;
}

const SCRATCH = '';

function kindLabel(kind: string): string {
  return kind.startsWith('c:') ? customKindLabel(kind) : getKind(kind).label;
}

function projectIdOf(summary: Pick<EntitySummary, 'state'> | null | undefined): EntityId | null {
  const state = summary?.state as { kind?: string; projectId?: string | null } | undefined;
  return state?.kind === 'project' && state.projectId ? (state.projectId as EntityId) : null;
}

/** The subject's own project: itself when it IS one, else its `in_project` edge. */
async function entityProject(seam: NewChatSettingsSeam, subject: NewChatSettingsProps['subject']): Promise<EntityId | null> {
  if (subject.kind === 'project') return projectIdOf(await seam.entity(subject.id));
  const edges = await seam.connections(subject.id, { types: ['in_project'], direction: 'outgoing', limit: 5 });
  for (const edge of edges.items) {
    const id = projectIdOf(edge.target);
    if (id) return id;
  }
  return null;
}

async function readFacts(seam: NewChatSettingsSeam, spaceId: string, subject: NewChatSettingsProps['subject']): Promise<Facts> {
  const [teammates, projects, own, linked] = await Promise.all([
    seam
      .query({ spaceId: spaceId as SpaceId, kinds: ['team_member'], sort: 'activityAt_desc', limit: 100 })
      .then((page) => page.page.items.map((item) => ({ id: item.id, label: item.title })))
      .catch(() => null),
    seam
      .query({ spaceId: spaceId as SpaceId, kinds: ['project'], sort: 'activityAt_desc', limit: 100 })
      .then((page) => page.page.items.flatMap((item) => {
        const id = projectIdOf(item);
        return id ? [{ id, label: item.title }] : [];
      }))
      .catch(() => [] as Option[]),
    entityProject(seam, subject).catch(() => null),
    seam.projects(spaceId as SpaceId).catch(() => []),
  ]);
  const offered = new Set(projects.map((project) => project.id));
  /* The space's project is the one Run starts in: the first trusted link. */
  const spaceProject = linked.find((project) => project.trust === 'trusted')?.id ?? null;
  const projectId = [own, spaceProject].find((id): id is EntityId => !!id && offered.has(id)) ?? null;
  return { teammates, projects, projectId };
}

/** The kind couldn't be learned: the card still shows, with no kind default. */
const UNKNOWN_KIND = '';

export function NewChatSettings({ seam, spaceId, nodeKey, subject, composerFor }: NewChatSettingsProps) {
  /* The host's kind is `null` while ITS subject read is in flight, and stays
     `null` forever if that read fails. Ask once more here, and on a failure
     fall to the card without a kind rather than wait on a kind that won't come. */
  const [readKind, setReadKind] = useState<string | null>(null);
  useEffect(() => {
    if (subject.kind) return;
    let live = true;
    seam.entity(subject.id).then(
      (detail) => { if (live) setReadKind(detail.kind); },
      () => { if (live) setReadKind(UNKNOWN_KIND); },
    );
    return () => { live = false; };
  }, [seam, subject.id, subject.kind]);
  const kind = subject.kind ?? readKind;
  const defaults = useChatDefaults(seam, spaceId, kind || undefined);
  const [fresh, setFresh] = useState(false);
  const [facts, setFacts] = useState<Facts | null>(null);
  const [started, setStarted] = useState<NewChatSeed | null>(null);
  /* DECIDED ONCE per mount. The card's own "Use for every ‹Kind› chat" write
     makes the default resolve a beat before "Start chat" lands; re-deciding
     then would swap the viewer's card choices for the default's. */
  const decided = useRef<NewChatSeed | 'card' | null>(null);
  const models = useMemo(() => modelCatalog(nodeKey).map((model) => ({ id: model.model, label: model.label })), [nodeKey]);

  const { refresh } = defaults;
  useEffect(() => {
    let live = true;
    /* A refusal still settles: the card then shows, with nothing pre-decided. */
    refresh().catch(() => {}).finally(() => { if (live) setFresh(true); });
    return () => { live = false; };
  }, [refresh]);

  useEffect(() => {
    if (kind === null) return;
    let live = true;
    void readFacts(seam, String(spaceId), { id: subject.id, kind }).then((next) => { if (live) setFacts(next); });
    return () => { live = false; };
  }, [seam, spaceId, subject.id, kind]);

  if (started) return <>{composerFor(started)}</>;
  if (kind === null || !fresh || !facts) {
    return <div className="ecp-card__load" role="status" data-testid="new-chat-loading">Loading chat settings…</div>;
  }

  const resolution = resolveChatDefault(defaults.entry, {
    teammateExists: (id) => facts.teammates === null || facts.teammates.some((teammate) => teammate.id === id),
    modelOffered: (model) => models.some((option) => option.id === model),
  });
  const mode = lastChatMode();
  decided.current ??= resolution.skip
    ? { teammateId: resolution.teammateId as EntityId, model: resolution.model, mode, projectId: facts.projectId }
    : 'card';
  if (decided.current !== 'card') return <>{composerFor(decided.current)}</>;
  /* Pre-fill: the resolved default → last used, while it still resolves →
     the first listed. Project keeps its own rule (no last-used). */
  const last = lastChatPicks();
  const lastTeammate = last.teammateId && facts.teammates?.some((teammate) => teammate.id === last.teammateId) ? last.teammateId : null;
  const lastModel = last.model && models.some((option) => option.id === last.model) ? last.model : null;
  return (
    <SettingsCard
      kind={kind}
      entry={defaults.entry}
      problems={resolution.problems}
      teammates={facts.teammates ?? []}
      models={models}
      projects={facts.projects}
      initial={{
        teammateId: resolution.teammateId ?? lastTeammate ?? facts.teammates?.[0]?.id ?? '',
        model: resolution.model ?? lastModel ?? models[0]?.id ?? '',
        mode,
        projectId: facts.projectId ?? SCRATCH,
      }}
      saveDefault={(entry) => defaults.set(kind, entry)}
      onStart={(seed) => {
        rememberChatStart(seed);
        setStarted({ ...seed, focus: true });
      }}
    />
  );
}

interface CardChoice {
  teammateId: string;
  model: string;
  mode: ChatMode;
  projectId: string;
}

interface SettingsCardProps {
  kind: string;
  entry: { teammateId?: string; model?: string } | null;
  problems: readonly string[];
  teammates: readonly Option[];
  models: readonly Option[];
  projects: readonly Option[];
  initial: CardChoice;
  saveDefault: (entry: { teammateId: EntityId; model: string }) => Promise<unknown>;
  onStart: (seed: NewChatSeed) => void;
}

function SettingsCard({ kind, entry, problems, teammates, models, projects, initial, saveDefault, onStart }: SettingsCardProps) {
  const [choice, setChoice] = useState<CardChoice>(initial);
  const [useForKind, setUseForKind] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const label = kind === UNKNOWN_KIND ? null : kindLabel(kind);
  const pick = <K extends keyof CardChoice>(key: K) => (value: CardChoice[K]) => setChoice((current) => ({ ...current, [key]: value }));
  const ready = choice.teammateId !== '' && choice.model !== '';

  const start = async () => {
    setError(null);
    if (useForKind) {
      setSaving(true);
      try {
        await saveDefault({ teammateId: choice.teammateId as EntityId, model: choice.model });
      } catch (refusal) {
        /* The write is admin-gated server-side. Say so and stay on the card:
           the viewer can untick the box and still start the chat. */
        setError(`Could not save the default for every ${label} chat: ${refusal instanceof Error ? refusal.message : String(refusal)}`);
        setSaving(false);
        return;
      }
      setSaving(false);
    }
    onStart({
      teammateId: choice.teammateId as EntityId,
      model: choice.model,
      mode: choice.mode,
      projectId: choice.projectId === SCRATCH ? null : (choice.projectId as EntityId),
    });
  };

  const partial = entry && (entry.teammateId || entry.model) && problems.length === 0;
  return (
    <form
      className="ecp-card"
      aria-label="New chat settings"
      data-testid="new-chat-card"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !saving) void start();
      }}
    >
      <p className="ecp-card__lead">
        {label === null
          ? 'Choose how this chat starts.'
          : partial
          ? `${label} chats have a default ${entry.teammateId ? 'teammate' : 'model'} but no ${entry.teammateId ? 'model' : 'teammate'}.`
          : entry && problems.length > 0
            ? `The default for ${label} chats no longer resolves.`
            : `No default for ${label} chats yet.`}
      </p>
      {problems.length > 0 ? (
        <ul className="ecp-card__problems" data-testid="new-chat-problems">
          {problems.map((problem) => <li key={problem}>{problem}</li>)}
        </ul>
      ) : null}
      <label className="ecp-card__row" htmlFor={`${ids}-teammate`}>
        <span>Teammate</span>
        <select id={`${ids}-teammate`} data-testid="new-chat-teammate" value={choice.teammateId} onChange={(e) => pick('teammateId')(e.target.value)}>
          {choice.teammateId === '' ? <option value="">Choose a teammate</option> : null}
          {teammates.map((teammate) => <option key={teammate.id} value={teammate.id}>{teammate.label}</option>)}
        </select>
      </label>
      <label className="ecp-card__row" htmlFor={`${ids}-model`}>
        <span>Model</span>
        <select id={`${ids}-model`} data-testid="new-chat-model" value={choice.model} onChange={(e) => pick('model')(e.target.value)}>
          {choice.model === '' ? <option value="">Choose a model</option> : null}
          {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </label>
      <label className="ecp-card__row" htmlFor={`${ids}-mode`}>
        <span>Mode</span>
        <select id={`${ids}-mode`} data-testid="new-chat-mode" value={choice.mode} onChange={(e) => pick('mode')(e.target.value as ChatMode)}>
          {MODE_SPECS.map((spec) => <option key={spec.id} value={spec.id}>{spec.label}</option>)}
        </select>
      </label>
      <label className="ecp-card__row" htmlFor={`${ids}-project`}>
        <span>Project</span>
        <select id={`${ids}-project`} data-testid="new-chat-project" value={choice.projectId} onChange={(e) => pick('projectId')(e.target.value)}>
          <option value={SCRATCH}>Scratch</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}
        </select>
      </label>
      {label === null ? null : (
        <label className="ecp-card__check">
          <input
            type="checkbox"
            data-testid="new-chat-use-for-kind"
            checked={useForKind}
            onChange={(e) => setUseForKind(e.target.checked)}
          />
          {` Use for every ${label} chat`}
        </label>
      )}
      {error ? <p className="ecp-card__error" role="alert" data-testid="new-chat-error">{error}</p> : null}
      <button type="submit" className="ecp-card__start" data-testid="new-chat-start" disabled={!ready || saving}>
        {saving ? 'Saving…' : 'Start chat'}
      </button>
    </form>
  );
}
