/**
 * The relay's host-boundary preconditions (independent review F03; design doc 01a1fe13, section 4,
 * checks R1 to R6 and R8). They run at boot whenever TM8_VAULT_AGENT_RUN_AS names where agent
 * sessions run, and production requires that knob (config.ts).
 *
 * WHAT A PASS MEANS. Each check reads one fact about this host, as this process sees it at boot, and
 * refuses a fact that would let an agent reach the relay's keys or memory. A pass proves those facts,
 * not the boundary: whether agents really run where the knob says is shown only by the boundary probe
 * in staging (design doc N1), and this server's spawner does not read the knob yet. No check here
 * reads a key file's contents: R1 and R2 use lstat and realpath, and readText reads /etc and /proc.
 *
 * POINT IN TIME. Group membership, sockets, mounts and sysctls can change after boot. R3, R4 and R5
 * need a periodic re-check (the design suggests every 10 minutes) that switches the vault to
 * vault_unavailable on drift. That re-check is a follow-up: these run once, at boot.
 *
 * NOT CHECKED HERE.
 * - R9 (option A: the relay holds no signing key, and the signer socket's peer is the signer's uid)
 *   waits for the owner's decision D3.
 * - Users and groups that come from NSS rather than the local files, sudoers, polkit and file
 *   capabilities (N2); metadata-server reachability (N3); exposure before this boot (N4); kernel or
 *   sandbox escapes (N7).
 * - Access granted by a POSIX ACL entry is seen only through the group bits, which carry the ACL
 *   mask, so R2 refuses any group write. An LSM rule is not seen at all.
 * - R5 reads this process's own mount namespace. Agents share it under uid:/uids:, and get their own
 *   /proc under gvisor:, so hidepid is checked only for the first two.
 * - PR_SET_DUMPABLE: Node cannot clear it without a native addon, so a same-uid process could read
 *   this one's memory if Yama allowed it. R1 keeps agents off this uid; R5 requires Yama.
 */
import { X509Certificate, createPrivateKey, type KeyObject } from 'node:crypto';
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

import { CONTAINER_SOCKETS, MAX_HOST_ID, parseGroupFile, parsePasswdFile, type GroupEntry, type PasswdEntry } from '@tm8/vault/relay';

export const AGENT_RUN_AS_KNOB = 'TM8_VAULT_AGENT_RUN_AS';

/**
 * Where agent sessions run, as host uids. This is owner decision D2, and each variant has a form:
 * - `uid:<uid>`: one shared agent uid (variant B1).
 * - `uids:<first>-<last>`: a uid per session, from this range (B2).
 * - `gvisor:<first>-<last>`: a gVisor sandbox per session, whose user namespace maps onto these host uids (B3).
 * Decimal, no sign and no leading zero. Root and (uid_t)-1 cannot be named. A range is an interval,
 * never listed out. B2-lite (bubblewrap or unshare) has no form yet.
 */
export interface AgentRunAs {
  readonly variant: 'uid' | 'uids' | 'gvisor';
  readonly first: number;
  readonly last: number;
}

const RUN_AS = /^(?:uid:([1-9][0-9]{0,9})|(uids|gvisor):([1-9][0-9]{0,9})-([1-9][0-9]{0,9}))$/;

/** Unset or blank is undefined. Anything that is not exactly one of the three forms is null. */
export function parseAgentRunAs(value: string | undefined): AgentRunAs | undefined | null {
  const text = value?.trim() ?? '';
  if (text === '') return undefined;
  const match = RUN_AS.exec(text);
  if (match === null) return null;
  const variant: AgentRunAs['variant'] = match[1] !== undefined ? 'uid' : match[2] as 'uids' | 'gvisor';
  const first = Number(match[1] ?? match[3]);
  const last = Number(match[1] ?? match[4]);
  if (first > MAX_HOST_ID || last > MAX_HOST_ID || first > last) return null;
  return Object.freeze({ variant, first, last });
}

export interface HostEntryStat {
  readonly uid: number;
  readonly gid: number;
  /** st_mode, file type bits included. */
  readonly mode: number;
}

