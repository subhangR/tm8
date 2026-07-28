/**
 * The most load-bearing strings in the system.
 *
 * `composePrompt` is injected at a spawned agent's FIRST token. Whatever it
 * says about the command surface is what the agent believes it can do, before
 * it has run anything or read any help. So a retired verb here is not a stale
 * doc comment — it is an agent confidently running a command that the kernel
 * answers with a discovery hint and a non-zero exit.
 *
 * `src/run.ts` (Slot A) already RETIRES `whoami`, `report`, `progress` and
 * public `session prompt`: each fails with a hint saying where the capability
 * went. This file is the other half of that retirement — the prompt must stop
 * TEACHING them. It is a grep with a rationale, and it is deliberately blunt:
 * the failure mode it guards is a well-meaning edit that "just adds a report
 * command back" for convenience.
 */
import { describe, expect, it } from 'vitest';

import {
  AGENT_MODES,
  commandSurface,
  completionCheckControl,
  composeKernel,
  composePrompt,
  coordinatorBootstrapControl,
  entityHandoffInjection,
  instructionFor,
  workerBootstrapControl,
  type KernelFacts,
  type PromptManifest,
} from '../src/index.js';

const KERNEL_FACTS: KernelFacts = {
  mode: 'worker',
  displayName: 'Atlas',
  actorId: 'ent_a',
  teamMemberId: 'ent_t',
  sessionId: 'ses_1',
  spaceId: 'spc_1',
  cwd: '/w',
  workdirMode: 'project',
  launchProjectId: 'prj_1',
  primaryTaskId: 'tsk_1',
  coordinatorSessionId: 'ses_c',
  interactionProfileId: 'ent_p',
  interactionProfileVersion: 1,
  resolvedProfileHash: 'sha256:x',
  manifestPath: '/m.json',
};

/**
 * Verbatim rejected vocabulary (grammar redesign §1, harness B1/D6). Matched
 * case-insensitively against every string the composer can emit.
 */
const REJECTED = [
  'tm8 whoami',
  'tm8 task report',
  'tm8 session report',
  'task report progress',
  'task report complete',
  'task report blocked',
  'session report progress',
  'session report complete',
  'session report blocked',
  'tm8 session prompt',
  'tm8 prompt',
  'tm8 report',
  'tm8 progress',
] as const;

/** Every surface the composer can put in front of an agent. */
function everyEmittedString(): { where: string; text: string }[] {
  const manifest: PromptManifest = {
    sessionId: 'ws_1',
    spaceId: 'spc_1',
    agent: { teamMemberId: 'ent_tm', name: 'Atlas', role: 'engineer', identity: 'persona' },
    tasks: [{ id: 'tsk_1', title: 'a task', description: 'do the thing' }],
    coordinator: { sessionId: 'ws_coord', displayName: 'Orion' },
  };
  const out: { where: string; text: string }[] = [];
  for (const mode of AGENT_MODES) {
    out.push({ where: `instructionFor(${mode})`, text: instructionFor(mode) });
    const { system, task } = composePrompt({ ...manifest, mode });
    out.push({ where: `composePrompt(${mode}).system`, text: system });
    out.push({ where: `composePrompt(${mode}).task`, text: task });
  }
  for (const hasSession of [true, false]) {
    for (const c of commandSurface(hasSession)) {
      out.push({ where: `commandSurface(${hasSession}).usage`, text: c.usage });
      out.push({ where: `commandSurface(${hasSession}).what`, text: c.what });
    }
  }
  return out;
}

