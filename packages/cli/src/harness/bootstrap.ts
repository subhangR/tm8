/**
 * One spawn's worth of harness bootstrap: manifest, kernel, control block, and
 * the log line that records it.
 *
 * This is the assembly point for §5.1, §5.2 and §14.1/§14.2, and it exists so
 * the three byte ceilings are checked TOGETHER. B2's ceiling is on the SUM of
 * everything injected before the agent's first turn, so a kernel that fits and
 * a control block that fits can still be a violation; only a caller holding
 * both can say. Composing them separately and hoping is the failure this
 * function removes.
 *
 * It also produces the log line, deliberately, rather than leaving it to
 * whoever is debugging the spawn: the log is the artifact most likely to grow
 * a token by accident, so it is generated from the same bounded facts as
 * everything else and is scanned alongside them.
 */
import {
  BYTE_BUDGETS,
  assertWithinBudget,
  composeKernel,
  coordinatorBootstrapControl,
  utf8Bytes,
  workerBootstrapControl,
  type BootstrapControlFacts,
} from '@tm8/prompt';

import {
  BEARER_ENV,
  composeBootstrapManifest,
  serializeBootstrapManifest,
  type BootstrapManifestInput,
  type BootstrapManifestV2,
} from './bootstrap-manifest.js';

export interface HarnessBootstrapInput {
  input: BootstrapManifestInput;
  /** Absolute path the manifest will be written to; named in the kernel. */
  manifestPath: string;
  /**
   * The bounded assignment snapshot, when the caller already has it. Counted
   * into the combined ceiling — that is the whole reason it is accepted here.
   */
  assignmentSnapshot?: string;
}

export interface HarnessBootstrap {
  manifest: BootstrapManifestV2;
  /** Compact JSON, already checked against the 4 KiB cap. */
  manifestJson: string;
  /** The §5.2 trusted kernel, already checked against the 6 KiB cap. */
  kernel: string;
  /** The §14.1 or §14.2 control block, chosen by the resolved identity mode. */
  control: string;
  /** Everything injected before the agent's first turn, under 32 KiB (B2). */
  injection: string;
  /** Identifiers and byte counts only — no value from any environment. */
  logLine: string;
  bytes: { manifest: number; kernel: number; injection: number };
}

export function composeHarnessBootstrap(opts: HarnessBootstrapInput): HarnessBootstrap {
  const manifest = composeBootstrapManifest(opts.input);
  const manifestJson = serializeBootstrapManifest(manifest);

  const { identity, session, interactionProfile: profile, assignment } = manifest;

  const kernel = composeKernel({
    mode: identity.mode,
    displayName: identity.displayName,
    actorId: identity.actorId,
    teamMemberId: identity.teamMemberId,
    sessionId: session.id,
    spaceId: session.spaceId,
    cwd: session.cwd,
    workdirMode: session.workdirMode,
    launchProjectId: session.launchProjectId,
    primaryTaskId: assignment.primaryTaskId ?? null,
    coordinatorSessionId: session.coordinatorSessionId ?? null,
    interactionProfileId: profile.entityId,
    interactionProfileVersion: profile.version,
    resolvedProfileHash: profile.resolvedHash,
    manifestPath: opts.manifestPath,
  });

  const facts: BootstrapControlFacts = {
    actorId: identity.actorId,
    teamMemberId: identity.teamMemberId,
    sessionId: session.id,
    spaceId: session.spaceId,
    cwd: session.cwd,
    workdirMode: session.workdirMode,
    launchProjectId: session.launchProjectId,
    trust: session.trust,
    profileId: profile.entityId,
    profileVersion: profile.version,
    pinRevision: profile.pinRevision,
    resolvedProfileHash: profile.resolvedHash,
    taskId: assignment.primaryTaskId ?? null,
    coordinatorSessionId: session.coordinatorSessionId ?? null,
  };

  // Only a coordinator gets the §14.2 orchestration block. `human-directed` and
  // `background` take the worker form because neither delegates, and handing a
  // non-delegating session spawn instructions is how a background job starts
  // creating sessions nobody asked for.
  const control =
    identity.mode === 'coordinator'
      ? coordinatorBootstrapControl(facts)
      : workerBootstrapControl(facts);

  const parts = [kernel, control];
  if (opts.assignmentSnapshot) {
    parts.push(assertWithinBudget('assignmentSnapshot', opts.assignmentSnapshot));
  }
  const injection = assertWithinBudget('combinedInitialInjection', parts.join('\n'));

  const bytes = {
    manifest: utf8Bytes(manifestJson),
    kernel: utf8Bytes(kernel),
    injection: utf8Bytes(injection),
  };

  const logLine =
    `tm8 harness bootstrap: session=${session.id} space=${session.spaceId} ` +
    `mode=${identity.mode} trust=${session.trust} profile=${profile.entityId}@${profile.version} ` +
    `manifest=${opts.manifestPath} credentialEnv=${BEARER_ENV} ` +
    `bytes manifest=${bytes.manifest}/${BYTE_BUDGETS.manifest} ` +
    `kernel=${bytes.kernel}/${BYTE_BUDGETS.kernel} ` +
    `injection=${bytes.injection}/${BYTE_BUDGETS.combinedInitialInjection}`;

  return { manifest, manifestJson, kernel, control, injection, logLine, bytes };
}
