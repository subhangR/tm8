import { useEffect, useId, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { TOOL_STARTERS, toolStarterDefinition, toolStarterNamed, type ToolView } from '@tm8/contract';
import { EMPTY_HEADER_DRAFT, headerDraftHasText, headerInputOf, type HeaderDraft } from '../domain';
import { HeaderFields } from '../panels/detail/HeaderSection';
import { DefinitionForm, definitionOfDraft, draftOfDefinition, newDefinitionDraft, type DefinitionDraft } from './DefinitionForm';
import { definitionProblemOf, type DefinitionProblem } from './errors';
import type { ToolPort } from './port';
import './tools.css';

/**
 * Everything the create form holds between keystrokes: the starter it began
 * from (`''` for a blank tool), the definition as typed, and the selection
 * header. The draft tab stores it, so a remount (tab switch, reload) restores
 * the half-written tool instead of a blank form.
 */
export interface ToolCreateValues {
  starter: string;
  draft: DefinitionDraft;
  header: HeaderDraft;
}

export function newToolCreateValues(): ToolCreateValues {
  return { starter: '', draft: newDefinitionDraft(), header: EMPTY_HEADER_DRAFT };
}

/** A starter's values: every definition field plus its selection header, all editable afterwards. */
export function toolCreateValuesOfStarter(name: string): ToolCreateValues | null {
  const starter = toolStarterNamed(name);
  if (!starter) return null;
  return {
    starter: starter.name,
    draft: draftOfDefinition(toolStarterDefinition(starter)),
    header: { whenToUse: starter.whenToUse, summary: starter.summary, keywords: '' },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';

function isDefinitionDraft(value: unknown): value is DefinitionDraft {
  return isRecord(value) && isText(value.name) && isText(value.description) && (value.runtime === 'bash' || value.runtime === 'python')
    && isText(value.source) && Array.isArray(value.inputs) && value.inputs.every(row => isRecord(row) && isText(row.name) && isText(row.type))
    && isText(value.help) && (value.tm8Access === 'none' || value.tm8Access === 'read' || value.tm8Access === 'write') && isText(value.timeout);
}

function isHeaderDraft(value: unknown): value is HeaderDraft {
  return isRecord(value) && isText(value.whenToUse) && isText(value.summary) && isText(value.keywords);
}

/** The draft tab's stored values, when they still look like this form's; anything else starts blank. */
export function toolCreateValuesOf(values: Record<string, unknown> | null | undefined): ToolCreateValues | null {
  if (!values || !isDefinitionDraft(values.draft) || !isHeaderDraft(values.header)) return null;
  return { starter: isText(values.starter) ? values.starter : '', draft: values.draft, header: values.header };
}

/** What a create returns to its host: the new tool, and a header the node did not store (a notice, never a failure). */
export interface ToolCreated {
  tool: ToolView;
  headerNotStored: string | null;
}

const errorText = (failure: unknown) => failure instanceof Error ? failure.message : 'The request could not be completed.';

/**
 * CREATE A TOOL — the one door for the New tab (`ToolDraftBody`, `autoOpen`),
 * the Tools list header (`EntityCreateControl`, a button that opens this form
 * in a dialog) and, through them, the ⌘K palette and the `n u` chord.
 *
 * The definition fields are `DefinitionForm`, the same component the tool
 * page's editor uses, so create and edit cannot drift apart. Create adds
 * "Start from a starter" (every field prefilled from `TOOL_STARTERS`, still
 * editable) and the selection header, which is sent with
 * `entities.header.set` AFTER `tools.create` returns: a header the node does
 * not store is reported as a notice, never as a failed create. A refusal is
 * placed on the field its path names and the server's own message heads the
 * form (`definitionProblemOf`); nothing is replaced by a generic sentence.
 */
export function ToolCreateControl({ spaceId, port, label = 'New tool', autoOpen = false, initial, onValues, onBusy, onCreated, onCancel, onNotice }: {
  spaceId: string;
  port: ToolPort | undefined;
  /** The registry's `palette.createLabel`; the button's text when not `autoOpen`. */
  label?: string;
  /** Draft-tab hosting: the form shows at once, with no button and no dialog. */
  autoOpen?: boolean;
  /** Restored values (the draft tab's store); absent ⇒ a blank tool. */
  initial?: ToolCreateValues | null;
  /** Every change, for the host to store. */
  onValues?: (values: ToolCreateValues) => void;
  /** A create started (true) or ended without a tool (false). */
  onBusy?: (busy: boolean) => void;
  onCreated?: (created: ToolCreated) => void;
  /** Replaces the form's own Cancel (the draft tab closes itself). */
  onCancel?: () => void;
  onNotice?: (text: string) => void;
}) {
  const [open, setOpen] = useState(autoOpen);
  const [busy, setBusy] = useState(false);
  const close = () => {
    if (busy) return;
    if (onCancel) onCancel();
    if (!autoOpen) setOpen(false);
  };
  const stop = (event: MouseEvent) => event.stopPropagation();
  const form = open ? (
    <ToolCreateForm
      spaceId={spaceId}
      port={port}
      initial={initial ?? null}
      onValues={onValues}
      onBusy={next => { setBusy(next); onBusy?.(next); }}
      onCancel={close}
      onNotice={onNotice}
      onCreated={created => { if (!autoOpen) setOpen(false); onCreated?.(created); }}
    />
  ) : null;
  if (autoOpen) return form;
  return <>
    <button type="button" className="pn-btn pn-btn--primary" disabled={!port} title={port ? undefined : 'Tools are unavailable on this connection.'}
      onClick={() => setOpen(true)} data-testid="tool-create-open">{label}</button>
    {open ? (
      <div className="au-dialog__backdrop" role="presentation" onMouseDown={close}>
        <div className="au-dialog tool-create-dialog" role="dialog" aria-modal="true" aria-label="New tool" data-testid="tool-create-dialog" onMouseDown={stop}
          onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
          <h2 className="au-dialog__title">New tool</h2>
          {form}
        </div>
      </div>
    ) : null}
  </>;
}

function ToolCreateForm({ spaceId, port, initial, onValues, onBusy, onCancel, onCreated, onNotice }: {
  spaceId: string;
  port: ToolPort | undefined;
  initial: ToolCreateValues | null;
  onValues?: (values: ToolCreateValues) => void;
  onBusy(busy: boolean): void;
  onCancel(): void;
  onCreated(created: ToolCreated): void;
  onNotice?: (text: string) => void;
}) {
  const id = useId();
  const formRef = useRef<HTMLFormElement | null>(null);
  const starterRef = useRef<HTMLSelectElement | null>(null);
  const [values, setValues] = useState<ToolCreateValues>(() => initial ?? newToolCreateValues());
  const [problem, setProblem] = useState<DefinitionProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => { starterRef.current?.focus(); }, []);
  /* A refusal lands the caret on the first field it names. */
  useEffect(() => {
    if (!problem || !Object.keys(problem.fields).length) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [problem]);

  const update = (next: ToolCreateValues) => { setValues(next); onValues?.(next); };
  const pickStarter = (name: string) => {
    update((name ? toolCreateValuesOfStarter(name) : null) ?? newToolCreateValues());
    setProblem(null);
  };
  const starter = values.starter ? toolStarterNamed(values.starter) : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current || !port) return;
    setProblem(null);
    const parsed = definitionOfDraft(values.draft);
    if ('problem' in parsed) { setProblem(parsed.problem); return; }
    inFlight.current = true;
    setBusy(true); onBusy(true);
    let created: ToolCreated;
    try {
      const tool = await port.create(spaceId, parsed.definition);
      let headerNotStored: string | null = null;
      if (headerDraftHasText(values.header)) {
        try {
          const outcome = await port.setHeader(tool.id, headerInputOf(values.header));
          if (!outcome.stored) headerNotStored = outcome.reason;
        } catch (failure) {
          headerNotStored = errorText(failure);
        }
      }
      created = { tool, headerNotStored };
    } catch (failure) {
      setProblem(definitionProblemOf(failure));
      setBusy(false); onBusy(false);
      inFlight.current = false;
      return;
    }
    inFlight.current = false;
    if (created.headerNotStored) onNotice?.(`Tool ${created.tool.definition.name} created. Its selection header was not stored: ${created.headerNotStored}`);
    onCreated(created);
  };

  const marked = problem !== null && Object.keys(problem.fields).length > 0;
  return (
    <form ref={formRef} className="tool-definition tool-create" aria-label="New tool" data-testid="tool-create-form" noValidate onSubmit={event => void submit(event)}>
      <fieldset disabled={busy || !port}>
        <div className="tool-field">
          <label htmlFor={`${id}-starter`}>Start from a starter</label>
          <select id={`${id}-starter`} ref={starterRef} value={values.starter} onChange={event => pickStarter(event.target.value)} data-testid="tool-create-starter">
            <option value="">Blank tool</option>
            {TOOL_STARTERS.map(item => <option key={item.name} value={item.name}>{`${item.name} (${item.runtime})`}</option>)}
          </select>
          <span className="tool-starter-note">{starter ? starter.description : 'A starter fills in every field below; edit anything afterwards.'}</span>
        </div>
        <DefinitionForm draft={values.draft} onChange={draft => update({ ...values, draft })} disabled={busy} errors={problem?.fields} />
        <section aria-label="Selection header" className="tool-create-header">
          <h3>Selection header</h3>
          <p className="tool-starter-note">Agents read this to decide when to open the tool. Optional; stored after the tool is created.</p>
          <HeaderFields draft={values.header} onChange={header => update({ ...values, header })} disabled={busy} />
        </section>
        {!port && <p role="alert" className="tool-form-problem">Tools are unavailable on this connection.</p>}
        {problem?.message && <p role="alert" className="tool-form-problem" data-testid="tool-create-problem">{problem.message}</p>}
        {marked && <p role="alert" className="tool-form-problem">Fix the marked fields, then create again.</p>}
        <div className="tool-actions tws-draft-actions">
          <button type="button" className="pn-btn" onClick={onCancel} disabled={busy} data-testid="tool-create-cancel">Cancel</button>
          <button type="submit" className="pn-btn pn-btn--primary" aria-busy={busy || undefined} disabled={busy || !port} data-testid="tool-create-submit">{busy ? 'Creating…' : 'Create tool'}</button>
        </div>
      </fieldset>
    </form>
  );
}
