/**
 * THE RENDER SEAM — the one place an argv becomes a shell command line.
 *
 * Internals are argv arrays; `shellQuote` is called here and nowhere else. The
 * pre-registry code called it in nine places across four functions, each with
 * its own idea of what needed quoting, which is exactly the kind of scattered
 * decision that stays correct only while one person holds all of it in their
 * head.
 */
import { shellQuote } from '../spawn/manifest.js';
import type { ArgToken } from './types.js';

/**
 * Render one token: fixed CLI vocabulary verbatim, content shell-quoted.
 *
 * Reproduces both pre-registry quoting rules exactly — the Claude branch's
 * inline `shellQuote(launch.model)`, and `renderCodexCommand`'s "quote iff the
 * previous token was `--model` or `-c`" — because the decision is now made where
 * the token is BUILT, by the code that knows which it is.
 */
export function renderToken(token: ArgToken): string {
  return typeof token === 'string' ? token : shellQuote(token.value);
}

/** Render a full command line: `head` verbatim, then every token. */
export function renderCommand(head: string, tokens: readonly ArgToken[]): string {
  const parts = [head];
  for (const token of tokens) parts.push(renderToken(token));
  return parts.join(' ');
}

/**
 * Append rendered tokens to an ALREADY-RENDERED command line.
 *
 * WHY THIS EXISTS RATHER THAN A PURE ARGV PIPELINE. `withAgentPrompt` and
 * `withAgentResume` take a command STRING because of a real ordering constraint
 * that looks circular and is not: the prompt is composed FROM the manifest, and
 * the manifest records the command, so the base command must be built and
 * recorded before the prompt that is later appended to it exists.
 *
 * Phase 0 keeps that contract — those two functions are exported from
 * `@tm8/execution` and re-deriving the base argv here instead would mean
 * guessing which `buildAgentCommand` options the caller originally used, which
 * is a behaviour risk in a phase whose entire gate is that behaviour does not
 * change. The tokens being appended are still built as argv and rendered here,
 * so the quoting decision stays in one place; only the base is carried as text.
 */
export function appendRendered(command: string, tokens: readonly ArgToken[]): string {
  if (tokens.length === 0) return command;
  const parts = [command];
  for (const token of tokens) parts.push(renderToken(token));
  return parts.join(' ');
}

/**
 * Insert a resume SUBCOMMAND immediately after the executable.
 *
 * This replaces `command.replace(/^codex\b/, 'codex resume')` — a regex
 * rewriting a command line to insert a subcommand, which was correct only
 * because there were exactly two shapes to keep in one head. The subcommand is
 * now data on the harness (`capabilities.resume.subcommand`), and the splice is
 * positional rather than pattern-matched, so it cannot misfire on a binary whose
 * name merely starts with the same letters.
 */
export function spliceSubcommand(command: string, subcommand: string): string {
  const firstSpace = command.indexOf(' ');
  if (firstSpace === -1) return `${command} ${subcommand}`;
  return `${command.slice(0, firstSpace)} ${subcommand}${command.slice(firstSpace)}`;
}
