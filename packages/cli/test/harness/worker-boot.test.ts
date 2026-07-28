/**
 * The boot path end to end: a `manifestVersion: "2"` file on disk becomes the
 * §5.2 kernel plus one §14 control block, and a v1 file still boots.
 *
 * This is where the harness stops being a library and starts being what a
 * spawned agent actually reads. The reader has to handle both versions for the
 * length of the transition — an agent whose manifest is one version behind the
 * server must still boot, because the alternative is a terminal that opens on
 * a stack trace.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import { readManifest } from '../../src/manifest.js';
import { composePrompt } from '../../src/prompt.js';
import { BYTE_BUDGETS, utf8Bytes } from '@tm8/prompt';

const V2 = fileURLToPath(new URL('../fixtures/manifest.v2.json', import.meta.url));
const V1 = fileURLToPath(new URL('../fixtures/manifest.sample.json', import.meta.url));

describe('reading a v2 bootstrap manifest', () => {
  it('keeps the v2 projection AND fills the fields the composer already reads', () => {
    const manifest = readManifest(V2);
    expect(manifest.manifestVersion).toBe('2');
    expect(manifest.bootstrap?.identity.actorId).toBe('ent_01HZACTOR');
    expect(manifest.bootstrap?.credential).toEqual({ bearerEnv: 'TM8_AGENT_TOKEN' });
    // Back-compat projection so nothing downstream has to branch on version.
    expect(manifest.sessionId).toBe('ses_01HZPHOENIXSESSION');
    expect(manifest.spaceId).toBe('spc_01HZDEMOSPACE');
    expect(manifest.project?.workingDir).toBe('/Users/subhang/Desktop/Projects/tm8');
    expect(manifest.coordinator?.sessionId).toBe('ses_01HZORION');
    expect(manifest.tasks?.map((t) => t.id)).toEqual(['tsk_01HZTASKONE', 'tsk_01HZTASKTWO']);
  });

  it('projects the manifest mode onto the composer mode, honouring the coordinator', () => {
    // `identity.mode` is the manifest's four-value vocabulary
    // (human-directed|worker|coordinator|background); `AgentMode` is the
    // composer's. A worker WITH a coordinator is a coordinated worker.
    expect(readManifest(V2).mode).toBe('coordinated-worker');
  });

  it('records the path it read, because the kernel has to name it', () => {
    expect(readManifest(V2).bootstrapPath).toBe(V2);
  });
});

describe('composing from a v2 manifest', () => {
  it('emits the kernel and the §14.1 worker control block, not the v1 persona frame', () => {
    const { system } = composePrompt(readManifest(V2));
    expect(system).toContain('You are a tm8 worker operating as Phoenix.');
    expect(system).toContain('- cwd=/Users/subhang/Desktop/Projects/tm8');
    expect(system).toContain('<trusted_control type="tm8.worker-bootstrap" version="1">');
    expect(system).toContain(`Bootstrap manifest: ${V2}`);
    expect(system).not.toContain('<tm8_system_prompt');
  });

  it('carries task IDS ONLY — bodies come from the bounded assignment fetch', () => {
    const { task, metadata } = composePrompt(readManifest(V2));
    expect(metadata.taskCount).toBe(2);
    expect(task).toContain('<task id="tsk_01HZTASKONE" />');
    expect(task).toContain('<task id="tsk_01HZTASKTWO" />');
    expect(task).toMatch(/Fetch the bounded assignment snapshot/);
    expect(task).not.toContain('<description>');
  });

  it('holds the whole initial injection under the 32 KiB ceiling (B2)', () => {
    const { system, task } = composePrompt(readManifest(V2));
    expect(utf8Bytes(`${system}\n\n${task}`)).toBeLessThanOrEqual(
      BYTE_BUDGETS.combinedInitialInjection,
    );
    expect(utf8Bytes(system)).toBeGreaterThan(1500);
  });

  it('teaches no rejected vocabulary and no operation inventory', () => {
    const { system, task } = composePrompt(readManifest(V2));
    const text = `${system}\n${task}`.toLowerCase();
    for (const retired of ['whoami', 'task report', 'session report', 'session prompt']) {
      expect(text, `bootstrap contains "${retired}"`).not.toContain(retired);
    }
    // Lazy discovery: `help` is the only command path the kernel names.
    expect(text).not.toMatch(/entities\.(get|patch|create)/);
  });
});

describe('a v1 manifest still boots', () => {
  it('takes the legacy persona frame and attaches no bootstrap projection', () => {
    const manifest = readManifest(V1);
    expect(manifest.bootstrap).toBeUndefined();
    const { system } = composePrompt(manifest);
    expect(system).toContain('<tm8_system_prompt');
    expect(system).toContain('<name>Phoenix</name>');
    expect(system).not.toContain('<trusted_control');
  });
});
