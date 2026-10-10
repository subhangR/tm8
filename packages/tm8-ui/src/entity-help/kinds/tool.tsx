import type { KindHelpModule } from '../types';

export const TOOL_HELP: KindHelpModule = {
  kind: 'tool',
  story: {
    logline: 'A reusable script with named inputs, saved configuration and a record of every run.',
    opening: <><p>A tool stores Bash or Python source alongside its input definitions and help. Open it to read or edit the source, configure inputs, and run it.</p><p>Each run pins the source it executed. Its terminal shows live output and the exit result; a run started here leaves an interactive shell open until you close it.</p></>,
    beats: [
      { title: 'Configure once', body: <p>Saved values prefill the Run form. You can override them for one run. Secret inputs show only a key hint; a human sets the secret.</p> },
      { title: 'See what ran', body: <p>Run history opens each execution and its terminal. If the source changed since your last run, the Run form names who changed it.</p> },
    ],
    lifecycle: [{ name: 'Define', note: 'Store source and declare inputs.' }, { name: 'Configure', note: 'Save values and bind secret inputs.' }, { name: 'Run', note: 'Execute the stored source and record its result.' }],
  },
  constellation: { intro: <p>Every execution is a work session linked to the tool through executes.</p>, spotlight: ['work_session'], notes: { 'executes:incoming': 'Open a recorded run from the tool’s run history.' } },
};
