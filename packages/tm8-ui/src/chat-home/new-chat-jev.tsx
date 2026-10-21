import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { ChatMode, EntityId, LaunchModelEffort, ModelSuggestion, ModelTier } from '@tm8/contract';

import {
  JevEntryPoint,
  modelApplyRefusal,
  modelLabel,
  useJevSuggestions,
  type JevApplyHost,
  type JevEntityGroup,
  type JevModelChoice,
  type JevPanelSource,
  type JevPort,
} from '../jev';
import type { LaunchContextRow, LaunchGroupEdit, LaunchSelectionDefaults, LaunchSelectionEdits } from '../domain/launch-selection';
import type { CatalogModel } from '../domain/model-catalog';
import { skillReference } from '../rich-input';
import { roleOfMode, roleSpec } from './composer';
import type { ChatModelOption } from './types';

/**
 * ✦ ASK JEV IN THE NEW-CHAT COMPOSER (Phase 1 of doc 01a154f2).
 *
 * The same `launch.suggest` the Run popup asks, about the prompt being typed:
 * the subject is the chat's `about` entity, else the picked project, else the
 * space's home anchor, and the draft is the prompt. Jev only RECOMMENDS. Each
 * pick reaches the composer on an Apply click and is then ordinary composer
 * state the person can still change before Send:
 *
 *  - model + effort → the model picker (sent by `chat.start`, sticky),
 *  - mode           → the mode, from Jev's work kind (client-side mapping),
 *  - teammate       → the teammate picker,
 *  - skills         → `/skill` references in the opening message,
 *  - memories and references → entity references in the opening message
 *                     (a stopgap: `chat.start` carries no context ids yet).
 *
 * Only before the first message: once the chat has started the button is
 * gone, and Send never waits for Jev.
 */

/** What the new-chat composer needs from the host to ask Jev. */
export interface ChatJevPort {
  jev: JevPort;
  /** The space's home anchor (its default channel): the subject when the chat has no `about` and no project. */
  homeAnchor(spaceId: string): Promise<EntityId | null>;
  /** True when the viewer can run Codex (an OpenAI credential of their own or the space's). */
  codexAvailable(spaceId: string): Promise<boolean>;
}

/**
 * The Claude model on each rung of Jev's ladder (`TIER_LADDER` in
 * `packages/jev/src/model.ts`; the test holds the two equal). Without an
 * OpenAI credential a Codex pick is left out and the same rung's Claude model
 * is recommended instead.
 */
export const CLAUDE_RUNG: Readonly<Record<ModelTier, string>> = {
  economy: 'claude-haiku-4-5-20251001',
  standard: 'claude-sonnet-5',
  premium: 'claude-opus-5',
  frontier: 'claude-opus-5[1m]',
};

export function withoutCodex(suggestion: ModelSuggestion): ModelSuggestion {
  if (suggestion.agentTool !== 'codex') return suggestion;
  const model = CLAUDE_RUNG[suggestion.tier];
  return {
    ...suggestion,
    model,
    agentTool: 'claude-code',
    reasons: [...suggestion.reasons, `no OpenAI (Codex) credential: Codex left out -> ${model} on claude-code`],
  };
}

/**
 * Jev's work kind as a chat mode (Phase 1: a client-side mapping; a native
 * mode answer is Phase 2). Null: the kind says nothing about the mode.
 */
export function modeForWorkKind(workKind: string): ChatMode | null {
  switch (workKind) {
    case 'implement':
    case 'operate':
      return 'build';
    case 'coordinate':
      return 'orchestrate';
    case 'design':
      return 'plan';
    case 'review':
    case 'investigate':
      return 'ask';
    default:
      return null;
  }
}

/** One skill or context entity Apply put in the opening message. */
export interface ChatJevReference {
  id: EntityId;
  kind: string;
  title: string;
  group: JevEntityGroup;
}

