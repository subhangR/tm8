/**
 * THE TITLE WRITES ITSELF (task 01a15e22, Subhang: "the title gets
 * automatically created by the content we write, or the user can edit the
 * title").
 *
 * A doc still wearing the placeholder takes its title from its first line of
 * text, and keeps following that line as it is written. The moment the person
 * types a title of their own, the saved title stops matching the one this
 * hook last wrote, and it lets go for good — a name someone chose is never
 * overwritten by their own prose.
 */
import { useEffect, useRef } from 'react';
import { FRESH_DOC_TITLE } from './freshDocs';
import type { DocSaveHandle } from './useDocSave';

const MAX_TITLE = 80;

/** The first line of text in a markdown body, as a title; '' when there is none. */
export function titleFromBody(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw
      // Block markers: heading, quote, list bullet or number, task box.
      .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)*/, '')
      // Inline markup: images and links keep their text, emphasis and code lose their marks.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (line === '' || /^[-=]{3,}$/.test(line)) continue;
    if (line.length <= MAX_TITLE) return line;
    const cut = line.slice(0, MAX_TITLE);
    const space = cut.lastIndexOf(' ');
    return `${(space > MAX_TITLE / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return '';
}

/**
 * Keeps an untitled doc's title in step with its first line while `active`.
 * Rides the same `DocSaveHandle` as the body, so the title and the text land
 * in one patch against one base version.
 */
export function useAutoTitle(save: DocSaveHandle, active: boolean): void {
  /* The last title this hook wrote. A saved title equal to it is still ours to
     follow; any other title is the person's. */
  const written = useRef<string | null>(null);
  useEffect(() => {
    if (!active || save.unavailable !== null) return;
    const ours = save.title === FRESH_DOC_TITLE || save.title === written.current;
    if (!ours) return;
    const next = titleFromBody(save.body) || FRESH_DOC_TITLE;
    if (next === save.title) return;
    written.current = next;
    save.edit({ title: next });
  }, [active, save, save.body, save.title, save.unavailable]);
}
