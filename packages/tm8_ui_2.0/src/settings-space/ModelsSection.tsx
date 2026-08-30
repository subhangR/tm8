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
 * see that model". Its eleven neighbours on this screen ARE space-scoped, so a
 * reader's default is wrong here and the section has to say so before they act,
 * in type they will actually read — it was 9px `--pn-ink-4` mono, the faintest
 * treatment on the page, for the one fact that changes what a click means.
 *
 * AND WHICH NODE. The catalog is keyed by node, so a host pointed at a named
 * Server edits THAT node's list. The key was passed in and rendered nowhere:
 * two nodes' catalogs looked identical on screen. It is now printed under the
 * scope statement, and a non-local key says plainly that it is not this
 * browser's own node.
 *
 * BUILT-INS ARE HIDDEN, NEVER DELETED. They come back on the next contract
 * update no matter what this screen does, so offering "delete" would be a
 * control whose effect silently expires. Hide is honest and reversible; custom
 * models, which this browser owns outright, delete for real.
 *
 * LAYOUT (2026-08-16, SECTION-CONTRACT.md). The head and scroller are
 * `SectionFrame`'s now, not hand-rolled here, and the rows are the section's
 * own `.set-models__row` rather than `.set-card` — which is the class the whole
 * settings CARD is drawn with and had just gained `flex: 1` and a 1080px
 * `max-width` underneath this section. `models.css` carries the measurements.
 */
import { useCallback, useMemo, useState } from 'react';
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
import { SectionAbsent, SectionFrame } from './SectionFrame';
import './models.css';

export interface ModelsSectionProps {
  /** Which node's catalog. Per-node, like every other browser-local setting. */
  nodeKey: string;
  heading: string;
}