/**
 * The opening message with Jev's applied skills and context. Skills are the
 * composer's own `/` references; an entity is a code-span id beside its
 * title, which the transcript draws as an entity chip.
 */
export function withJevReferences(body: string, refs: readonly ChatJevReference[]): string {
  if (refs.length === 0) return body;
  const skills = refs.filter((ref) => ref.group === 'skills').map((ref) => skillReference(ref.title, ref.id).trim());
  const context = refs.filter((ref) => ref.group !== 'skills').map((ref) => `${ref.title.replace(/`/g, "'")} \`${ref.id}\``);
  const lines = [body];
  if (skills.length > 0) lines.push(`Skills: ${skills.join(' ')}`);
  if (context.length > 0) lines.push(`Context: ${context.join(' · ')}`);
  return lines.join('\n\n');
}

const NO_EDIT: LaunchGroupEdit = { removed: [], added: [] };
const NO_EDITS: LaunchSelectionEdits = { memories: NO_EDIT, skills: NO_EDIT, references: NO_EDIT };
/* A chat loads nothing per group that the body would have to name: every row
   Apply ticks is an ADD, and there is no default to untick. */
const NOTHING_LOADED: LaunchSelectionDefaults = {
  memories: { status: 'ready', rows: [], total: 0 },
  skills: { status: 'ready', rows: [], total: 0 },
  references: { status: 'ready', rows: [], total: 0 },
};

export const CHAT_JEV_TITLE =
  'Jev’s recommendations for this chat: model, mode, teammate, skills and context. Nothing changes until you apply it.';
export const CHAT_JEV_NOTE = 'Nothing changes until you apply it. What you apply goes out when you send the first message.';

export interface NewChatJevArgs {
  port?: ChatJevPort | undefined;
  spaceId: string;
  /** The chat's `about` entity, when the host has one. */
  aboutId?: EntityId | undefined;
  /** The picked project's id; '' (or scratch) for none. */
  projectId?: EntityId | null | undefined;
  /** The draft prompt. */
  draft: string;
  teammateId: string;
  setTeammate(id: string): void;
  models: readonly ChatModelOption[];
  modelId: string;
  effort: LaunchModelEffort | null;
  /** Sets the new chat's model and, when Jev names one, its effort under `mode`. */
  setModel(model: string, effort: LaunchModelEffort | null, mode: ChatMode): void;
  mode: ChatMode;
  setMode(mode: ChatMode): void;
  /** A host that pins the mode (Craft): Jev's mode is not offered. */
  modeLocked: boolean;
  /** Changes when a chat has started: the next new chat asks Jev afresh. */
  resetKey: string | number;
}

export interface NewChatJev {
  /** What Apply put in the opening message, in apply order. */
  references: readonly ChatJevReference[];
  removeReference(id: EntityId): void;
  /** The opening message with the applied references. */
  composeBody(body: string): string;
  /** The ✦ entry point and the applied strip, or null without a port. */
  entry: ReactElement | null;
  strip: ReactElement | null;
}

