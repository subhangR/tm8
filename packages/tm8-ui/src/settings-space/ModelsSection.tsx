/**
 * MODELS — the launch catalog, and this browser's edits to it.
 *
 * WHAT IS REAL HERE, unusually for this module: every write. The catalog is a
 * browser-local delta over the contract's built-in offering, so add, edit, hide
 * and reset all take effect immediately and reach the launch picker on its next
 * render. There is no seam verb to be refused by.
 *
 * WHICH IS EXACTLY WHY THE SCOPE IS STATED AT THE TOP AND NOT IN A FOOTNOTE.
 * A settings screen that looks space-wide while writing to one browser is a lie
 * of scope, and it is the kind that only surfaces when a teammate says "I don't
 * see that model". The banner says per-browser, and the reset control names the
 * same fact.
 *
 * BUILT-INS ARE HIDDEN, NEVER DELETED. They come back on the next contract
 * update no matter what this screen does, so offering "delete" would be a
 * control whose effect silently expires. Hide is honest and reversible; custom
 * models, which this browser owns outright, delete for real.
 */
import { useCallback, useState } from 'react';
import {
  KNOWN_AGENT_TOOLS,
  addCustomModel,
  editModel,
  isModelHidden,
  localChangeCount,
  modelCatalog,
  removeModel,
  resetModel,
  resetModelCatalog,
  type CatalogModel,
} from '../domain/model-catalog';
import { agentTool } from '../domain/launch';

export interface ModelsSectionProps {
  /** Which node's catalog. Per-node, like every other browser-local setting. */
  nodeKey: string;
  heading: string;
}

export function ModelsSection({ nodeKey, heading }: ModelsSectionProps) {
  // A local tick, because the catalog lives in module state + localStorage
  // rather than in React. Every mutator below bumps it so the list re-reads.
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  void tick;
  const all = modelCatalog(nodeKey, true);
  const changes = localChangeCount(nodeKey);

  const act = (result: string | null) => {
    setRefusal(result);
    if (result === null) refresh();
  };

  return (
    <>
      <div className="set-section__head">
        <span className="set-section__title">{heading}</span>
        <div className="set-section__grow" />
        {changes > 0 ? (
          <button
            type="button"
            className="set-ghost"
            data-testid="models-reset-all"
            onClick={() => {
              resetModelCatalog(nodeKey);
              setRefusal(null);
              refresh();
            }}
          >
            {`reset all (${changes})`}
          </button>
        ) : null}
      </div>

      <div className="set-section__scroll" style={{ padding: 16 }}>
        {/* THE SCOPE, FIRST AND PLAINLY. */}
        <p className="set-absent__why" data-testid="models-scope">
          These models are stored in THIS BROWSER, for this node. They change what the launch
          picker offers here — they are not shared with your teammates, your other devices, or the
          CLI, and clearing site data removes them. The built-in list ships with the node.
        </p>

        {refusal ? (
          <p className="set-absent__head" role="alert" data-testid="models-refusal">
            {refusal}
          </p>
        ) : null}

        <AddModelForm
          onAdd={(input) => act(addCustomModel(nodeKey, input))}
          data-testid="models-add"
        />

        {KNOWN_AGENT_TOOLS.map((tool) => {
          const rows = all.filter((entry) => entry.agentTool === tool);
          return (
            <section key={tool} data-testid={`models-group-${tool}`} style={{ marginTop: 18 }}>
              <span className="set-eyebrow">{agentTool(tool)?.label ?? tool}</span>
              {rows.length === 0 ? (
                <p className="set-absent__why">No models are offered for this tool.</p>
              ) : (
                rows.map((entry) => (
                  <ModelRow
                    key={entry.model}
                    entry={entry}
                    hidden={isModelHidden(nodeKey, entry.model)}
                    editing={editing === entry.model}
                    onEdit={() => {
                      setRefusal(null);
                      setEditing(entry.model);
                    }}
                    onCancel={() => setEditing(null)}
                    onSave={(patch) => {
                      const result = editModel(nodeKey, entry.model, patch);
                      act(result);
                      if (result === null) setEditing(null);
                    }}
                    onRemove={() => act(removeModel(nodeKey, entry.model))}
                    onReset={() => {
                      resetModel(nodeKey, entry.model);
                      setRefusal(null);
                      refresh();
                    }}
                  />
                ))
              )}
            </section>
          );
        })}

        {/* Anything whose tool this UI does not know still has to be VISIBLE —
            it is offerable at spawn, and a catalog that quietly omitted it
            would make the picker and this screen disagree. */}
        {(() => {
          const orphans = all.filter(
            (entry) => !(KNOWN_AGENT_TOOLS as readonly string[]).includes(entry.agentTool),
          );
          if (orphans.length === 0) return null;
          return (
            <section data-testid="models-group-other" style={{ marginTop: 18 }}>
              <span className="set-eyebrow">Other tools</span>
              <p className="set-absent__why">
                This UI does not know how to build a launch command for these tools; the node may
                still accept them.
              </p>
              {orphans.map((entry) => (
                <ModelRow
                  key={entry.model}
                  entry={entry}
                  hidden={isModelHidden(nodeKey, entry.model)}
                  editing={false}
                  onEdit={() => setEditing(entry.model)}
                  onCancel={() => setEditing(null)}
                  onSave={() => {}}
                  onRemove={() => act(removeModel(nodeKey, entry.model))}
                  onReset={() => {
                    resetModel(nodeKey, entry.model);
                    refresh();
                  }}
                />
              ))}
            </section>
          );
        })()}
      </div>
    </>
  );
}

