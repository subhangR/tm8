import { useEffect, useRef, useState } from 'react';
import type { ToolView } from '@tm8/contract';
import { useDismissable } from '../panels/useDismissable';
import type { ToolPort, ToolSourceChange } from './port';
import { InputValue } from './InputValue';
import { initialValues, runValues, UI_ACCESS_REFUSAL } from './values';

export function RunDialog({ tool, port, onClose, onOpenSession }: { tool: ToolView; port: ToolPort; onClose(): void; onOpenSession(id: string): void }) {
  const [values, setValues] = useState(() => initialValues(tool));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [change, setChange] = useState<ToolSourceChange | null>(null);
  const [checking, setChecking] = useState(true);
  const [sourceError, setSourceError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  useDismissable(true, dialog, () => { if (!busy) onClose(); });
  useEffect(() => { let active = true;
    void port.sourceChange(tool).then(result => { if (active) { setChange(result); setChecking(false); } }, failure => { if (active) { setSourceError(failure instanceof Error ? failure.message : 'The source-change check could not be loaded. Reopen the Run dialog to retry.'); setChecking(false); } });
    const previousFocus = document.activeElement;
    dialog.current?.querySelector<HTMLElement>('input, select, button')?.focus();
    const focusTrap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)')];
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', focusTrap);
    return () => { active = false; document.removeEventListener('keydown', focusTrap); if (previousFocus instanceof HTMLElement) previousFocus.focus(); };
  }, [port, tool]);
  const refused = tool.definition.tm8Access !== 'none';
  return <div className="tool-dialog-backdrop"><div ref={dialog} className="tool-dialog" role="dialog" aria-modal="true" aria-label={`Run ${tool.definition.name}`}>
    <h2>Run {tool.definition.name}</h2><p>{tool.definition.description}</p>
    {change && <p role="status" className="tool-notice">Source changed since your last run, by {change.changedBy}.</p>}
    {checking && <p role="status">Checking source changes…</p>}
    {sourceError && <p role="alert">{sourceError}</p>}
    {refused && <p role="alert">{UI_ACCESS_REFUSAL}</p>}
    <form onSubmit={event => { event.preventDefault(); if (busy || refused || checking || sourceError) return; setError('');
      let resolved: ReturnType<typeof runValues>;
      try { resolved = runValues(tool, values, secrets); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Check the inputs.'); return; }
      setBusy(true); setSecrets({});
      void port.run({ toolId: tool.id, clientMutationId: `tool-run-${crypto.randomUUID()}`, keepOpen: true, ...resolved }).then(run => { onOpenSession(run.sessionId); onClose(); }, () => { setError('The tool could not be started. Check input values, secret access and permissions, then try again.'); setBusy(false); });
    }}>
      {tool.definition.inputs.map(input => <label key={input.name} className="tool-field"><span>{input.name}{input.required ? ' · required' : ''}</span>
        {input.description && <small>{input.description}</small>}
        <InputValue input={input} value={(input.type === 'secret' ? secrets : values)[input.name] ?? ''} disabled={busy || refused}
          onChange={value => input.type === 'secret' ? setSecrets(previous => ({ ...previous, [input.name]: value })) : setValues(previous => ({ ...previous, [input.name]: value }))} />
        {input.type === 'secret' && tool.secretBindings.some(binding => binding.inputName === input.name) && <small>Leave blank to use the saved secret.</small>}
      </label>)}
      {error && <p role="alert">{error}</p>}
      <p>The terminal stays open as a shell after the tool exits. Close the tab when you’re finished.</p>
      <div className="tool-actions"><button type="button" className="pn-btn" disabled={busy} onClick={onClose}>Cancel</button><button className="pn-btn pn-btn--primary" disabled={busy || refused || checking || Boolean(sourceError)}>{busy ? 'Starting…' : 'Run tool'}</button></div>
    </form>
  </div></div>;
}