export function useNewChatJev(args: NewChatJevArgs): NewChatJev {
  const { port, spaceId, aboutId, projectId, draft, teammateId, models, modelId, effort, mode, modeLocked, resetKey } = args;

  /* WHAT JEV IS ASKED ABOUT: the about entity, the project, else the home anchor. */
  const [homeAnchor, setHomeAnchor] = useState<EntityId | null>(null);
  const [codex, setCodex] = useState(false);
  useEffect(() => {
    if (!port) return;
    let cancelled = false;
    port.homeAnchor(spaceId).then((id) => { if (!cancelled) setHomeAnchor(id); }, () => { if (!cancelled) setHomeAnchor(null); });
    /* Unknown is no: a Codex chat cannot run without a key, so it is left out. */
    port.codexAvailable(spaceId).then((yes) => { if (!cancelled) setCodex(yes); }, () => { if (!cancelled) setCodex(false); });
    return () => { cancelled = true; };
  }, [port, spaceId]);
  const subjectId = aboutId ?? (projectId || null) ?? homeAnchor ?? '';

  const jevDraft = useMemo(() => {
    const text = draft.trim();
    return { title: (text.split('\n')[0] ?? '').slice(0, 200), description: text };
  }, [draft]);

  /* The skills and context Apply chose, kept as the group edits the hook writes. */
  const [edits, setEdits] = useState<LaunchSelectionEdits>(NO_EDITS);
  const [rows, setRows] = useState<ReadonlyMap<string, LaunchContextRow>>(new Map());

  const selected = models.find((m) => m.model === modelId);
  /* Mode Apply writes before Apply all's model does, in the same click — the
     effort is remembered per mode, so the model's effort must land under it. */
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const catalog = useMemo<CatalogModel[]>(
    () => models.map((m) => ({ ...m, note: m.note ?? '', builtIn: true, overridden: false })),
    [models],
  );

  const live = useRef(args);
  live.current = args;
  const host: JevApplyHost = {
    defaults: NOTHING_LOADED,
    edits,
    setEdit(group, edit, added) {
      setEdits((current) => ({ ...current, [group]: edit }));
      if (added && added.length > 0) {
        setRows((current) => {
          const next = new Map(current);
          for (const row of added) next.set(row.id, row);
          return next;
        });
      }
      return null;
    },
    setTeammate: (id) => live.current.setTeammate(id),
    model: selected ? { model: selected.model, agentToolId: selected.agentTool, reasoningEffort: effort } : null,
    setModel: (choice: JevModelChoice) => live.current.setModel(choice.model, choice.reasoningEffort, modeRef.current),
    modelRefusal: (suggestion) => modelApplyRefusal(suggestion, {
      catalog,
      credentialRefusal: (tool) => (tool === 'codex' && !codex ? 'You have no OpenAI (Codex) credential, so a Codex model can’t run this chat.' : null),
    }),
  };

  const adjustModel = useCallback((s: ModelSuggestion) => (codex ? s : withoutCodex(s)), [codex]);
  const jev = useJevSuggestions({
    port: port?.jev ?? null,
    spaceId,
    subjectId,
    teammateId: teammateId || null,
    draft: jevDraft,
    host,
    adjustModel,
    resetKey,
    /* The teammate Jev ranks for is the person's pick: a change turns ✦
       stale, and they ask again — no uninvited charged call. */
    reaskOnChange: false,
  });

  /* MODE: Jev's work kind, applied like any other pick. */
  const [modeApplied, setModeApplied] = useState<{ value: ChatMode; previous: ChatMode } | null>(null);
  const suggestion = jev.groups.model.status === 'ok' ? jev.groups.model.value : null;
  const suggestedMode = suggestion ? modeForWorkKind(suggestion.workKind) : null;
  const modeRefusal = !suggestion
    ? 'Jev hasn’t answered yet — ask, then apply.'
    : modeLocked
      ? 'This chat’s mode is fixed here.'
      : !suggestedMode
        ? `Jev read the work as “${suggestion.workKind}”, which names no mode — keep yours.`
        : suggestedMode === mode && !modeApplied
          ? 'The chat already starts in this mode.'
          : null;
  const applyMode = useCallback((): boolean => {
    if (modeRefusal || !suggestedMode) return false;
    setModeApplied((current) => ({ value: suggestedMode, previous: current?.previous ?? modeRef.current }));
    modeRef.current = suggestedMode;
    live.current.setMode(suggestedMode);
    return true;
  }, [modeRefusal, suggestedMode]);
  const undoMode = useCallback(() => {
    if (!modeApplied) return;
    modeRef.current = modeApplied.previous;
    live.current.setMode(modeApplied.previous);
    setModeApplied(null);
  }, [modeApplied]);
  const modeReplaced = modeApplied !== null && modeApplied.value !== mode;

  const lastReset = useRef(resetKey);
  useEffect(() => {
    if (lastReset.current === resetKey) return;
    lastReset.current = resetKey;
    setEdits(NO_EDITS);
    setRows(new Map());
    setModeApplied(null);
  }, [resetKey]);

  /* Apply all and Undo all carry the mode too — first, so the model's effort lands under it. */
  const source: JevPanelSource = {
    ...jev,
    applyAll: () => {
      applyMode();
      return jev.applyAll();
    },
    undoAll: () => {
      jev.undoAll();
      if (modeApplied && !modeReplaced) undoMode();
    },
  };

  const references = useMemo<ChatJevReference[]>(() => {
    const out: ChatJevReference[] = [];
    for (const group of ['skills', 'memories', 'references'] as const) {
      for (const id of edits[group].added) {
        const row = rows.get(id);
        out.push({ id, group, kind: row?.kind ?? group, title: row?.title ?? id });
      }
    }
    return out;
  }, [edits, rows]);

  const removeReference = useCallback((id: EntityId) => {
    setEdits((current) => {
      const next = { ...current };
      for (const group of ['skills', 'memories', 'references'] as const) {
        if (current[group].added.includes(id)) next[group] = { ...current[group], added: current[group].added.filter((x) => x !== id) };
      }
      return next;
    });
  }, []);

  const composeBody = useCallback((body: string) => withJevReferences(body, references), [references]);

  const modeRow = suggestion ? (
    <section className="jev-panel__section" data-testid="jev-section-mode">
      <div className="jev-panel__section-head">
        <h3 className="jev-panel__eyebrow">Mode</h3>
        <span className="jev-panel__spacer" />
        {modeApplied && !modeReplaced ? (
          <span className="jev-panel__applied">
            <span className="jev-mark" data-testid="jev-applied-mode">Applied ✓</span>
            <button type="button" className="jev-link" data-testid="jev-undo-mode" onClick={undoMode}>Undo</button>
          </span>
        ) : (
          <button
            type="button"
            className="jev-apply"
            data-testid="jev-apply-mode"
            aria-disabled={modeRefusal ? true : undefined}
            title={modeRefusal ?? undefined}
            onClick={() => { applyMode(); }}
          >
            {modeReplaced ? 'Re-apply' : 'Apply mode'}
          </button>
        )}
      </div>
      <p className="jev-panel__value" data-testid="jev-panel-mode-value">
        {suggestedMode ? `${roleSpec(roleOfMode(suggestedMode)).label} · ${suggestedMode}` : 'No mode'} · work kind {suggestion.workKind}
      </p>
      {modeReplaced ? <p className="jev-mark" data-testid="jev-replaced-mode">Applied, then changed by hand.</p> : null}
    </section>
  ) : null;

  const label = suggestion ? modelLabel(suggestion, catalog) : '';
  const entry = port ? (
    <JevEntryPoint
      jev={source}
      modelLabel={label}
      title={CHAT_JEV_TITLE}
      panelNote={CHAT_JEV_NOTE}
      panelExtra={modeRow}
    />
  ) : null;

  const strip = references.length > 0 ? (
    <div className="tch-jev-refs" data-testid="chat-jev-refs" aria-label="Jev’s picks in the first message">
      {references.map((ref) => (
        <span key={ref.id} className="tch-jev-ref" data-testid={`chat-jev-ref-${ref.id}`} title={`${ref.kind}: ${ref.title}`}>
          <span className="tch-jev-ref__mark" aria-hidden="true">{ref.group === 'skills' ? '/' : '✦'}</span>
          <span className="tch-jev-ref__title">{ref.title}</span>
          <button
            type="button"
            className="tch-jev-ref__remove"
            data-testid={`chat-jev-ref-remove-${ref.id}`}
            aria-label={`Remove ${ref.title}`}
            onClick={() => removeReference(ref.id)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  ) : null;

  return { references, removeReference, composeBody, entry, strip };
}
