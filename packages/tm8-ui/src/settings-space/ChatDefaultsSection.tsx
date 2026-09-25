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
}

const NONE = '';

export function ChatDefaultsSection({ heading, nodeKey, wiring }: ChatDefaultsSectionProps) {
  const { status, defaults, error, set } = useChatDefaults(wiring?.seam, wiring?.spaceId);
  const [options, setOptions] = useState<ChatDefaultsOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

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

  const scope = (
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

  const write = async (kind: string, next: ChatDefault) => {
    const entry: ChatDefault = {
      ...(next.teammateId ? { teammateId: next.teammateId } : {}),
      ...(next.model ? { model: next.model } : {}),
    };
    setSaving(kind);
    setRefusals(({ [kind]: _dropped, ...rest }) => rest);
    try {
      await set(kind, Object.keys(entry).length === 0 ? null : entry);
    } catch (err) {
      setRefusals((prev) => ({ ...prev, [kind]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSaving(null);
    }
  };

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
