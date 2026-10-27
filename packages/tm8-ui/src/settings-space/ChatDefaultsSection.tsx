/**
 * CHAT DEFAULTS — the teammate and model a new chat about an entity of each
 * kind starts with (entity-chat design 01a0da4e §3.4).
 *
 * SPACE-WIDE, AND IT SAYS SO FIRST. Its neighbour `ModelsSection` writes to one
 * browser and states that at the top; this one writes to the server for every
 * member, and states THAT at the top, so a reader never has to infer scope
 * from which section they happen to be in.
 *
 * ONE ROW PER KIND FROM THE REGISTRY (`chatDefaultKindRows`), custom kinds
 * included — this file names no kind. Teammate and model are each optional:
 * a kind with both skips the chat panel's settings card; half a default
 * pre-fills it (§3.4 rules 1 and 2).
 *
 * A STORED VALUE THAT NO LONGER RESOLVES IS SHOWN, NOT DROPPED: a deleted
 * teammate or a model the catalog no longer offers stays selected and is
 * labelled as such, so the row tells the truth about what a chat would get.
 *
 * WRITES ARE THE SERVER'S. Only an owner/admin may change a default; a
 * member's attempt comes back as the server's own refusal, rendered beside
 * the row it belongs to.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ChatDefault } from '@tm8/contract';
import { useChatDefaults, type ChatDefaultsOptions, type ChatDefaultsSeam } from '../chat-defaults';
import { modelCatalog } from '../domain/model-catalog';
import { KindIcon } from '../domain';
import { MobileSheet } from '../mobile/MobileSheet';
import { SectionAbsent, SectionFrame } from './SectionFrame';
import './chat-defaults-section.css';

export interface ChatDefaultsSectionProps {
  heading: string;
  /** Whose launch catalog offers the models — per node, as in ModelsSection. */
  nodeKey: string;
  /** Absent on a port built before the section existed: the section says so. */
  wiring?: {
    seam: ChatDefaultsSeam;
    spaceId: string;
    loadOptions: () => Promise<ChatDefaultsOptions>;
  };
  /**
   * The phone's arrangement (mockup 01a14cc4): one row per kind with the
   * teammate and model stacked under it, and a sheet with the two pickers.
   * The desktop table is not rendered at all — three columns of selects do
   * not fit 360px, and a table that clips is worse than none.
   */
  phone?: boolean;
}

const NONE = '';

