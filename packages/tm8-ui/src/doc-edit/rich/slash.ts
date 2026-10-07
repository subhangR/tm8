import type { Editor } from '@tiptap/core';

/** `/query` before the caret: the range it covers and the words after `/`. */
export interface SlashRange {
  from: number;
  to: number;
  query: string;
}

/**
 * `/` opens the menu at the start of a line or after a space, never inside a
 * word (`and/or`, a path) and never inside code, where `/` is just text.
 */
export function slashAt(editor: Editor): SlashRange | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  if ($from.parent.type.spec.code) return null;
  if ($from.marks().some((mark) => mark.type.name === 'code')) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(before);
  if (!match) return null;
  const query = match[1] ?? '';
  return { from: selection.from - query.length - 1, to: selection.from, query };
}

/** The blocks '/' offers, in the order a writer reaches for them. */
export const SLASH_BLOCKS: ReadonlyArray<{ id: string; label: string; run(editor: Editor): void }> = [
  { id: 'h1', label: 'Heading 1', run: (e) => e.chain().focus().setNode('heading', { level: 1 }).run() },
  { id: 'h2', label: 'Heading 2', run: (e) => e.chain().focus().setNode('heading', { level: 2 }).run() },
  { id: 'h3', label: 'Heading 3', run: (e) => e.chain().focus().setNode('heading', { level: 3 }).run() },
  { id: 'bullets', label: 'Bulleted list', run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: 'numbers', label: 'Numbered list', run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: 'todo', label: 'To-do list', run: (e) => e.chain().focus().toggleTaskList().run() },
  { id: 'quote', label: 'Quote', run: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: 'code', label: 'Code block', run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { id: 'mermaid', label: 'Mermaid diagram', run: (e) => e.chain().focus().setCodeBlock({ language: 'mermaid' }).run() },
  {
    id: 'table',
    label: 'Table',
    run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  { id: 'divider', label: 'Divider', run: (e) => e.chain().focus().setHorizontalRule().run() },
];
