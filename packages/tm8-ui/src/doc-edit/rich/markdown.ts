/**
 * MARKDOWN IN, MARKDOWN OUT — the contract the rich editor keeps with the
 * stored body (New doc UX, 2026-10-07: TipTap v3 + @tiptap/markdown).
 *
 * The record stays markdown. TipTap is only the way a person writes it, so
 * every body has to survive parse → edit → serialise without changing what it
 * MEANS. Spelling may move (`*` lists come back as `-`, tables are padded,
 * setext headings become `#`); the rendered document may not. `roundTrips` is
 * the check, and a body that fails it is edited as markdown source instead —
 * never silently rewritten. Raw HTML is the usual reason: TipTap has no node
 * for it and would drop it.
 *
 * TWO MARKED INSTANCES, NEITHER THE GLOBAL ONE. @tiptap/markdown registers its
 * tokenizers on whatever instance it is given; given none, it uses the global
 * `marked`, and every later `marked()` in the app then throws "Token with
 * taskList type was not found". The editor gets its own instance, and the
 * comparison renders through another clean one.
 */
import { Editor, mergeAttributes, type AnyExtension } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Placeholder from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { Marked, type marked } from 'marked';

export interface RichExtensionOptions {
  /** Grey text in an empty body. Absent ⇒ none. */
  placeholder?: string;
  /**
   * Resolves `tm8://file/<id>` image sources for DISPLAY. Only the drawn
   * `<img>` changes; the stored markdown keeps the tm8 reference.
   */
  fileHref?: (fileEntityId: string) => string | null;
}

const TM8_FILE = /^tm8:\/\/file\/(.+)$/;

function displayedImage(fileHref: RichExtensionOptions['fileHref']) {
  return Image.extend({
    renderHTML({ HTMLAttributes }) {
      const src = typeof HTMLAttributes.src === 'string' ? HTMLAttributes.src : '';
      const file = TM8_FILE.exec(src);
      const shown = file && fileHref ? (fileHref(decodeURIComponent(file[1]!)) ?? src) : src;
      return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { src: shown })];
    },
  });
}

export function richExtensions(options: RichExtensionOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      /* Links open on ⌘click only: a plain click places the caret, which is
         what a writer clicking into a sentence means. */
      link: { openOnClick: false, autolink: true, protocols: ['tm8'] },
      /* Markdown has no underline; a mark it cannot store is a mark that
         vanishes on reload. */
      underline: false,
    }),
    TableKit,
    TaskList,
    TaskItem.configure({ nested: true }),
    displayedImage(options.fileHref),
    ...(options.placeholder ? [Placeholder.configure({ placeholder: options.placeholder })] : []),
    /* The option is typed as the global; an instance carries every method
       the extension calls on it. */
    Markdown.configure({ marked: new Marked() as unknown as typeof marked }),
  ];
}

/**
 * The text escaping @tiptap/markdown ships HTML-encodes every `&`, `<` and
 * `>` into the markdown itself, so "R&D" is stored as "R&amp;D" and grows an
 * entity on every save. Markdown only needs an escape where the character
 * would otherwise START something: `<` before a tag or comment, `&` before an
 * entity, `>` at the start of a line (a quote). The library's own code-span
 * skip and its backslash escapes are kept; `_` inside a word is left alone,
 * because GFM never reads it as emphasis there (`snake_case` stays readable).
 */
const ESCAPE_TARGET = /([\\`*[\]~])|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu;

export function encodeMinimal(text: string): string {
  return text
    .replace(ESCAPE_TARGET, (m) => `\\${m}`)
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '&amp;')
    .replace(/<(?=[A-Za-z/!?])/g, '&lt;')
    .replace(/^>/, '&gt;');
}

interface EncodingManager {
  codeTypes: Set<string>;
  encodeTextForMarkdown(text: string, node: { marks?: readonly unknown[] }, parent?: { type?: string }): string;
}

/** Swaps the manager's escaping for `encodeMinimal`. Idempotent. */
export function installMinimalEscaping(editor: Editor): void {
  const manager = (editor as unknown as { markdown?: EncodingManager }).markdown;
  if (!manager || typeof manager.encodeTextForMarkdown !== 'function') return;
  manager.encodeTextForMarkdown = (text, node, parent) => {
    const inCode =
      (parent?.type != null && manager.codeTypes.has(parent.type)) ||
      (node.marks ?? []).some((m) =>
        manager.codeTypes.has(typeof m === 'string' ? m : (m as { type: string }).type),
      );
    return inCode ? text : encodeMinimal(text);
  };
}

/** Parse → serialise once, as the editor would on its first keystroke. */
export function reserialise(markdown: string): string {
  const editor = new Editor({
    element: null,
    extensions: richExtensions(),
    content: markdown,
    contentType: 'markdown',
  });
  try {
    installMinimalEscaping(editor);
    return editor.getMarkdown();
  } finally {
    editor.destroy();
  }
}

const reference = new Marked({ gfm: true });

/** Rendered HTML with the whitespace between tags removed. */
export function renderedShape(markdown: string): string {
  const html = reference.parse(markdown, { async: false }) as string;
  return html
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();
}

const verdicts = new Map<string, boolean>();

/**
 * Does this body come back meaning the same thing? Cached per body: the
 * editor asks once per document it opens, and a headless editor is not free.
 */
export function roundTrips(markdown: string): boolean {
  const known = verdicts.get(markdown);
  if (known !== undefined) return known;
  let verdict: boolean;
  try {
    verdict = renderedShape(reserialise(markdown)) === renderedShape(markdown);
  } catch {
    verdict = false;
  }
  if (verdicts.size > 200) verdicts.clear();
  verdicts.set(markdown, verdict);
  return verdict;
}