export function ChatDefaultsSection({ heading, nodeKey, wiring, phone = false }: ChatDefaultsSectionProps) {
  const { status, defaults, error, set } = useChatDefaults(wiring?.seam, wiring?.spaceId);
  const [options, setOptions] = useState<ChatDefaultsOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  /** Phone only: the kind whose sheet is open. */
  const [editing, setEditing] = useState<string | null>(null);

  const loadOptions = wiring?.loadOptions;
  useEffect(() => {
    if (!loadOptions) return;
    let live = true;
    loadOptions().then(
      (next) => live && setOptions(next),
      (err: unknown) => live && setOptionsError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [loadOptions]);

  const models = useMemo(() => modelCatalog(nodeKey), [nodeKey]);

  const scope = phone ? (
    <div className="set-chatdef__scope set-chatdef__scope--phone" data-testid="chat-defaults-scope">
      <span className="set-chatdef__scope-head">Shared with the whole space.</span>{' '}
      A new chat about an entity of each kind starts with this teammate and model. Owners and admins
      can change it.
    </div>
  ) : (
    <div className="set-chatdef__scope" data-testid="chat-defaults-scope">
      <span className="set-chatdef__scope-head">Shared with the whole space</span>
      <p className="set-chatdef__scope-body">
        These defaults are stored on the server for EVERY MEMBER of this space. When anyone opens
        Chat on an entity, its kind&rsquo;s teammate and model are used; if a kind has both, the chat
        opens straight into the composer. Only owners and admins can change them.
      </p>
    </div>
  );

  if (!wiring) {
    return (
      <SectionFrame title={heading}>
        {scope}
        <SectionAbsent
          head="Chat defaults are not wired on this screen."
          why="this settings port carries no chat-defaults seam — spaces.chatDefaults.get/set are not reachable from here"
        />
      </SectionFrame>
    );
  }

  const failure = error ?? optionsError;
  if (failure && (status === 'error' || !options)) {
    return (
      <SectionFrame title={heading}>
        {scope}
        <SectionAbsent head="Chat defaults could not be read." why={failure} testId="chat-defaults-error" />
      </SectionFrame>
    );
  }
  if (status !== 'ready' || !options) {
    return (
      <SectionFrame title={heading}>
        {scope}
        <p className="set-chatdef__loading" data-testid="chat-defaults-loading">Reading this space&rsquo;s chat defaults…</p>
      </SectionFrame>
    );
  }

  const teammateLabel = new Map(options.teammates.map((t) => [t.id, t.label]));
  const modelLabel = new Map(models.map((m) => [m.model, m.label]));

  const write = async (kind: string, next: ChatDefault): Promise<boolean> => {
    const entry: ChatDefault = {
      ...(next.teammateId ? { teammateId: next.teammateId } : {}),
      ...(next.model ? { model: next.model } : {}),
    };
    setSaving(kind);
    setRefusals(({ [kind]: _dropped, ...rest }) => rest);
    try {
      await set(kind, Object.keys(entry).length === 0 ? null : entry);
      return true;
    } catch (err) {
      setRefusals((prev) => ({ ...prev, [kind]: err instanceof Error ? err.message : String(err) }));
      return false;
    } finally {
      setSaving(null);
    }
  };

  if (phone) {
    const open = editing ? options.kinds.find((k) => k.kind === editing) ?? null : null;
    return (
      <SectionFrame title={heading}>
        {scope}
        <ul className="set-chatdef__rows" data-testid="chat-defaults-rows">
          {options.kinds.map((row) => {
            const current = defaults[row.kind] ?? {};
            const teammate = current.teammateId
              ? teammateLabel.get(current.teammateId) ?? null
              : null;
            const model = current.model ? modelLabel.get(current.model) ?? null : null;
            return (
              <li key={row.kind}>
                <button
                  type="button"
                  className="set-chatdef__row"
                  data-testid={`chat-default-row-${row.kind}`}
                  data-complete={current.teammateId && current.model ? 'true' : 'false'}
                  onClick={() => setEditing(row.kind)}
                >
                  <span className="set-chatdef__mark" aria-hidden>
                    <KindIcon kind={row.kind} size={16} />
                  </span>
                  <span className="set-chatdef__text">
                    <span className="set-chatdef__kind">
                      {row.label}
                      {row.custom ? <span className="set-chatdef__custom">custom</span> : null}
                    </span>
                    <span className="set-chatdef__pair">
                      {current.teammateId ? (
                        teammate ?? <span className="set-chatdef__stale">{`${current.teammateId} (no longer in this space)`}</span>
                      ) : 'Teammate: none'}
                      {' · '}
                      {current.model ? (
                        model ?? <span className="set-chatdef__stale">{`${current.model} (no longer offered)`}</span>
                      ) : 'model: none'}
                    </span>
                  </span>
                  <span className="set-chatdef__chev" aria-hidden>›</span>
                </button>
              </li>
            );
          })}
        </ul>
        {open ? (
          <ChatDefaultSheet
            key={open.kind}
            label={open.label}
            current={defaults[open.kind] ?? {}}
            teammates={options.teammates}
            teammateLabel={teammateLabel}
            models={models}
            modelLabel={modelLabel}
            busy={saving === open.kind}
            refusal={refusals[open.kind] ?? null}
            testKind={open.kind}
            onSave={async (next) => {
              if (await write(open.kind, next)) setEditing(null);
            }}
            onDismiss={() => {
              setRefusals(({ [open.kind]: _dropped, ...rest }) => rest);
              setEditing(null);
            }}
          />
        ) : null}
      </SectionFrame>
    );
  }

  return (
    <SectionFrame title={heading}>
      {scope}
      <table className="set-chatdef__table" data-testid="chat-defaults-table">
        <thead>
          <tr>
            <th scope="col">Kind</th>
            <th scope="col">Teammate</th>
            <th scope="col">Model</th>
          </tr>
        </thead>
        <tbody>
          {options.kinds.map((row) => {
            const current = defaults[row.kind] ?? {};
            const staleTeammate = current.teammateId && !teammateLabel.has(current.teammateId) ? current.teammateId : null;
            const staleModel = current.model && !modelLabel.has(current.model) ? current.model : null;
            const busy = saving === row.kind;
            return (
              <tr key={row.kind} data-testid={`chat-default-row-${row.kind}`} data-complete={current.teammateId && current.model ? 'true' : 'false'}>
                <th scope="row" className="set-chatdef__kind">
                  {row.label}
                  {row.custom ? <span className="set-chatdef__custom">custom</span> : null}
                </th>
                <td>
                  <select
                    aria-label={`default teammate for ${row.label}`}
                    value={current.teammateId ?? NONE}
                    disabled={busy}
                    onChange={(e) => void write(row.kind, { ...current, teammateId: e.target.value || undefined })}
                  >
                    <option value={NONE}>— none —</option>
                    {staleTeammate ? <option value={staleTeammate}>{`${staleTeammate} (no longer in this space)`}</option> : null}
                    {options.teammates.map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    aria-label={`default model for ${row.label}`}
                    value={current.model ?? NONE}
                    disabled={busy}
                    onChange={(e) => void write(row.kind, { ...current, model: e.target.value || undefined })}
                  >
                    <option value={NONE}>— none —</option>
                    {staleModel ? <option value={staleModel}>{`${staleModel} (no longer offered)`}</option> : null}
                    {models.map((m) => (
                      <option key={m.model} value={m.model}>{m.label}</option>
                    ))}
                  </select>
                  {refusals[row.kind] ? (
                    <p className="set-chatdef__refusal" role="alert" data-testid={`chat-default-refusal-${row.kind}`}>
                      {refusals[row.kind]}
                    </p>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </SectionFrame>
  );
}

/**
 * The two pickers for one kind, over the list (a picker is temporary and sits
 * over your place, CONTRACT §4). Nothing is written until Save, so a viewer
 * can set both halves and send one write. A stored value that no longer
 * resolves stays an option, checked, and labelled as gone. A refusal is the
 * server's own words, inside the sheet, under the Save that earned it.
 */
function ChatDefaultSheet({
  label,
  current,
  teammates,
  teammateLabel,
  models,
  modelLabel,
  busy,
  refusal,
  testKind,
  onSave,
  onDismiss,
}: {
  label: string;
  current: ChatDefault;
  teammates: readonly { id: string; label: string }[];
  teammateLabel: ReadonlyMap<string, string>;
  models: readonly { model: string; label: string }[];
  modelLabel: ReadonlyMap<string, string>;
  busy: boolean;
  refusal: string | null;
  testKind: string;
  onSave: (next: ChatDefault) => Promise<void>;
  onDismiss: () => void;
}) {
  const [teammateId, setTeammateId] = useState(current.teammateId ?? NONE);
  const [model, setModel] = useState(current.model ?? NONE);
  const staleTeammate = current.teammateId && !teammateLabel.has(current.teammateId) ? current.teammateId : null;
  const staleModel = current.model && !modelLabel.has(current.model) ? current.model : null;

  const teammateOptions = [
    { value: NONE, label: 'None', hint: 'The chat panel asks' },
    ...(staleTeammate ? [{ value: staleTeammate, label: staleTeammate, hint: 'No longer in this space' }] : []),
    ...teammates.map((t) => ({ value: t.id, label: t.label })),
  ];
  const modelOptions = [
    { value: NONE, label: 'None', hint: 'The chat panel asks' },
    ...(staleModel ? [{ value: staleModel, label: staleModel, hint: 'No longer offered' }] : []),
    ...models.map((m) => ({ value: m.model, label: m.label })),
  ];

  return (
    <MobileSheet title={label} onDismiss={onDismiss} testId="chat-default-sheet">
      <div className="set-chatdef__sheet">
      <p className="set-chatdef__sheet-sub">Shared with the whole space</p>
      <Picker
        legend="Teammate"
        name={`chatdef-teammate-${testKind}`}
        options={teammateOptions}
        value={teammateId}
        disabled={busy}
        onChange={setTeammateId}
      />
      <Picker
        legend="Model"
        name={`chatdef-model-${testKind}`}
        options={modelOptions}
        value={model}
        disabled={busy}
        onChange={setModel}
      />
      {refusal ? (
        <p className="set-chatdef__refusal" role="alert" data-testid={`chat-default-refusal-${testKind}`}>
          {refusal}
        </p>
      ) : null}
      <button
        type="button"
        className="set-chatdef__save"
        data-testid="chat-default-save"
        disabled={busy}
        onClick={() =>
          void onSave({
            ...(teammateId ? { teammateId } : {}),
            ...(model ? { model } : {}),
          })
        }
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
      </div>
    </MobileSheet>
  );
}

function Picker({
  legend,
  name,
  options,
  value,
  disabled,
  onChange,
}: {
  legend: string;
  name: string;
  options: readonly { value: string; label: string; hint?: string }[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="set-chatdef__picker" disabled={disabled}>
      <legend className="set-chatdef__legend">{legend}</legend>
      {options.map((o) => (
        <label key={o.value || 'none'} className="set-chatdef__opt">
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
          />
          <span className="set-chatdef__check" aria-hidden>{value === o.value ? '✓' : ''}</span>
          <span className="set-chatdef__opt-text">
            <span className="set-chatdef__opt-label">{o.label}</span>
            {o.hint ? <span className="set-chatdef__opt-hint">{o.hint}</span> : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
