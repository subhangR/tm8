#!/usr/bin/env node
// tm8 echo-agent — the smoke agent for the G1A loop.
//
// Selected with TM8_AGENT_CMD=echo-agent. It stands in for Claude everywhere the
// loop is being PROVEN rather than used, so spawn → manifest → prompt → output
// can be exercised in a test suite, in HOW-TO-TEST.md, and in CI without
// burning a real model session or needing an API key.
//
// It is deliberately the dumbest thing that can still prove every link:
//   - reads TM8_MANIFEST_PATH and prints what it found  → the manifest file was
//     written, was valid JSON, and the path reached the agent through the env
//   - prints TM8-ECHO-READY                             → the PTY spawned and
//     its output is flowing back through the ring buffer
//   - prefixes every stdin line with TM8-ECHO:          → THE ONE THAT MATTERS.
//
// That last line is what makes `execution.prompt` testable. A prompt marked
// delivered that never reached the PTY looks completely green from the graph's
// side, so the only honest assertion is on bytes the AGENT PROCESS emitted.
// Terminal local echo would show the prompt text in the output either way — the
// TM8-ECHO: prefix cannot appear unless this process actually read the line from
// its stdin and wrote it back.

import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const say = (line) => process.stdout.write(`${line}\r\n`);

async function main() {
  const manifestPath = process.env.TM8_MANIFEST_PATH;
  const sessionId = process.env.TM8_SESSION_ID ?? '(unset)';

  say(`TM8-ECHO-AGENT session=${sessionId}`);

  if (!manifestPath) {
    say('TM8-ECHO-MANIFEST-ERROR TM8_MANIFEST_PATH is not set');
  } else {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      // `agent` is the PERSONA, `launch` is how the session was started. They
      // are separate keys precisely because conflating them is how an agent
      // boots with an empty identity block and nobody sees an error.
      say(
        `TM8-ECHO-MANIFEST ok session=${manifest.sessionId} mode=${manifest.mode} ` +
          `model=${manifest.launch?.model ?? 'none'} tool=${manifest.launch?.tool ?? 'none'} ` +
          `persona=${manifest.agent?.name ?? 'none'} ` +
          `tasks=${manifest.tasks?.length ?? 0} cwd=${manifest.session?.workingDirectory ?? 'none'}`,
      );
    } catch (error) {
      say(`TM8-ECHO-MANIFEST-ERROR ${error.message}`);
    }
  }

  say(`TM8-ECHO-CWD ${process.cwd()}`);
  say(`TM8-ECHO-BASE-URL ${process.env.TM8_BASE_URL ?? '(unset)'}`);
  say('TM8-ECHO-READY');

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const text = line.trim();
    if (text === '/exit' || text === '/quit') {
      say('TM8-ECHO-EXIT');
      rl.close();
      process.exit(0);
    }
    say(`TM8-ECHO: ${text}`);
  });
  rl.on('close', () => process.exit(0));
}

main().catch((error) => {
  say(`TM8-ECHO-FATAL ${error.message}`);
  process.exit(1);
});