describe('the composed prompt never teaches rejected vocabulary', () => {
  it('emits no retired verb anywhere a spawned agent can read it', () => {
    const offences: string[] = [];
    for (const { where, text } of everyEmittedString()) {
      const haystack = text.toLowerCase();
      for (const verb of REJECTED) {
        if (haystack.includes(verb)) offences.push(`${where} contains "${verb}"`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('does not tell a coordinator it cannot delegate — the adopted grammar has `session spawn`', () => {
    // The old string said: "this CLI has no spawn or session-prompt verbs, so
    // you cannot delegate or message siblings". Half of that is a false claim
    // about the frozen grammar (`execution.spawn` -> `session spawn`, row 75)
    // and the other half teaches a retired verb name.
    for (const mode of ['coordinator', 'coordinated-coordinator'] as const) {
      const text = instructionFor(mode);
      expect(text, `${mode} claims it cannot delegate`).not.toMatch(
        /cannot delegate|no spawn|does not yet carry spawn|no session-prompt/i,
      );
      expect(text, `${mode} does not name the real delegation verb`).toMatch(/session spawn/);
    }
  });

  it('routes every report through a durable message on an anchor, not a report verb', () => {
    for (const mode of AGENT_MODES) {
      expect(instructionFor(mode), `${mode}`).toMatch(/message send --to/);
    }
  });
});

describe('program-wide rulings this prompt must not contradict', () => {
  /** Every string the composer and the ten §14 templates can emit. */
  function everything(): { where: string; text: string }[] {
    const facts = {
      actorId: 'ent_a',
      teamMemberId: 'ent_t',
      sessionId: 'ses_1',
      spaceId: 'spc_1',
      cwd: '/w',
      workdirMode: 'project',
      launchProjectId: 'prj_1',
      trust: 'trusted',
      profileId: 'ent_p',
      profileVersion: 1,
      pinRevision: 1,
      resolvedProfileHash: 'sha256:x',
      taskId: 'tsk_1',
      coordinatorSessionId: 'ses_c',
    };
    return [
      ...everyEmittedString(),
      { where: '§14.1', text: workerBootstrapControl(facts) },
      { where: '§14.2', text: coordinatorBootstrapControl(facts) },
      {
        where: '§14.6',
        text: entityHandoffInjection({
          clientMutationId: 'mut_1',
          sourceEntityId: 'ent_s',
          sourceSessionId: 'ses_a',
          destinationSessionId: 'ses_b',
          deliveryStatus: 'delivered',
          recordStatus: 'active',
          summary: 'handing over',
        }),
      },
      { where: '§14.10', text: completionCheckControl({ taskId: 'tsk_1' }) },
      { where: 'kernel', text: composeKernel({ ...KERNEL_FACTS }) },
    ];
  }

  it('never calls a mutation id, handoff id or batch id secret — it is a CORRELATION id', () => {
    // Adopted program-wide: "clientMutationId is a correlation identifier, NOT a
    // capability. It is published in read DTOs by design. No authorization
    // decision may depend on its secrecy." §14.6 setting handoff_id from the
    // client mutation id is correct and stays; annotating it as sensitive is
    // what would be wrong, because it would invite an agent to protect the
    // wrong thing and relax about the one that matters — the token VALUE.
    for (const { where, text } of everything()) {
      for (const sentence of text.split(/(?<=[.!])\s+/)) {
        if (!/mutation id|handoff id|handoff_id|batch id/i.test(sentence)) continue;
        expect(sentence, `${where} calls a correlation id secret`).not.toMatch(
          /secret|sensitive|private|confidential|do not (share|expose|reveal)|authenticat/i,
        );
      }
    }
  });

  it('never renders undo as a delete — it is a redaction and thread history survives', () => {
    // Telling an agent history is gone when it is not invites a destructive
    // recovery action against data that was never lost.
    for (const { where, text } of everything()) {
      for (const sentence of text.split(/(?<=[.!])\s+/)) {
        if (!/\bundo/i.test(sentence)) continue;
        expect(sentence, `${where} renders undo as a delete`).not.toMatch(/delet|erase|destroy/i);
      }
    }
  });

  it('never writes a bare --timeout without its unit', () => {
    // An unlabelled duration flag is how 30 seconds silently becomes 30ms.
    for (const { where, text } of everything()) {
      for (const m of text.matchAll(/--timeout(\s+\S+)?/g)) {
        expect(m[0], `${where} writes --timeout without <seconds>`).toMatch(/<seconds>/);
      }
    }
  });
});
