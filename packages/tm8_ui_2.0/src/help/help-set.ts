/**
 * WHERE HELP COMES FROM — this repository, and nothing else.
 *
 * Help was read from a `collection` entity and its ordered `contains` edges at
 * run time until 2026-08-20, so that publishing a new page was a graph write
 * rather than a release. The owner has now ruled the other way, for the reason
 * that outranks it: **the field guide ships with the application.** A node
 * whose graph is unreachable, a fresh install, a Space that never curated a
 * shelf — all three used to get an empty Help screen, and Help is exactly what
 * a reader in that position needs. The reading path here touches no seam, no
 * network and no collection.
 *
 * THE COLLECTION IS STILL THE AUTHORING SURFACE. `tm8 Help`
 * (`01a01b1b-ff3d-7aa7-8f1e-b7da35eda726`) remains where plates are drafted,
 * reviewed, ordered and published; `help-plates.ts` records which immutable
 * revision of each was vendored, so the graph stays the provenance of record.
 * What changed is only where a READER's bytes come from.
 *
 * ORDER AND CHAPTER ARE THE REGISTRY'S. `HelpPlateDefinition.number` is the
 * guide's global reading order and `.section` its chapter — both written down,
 * neither derived. The old position-band heuristic (1–99 ⇒ Section 0, 100–199
 * ⇒ Section A, …) is gone: it could not survive the flat 1–55 renumbering,
 * under which every plate in the guide would have landed in Section 0.
 */
import { HELP_PLATES, type HelpPlateDefinition, type HelpSectionId } from './help-plates';

export type { HelpSectionId };

export interface HelpChapterDefinition {
  readonly id: HelpSectionId;
  readonly number: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly summary: string;
  /** Plain-language feature names a reader is likely to search for. */
  readonly keywords: string;
}

/**
 * The editorial structure from the binding Help content tree
 * (`01a01ba8-ddb7-7207-bb3f-ada5542e67f2`). Chapter labels only — membership is
 * each plate's own `section`.
 */
export const HELP_CHAPTERS: readonly HelpChapterDefinition[] = [
  { id: '0', number: '00', eyebrow: 'Orientation', title: 'What tm8 does', summary: 'One conversation, one graph, and the three shapes that hold the work.', keywords: 'overview basics start home chat workspace' },
  { id: 'A', number: 'A', eyebrow: 'Under the hood', title: 'How tm8 is built', summary: 'The catalog, the terminal stream, and the identities allowed to act.', keywords: 'server cli api terminal permissions security architecture' },
  { id: '1', number: '01', eyebrow: 'Arrival', title: 'Getting going', summary: 'Install, claim, diagnose, and invite another person in.', keywords: 'setup account login onboarding doctor troubleshoot members' },
  { id: '2', number: '02', eyebrow: 'Foundation', title: 'The graph', summary: 'Entities, connections, collections, and the rules that keep them coherent.', keywords: 'entity links edges collections folders context relationships' },
  { id: '3', number: '03', eyebrow: 'Agency', title: 'Teammates & sessions', summary: 'Who works, where execution lives, and how identity carries through.', keywords: 'agents ai models skills spawn worktree execution persona' },
  { id: '4', number: '04', eyebrow: 'Practice', title: 'Work', summary: 'Tasks, projects, plans, launches, and delivery from one shared record.', keywords: 'task project board status assignee acceptance done delivery' },
  { id: '5', number: '05', eyebrow: 'Orchestration', title: 'Coordination', summary: 'Messages, handoffs, attention, and durable team awareness.', keywords: 'message chat inbox notification coordinator delegation blocker' },
  { id: '6', number: '06', eyebrow: 'Depth', title: 'Memory, loops & spells', summary: 'Long-lived context and repeatable operating patterns.', keywords: 'knowledge automation schedule recurring context remember' },
  { id: '7', number: '07', eyebrow: 'Making', title: 'Craft', summary: 'Designing and publishing graphs as living entities.', keywords: 'blueprint design plan materialize specification' },
  { id: '8', number: '08', eyebrow: 'Together', title: 'Collaboration', summary: 'Working across humans, teammates, sessions, and shared spaces.', keywords: 'channels mentions rooms people multiplayer team' },
] as const;

export interface HelpPage {
  readonly plate: HelpPlateDefinition;
  /** URL-safe address; the deep-link segment and the React key. */
  readonly slug: string;
  readonly title: string;
  /** The plate's own opening sentence — see `HelpPlateDefinition.lede`. */
  readonly excerpt: string;
  /** Global plate number — 1-based, and the index into `HelpSet.pages` plus 1. */
  readonly number: number;
  readonly sectionId: HelpSectionId;
}

export interface HelpChapter extends HelpChapterDefinition {
  readonly pages: readonly HelpPage[];
}

export interface HelpSet {
  /** Every plate, in the canonical reading order. */
  readonly pages: readonly HelpPage[];
  /** Every chapter, in content-tree order, each carrying its own plates. */
  readonly chapters: readonly HelpChapter[];
}

function searchWords(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
}

function wordMatches(query: string, candidate: string): boolean {
  /* The reverse comparison makes simple plurals useful ("agents" finds
     "agent"), but short prose words such as "a" and "the" must never turn
     every page into a match. */
  return candidate.includes(query) || (candidate.length >= 3 && query.includes(candidate));
}

/**
 * Filter the guide by the words a reader sees, plus a small vocabulary of
 * familiar product terms. A chapter-name match keeps the whole chapter so a
 * broad search such as "tasks" or "agents" returns an organised reading set;
 * otherwise only matching plates remain.
 */
export function searchHelpSet(set: HelpSet, rawQuery: string): HelpSet {
  const query = searchWords(rawQuery);
  if (query.length === 0) return set;

  const chapters = set.chapters.flatMap((chapter) => {
    const chapterWords = searchWords([
      chapter.eyebrow,
      chapter.title,
      chapter.summary,
      chapter.keywords,
    ].join(' '));
    const chapterMatches = query.every((term) =>
      chapterWords.some((candidate) => wordMatches(term, candidate)));

    const pages = chapterMatches
      ? chapter.pages
      : chapter.pages.filter((page) => {
          const pageWords = searchWords([page.title, page.excerpt, page.slug].join(' '));
          return query.every((term) =>
            pageWords.some((candidate) => wordMatches(term, candidate)));
        });

    return pages.length > 0 ? [{ ...chapter, pages }] : [];
  });

  return { pages: chapters.flatMap((chapter) => chapter.pages), chapters };
}

/**
 * Build the guide.
 *
 * Synchronous and pure, which is the point of the ruling: there is no loading
 * state, no failure state and no empty state to design for, because there is no
 * fetch. `HelpScreen` has plates on its first paint.
 */
export function buildHelpSet(plates: readonly HelpPlateDefinition[] = HELP_PLATES): HelpSet {
  const pages: HelpPage[] = [...plates]
    .sort((a, b) => a.number - b.number)
    .map((plate) => ({
      plate,
      slug: plate.slug,
      title: plate.title,
      excerpt: plate.lede,
      number: plate.number,
      sectionId: plate.section,
    }));

  const chapters = HELP_CHAPTERS.map((chapter) => ({
    ...chapter,
    pages: pages.filter((page) => page.sectionId === chapter.id),
  }));

  return { pages, chapters };
}

/** The one guide, built once — the registry cannot change at run time. */
export const HELP_SET: HelpSet = buildHelpSet();
