import { useEffect, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { languageExtension } from '../project-file/codemirror';
import '../project-file/project-file.css';

/** The existing code viewer's grammars and token colours, with editing enabled. */
export function SourceEditor({ value, runtime, onChange, readOnly = false }: { value: string; runtime: 'bash' | 'python'; onChange(value: string): void; readOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const current = useRef({ value, onChange }); current.current = { value, onChange };
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true; setReady(false);
    void Promise.all([import('@codemirror/state'), import('@codemirror/view'), import('@codemirror/language'), import('@lezer/highlight'), languageExtension(runtime === 'bash' ? 'shell' : 'python')]).then(([state, editor, language, highlight, grammar]) => {
      if (!active || !host.current) return;
      view.current = new editor.EditorView({ parent: host.current, state: state.EditorState.create({ doc: current.current.value, extensions: [
        state.EditorState.readOnly.of(readOnly), editor.EditorView.editable.of(!readOnly),
        editor.EditorView.contentAttributes.of({ 'aria-label': 'Source', role: 'textbox', 'aria-multiline': 'true' }),
        editor.lineNumbers(), editor.drawSelection(), language.syntaxHighlighting(highlight.classHighlighter), grammar,
        editor.EditorView.updateListener.of(update => { if (update.docChanged) current.current.onChange(update.state.doc.toString()); }),
      ] }) });
      setReady(true);
    }).catch(() => { /* The editable textarea remains usable if a chunk fails. */ });
    return () => { active = false; view.current?.destroy(); view.current = null; };
  }, [runtime, readOnly]);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);
  return <div className="tool-source pf-code" data-language={runtime}>
    <div ref={host} hidden={!ready} />
    {!ready && <textarea aria-label="Source" rows={16} value={value} onChange={event => onChange(event.target.value)} readOnly={readOnly} spellCheck={false} />}
  </div>;
}