/** The key the shell defaults to when no named server is in play. */
const LOCAL_NODE = 'local';

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

  /**
   * Groups, in one pass: the known tools in their declared order, then any
   * UNRECOGNISED tool under its own real name.
   *
   * The unknown ones were previously lumped into one "Other tools" heap, which
   * hid the only fact worth knowing about them — WHICH tool. A catalog row is
   * offerable at spawn whether or not this UI can build its command line, so
   * omitting it, or naming it "other", makes the picker and this screen
   * disagree about the same list.
   */
  const groups = useMemo(() => {
    const known = new Set<string>(KNOWN_AGENT_TOOLS);
    const out: { tool: string; label: string; rows: CatalogModel[]; unknown: boolean }[] =
      KNOWN_AGENT_TOOLS.map((tool) => ({
        tool,
        label: agentTool(tool)?.label ?? tool,
        rows: all.filter((entry) => entry.agentTool === tool),
        unknown: false,
      }));
    const seen = new Set<string>();
    for (const entry of all) {
      if (known.has(entry.agentTool) || seen.has(entry.agentTool)) continue;
      seen.add(entry.agentTool);
      out.push({
        tool: entry.agentTool,
        label: entry.agentTool || '(no tool)',
        rows: all.filter((e) => e.agentTool === entry.agentTool),
        unknown: true,
      });
    }
    return out;
  }, [all]);

  const rowProps = (entry: CatalogModel) => ({
    entry,
    hidden: isModelHidden(nodeKey, entry.model),
    editing: editing === entry.model,
    onEdit: () => {
      setRefusal(null);
      setEditing(entry.model);
    },
    onCancel: () => setEditing(null),
    onSave: (patch: { label?: string; note?: string }) => {
      const result = editModel(nodeKey, entry.model, patch);
      act(result);
      if (result === null) setEditing(null);
    },
    onRemove: () => act(removeModel(nodeKey, entry.model)),
    onReset: () => {
      resetModel(nodeKey, entry.model);
      setRefusal(null);
      refresh();
    },
  });

  return (
    <SectionFrame
      title={heading}
      bodyTestId="models-body"
      action={
        changes > 0 ? (
          <button
            type="button"
            className="set-ghost"
            data-testid="models-reset-all"
            title="Discards every local add, edit and hide on this node, in this browser."
            onClick={() => {
              resetModelCatalog(nodeKey);
              setRefusal(null);
              refresh();
            }}
          >
            {`reset all (${changes})`}
          </button>
        ) : null
      }
    >
      {/* THE SCOPE, FIRST AND PLAINLY. */}
      <div className="set-models__scope" data-testid="models-scope">
        <span className="set-models__scope-head">Stored in this browser</span>
        <p className="set-models__scope-body">
          These models are stored in THIS BROWSER. They change what the launch picker offers here —
          they are not shared with your teammates, your other devices, or the CLI, and clearing site
          data removes them. The built-in list ships with the node.
        </p>
        <div className="set-models__node" data-testid="models-node">
          <span>catalog for node</span>
          <span className="set-models__node-key">{nodeKey || LOCAL_NODE}</span>
          {nodeKey !== LOCAL_NODE ? (
            <>
              <span className="set-models__node-dot">·</span>
              <span>a named server — not this browser&rsquo;s own node</span>
            </>
          ) : null}
          <span className="set-models__node-dot">·</span>
          <span data-testid="models-change-count">
            {changes === 0 ? 'no local changes' : `${changes} local change${changes === 1 ? '' : 's'}`}
          </span>
        </div>
      </div>

      {refusal ? (
        <p className="set-models__refusal" role="alert" data-testid="models-refusal">
          {refusal}
        </p>
      ) : null}

      <AddModelForm onAdd={(input) => act(addCustomModel(nodeKey, input))} />

      {all.length === 0 ? (
        <SectionAbsent
          testId="models-absent"
          head="This node offers no models at all."
          why="the built-in catalog is empty and this browser has added none — the launch picker will have nothing to offer until a model is added above"
        />
      ) : (
        groups.map((group) => (
          <section
            key={group.tool}
            className="set-models__group"
            data-testid={`models-group-${group.tool}`}
          >
            <div className="set-models__group-head">
              <span className="set-eyebrow">{group.label}</span>
              <span className="set-models__count">
                {group.rows.length === 1 ? '1 model' : `${group.rows.length} models`}
              </span>
            </div>
            {group.unknown ? (
              <p className="set-models__group-why">
                This UI does not know how to build a launch command for {group.tool}; the node may
                still accept it.
              </p>
            ) : null}
            {group.rows.length === 0 ? (
              <p className="set-models__group-why" data-testid={`models-empty-${group.tool}`}>
                No models are offered for this tool. Add one above, or reset a hidden built-in.
              </p>
            ) : (
              group.rows.map((entry) => <ModelRow key={entry.model} {...rowProps(entry)} />)
            )}
          </section>
        ))
      )}
    </SectionFrame>
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
      <div className="set-models__edit" data-testid={`model-row-${entry.model}`} data-editing="true">
        {/* The id is NOT editable — it is the identity the delta is keyed by,
            and letting it be typed over would silently orphan the delta rather
            than rename anything. Shown so the editor says what it is editing. */}
        <span className="set-models__edit-id">{entry.model}</span>
        <div className="set-models__edit-fields">
          <div className="set-models__edit-field">
            <span className="set-models__add-label">Label</span>
            <input
              className="set-field set-models__add-input"
              aria-label={`Label for ${entry.model}`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="set-models__edit-field">
            <span className="set-models__add-label">Note</span>
            <input
              className="set-field set-models__add-input"
              aria-label={`Note for ${entry.model}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <div className="set-models__edit-acts">
          <button type="button" className="set-add" onClick={() => onSave({ label, note })}>
            Save
          </button>
          <button type="button" className="set-ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`set-models__row${hidden ? ' set-models__row--hidden' : ''}`}
      data-testid={`model-row-${entry.model}`}
      data-hidden={hidden ? 'true' : undefined}
    >
      <div className="set-models__ident">
        <span className="set-models__label">{entry.label}</span>
        <span className="set-models__id">{entry.model}</span>
        {entry.note ? <span className="set-models__note">{entry.note}</span> : null}
      </div>
      <div className="set-models__marks">
        {entry.builtIn ? null : <span className="set-chip set-chip--sm">custom</span>}
        {entry.overridden ? <span className="set-chip set-chip--sm">edited</span> : null}
        {hidden ? <span className="set-chip set-chip--sm">hidden</span> : null}
      </div>
      <div className="set-models__acts">
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
    </div>
  );
}

function AddModelForm({
  onAdd,
}: {
  onAdd: (input: { model: string; label: string; agentTool: string; note?: string }) => void;
}) {
  const [model, setModel] = useState('');
  const [label, setLabel] = useState('');
  const [tool, setTool] = useState<string>(KNOWN_AGENT_TOOLS[0]);

  return (
    <div className="set-models__add" data-testid="models-add-form">
      <span className="set-eyebrow">Add a model</span>
      <div className="set-models__add-fields">
        {/* Each control is LABELLED rather than placeholder-only: at 900x600
            the id input is narrow enough that its placeholder was clipped
            mid-word ("model id (e.g. claude"), which left the field with no
            name at the width it is most often read at. */}
        <div className="set-models__add-field set-models__add-field--id">
          <span className="set-models__add-label">Model id</span>
          <input
            className="set-field set-models__add-input"
            aria-label="Model id"
            placeholder="claude-opus-5"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
        <div className="set-models__add-field set-models__add-field--label">
          <span className="set-models__add-label">Display label</span>
          <input
            className="set-field set-models__add-input"
            aria-label="Display label"
            placeholder="Claude Opus 5"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div className="set-models__add-field set-models__add-field--tool">
          <span className="set-models__add-label">Agent tool</span>
          <select
            className="set-field set-models__add-input"
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
        </div>
        <button
          type="button"
          className="set-add set-models__add-submit"
          data-testid="models-add-submit"
          onClick={() => {
            onAdd({ model, label, agentTool: tool });
            setModel('');
            setLabel('');
          }}
        >
          Add model
        </button>
      </div>
      <p className="set-models__add-hint">
        The id is the string passed to the agent CLI; the picker shows the label. Adding a model
        here does not check that the node can run it.
      </p>
    </div>
  );
}
