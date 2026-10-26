import { readTextSource } from '../args.js';
import { CliError, EXIT_INTERRUPTED, EXIT_USAGE } from '../exit.js';
import type { Output } from '../output.js';

/** Read the value without terminal echo, argv, readline history, or value-bearing errors. */
export async function readToolSecret(out: Output, inputName: string): Promise<string> {
  let value: string;
  if (!process.stdin.isTTY) {
    try { value = (await readTextSource('-')).replace(/\r?\n$/, ''); }
    catch { throw new CliError('Unable to read secret from stdin', EXIT_USAGE); }
  } else {
    out.warn(`Enter secret for ${inputName} (hidden):`);
    const wasRaw = process.stdin.isRaw, wasPaused = process.stdin.isPaused();
    value = await new Promise<string>((resolve, reject) => {
      let text = '';
      const cleanup = (): void => {
        process.stdin.off('data', data); process.stdin.off('end', end); process.stdin.off('error', error);
        process.stdin.setRawMode(wasRaw);
        if (wasPaused) process.stdin.pause();
      };
      const error = (): void => { cleanup(); reject(new CliError('Unable to read secret from TTY', EXIT_USAGE)); };
      const end = (): void => { cleanup(); resolve(text); };
      const data = (chunk: Buffer): void => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\u0003') { cleanup(); reject(new CliError('Secret entry interrupted', EXIT_INTERRUPTED)); return; }
          if (char === '\r' || char === '\n' || char === '\u0004') { end(); return; }
          if (char === '\u007f' || char === '\b') text = text.slice(0, -1);
          else text += char;
          if (text.length > 4096) { error(); return; }
        }
      };
      process.stdin.setRawMode(true);
      process.stdin.on('data', data); process.stdin.once('end', end); process.stdin.once('error', error);
      process.stdin.resume();
    });
  }
  if (!value || value.length > 4096) throw new CliError('Secret must contain 1–4096 characters', EXIT_USAGE);
  return value;
}