/** What the checks read. Tests pass a synthetic one. Errors read as null or false. */
export interface VaultHostView {
  /** This process's uid; -1 where the platform has none. */
  uid(): number;
  /** This process's supplementary groups and its effective gid; null when unknown. */
  gids(): readonly number[] | null;
  /** The entry itself, never a link's target. */
  lstat(path: string): HostEntryStat | null;
  realpath(path: string): string | null;
  /** A whole file as UTF-8. Called for /etc and /proc files only, never for a key file. */
  readText(path: string): string | null;
  /** access(path, W_OK) for this process: for a socket, whether it may connect. */
  canWrite(path: string): boolean;
  now(): number;
}

export const systemHostView: VaultHostView = Object.freeze({
  uid: () => (typeof process.getuid === 'function' ? process.getuid() : -1),
  gids: () => {
    if (typeof process.getgroups !== 'function' || typeof process.getegid !== 'function') return null;
    return [...new Set([...process.getgroups(), process.getegid()])];
  },
  lstat: (path: string) => {
    try {
      const stat = lstatSync(path);
      return { uid: stat.uid, gid: stat.gid, mode: stat.mode };
    } catch { return null; }
  },
  realpath: (path: string) => {
    try { return realpathSync.native(path); } catch { return null; }
  },
  readText: (path: string) => {
    try { return readFileSync(path, 'utf8'); } catch { return null; }
  },
  canWrite: (path: string) => {
    try { accessSync(path, constants.W_OK); return true; } catch { return false; }
  },
  now: () => Date.now(),
});

export type BoundaryCheck = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R8';

/** A refused precondition: the check, the knob to change (the run-as knob for a host fact), and why. */
export interface BoundaryFailure {
  readonly check: BoundaryCheck;
  readonly knob: string;
  readonly rule: string;
}

/** A file the relay will read: a key, or for mutual TLS also the certificate and the CA. */
export interface BoundaryFile {
  readonly knob: string;
  readonly path: string;
}

/**
 * Groups an agent must not be in (R4). The design names docker, sudo, wheel, adm and tm8-vault in
 * R4 and systemd-journal, tm8 and tm8-relay in section 1. root, disk, kmem, shadow, lxd and libvirt
 * are added here: each reads raw disks, memory or password hashes, or drives a daemon that acts as
 * root. Any group this server itself is in is refused too.
 */
export const FORBIDDEN_AGENT_GROUPS: readonly string[] = Object.freeze([
  'adm', 'disk', 'docker', 'kmem', 'libvirt', 'lxd', 'root', 'shadow', 'sudo', 'systemd-journal',
  'tm8', 'tm8-relay', 'tm8-vault', 'wheel',
]);

/** hidepid values that hide other users' processes: 2 and 4, and the names newer kernels print. */
const HIDING_HIDEPID: ReadonlySet<string> = new Set(['2', 'invisible', '4', 'ptraceable']);

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const STICKY = 0o1000;
const GROUP_OR_OTHER_WRITE = 0o022;

/** A path inside a message: quoted, with any control character escaped. */
const quoted = (path: string): string => JSON.stringify(path);

/**
 * R1 to R6, every failure collected. `files` are the key files, plus the certificate and CA for
 * mutual TLS, in the order config.ts checks them.
 */
