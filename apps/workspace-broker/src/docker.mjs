import http from 'node:http';

export class DockerError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export class Docker {
  constructor(socketPath = '/var/run/docker.sock') { this.socketPath = socketPath; }
  request(method, path, data, { hijack = false, limit = 128 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
      const body = data === undefined ? undefined : JSON.stringify(data);
      const req = http.request({ socketPath: this.socketPath, method, path: `/v1.45${path}`, headers: {
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        ...(hijack ? { connection: 'Upgrade', upgrade: 'tcp' } : {}),
      } });
      req.on('error', reject);
      req.setTimeout(120000, () => req.destroy(new Error('Docker request timed out')));
      req.on('upgrade', (res, socket, head) => {
        if (!hijack) { socket.destroy(); return reject(new Error('Unexpected Docker upgrade')); }
        if (head.length) socket.unshift(head);
        socket.setTimeout(0);
        resolve(socket);
      });
      req.on('response', res => {
        const parts = []; let size = 0;
        res.on('data', part => { size += part.length; if (size > limit) res.destroy(new Error('Docker response too large')); else parts.push(part); });
        res.on('error', reject);
        res.on('end', () => {
          const bytes = Buffer.concat(parts);
          if (res.statusCode >= 400) return reject(new DockerError(res.statusCode, bytes.toString('utf8').slice(0, 1000)));
          if (res.headers['content-type']?.includes('application/json') && bytes.length) {
            try { resolve(JSON.parse(bytes.toString('utf8'))); } catch (error) { reject(error); }
          } else resolve(bytes);
        });
      });
      req.end(body);
    });
  }
  async inspect(name) { try { return await this.request('GET', `/containers/${encodeURIComponent(name)}/json`); } catch (error) { if (error.status === 404) return null; throw error; } }
  async exec(name, argv, { input, user = '1000:1000', workdir = '/home/user', timeout = 120000 } = {}) {
    const command = await this.request('POST', `/containers/${encodeURIComponent(name)}/exec`, {
      AttachStdout: true, AttachStderr: true, AttachStdin: input !== undefined, Tty: false,
      Cmd: argv, User: user, WorkingDir: workdir,
    });
    const socket = await this.request('POST', `/exec/${command.Id}/start`, { Detach: false, Tty: false }, { hijack: true });
    const parts = []; let size = 0;
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(new Error('Execution timed out')); }, timeout);
      socket.on('data', part => { size += part.length; if (size > 128 * 1024 * 1024) socket.destroy(new Error('Execution output too large')); else parts.push(part); });
      socket.on('error', reject);
      socket.on('end', resolve);
      socket.on('close', () => clearTimeout(timer));
    });
    // Docker's hijacked connection accepts a half-close as stdin EOF while
    // continuing to stream stdout. GET-only executions need no input stream.
    if (input !== undefined) socket.end(input);
    await completed;
    const status = await this.request('GET', `/exec/${command.Id}/json`);
    return { ...demux(Buffer.concat(parts)), exitCode: status.ExitCode };
  }
}
export function demux(bytes) {
  const stdout = [], stderr = []; let offset = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error('Truncated Docker stream');
    const size = bytes.readUInt32BE(offset + 4);
    if (offset + 8 + size > bytes.length) throw new Error('Truncated Docker frame');
    (bytes[offset] === 2 ? stderr : stdout).push(bytes.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}
