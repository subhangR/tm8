import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { UploadCancelledError } from '../../files/upload';
import { fileReference, filterTriggerOptions, type TriggerOption } from '../../rich-input';
import type { DocAttach } from '../DocSource';
import { InsertBar } from '../DocSource';
import type { DocSaveHandle } from '../useDocSave';
import { installMinimalEscaping, renderedShape, richExtensions } from './markdown';
import { SLASH_BLOCKS, slashAt, type SlashRange } from './slash';

/**
 * THE BODY, WRITTEN AS IT READS (New doc UX, 2026-10-07).
 *
 * One TipTap editor over a markdown body, driven by any `DocSaveHandle` — a
 * doc's, a task's description, a story's — so every long text in tm8 is
 * written the same way and autosaves the same way. It draws with the reader's
 * own typography (`md-root rd-md`), so entering edit does not move the text
 * the person was just reading.
 *
 * THE HANDLE STAYS THE SOURCE OF TRUTH. A keystroke serialises to markdown and
 * goes through `save.edit`; a body that changes from OUTSIDE (load theirs, a
 * restored device draft) is pushed back in. Opening a document emits nothing,
 * so a doc nobody typed in is never re-spelled by the serialiser.
 *
 * Bodies the editor cannot keep (see `roundTrips`) never reach this component;
 * the host edits them as markdown source instead.
 */
export function RichBody({
  save,
  label = 'Document',
  placeholder = 'Write, or type / for blocks and skills',
  fileHref,
  attach,
  onAttached,
  skillOptions,
}: {
  save: DocSaveHandle;
  label?: string;
  placeholder?: string;
  fileHref?: (fileEntityId: string) => string | null;
  /** Absent ⇒ no insert control and no file paste/drop. */
  attach?: DocAttach;
  onAttached?: () => void;
  /** Skills '/' offers beside the blocks. */
  skillOptions?: readonly TriggerOption[];
}) {
  const readOnly = save.unavailable !== null;
  const canInsert = attach !== undefined && !readOnly;

  /* Callbacks ProseMirror holds for the editor's lifetime read these, never
     the values captured on the render that created the editor. */
  const handle = useRef(save);
  handle.current = save;
  const emitted = useRef(save.body);
  const changedMeaning = useRef(false);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const slashRef = useRef(slash);
  slashRef.current = slash;
  const dismissedAt = useRef<number | null>(null);
  const [busy, setBusy] = useState<readonly string[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadRef = useRef<(files: readonly File[], at?: number) => void>(() => {});

  const extensions = useMemo(() => richExtensions({ placeholder, fileHref }), [placeholder, fileHref]);

  const editor = useEditor(
    {
      extensions,
      content: save.body,
      contentType: 'markdown',
      editable: !readOnly,
      editorProps: {
        attributes: {
          class: 'md-root rd-md de-rich__doc',
          'data-testid': 'doc-rich',
          'aria-label': label,
          role: 'textbox',
          'aria-multiline': 'true',
        },
        handleKeyDown: (_view, event) => {
          const open = slashRef.current;
          if (open && open.items.length > 0) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setSlash({ ...open, current: (open.current + step + open.items.length) % open.items.length });
              return true;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault();
              pickRef.current(open.items[open.current]!);
              return true;
            }
          }
          if (open && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            dismissedAt.current = open.range.from;
            setSlash(null);
            return true;
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void handle.current.save();
            return true;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            // Esc in a field belongs to the field (C6 layer 4).
            event.stopPropagation();
            if (handle.current.autosave) void handle.current.flush();
            else handle.current.cancel();
            return true;
          }
          return false;
        },
        handlePaste: (_view, event) => {
          const files = [...(event.clipboardData?.files ?? [])];
          if (files.length === 0 || attachRef.current === undefined) return false;
          event.preventDefault();
          uploadRef.current(files);
          return true;
        },
        handleDrop: (view, event) => {
          const files = [...(event.dataTransfer?.files ?? [])];
          if (files.length === 0 || attachRef.current === undefined) return false;
          event.preventDefault();
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          uploadRef.current(files, at);
          return true;
        },
      },
      onCreate: ({ editor: created }) => installMinimalEscaping(created),
      onUpdate: ({ editor: changed }) => {
        const body = changed.getMarkdown();
        if (body === emitted.current) return;
        /* The editor tidies a document as it opens (a trailing paragraph
           after a closing list or table), and that arrives as an update.
           Until something changes what the text MEANS, nothing is sent: a
           doc nobody typed in keeps its own spelling. */
        if (!changedMeaning.current && renderedShape(body) === renderedShape(emitted.current)) return;
        changedMeaning.current = true;
        emitted.current = body;
        handle.current.edit({ body });
      },
      onBlur: () => {
        if (handle.current.autosave) void handle.current.flush();
      },
    },
    [extensions],
  );

  const attachRef = useRef(canInsert ? attach : undefined);
  attachRef.current = canInsert ? attach : undefined;

  /* A body changed by someone other than this editor comes back in. */
  useEffect(() => {
    if (!editor || save.body === emitted.current) return;
    emitted.current = save.body;
    changedMeaning.current = false;
    editor.commands.setContent(save.body, { contentType: 'markdown', emitUpdate: false });
  }, [editor, save.body]);

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  /* The '/' menu follows the caret: open while `/word` sits before it. */
  useEffect(() => {
    if (!editor) return;
    const follow = () => {
      const range = slashAt(editor);
      if (!range || range.from === dismissedAt.current) {
        if (!range) dismissedAt.current = null;
        setSlash(null);
        return;
      }
      const items = slashItems(range.query, skillOptions);
      const coords = caretBox(editor, range.from);
      setSlash((was) => ({
        range,
        items,
        current: was && was.range.from === range.from ? Math.min(was.current, Math.max(0, items.length - 1)) : 0,
        at: { left: coords.left, top: coords.bottom },
      }));
    };
    editor.on('selectionUpdate', follow);
    editor.on('update', follow);
    return () => {
      editor.off('selectionUpdate', follow);
      editor.off('update', follow);
    };
  }, [editor, skillOptions]);

  const pickRef = useRef<(item: SlashItem) => void>(() => {});
  pickRef.current = (item) => {
    const open = slashRef.current;
    if (!editor || !open) return;
    setSlash(null);
    editor.chain().focus().deleteRange(open.range).run();
    item.run(editor);
  };

  uploadRef.current = (files, at) => {
    const start = attachRef.current;
    if (!editor || !start) return;
    setUploadError(null);
    /* Where the references go, carried through every edit made while the
       bytes are on their way, and advanced past each one that lands. */
    let pos = at ?? editor.state.selection.from;
    const remap = ({ transaction }: { transaction: { mapping: { map(p: number): number } } }) => {
      pos = transaction.mapping.map(pos);
    };
    editor.on('transaction', remap);
    let pending = files.length;
    const settle = () => {
      pending -= 1;
      if (pending === 0) editor.off('transaction', remap);
    };
    for (const file of files) {
      setBusy((names) => [...names, file.name]);
      let task;
      try {
        task = start(file);
      } catch (error) {
        setBusy((names) => names.filter((name) => name !== file.name));
        setUploadError(error instanceof Error ? error.message : String(error));
        settle();
        continue;
      }
      task.result
        .then((uploaded) => {
          if (editor.isDestroyed) return;
          const reference = fileReference(uploaded.name, uploaded.fileEntityId, uploaded.mime);
          const before = editor.state.doc.content.size;
          editor.chain().insertContentAt(Math.min(pos, before), reference, { contentType: 'markdown' }).run();
          onAttached?.();
        })
        .catch((error: unknown) => {
          if (error instanceof UploadCancelledError) return;
          setUploadError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          setBusy((names) => names.filter((name) => name !== file.name));
          settle();
        });
    }
  };

  return (
    <div className="de-rich">
      <EditorContent editor={editor} className="de-rich__body" />
      {slash && slash.items.length > 0 ? (
        <SlashMenu state={slash} onPick={(item) => pickRef.current(item)} onHover={(current) => setSlash({ ...slash, current })} />
      ) : null}
      <InsertBar
        canInsert={canInsert}
        busy={busy}
        error={uploadError}
        begin={(files) => uploadRef.current(files)}
        readOnly={readOnly}
      />
    </div>
  );
}

