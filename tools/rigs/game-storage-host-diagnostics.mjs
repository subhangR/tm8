/** Local environment evidence only; never changes an acceptance assertion. */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function captureHostDiagnostics(runRoot, phase) {
  const result = { phase, at: new Date().toISOString() };
  try {
    const cgroup = (await readFile('/proc/self/cgroup', 'utf8')).split('\n').find(line => line.startsWith('0::'))?.slice(3);
    if (!cgroup) throw new Error('Unified service cgroup is unavailable');
    const directory = join('/sys/fs/cgroup', cgroup);
    result.cgroup = directory;
    for (const name of ['memory.events', 'memory.current', 'memory.max', 'pids.events', 'pids.current', 'pids.max']) {
      try { result[name] = (await readFile(join(directory, name), 'utf8')).trim(); }
      catch (error) { result[name] = { unavailable: error.code }; }
    }
  } catch (error) { result.cgroupUnavailable = String(error.message); }
  try {
    const output = execFileSync('dmesg', ['--ctime'], { encoding: 'utf8', timeout: 2_000, maxBuffer: 256 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'] });
    result.kernel = { available: true, tail: output.slice(-8_192) };
  } catch (error) {
    result.kernel = { available: false, status: error.status ?? null, signal: error.signal ?? null,
      reason: String(error.stderr ?? error.message).trim().slice(0, 500) };
  }
  await mkdir(runRoot, { recursive: true });
  await writeFile(join(runRoot, `host-diagnostics-${phase}.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ stage: 'local host diagnostics', phase, kernelAvailable: result.kernel.available }));
  return result;
}