function ModelRow({
  entry,
  hidden,
  editing,
  onEdit,
  onCancel,
  onSave,
  onRemove,
  onReset,
}: {
  entry: CatalogModel;
  hidden: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (patch: { label?: string; note?: string }) => void;
  onRemove: () => void;
  onReset: () => void;
}) {
  const [label, setLabel] = useState(entry.label);
  const [note, setNote] = useState(entry.note);

  if (editing) {
    return (
      <div className="set-card" data-testid={`model-row-${entry.model}`} data-editing="true">
        <input
          className="set-field"
          aria-label={`Label for ${entry.model}`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <input
          className="set-field set-field--grow"
          aria-label={`Note for ${entry.model}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button type="button" className="set-add" onClick={() => onSave({ label, note })}>
          Save
        </button>
        <button type="button" className="set-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div
      className="set-card"
      data-testid={`model-row-${entry.model}`}
      data-hidden={hidden ? 'true' : undefined}
      style={hidden ? { opacity: 0.55 } : undefined}
    >
      <div className="set-kv">
        <span className="set-kv__k">{entry.label}</span>
        <span className="set-kv__v">{entry.model}</span>
      </div>
      <div className="set-section__grow" />
      {entry.builtIn ? null : <span className="set-chip set-chip--sm">custom</span>}
      {entry.overridden ? <span className="set-chip set-chip--sm">edited</span> : null}
      {hidden ? <span className="set-chip set-chip--sm">hidden</span> : null}
      <button type="button" className="set-ghost" onClick={onEdit} aria-label={`Edit ${entry.label}`}>
        edit
      </button>
      {hidden || entry.overridden ? (
        <button type="button" className="set-ghost" onClick={onReset} aria-label={`Reset ${entry.label}`}>
          reset
        </button>
      ) : null}
      {hidden ? null : (
        <button
          type="button"
          className="set-ghost"
          onClick={onRemove}
          aria-label={entry.builtIn ? `Hide ${entry.label}` : `Delete ${entry.label}`}
          /* The word differs because the ACT differs, and conflating them is
             how a viewer comes to believe a built-in was deleted. */
          title={
            entry.builtIn
              ? 'Hides it from the launch picker in this browser; the node still ships it.'
              : 'Deletes it from this browser.'
          }
        >
          {entry.builtIn ? 'hide' : 'delete'}
        </button>
      )}
    </div>
  );
}

function AddModelForm({ onAdd }: { onAdd: (input: { model: string; label: string; agentTool: string; note?: string }) => void } & Record<string, unknown>) {
  const [model, setModel] = useState('');
  const [label, setLabel] = useState('');
  const [tool, setTool] = useState<string>(KNOWN_AGENT_TOOLS[0]);

  return (
    <div className="set-add-bar" data-testid="models-add-form" style={{ marginTop: 12 }}>
      <input
        className="set-field"
        aria-label="Model id"
        placeholder="model id (e.g. claude-opus-5)"
        value={model}
        onChange={(e) => setModel(e.target.value)}
      />
      <input
        className="set-field"
        aria-label="Display label"
        placeholder="display label"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <select
        className="set-field"
        aria-label="Agent tool"
        value={tool}
        onChange={(e) => setTool(e.target.value)}
      >
        {KNOWN_AGENT_TOOLS.map((t) => (
          <option key={t} value={t}>
            {agentTool(t)?.label ?? t}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="set-add"
        data-testid="models-add-submit"
        onClick={() => {
          onAdd({ model, label, agentTool: tool });
          setModel('');
          setLabel('');
        }}
      >
        ＋ Add model
      </button>
    </div>
  );
}