/** Where the menu hangs: under the `/`, or under the editor's top-left
    corner when the browser cannot measure a caret (no layout). */
function caretBox(editor: Editor, pos: number): { left: number; bottom: number } {
  try {
    return editor.view.coordsAtPos(pos);
  } catch {
    const box = editor.view.dom.getBoundingClientRect();
    return { left: box.left, bottom: box.top };
  }
}

// ---------------------------------------------------------------------------
// THE '/' MENU — blocks first, then skills, one list
// ---------------------------------------------------------------------------

export interface SlashItem {
  id: string;
  label: string;
  group: 'Blocks' | 'Skills';
  meta?: string;
  run(editor: Editor): void;
}

interface SlashState {
  range: SlashRange;
  items: readonly SlashItem[];
  current: number;
  at: { left: number; top: number };
}

export function slashItems(query: string, skills: readonly TriggerOption[] = []): SlashItem[] {
  const q = query.toLowerCase();
  const blocks = SLASH_BLOCKS.filter((block) => block.label.toLowerCase().includes(q) || block.id.startsWith(q)).map(
    (block): SlashItem => ({ ...block, group: 'Blocks' }),
  );
  const skillRows = filterTriggerOptions(skills, query).map(
    (skill): SlashItem => ({
      id: `skill:${skill.id}`,
      label: `/${skill.display}`,
      group: 'Skills',
      ...(skill.meta ? { meta: skill.meta } : {}),
      run: (editor) =>
        editor
          .chain()
          .focus()
          .insertContent([
            {
              type: 'text',
              text: `/${skill.display}`,
              marks: [{ type: 'link', attrs: { href: `tm8://skill/${encodeURIComponent(skill.id)}` } }],
            },
            { type: 'text', text: ' ' },
          ])
          .run(),
    }),
  );
  return [...blocks, ...skillRows];
}

function SlashMenu({
  state,
  onPick,
  onHover,
}: {
  state: SlashState;
  onPick(item: SlashItem): void;
  onHover(index: number): void;
}) {
  let group: string | null = null;
  return (
    <div
      className="de-slash"
      role="listbox"
      aria-label="Insert a block or a skill"
      data-testid="doc-slash-menu"
      style={{ position: 'fixed', left: state.at.left, top: state.at.top + 4 }}
    >
      {state.items.map((item, index) => {
        const heading = item.group !== group ? item.group : null;
        group = item.group;
        return (
          <div key={item.id}>
            {heading ? <div className="de-slash__group">{heading}</div> : null}
            <div
              role="option"
              aria-selected={index === state.current}
              className="de-slash__item"
              data-current={index === state.current ? '' : undefined}
              data-testid="doc-slash-item"
              /* mousedown, not click: a click would blur the editor first. */
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(item);
              }}
              onMouseEnter={() => onHover(index)}
            >
              <span className="de-slash__label">{item.label}</span>
              {item.meta ? <span className="de-slash__meta">{item.meta}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