export function checkRelayBoundary(host: VaultHostView, runAs: AgentRunAs, files: readonly BoundaryFile[]): BoundaryFailure[] {
  const failures: BoundaryFailure[] = [];
  const fail = (check: BoundaryCheck, knob: string, rule: string): void => { failures.push(Object.freeze({ check, knob, rule })); };
  const agentUid = (id: number): boolean => id >= runAs.first && id <= runAs.last;

  // R1: agents do not run as this process, and no file the relay reads is theirs.
  const uid = host.uid();
  if (uid < 0) fail('R1', AGENT_RUN_AS_KNOB, 'cannot be checked: this process has no uid');
  else if (agentUid(uid)) fail('R1', AGENT_RUN_AS_KNOB, `includes this server's own uid (${uid}): agents would run as the relay and could read its keys`);
  for (const file of files) {
    const stat = host.lstat(file.path);
    if (stat === null) fail('R1', file.knob, 'cannot be checked: the file cannot be inspected');
    else if (agentUid(stat.uid)) fail('R1', file.knob, `names a file owned by uid ${stat.uid}, an agent uid`);
  }

  // R2: no agent can replace a file the relay reads, or anything on its path.
  for (const file of files) checkPath(host, file, agentUid, fail);

  const groupText = host.readText('/etc/group');
  const groups = groupText === null ? null : parseGroupFile(groupText);
  const passwdText = host.readText('/etc/passwd');
  const passwd = passwdText === null ? null : parsePasswdFile(passwdText);
  const own = host.gids();
  const agentGid = agentGroupTest(agentUid, groups, passwd);

  // R3: this process cannot start a container that mounts the host.
  if (groups === null) fail('R3', AGENT_RUN_AS_KNOB, 'cannot be checked: /etc/group is unreadable or malformed');
  if (own === null) fail('R3', AGENT_RUN_AS_KNOB, "cannot be checked: this process's groups are unknown");
  if (groups !== null && own !== null) {
    for (const group of groups) {
      if (group.name === 'docker' && own.includes(group.gid)) {
        fail('R3', AGENT_RUN_AS_KNOB, `cannot be met while this server is in the docker group (gid ${group.gid})`);
      }
    }
  }
  for (const socket of CONTAINER_SOCKETS) {
    if (host.canWrite(socket)) fail('R3', AGENT_RUN_AS_KNOB, `cannot be met while this server can connect to ${quoted(socket)}`);
  }

  // R4: agents are in no group that reaches root, the journal, the vault or this server.
  if (groups === null || passwd === null) {
    fail('R4', AGENT_RUN_AS_KNOB, 'cannot be checked: /etc/passwd or /etc/group is unreadable or malformed');
  } else {
    const reported = new Set<number>();
    for (const group of groups) {
      if (FORBIDDEN_AGENT_GROUPS.includes(group.name) && agentGid(group.gid) && !reported.has(group.gid)) {
        reported.add(group.gid);
        fail('R4', AGENT_RUN_AS_KNOB, `would put agents in the ${group.name} group (gid ${group.gid})`);
      }
    }
    for (const gid of own ?? []) {
      if (agentGid(gid) && !reported.has(gid)) {
        reported.add(gid);
        fail('R4', AGENT_RUN_AS_KNOB, `would put agents in a group this server is in (gid ${gid})`);
      }
    }
  }

  // R5: agents cannot see or trace this process.
  const scope = host.readText('/proc/sys/kernel/yama/ptrace_scope')?.trim();
  if (scope === undefined || !/^[0-9]$/.test(scope)) fail('R5', AGENT_RUN_AS_KNOB, 'cannot be checked: Yama ptrace_scope is unreadable');
  else if (Number(scope) < 1) fail('R5', AGENT_RUN_AS_KNOB, `cannot be met while Yama ptrace_scope is ${scope}: it must be 1 or more`);
  if (runAs.variant !== 'gvisor') {
    const mountinfo = host.readText('/proc/self/mountinfo');
    const mounts = mountinfo === null ? null : procMounts(mountinfo);
    if (mounts === null) fail('R5', AGENT_RUN_AS_KNOB, 'cannot be checked: /proc/self/mountinfo is unreadable or malformed');
    else if (mounts.length === 0) fail('R5', AGENT_RUN_AS_KNOB, 'cannot be checked: no proc mount is visible');
    else {
      for (const mount of mounts) {
        if (!HIDING_HIDEPID.has(mount.hidepid ?? '')) {
          fail('R5', AGENT_RUN_AS_KNOB, `cannot be met while proc at ${quoted(mount.mountPoint)} is mounted without hidepid=invisible`);
        }
        if (mount.gid !== null && agentGid(mount.gid)) {
          fail('R5', AGENT_RUN_AS_KNOB, `cannot be met while proc at ${quoted(mount.mountPoint)} lets gid ${mount.gid}, an agent group, see every process`);
        }
      }
    }
  }

  // R6: this process leaves no core dump. The kernel ignores LimitCORE for a piped core_pattern (core(5)).
  const limits = /^Max core file size[ \t]+(\S+)[ \t]+(\S+)/m.exec(host.readText('/proc/self/limits') ?? '');
  if (limits === null) fail('R6', AGENT_RUN_AS_KNOB, 'cannot be checked: /proc/self/limits is unreadable');
  else if (limits[1] !== '0' || limits[2] !== '0') {
    fail('R6', AGENT_RUN_AS_KNOB, `cannot be met while this process may dump core (soft ${limitText(limits[1]!)}, hard ${limitText(limits[2]!)}): set LimitCORE=0`);
  }
  const pattern = host.readText('/proc/sys/kernel/core_pattern');
  if (pattern === null) fail('R6', AGENT_RUN_AS_KNOB, 'cannot be checked: kernel.core_pattern is unreadable');
  else if (pattern.startsWith('|')) fail('R6', AGENT_RUN_AS_KNOB, 'cannot be met while kernel.core_pattern pipes cores to a program, which ignores LimitCORE');

  return failures;
}

