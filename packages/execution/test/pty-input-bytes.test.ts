import { expect, it } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';

it('delivers legacy mouse bytes and UTF-8 text unchanged to a real PTY', async () => {
  const host = new PtyHostService({ defaultShell: '/bin/sh' });
  const id = 'binary-mouse-input';
  // Raw mode prevents the line discipline from interpreting control bytes.
  const program = 'import os,tty,time; tty.setraw(0); print("READY",flush=True); data=b""; exec("while len(data)<9: data+=os.read(0,9-len(data))"); print(data.hex(),flush=True); time.sleep(2)';
  try {
    host.spawn({ sessionId: id, command: `python3 -c '${program}'`, cwd: '/tmp', env: { PATH: '/usr/bin:/bin' } });
    const output = () => host.getReplay(id, 0)?.data.toString('utf8') ?? '';
    await expect.poll(output, { timeout: 10000 }).toContain('READY');
    host.write(id, Buffer.from([27, 91, 77, 96, 200, 255]));
    host.write(id, '€');
    await expect.poll(output, { timeout: 10000 }).toContain('1b5b4d60c8ffe282ac');
  } finally {
    host.shutdownAll();
  }
}, 20000);
