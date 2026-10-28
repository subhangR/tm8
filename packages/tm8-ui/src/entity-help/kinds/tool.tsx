import type { KindHelpModule } from '../types';

export const TOOL_HELP: KindHelpModule = {
  kind: 'tool',
  story: {
    logline: 'A reusable script with named inputs, saved configuration and a record of every run.',
    opening: <><p>A tool stores Bash or Python source alongside its input definitions and help. Open it to read or edit the source, configure inputs, and run it.</p><p>Each run is a session that pins the version and source hash it executed, and records who started it, its exit code and a redacted tail of its output. A run started here leaves an interactive shell open until you close it.</p></>,
    beats: [
      { title: 'Make one', body: <p>Choose <strong>New tool</strong> from the New tab, the Tools list or the command palette, starting empty or from a starter, or run <code>tm8 tool create</code>. The server checks the whole definition before it stores anything. If it refuses, it says which field and why.</p> },
      { title: 'Configure once', body: <p>Saved values prefill the Run form. You can override them for one run. Secret inputs show only a key hint; a human sets the secret.</p> },
      { title: 'Every version is kept', body: <p>Versions lists each stored snapshot: its number, who changed it, when, and which fields changed. Pick any two to compare their source; the default is the latest against the one before it. One author&rsquo;s edits within five minutes fold into a single snapshot, so numbers can skip. A run pinned to a folded version shows its source hash and says which version absorbed it, instead of a diff.</p> },
      { title: 'See what ran', body: <p>Run history is a table, newest first. Each row shows when the run started, how long it took, its result and exit code, and who ran it: a person, an agent, or a loop. It also shows the version and source hash it ran and whether its shell stayed open. <strong>Open terminal</strong> opens the run&rsquo;s session. <strong>Output</strong> shows the saved tail: the last 64 KiB, with secrets redacted. The header&rsquo;s last-run chip and each tile in the Tools list show the newest run.</p> },
      { title: 'When a run is refused', body: <p>The Run dialog shows the server&rsquo;s reason and its code. The usual ones: the eight-session cap (idle keep-open shells count, so close one and retry), a missing required input, a secret you may not use, a source that changed while the dialog was open, or a launch that failed. A failed launch still appears in Run history, as killed. If the source changed since your last run, the Run form names who changed it.</p> },
    ],
    lifecycle: [{ name: 'Define', note: 'Store source and declare inputs.' }, { name: 'Configure', note: 'Save values and bind secret inputs.' }, { name: 'Run', note: 'Execute the stored source and record its result.' }, { name: 'Inspect', note: 'Read each run’s result, invoker, version and saved output.' }],
  },
  toolkit: {
    intro: <p>Everything the page does is a <code>tools.*</code> operation, and the <code>tool</code> noun reaches each one. Run options go before the tool name; every argument after the name belongs to the tool.</p>,
    scenes: [
      { title: 'Define it', narrative: <p>The spec file carries inputs, help, tm8 access and the timeout; an edit names the version it read.</p>,
        commands: ['tool create', 'tool edit', 'tool show'],
        demo: ['tm8 tool create url-check --runtime bash --source @tool.sh --spec @spec.json', 'tm8 tool show url-check --source'] },
      { title: 'Configure it', narrative: <p>Configured values prefill every run. A secret prompts without echo, and only a human can bind one.</p>,
        commands: ['tool config set', 'tool secret set'],
        demo: ['tm8 tool config set url-check timeout 10', 'tm8 tool secret set gh-pr-status github_token'] },
      { title: 'Run it and read the record', narrative: <p>An attached run prints its session id first and exits with the tool&rsquo;s own code. <code>tool runs</code> lists runs newest first. <code>run-show --output</code> prints the saved, redacted tail.</p>,
        commands: ['tool run', 'tool runs', 'tool run-show'],
        demo: ['tm8 tool run url-check --urls https://example.com', 'tm8 tool runs url-check --limit 20', 'tm8 tool run-show <session-id> --output'] },
    ],
  },
  constellation: { intro: <p>Every execution is a work session linked to the tool through executes. A run a loop fired also points at that loop.</p>, spotlight: ['work_session'], notes: { 'executes:incoming': 'Open a recorded run from the tool’s run history.' } },
};