function limitText(value: string): string {
  return /^(?:[0-9]{1,20}|unlimited)$/.test(value) ? value : 'unrecognised';
}

/**
 * R2. The path must be its own realpath: a symbolic link, `.` or `..` anywhere would put a second
 * path in play. Then neither the file nor any directory up to `/` may be owned by an agent uid or
 * writable by group or others; a directory with the sticky bit is allowed, as the design says,
 * because only an entry's owner can rename or remove it there.
 */
function checkPath(
  host: VaultHostView, file: BoundaryFile, agentUid: (id: number) => boolean,
  fail: (check: BoundaryCheck, knob: string, rule: string) => void,
): void {
  if (!isAbsolute(file.path)) { fail('R2', file.knob, 'must be an absolute path'); return; }
  const real = host.realpath(file.path);
  if (real === null) { fail('R2', file.knob, 'cannot be checked: the path does not resolve'); return; }
  if (real !== file.path) { fail('R2', file.knob, 'must be a canonical path with no symbolic link, "." or ".." in it'); return; }
  const self = host.lstat(file.path);
  if (self !== null && (self.mode & GROUP_OR_OTHER_WRITE) !== 0) fail('R2', file.knob, 'names a file that group or others can write');
  for (let dir = dirname(file.path); ; dir = dirname(dir)) {
    const stat = host.lstat(dir);
    if (stat === null) fail('R2', file.knob, `cannot be checked: ${quoted(dir)} cannot be inspected`);
    else if ((stat.mode & S_IFMT) !== S_IFDIR) fail('R2', file.knob, `has a parent that is not a directory: ${quoted(dir)}`);
    else if (agentUid(stat.uid)) fail('R2', file.knob, `is under a directory owned by uid ${stat.uid}, an agent uid: ${quoted(dir)}`);
    else if ((stat.mode & GROUP_OR_OTHER_WRITE) !== 0 && (stat.mode & STICKY) === 0) {
      fail('R2', file.knob, `is under a directory that group or others can write: ${quoted(dir)}`);
    }
    if (dirname(dir) === dir) break;
  }
}

/**
 * Whether an agent could hold a gid: as its own private group (the gid equal to an agent uid: the
 * spawner must keep that assumption or give agents a gid passwd names), as the primary gid passwd
 * gives a user with an agent uid, or as a listed member. Without the account files, the first alone.
 */
function agentGroupTest(
  agentUid: (id: number) => boolean, groups: readonly GroupEntry[] | null, passwd: readonly PasswdEntry[] | null,
): (gid: number) => boolean {
  const agents = (passwd ?? []).filter((user) => agentUid(user.uid));
  const names = new Set(agents.map((user) => user.name));
  const primary = new Set(agents.map((user) => user.gid));
  return (gid) => agentUid(gid) || primary.has(gid)
    || (groups ?? []).some((group) => group.gid === gid && group.members.some((member) => names.has(member)));
}

interface ProcMount { readonly mountPoint: string; readonly hidepid: string | null; readonly gid: number | null }

