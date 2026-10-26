/**
 * CodeMirror 6, read-only, loaded on first use: the editor core and each
 * language pack are separate chunks, so a Workspace that never opens a file
 * never downloads them, and a TypeScript file never pulls in the Python
 * grammar. Highlighting uses `classHighlighter` (`tok-*` classes) so colours
 * come from the app's tokens in `project-file.css`, never from hex in code.
 */
import type { Extension } from '@codemirror/state';
import type { EditorLanguage } from './language';

const LOADERS: Record<Exclude<EditorLanguage, 'plain'>, () => Promise<Extension>> = {
  typescript: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true })),
  javascript: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  python: () => import('@codemirror/lang-python').then((m) => m.python()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  go: () => import('@codemirror/lang-go').then((m) => m.go()),
  rust: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  xml: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  shell: () =>
    Promise.all([import('@codemirror/language'), import('@codemirror/legacy-modes/mode/shell')]).then(([l, m]) =>
      l.StreamLanguage.define(m.shell),
    ),
};

/** The language pack for `language`; none for plain text or a pack that failed to load. */
export async function languageExtension(language: EditorLanguage): Promise<Extension> {
  if (language === 'plain') return [];
  try {
    return await LOADERS[language]();
  } catch {
    // A chunk that failed to load costs colours, not the file.
    return [];
  }
}

export interface ReadOnlyEditor {
  destroy(): void;
}

/** Mount a read-only, line-numbered view of `text` into `parent`. */
export async function mountReadOnlyEditor(
  parent: HTMLElement,
  text: string,
  language: EditorLanguage,
): Promise<ReadOnlyEditor> {
  const [{ EditorState }, view, lang, { classHighlighter }, langExt] = await Promise.all([
    import('@codemirror/state'),
    import('@codemirror/view'),
    import('@codemirror/language'),
    import('@lezer/highlight'),
    languageExtension(language),
  ]);
  const state = EditorState.create({
    doc: text,
    extensions: [
      EditorState.readOnly.of(true),
      view.EditorView.editable.of(false),
      view.lineNumbers(),
      view.highlightActiveLineGutter(),
      view.drawSelection(),
      lang.syntaxHighlighting(classHighlighter),
      lang.foldGutter(),
      langExt,
    ],
  });
  const editor = new view.EditorView({ state, parent });
  return { destroy: () => editor.destroy() };
}
