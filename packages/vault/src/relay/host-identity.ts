/**
 * Local account files and container sockets, for the host-boundary checks at both ends
 * (independent review F03; design doc 01a1fe13, section 4: the relay's R3 and R4, the broker's B3).
 *
 * Pure: this parses text the caller read and lists paths. It opens nothing.
 *
 * Only the local files count. Users and groups that come from NSS (LDAP, SSSD, systemd's dynamic
 * users through nss-systemd) are not visible here (design doc N2), so a passing check says nothing
 * about them. A NIS compat line (`+` or `-`) pulls such entries in, so it fails the parse instead
 * of passing unseen. Blank lines and `#` comments are skipped, as glibc's files backend skips them.
 */

export interface GroupEntry {
  readonly name: string;
  readonly gid: number;
  readonly members: readonly string[];
}

export interface PasswdEntry {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
}

/** The largest id a uid or gid can be: 4294967295 is (uid_t)-1, which names no one. */
export const MAX_HOST_ID = 4_294_967_294;

/** A local user or group name. The first character is never `+` or `-`, so a NIS line fails. */
const NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*\$?$/;
/** Decimal, no sign, no leading zero. */
const ID = /^(?:0|[1-9][0-9]{0,9})$/;

function hostId(text: string): number | null {
  if (!ID.test(text)) return null;
  const value = Number(text);
  return value <= MAX_HOST_ID ? value : null;
}

function entryLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
}

/** `/etc/group`, or null if any line is not `name:password:gid:member,member`. */
export function parseGroupFile(text: string): GroupEntry[] | null {
  const entries: GroupEntry[] = [];
  for (const line of entryLines(text)) {
    const fields = line.split(':');
    if (fields.length !== 4) return null;
    const [name, , gidText, memberText] = fields as [string, string, string, string];
    const gid = hostId(gidText);
    if (!NAME.test(name) || gid === null) return null;
    const members = memberText === '' ? [] : memberText.split(',');
    if (!members.every((member) => NAME.test(member))) return null;
    entries.push(Object.freeze({ name, gid, members: Object.freeze(members) }));
  }
  return entries;
}

/** `/etc/passwd`, or null if any line is not `name:password:uid:gid:gecos:home:shell`. */
export function parsePasswdFile(text: string): PasswdEntry[] | null {
  const entries: PasswdEntry[] = [];
  for (const line of entryLines(text)) {
    const fields = line.split(':');
    if (fields.length !== 7) return null;
    const [name, , uidText, gidText] = fields as [string, string, string, string];
    const uid = hostId(uidText);
    const gid = hostId(gidText);
    if (!NAME.test(name) || uid === null || gid === null) return null;
    entries.push(Object.freeze({ name, uid, gid }));
  }
  return entries;
}

/**
 * Sockets whose daemon starts a container for whoever can connect, and so acts as root on the host:
 * docker, containerd, podman, CRI-O and BuildKit, at their default paths. Each is listed under
 * `/var/run` too, for hosts where that is not a link to `/run`. A daemon listening anywhere else,
 * or over TCP, is not seen.
 */
export const CONTAINER_SOCKETS: readonly string[] = Object.freeze([
  '/run/docker.sock', '/var/run/docker.sock',
  '/run/containerd/containerd.sock', '/var/run/containerd/containerd.sock',
  '/run/podman/podman.sock', '/var/run/podman/podman.sock',
  '/run/crio/crio.sock', '/var/run/crio/crio.sock',
  '/run/buildkit/buildkitd.sock', '/var/run/buildkit/buildkitd.sock',
]);
