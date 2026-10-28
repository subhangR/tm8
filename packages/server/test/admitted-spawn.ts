/**
 * A stand-in for `SpawnService.admit` (379) in handler tests that stub the
 * service boundary: the launch admitted, and a boot that has already ended
 * well. `spawn()` goes through `admit`, so stubbing this one method covers the
 * public handler and the in-process callers (the dispatcher) alike.
 */
import { vi } from 'vitest';
import type { AdmittedSpawn, SpawnAdmission, SpawnService } from '@tm8/execution';

export function admittedSpawn(admission: Partial<SpawnAdmission> = {}): AdmittedSpawn {
  const admitted: SpawnAdmission = {
    sessionId: '99999999-9999-4999-8999-999999999999',
    cwd: '/tmp',
    commandResult: {},
    reused: false,
    timings: { totalMs: 0, phases: {} },
    ...admission,
  };
  return {
    admission: admitted,
    boot: Promise.resolve({
      ok: true,
      result: {
        sessionId: admitted.sessionId,
        manifestPath: '/tmp/manifest.json',
        manifest: {} as never,
        command: '',
        cwd: admitted.cwd,
        envVarNames: [],
        reused: admitted.reused,
        commandResult: admitted.commandResult,
      },
    }),
  };
}

/**
 * Every boot `admit` starts on this service, so a test that drives the real
 * handler can wait for them before it removes the directories they write to:
 * the handler answers at admission and the boot goes on without it.
 */
export function trackBoots(service: SpawnService): () => Promise<void> {
  const boots: Array<Promise<unknown>> = [];
  const admit = service.admit.bind(service);
  vi.spyOn(service, 'admit').mockImplementation(async (...args) => {
    const admitted = await admit(...args);
    boots.push(admitted.boot);
    return admitted;
  });
  return async () => {
    await Promise.all(boots);
  };
}
