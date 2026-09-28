/**
 * TEMPLATE — copy to `kinds/<kind>.tsx`, rename the export, register it in
 * `kinds/index.ts`. This file is NOT registered; it typechecks so the shape
 * cannot rot, and the authoring guide (doc, "Open before authoring an Entity
 * Help page for any kind") walks through each field.
 *
 * The three tabs are each optional. Leave one out and the baseline stands in.
 * Command paths are NAMES only (`'task tick'`); their syntax, summary and
 * examples are read from the live catalog when the page renders.
 */
import type { KindHelpModule } from '../types';

export const TEMPLATE_HELP: KindHelpModule = {
  kind: 'c:template',

  story: {
    /* One sentence. Italic serif under the title. The hook — say what this
       thing is FOR, in the reader's terms, not what it is made of. */
    logline: 'What this entity is for, in one line a reader repeats to a colleague.',

    /* The opening: what the entity IS. Two short paragraphs. Present tense.
       Second person is welcome. No feature lists. */
    opening: (
      <>
        <p>Open with the thing itself, as a person meets it.</p>
        <p>Then the reason it exists — the problem that was there before it was.</p>
      </>
    ),

    /* Three to five beats. Each beat is one idea with a title a reader could
       skim. Eyebrows are optional mono captions: `WHY IT EXISTS`, `THE RULE`. */
    beats: [
      {
        eyebrow: 'Why it exists',
        title: 'The problem it answers',
        body: <p>One idea, a few sentences, no bullet lists unless the items are truly parallel.</p>,
      },
      {
        eyebrow: 'How it is born',
        title: 'Where one comes from',
        body: <p>Who makes it, what the first edit is, what is already true the moment it exists.</p>,
      },
      {
        eyebrow: 'How it ends',
        title: 'What done looks like',
        body: <p>Completion, archive, tombstone — say which, and what stays behind.</p>,
      },
    ],

    /* The filmstrip. Three to six frames. Omit for a kind with no lifecycle. */
    lifecycle: [
      { name: 'Open', note: 'What is true of it here.' },
      { name: 'Working', note: 'Who is on it, and what they can do.' },
      { name: 'Done', note: 'What the record keeps.' },
    ],
  },

  toolkit: {
    /* One paragraph: the posture of working this kind from a terminal. */
    intro: <p>How an agent approaches this kind from the command line, in a paragraph.</p>,

    /* Two to four scenes. Each is a paragraph of intent plus the commands
       it names, by path. `demo` is optional: when omitted, the terminal
       plays the catalog's own examples for those commands. */
    scenes: [
      {
        title: 'Orient',
        narrative: <p>Why the first read is a context call and not a full get.</p>,
        commands: ['entity context', 'action list'],
        demo: ['# orient before anything else', 'tm8 entity context <id>'],
      },
      {
        title: 'Act',
        narrative: <p>The verbs a caller reaches for, and the version they must carry.</p>,
        commands: ['entity update'],
      },
    ],

    /* Optional: nouns or paths the registry vocabulary does not list. */
    // nouns: ['session'],
    // commands: ['handoff send'],
  },

  constellation: {
    /* One paragraph: how this kind sits among the others. */
    intro: <p>Which neighbours matter most, and which edge a reader should look for first.</p>,

    /* Optional glosses per relation, by edge type or `type:direction`. */
    notes: {
      relates_to: 'The general-purpose link, when nothing more specific fits.',
    },

    /* Optional: neighbours seated nearest the centre, in order. */
    spotlight: [],
  },
};