/** The proc mounts in /proc/self/mountinfo (proc(5)), or null if a line does not parse. */
function procMounts(text: string): ProcMount[] | null {
  const mounts: ProcMount[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const split = line.indexOf(' - ');
    if (split < 0) return null;
    const left = line.slice(0, split).split(' ');
    const right = line.slice(split + 3).split(' ');
    if (left.length < 6 || right.length !== 3) return null;
    if (right[0] !== 'proc') continue;
    const options = right[2]!.split(',');
    const hidepid = options.find((option) => option.startsWith('hidepid='))?.slice('hidepid='.length) ?? null;
    const gidText = options.find((option) => option.startsWith('gid='))?.slice('gid='.length);
    if (gidText !== undefined && !/^(?:0|[1-9][0-9]{0,9})$/.test(gidText)) return null;
    mounts.push({ mountPoint: left[4]!, hidepid, gid: gidText === undefined ? null : Number(gidText) });
  }
  return mounts;
}

export const RELAY_TLS_KEY_KNOB = 'TM8_VAULT_RELAY_TLS_KEY_FILE';
export const RELAY_TLS_CERT_KNOB = 'TM8_VAULT_RELAY_TLS_CERT_FILE';
export const RELAY_TLS_CA_KNOB = 'TM8_VAULT_RELAY_TLS_CA_FILE';

/**
 * R8, for mutual TLS: the client certificate matches its key, is not a CA and is valid at `now`,
 * and the CA file holds exactly one PEM block, a CA certificate. The key is parsed here and dropped; the
 * caller wipes its bytes on a failure.
 */
export function checkRelayTlsMaterial(material: { readonly key: Buffer; readonly cert: Buffer; readonly ca: Buffer }, now: number): BoundaryFailure[] {
  const failures: BoundaryFailure[] = [];
  const fail = (knob: string, rule: string): void => { failures.push(Object.freeze({ check: 'R8' as const, knob, rule })); };

  let key: KeyObject | null = null;
  try { key = createPrivateKey(material.key); } catch { fail(RELAY_TLS_KEY_KNOB, 'is not an unencrypted PEM private key'); }
  let cert: X509Certificate | null = null;
  try { cert = new X509Certificate(material.cert); } catch { fail(RELAY_TLS_CERT_KNOB, 'is not a certificate'); }
  if (cert !== null) {
    if (key !== null && !matches(cert, key)) fail(RELAY_TLS_CERT_KNOB, `does not match ${RELAY_TLS_KEY_KNOB}`);
    if (cert.ca) fail(RELAY_TLS_CERT_KNOB, 'is a CA certificate: the relay needs a leaf client certificate');
    const from = Date.parse(cert.validFrom);
    const to = Date.parse(cert.validTo);
    if (!Number.isFinite(from) || !Number.isFinite(to)) fail(RELAY_TLS_CERT_KNOB, 'has a validity period that cannot be read');
    else if (now < from) fail(RELAY_TLS_CERT_KNOB, 'is not valid yet');
    else if (now > to) fail(RELAY_TLS_CERT_KNOB, 'has expired');
  }

  // Every PEM block counts, whatever its type: TLS would trust each certificate in the file. Text
  // outside a block is ignored here, as OpenSSL ignores it.
  const blocks = material.ca.toString('latin1').match(/-----BEGIN [A-Z0-9 ]{1,64}-----/g) ?? [];
  const certificates = blocks.filter((block) => block === '-----BEGIN CERTIFICATE-----').length;
  if (blocks.length !== 1 || certificates !== 1) {
    fail(RELAY_TLS_CA_KNOB, `must hold exactly one PEM block, a certificate (it holds ${counted(certificates, 'certificate')} `
      + `and ${counted(blocks.length - certificates, 'other PEM block')})`);
  } else {
    let ca: X509Certificate | null = null;
    try { ca = new X509Certificate(material.ca); } catch { fail(RELAY_TLS_CA_KNOB, 'is not a certificate'); }
    if (ca !== null && !ca.ca) fail(RELAY_TLS_CA_KNOB, 'holds a certificate that is not a CA');
  }
  return failures;
}

function matches(cert: X509Certificate, key: KeyObject): boolean {
  try { return cert.checkPrivateKey(key); } catch { return false; }
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
