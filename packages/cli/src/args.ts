/**
 * Argument parsing — hand-rolled, no dependency.
 *
 * The old CLI carries Commander; this one is invoked by an agent writing a
 * flat command line with at most two positionals and two flags, and
 * packages/cli is deliberately dependency-light (installing anything in this
 * repo re-links node-pty and strips its spawn-helper exec bit, which breaks
 * the PTY harness for every other lane).
 *
 * Booleans are an explicit allowlist rather than "a flag whose next token
 * looks like a flag". Otherwise `tm8 --json task report progress …` silently
 * eats `task` as the value of `--json` and the verb vanishes.
 */
const BOOLEAN_FLAGS = new Set(['json', 'help', 'version']);

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags[body] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[body] = true;
    } else {
      flags[body] = next;
      i++;
    }
  }

  return { positionals, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] !== undefined;
}
