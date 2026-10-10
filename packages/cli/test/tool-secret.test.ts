import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readToolSecret } from '../src/commands/tool-secret.js';
import { createOutput } from '../src/output.js';
import * as args from '../src/args.js';

const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
let printed = '';
const output = () => createOutput({ format: 'human', streams: {
  stdout: chunk => { printed += String(chunk); }, stderr: chunk => { printed += chunk; },
} });
class SecretTty extends EventEmitter {
  isTTY = true; isRaw = false;
  setRawMode = vi.fn((raw: boolean) => { this.isRaw = raw; });
  isPaused = () => true;
  pause = vi.fn();
  resume = () => { queueMicrotask(() => this.emit('data', Buffer.from(this.input))); };
  constructor(private input: string) { super(); }
}
afterEach(() => { Object.defineProperty(process, 'stdin', stdinDescriptor); vi.restoreAllMocks(); printed = ''; });

describe('secret entry', () => {
  it('hides TTY input, handles backspace, and restores terminal mode and listeners', async () => {
    const tty = new SecretTty('private-valuX\u007fe\r');
    Object.defineProperty(process, 'stdin', { configurable: true, value: tty });
    expect(await readToolSecret(output(), 'auth')).toBe('private-value');
    expect(printed).toContain('hidden'); expect(printed).not.toContain('private');
    expect(tty.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(tty.pause).toHaveBeenCalledOnce(); expect(tty.listenerCount('data')).toBe(0);
  });
  it('restores raw mode on Ctrl-C and never echoes an entered value', async () => {
    const tty = new SecretTty('private-value\u0003'); tty.isRaw = true;
    Object.defineProperty(process, 'stdin', { configurable: true, value: tty });
    await expect(readToolSecret(output(), 'auth')).rejects.toMatchObject({ exitCode: 130 });
    expect(tty.isRaw).toBe(true); expect(tty.listenerCount('data')).toBe(0); expect(printed).not.toContain('private-value');
  });
  it('reads stdin, strips only its trailing line ending, and uses generic read errors', async () => {
    Object.defineProperty(process, 'stdin', { configurable: true, value: { isTTY: false } });
    const reader = vi.spyOn(args, 'readTextSource').mockResolvedValue(' private-value \r\n');
    expect(await readToolSecret(output(), 'auth')).toBe(' private-value ');
    expect(reader).toHaveBeenCalledWith('-'); expect(printed).toBe('');
    reader.mockRejectedValue(new Error('private-value'));
    await expect(readToolSecret(output(), 'auth')).rejects.toThrow('Unable to read secret from stdin');
  });
  it.each(['', 'x'.repeat(4097)])('rejects empty and oversized values without echo', async value => {
    Object.defineProperty(process, 'stdin', { configurable: true, value: { isTTY: false } });
    vi.spyOn(args, 'readTextSource').mockResolvedValue(value);
    await expect(readToolSecret(output(), 'auth')).rejects.toThrow('1–4096'); expect(printed).toBe('');
  });
});
