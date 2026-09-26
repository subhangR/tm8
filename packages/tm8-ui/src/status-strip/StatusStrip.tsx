/**
 * THE STATUS STRIP — a thin row directly beneath the desktop top bar
 * (owner ask, 2026-09-26). Order is the owner's:
 *
 *   [lead slot: pending attention] [CPU] [memory] [load] [disk] [tm8 RSS]
 *   [live sessions] [live chats]
 *
 * The lead slot belongs to the attention lane (task 01a0dc79-0015): it mounts
 * there and nothing in this module knows what it renders.
 *
 * Host segments render only when the node answers `node.metrics.get`, which is
 * node-admin-only; a viewer the node refuses sees the counts without them,
 * never a row of dashes that cannot fill in. The counts render from the first
 * frame — a dash until the liveness read lands, then a MEASURED number, so a
 * space with no chats reads 0, not an absent segment.
 */
import type { ReactNode } from 'react';
import type { NodeMetricsView, SpaceId } from '@tm8/contract';

import type { LivenessSnapshot, Seam } from '../data/seam';
import {
  DASH,
  formatBytes,
  formatCount,
  formatDuration,
  formatPercent,
  toneOfFraction,
  type Tone,
} from './format';
import { StatusSegment } from './StatusSegment';
import { useStatusStrip } from './useStatusStrip';
import './status-strip.css';

export interface StatusStripProps {
  seam: Seam;
  spaceId: SpaceId;
  /** Rendered FIRST — the attention segment's seat. */
  leadSlot?: ReactNode;
}

function HostSegments({ host, stale }: { host: NodeMetricsView; stale: boolean }) {
  const staleNote = stale ? ' (last reading — the latest read failed)' : '';
  const cpu = host.cpu.percent === null ? null : host.cpu.percent / 100;
  const memFraction = host.memory.totalBytes > 0 ? host.memory.usedBytes / host.memory.totalBytes : null;
  const diskFraction = host.disk && host.disk.totalBytes > 0 ? host.disk.usedBytes / host.disk.totalBytes : null;
  const load = host.loadAverage;
  const loadTone: Tone = load && host.cpu.cores > 0
    ? load[0] >= host.cpu.cores * 1.5 ? 'alert' : load[0] >= host.cpu.cores ? 'warn' : 'normal'
    : 'normal';
  return (
    <>
      <StatusSegment
        label="CPU"
        value={formatPercent(cpu)}
        tone={toneOfFraction(cpu)}
        title={`CPU ${cpu === null ? 'not measured' : formatPercent(cpu)} busy across ${host.cpu.cores} cores${staleNote}`}
        testId="status-strip-cpu"
      />
      <StatusSegment
        label="Mem"
        value={`${formatBytes(host.memory.usedBytes).replace(' GB', '')} / ${formatBytes(host.memory.totalBytes)}`}
        tone={toneOfFraction(memFraction)}
        title={`Memory in use ${formatBytes(host.memory.usedBytes)} of ${formatBytes(host.memory.totalBytes)} (${formatPercent(memFraction)}), excluding reclaimable cache${staleNote}`}
        testId="status-strip-memory"
      />
      {load ? (
        <StatusSegment
          label="Load"
          value={load[0].toFixed(2)}
          tone={loadTone}
          title={`Load average ${load.map((l) => l.toFixed(2)).join(' / ')} (1 / 5 / 15 min) on ${host.cpu.cores} cores${staleNote}`}
          testId="status-strip-load"
        />
      ) : null}
      {host.disk ? (
        <StatusSegment
          label="Disk"
          value={formatPercent(diskFraction)}
          tone={toneOfFraction(diskFraction)}
          title={`Data volume (${host.disk.path}): ${formatBytes(host.disk.usedBytes)} used of ${formatBytes(host.disk.totalBytes)}${staleNote}`}
          testId="status-strip-disk"
        />
      ) : null}
      <StatusSegment
        label="tm8"
        value={formatBytes(host.process.rssBytes)}
        title={`tm8 server process: ${formatBytes(host.process.rssBytes)} resident, ${formatBytes(host.process.heapUsedBytes)} JS heap, up ${formatDuration(host.process.uptimeSeconds)}${staleNote}`}
        testId="status-strip-rss"
      />
    </>
  );
}

function chatValue(live: LivenessSnapshot | null): string {
  const n = live?.liveChatCount;
  if (n === null || n === undefined) return DASH;
  const working = live?.workingChatCount ?? null;
  return working ? `${n} · ${working} working` : String(n);
}

export function StatusStrip({ seam, spaceId, leadSlot }: StatusStripProps) {
  const { host, hostAccess, hostStale, liveness } = useStatusStrip(seam, spaceId);
  const sessions = liveness?.liveSessionCount ?? null;
  const chats = liveness?.liveChatCount ?? null;
  const working = liveness?.workingChatCount ?? null;
  return (
    <div className="status-strip" role="region" aria-label="System status" data-testid="status-strip">
      {leadSlot}
      {hostAccess === 'granted' && host ? <HostSegments host={host} stale={hostStale} /> : null}
      <StatusSegment
        label="Sessions"
        value={formatCount(sessions)}
        title={
          sessions === null
            ? 'Live work sessions: not measured yet'
            : `${sessions} live work session${sessions === 1 ? '' : 's'} in this space (a running terminal whose record is live)`
        }
        testId="status-strip-sessions"
      />
      <StatusSegment
        label="Chats"
        value={chatValue(liveness)}
        title={
          chats === null
            ? 'Live chats: not measured yet'
            : `${chats} live chat${chats === 1 ? '' : 's'} in this space; ${working ?? 0} answering (a turn running or queued)`
        }
        testId="status-strip-chats"
      />
    </div>
  );
}
