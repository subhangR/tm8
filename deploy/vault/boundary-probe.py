"""tm8 Secure Vault: the agent-side boundary probe (review F03; design doc 01a1fe13, section 2).

DO NOT RUN THIS ON ANY HOST BUT A STAGING HOST, AND ONLY IN A RUN THE OWNER HAS APPROVED.
It ships as an asset and has never been run. Nothing in this repository runs it: its test
(packages/server/test/vault/boundary-probe.test.ts, through boundary-probe-check.py beside it)
parses and compiles the source and executes none of it.

WHAT IT ANSWERS
  Run from inside an ordinary agent session, it asks whether this process can reach what the
  boundary must keep from agents: the relay's keys and sockets; the tm8 server's environment, memory
  and file descriptors; other agent sessions; root paths and host credentials; the journal and cloud
  metadata; container daemons; the server's code and data; and the broker's mutual-TLS listener
  without the relay's certificate.

HOW TO RUN IT
  python3 -I deploy/vault/boundary-probe.py --staging-run --config /abs/path/config.json [--positive-control]

  Run it inside an ordinary agent session that tm8 spawned on the staging host, as that session's
  user. The config path must be absolute. It refuses to start in any of these cases:
  - without --staging-run;
  - without -I;
  - as root;
  - unless the config says "environment": "staging".
  These guard against a mistaken run. They do not authorize one.

CONFIG (JSON: paths, pids and uids only, never a secret value; any other key refuses)
  environment         "staging", exactly.
  server_uid          the tm8 server's uid (I1, P6, H3).
  signer_uid          the signer's uid, if option A is built (I1).
  server_pid          the tm8 server's pid, taken at run time (P1 to P4).
  relay_key_path      TM8_VAULT_RELAY_PRIVATE_KEY_FILE's path (K1, K3).
  relay_tls_key_path  TM8_VAULT_RELAY_TLS_KEY_FILE's path (K2, K3).
  vault_sockets       more unix sockets agents must not reach, such as the signer's (K4). The
                      broker's and the fill worker's default sockets are always checked.
  sibling_pids        pids of another live agent session (P5).
  sibling_homes       that session's home and credential directories (P5).
  server_home         the server uid's home directory (H2).
  credential_files    more files agents must not open: PGPASSFILE, the server unit's
                      EnvironmentFiles (H2).
  credential_dirs     more directories whose files agents must not open (H2).
  server_unit         the tm8 server's systemd unit, such as tm8-server.service (H3).
  refused_write_dirs  the server's install and data directories, and the vault's ledger or
                      checkpoint directory (W1).
  broker_host, broker_port   the broker's mutual-TLS listener (N1, N2).
  A check whose input is missing reports NOT_RUN. NOT_RUN is not a pass.

OUTPUT (stdout)
  JSON lines: one per check, in the order of CHECKS, then one SUMMARY or CONTROL line. For example:
    {"check":"P1","result":"PASS","detail":"EACCES"}
  - result is PASS, FAIL, ERROR or NOT_RUN.
  - detail is either an error name or counts. An error name is an errno name such as EACCES, or a
    name from EXTRA_ERROR_NAMES. Counts are up to eight key=digits pairs, such as
    "reachable=1 bytes=1".
  - emit() enforces that, and nothing else writes to stdout.
  - Nothing is ever printed from a file, an environment, memory, or a user or host name, and no
    path either. A read of a target (a key, a credential file, another process's environment or
    memory, a journal file) takes at most one byte, and only its length is kept. Read whole, and
    never printed: the config, this process's /proc/self/status and /proc/self/mounts, and a target
    pid's /proc/<pid>/maps (to find a readable address).
  - stderr carries only the fixed REFUSALS messages, never a traceback.
  Exit status: 0 when every check passes; 1 when a check fails; 2 when none fails but one is ERROR
  or NOT_RUN; 3 when it refuses to start; 4 on an internal error. Store the whole output as a tm8
  file attached to the staging test task.

POSITIVE CONTROL (first, on the OLD topology: agents run as the server's uid, in the docker group)
  1. On the staging host, before the boundary is in, start the tm8 server in pre_review. Use
     staging keys and test secrets only. Spawn one agent session.
  2. Write the config. Take server_pid at run time, and confirm it is the live server.
  3. Inside the agent session, run:
       python3 -I boundary-probe.py --staging-run --config <file> --positive-control
  4. K1, P1 and D1 must each report FAIL. The run must end with {"check":"CONTROL","result":"PASS",...}
     and exit 0. If any of the three does not FAIL, the probe cannot see the problem on this host.
     Stop, and fix the probe or the config before trusting any PASS from it.
  5. Keep the whole report. A check that PASSes here too proves nothing on this host. Report it
     as no evidence, never as a pass. Two are likely:
     - P3 under Yama ptrace_scope 1, which refuses to trace any process that is not a
       descendant, and the server is the agent's ancestor;
     - H3 where the server's own uid cannot read its journal entries either: a system user's
       entries go to the system journal, which only some groups can read.
  Then:
  - put the boundary in;
  - rotate the staging keys;
  - spawn a new agent session;
  - keep the same config (only the pids change), and run without --positive-control.
  Every check must PASS, and the run must exit 0. Under variant B1 (one shared agent uid), P5 is
  expected to FAIL: record that as an accepted risk, never as a pass.

WHAT A PASS MEANS
  ENOENT, ENOTDIR and ESRCH pass because a boundary may hide a path or a pid. A wrong path or pid in
  the config gives them too. That is why the config stays the same across both runs, and why the
  positive control must FAIL first.

SIDE EFFECTS (tell the staging host's owner before a run)
  - W1 tries to create .tm8-boundary-probe-<random> in each refused_write_dirs entry. Succeeding is
    a FAIL, and the probe removes the file at once.
  - N2 has openssl write a throwaway self-signed key and certificate into a new private temporary
    directory, and removes the directory.
  - I3 runs `sudo -n true`. sudo may log the attempt, and on some hosts mail root.
  - P3 and P5 attach with PTRACE_SEIZE from a short-lived child process. Unlike PTRACE_ATTACH, it
    does not stop the target, and the child's exit detaches it.
  - H4 sends one GET to the metadata server, for the service-account email path. It never asks for
    any other path, and least of all a credential path.
  - If a handshake completes, N1 and N2 send one HEAD request to the broker.
  - sudo, journalctl, docker and openssl run with no shell and no input. Their output is discarded,
    apart from journalctl's entries, which are counted and dropped.

NOT COVERED
  Design doc section 4 lists what cannot be decided at startup, as its own N1 to N8 (not this
  probe's N1 and N2). This probe covers section 4's N1 (agents really run under the boundary) and
  N3 (metadata from the agent uid), and part of N2 (groups through NSS, and sudo).
  Not covered:
  - N2's polkit rules and capabilities granted by other units;
  - N4, exposure before this boot (the rotation and the denylist cover it);
  - N5, other tenants of the broker host;
  - N6, the CA's other issuance (the pin covers it);
  - N7, kernel or sandbox escapes;
  - N8, other root-equivalent paths: cron, setuid binaries, writable unit directories.
  It sees only what this process can reach now, from this session.
"""

import ctypes
import errno
import glob
import grp
import http.client
import json
import os
import re
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import warnings

# The groups the relay's R4 refuses for agents (FORBIDDEN_AGENT_GROUPS in
# packages/server/src/vault/boundary.ts; a test keeps the two equal).
FORBIDDEN_GROUPS = (
    'adm', 'disk', 'docker', 'kmem', 'libvirt', 'lxd', 'root', 'shadow', 'sudo', 'systemd-journal',
    'tm8', 'tm8-relay', 'tm8-vault', 'wheel',
)

# The broker's and the fill worker's default sockets (DEFAULT_BROKER_SOCKET and DEFAULT_FILL_SOCKET
# in packages/vault/src/broker/main.ts; a test keeps them equal).
DEFAULT_VAULT_SOCKETS = ('/run/tm8-vault-broker/broker.sock', '/run/tm8-vault/fill.sock')

DOCKER_SOCKETS = ('/run/docker.sock', '/var/run/docker.sock')

# The container daemon sockets the relay's R3 and the broker's B3 look for (CONTAINER_SOCKETS in
# packages/vault/src/relay/host-identity.ts; a test keeps them equal).
CONTAINER_SOCKETS = (
    '/run/docker.sock', '/var/run/docker.sock',
    '/run/containerd/containerd.sock', '/var/run/containerd/containerd.sock',
    '/run/podman/podman.sock', '/var/run/podman/podman.sock',
    '/run/crio/crio.sock', '/var/run/crio/crio.sock',
    '/run/buildkit/buildkitd.sock', '/var/run/buildkit/buildkitd.sock',
)

# D2's rootless and gVisor runtime sockets, found by pattern. Only sockets count.
CONTAINER_SOCKET_PATTERNS = (
    '/run/user/*/podman/podman.sock', '/run/runsc*', '/run/runsc*/*', '/var/run/runsc*', '/var/run/runsc*/*',
)

# H3's system journal files. A user's own journal (user-<uid>.journal) is not matched.
JOURNAL_FILE_PATTERNS = ('/var/log/journal/*/system*.journal', '/run/log/journal/*/system*.journal')

METADATA_HOST = '169.254.169.254'
# The email path only: it shows reachability. No other metadata path is ever requested.
METADATA_PATH = '/computeMetadata/v1/instance/service-accounts/default/email'

CONTROL_CHECKS = ('K1', 'P1', 'D1')

RESULTS = ('PASS', 'FAIL', 'ERROR', 'NOT_RUN')

# TLS alerts that mean the broker refused this client. Any other TLS error is an ERROR.
REFUSAL_ALERTS = (
    'TLSV13_ALERT_CERTIFICATE_REQUIRED', 'TLSV1_ALERT_UNKNOWN_CA', 'SSLV3_ALERT_BAD_CERTIFICATE',
    'SSLV3_ALERT_CERTIFICATE_UNKNOWN', 'TLSV1_ALERT_ACCESS_DENIED', 'SSLV3_ALERT_HANDSHAKE_FAILURE',
)

EXTRA_ERROR_NAMES = ('NOT_CONFIGURED', 'TIMEOUT', 'UNEXPECTED', 'MALFORMED', 'DETAIL_REFUSED', 'TLS_ERROR') + REFUSAL_ALERTS

ERROR_NAMES = frozenset(errno.errorcode.values()) | frozenset(EXTRA_ERROR_NAMES)

# Counts: up to eight key=digits pairs. Nothing else but an error name can be printed.
COUNTS = re.compile(r'[a-z][a-z0-9_]{0,31}=[0-9]{1,20}(?: [a-z][a-z0-9_]{0,31}=[0-9]{1,20}){0,7}')

REFUSALS = {
    'usage': 'boundary probe: refused: run python3 -I boundary-probe.py --staging-run --config <file> [--positive-control]',
    'isolated': 'boundary probe: refused: run it with python3 -I',
    'root': 'boundary probe: refused: it runs as an agent session, never as root',
    'config': 'boundary probe: refused: the config is unreadable, not JSON, or has a key or value outside the documented schema',
    'environment': 'boundary probe: refused: the config does not say "environment": "staging"',
    'internal': 'boundary probe: internal error (no detail is printed)',
}

MAX_CONFIG_BYTES = 65536
MAX_PROC_TEXT = 1048576
MAX_LIST = 64
HOST = re.compile(r'[A-Za-z0-9.:-]{1,253}')
UNIT = re.compile(r'[A-Za-z0-9@_.:-]{1,128}')

SCHEMA = {
    'environment': 'text', 'server_uid': 'uid', 'signer_uid': 'uid', 'server_pid': 'pid',
    'relay_key_path': 'path', 'relay_tls_key_path': 'path', 'vault_sockets': 'paths',
    'sibling_pids': 'pids', 'sibling_homes': 'paths', 'server_home': 'path',
    'credential_files': 'paths', 'credential_dirs': 'paths', 'server_unit': 'unit',
    'refused_write_dirs': 'paths', 'broker_host': 'host', 'broker_port': 'port',
}

DENIED = frozenset((errno.EACCES, errno.EPERM))
HIDDEN = frozenset((errno.ENOENT, errno.ENOTDIR, errno.ESRCH))

PTRACE_SEIZE = 0x4206
SUBPROCESS_TIMEOUT = 15
NET_TIMEOUT = 5


def emit(check, result, detail):
    """The only writer to stdout. An unknown check, result or detail shape becomes ERROR DETAIL_REFUSED."""
    if check not in CHECK_IDS and check not in ('SUMMARY', 'CONTROL'):
        check, result, detail = 'SUMMARY', 'ERROR', 'DETAIL_REFUSED'
    if result not in RESULTS:
        result, detail = 'ERROR', 'DETAIL_REFUSED'
    if not isinstance(detail, str) or not (detail in ERROR_NAMES or COUNTS.fullmatch(detail)):
        result, detail = 'ERROR', 'DETAIL_REFUSED'
    sys.stdout.write(json.dumps({'check': check, 'result': result, 'detail': detail}, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def refuse(reason):
    """The only writer to stderr: a fixed message."""
    sys.stderr.write(REFUSALS[reason] + '\n')
    sys.stderr.flush()
    return 3


def error_name(error):
    if isinstance(error, socket.timeout):
        return 'TIMEOUT'
    return errno.errorcode.get(error.errno, 'UNEXPECTED') if isinstance(error.errno, int) else 'UNEXPECTED'


def outcome_of(error):
    """('denied' | 'hidden' | 'error', error name) for a refused open, connect or list."""
    if isinstance(error.errno, int) and error.errno in DENIED:
        return ('denied', error_name(error))
    if isinstance(error.errno, int) and error.errno in HIDDEN:
        return ('hidden', error_name(error))
    return ('error', error_name(error))


def read_one(path, offset=None):
    """Open read-only and read at most one byte, of which only the length is kept.

    ('reachable', 0 or 1) when the open succeeded, whether or not a byte could be read.
    """
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOCTTY | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError as error:
        return outcome_of(error)
    try:
        if offset is not None:
            os.lseek(fd, offset, os.SEEK_SET)
        return ('reachable', len(os.read(fd, 1)))
    except OSError:
        return ('reachable', 0)
    finally:
        os.close(fd)


def read_proc_text(path):
    """A small /proc text, whole: this process's status or mounts, or a target's maps. Never printed."""
    if not path.startswith('/proc/'):
        raise ValueError('read_proc_text reads /proc only')
    try:
        with open(path, 'rb') as handle:
            data = handle.read(MAX_PROC_TEXT)
    except OSError as error:
        return outcome_of(error)
    return data.decode('ascii', 'replace')


def connect_unix(path):
    """Connect and close at once, sending nothing. A refused listener still means permission was granted."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(3)
    try:
        sock.connect(path)
    except socket.timeout:
        return ('error', 'TIMEOUT')
    except OSError as error:
        if error.errno == errno.ECONNREFUSED:
            return ('reachable', 0)
        return outcome_of(error)
    finally:
        sock.close()
    return ('reachable', 1)


def run_quiet(argv, count_json_entries=False):
    """('ran', exit status, entry count) or an outcome. No shell and no input.

    Output is discarded. For journalctl's JSON output it is counted instead: each line that starts
    with '{' is one entry, and none is kept.
    """
    try:
        completed = subprocess.run(argv, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE if count_json_entries else subprocess.DEVNULL,
                                   timeout=SUBPROCESS_TIMEOUT, shell=False, check=False)
    except subprocess.TimeoutExpired:
        return ('error', 'TIMEOUT')
    except OSError as error:
        return outcome_of(error)
    entries = sum(1 for line in completed.stdout.splitlines() if line.startswith(b'{')) if count_json_entries else 0
    return ('ran', completed.returncode, entries)


def single(outcome):
    """A one-target check: refused or hidden passes, reachable fails."""
    kind, value = outcome[0], outcome[1]
    if kind in ('denied', 'hidden'):
        return ('PASS', value)
    if kind == 'reachable':
        return ('FAIL', 'reachable=1 bytes=%d' % value)
    return ('ERROR', value)


class Tally:
    """A many-target check: any reachable target fails; otherwise any error is an ERROR."""

    def __init__(self):
        self.targets = 0
        self.counts = {'denied': 0, 'hidden': 0, 'reachable': 0, 'error': 0}

    def add(self, outcome):
        self.targets += 1
        self.counts[outcome[0]] += 1

    def verdict(self, extra=''):
        detail = 'targets=%d denied=%d hidden=%d reachable=%d errors=%d%s' % (
            self.targets, self.counts['denied'], self.counts['hidden'], self.counts['reachable'], self.counts['error'], extra)
        if self.counts['reachable'] > 0:
            return ('FAIL', detail)
        if self.counts['error'] > 0:
            return ('ERROR', detail)
        if self.targets == 0:
            return ('NOT_RUN', detail)
        return ('PASS', detail)


def unique(items):
    seen = []
    for item in items:
        if item not in seen:
            seen.append(item)
    return seen


def ptrace_outcome(pid):
    """PTRACE_SEIZE from a child that exits at once. SEIZE does not stop the target; the exit detaches."""
    sys.stdout.flush()
    child = os.fork()
    if child == 0:
        code = 15
        try:
            libc = ctypes.CDLL(None, use_errno=True)
            libc.ptrace.argtypes = (ctypes.c_long, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p)
            libc.ptrace.restype = ctypes.c_long
            if libc.ptrace(PTRACE_SEIZE, pid, None, None) == 0:
                code = 10
            else:
                code = {errno.EPERM: 11, errno.EACCES: 12, errno.ESRCH: 13}.get(ctypes.get_errno(), 14)
        except BaseException:
            code = 15
        os._exit(code)
    _, status = os.waitpid(child, 0)
    code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 16
    return {10: ('reachable', 1), 11: ('denied', 'EPERM'), 12: ('denied', 'EACCES'), 13: ('hidden', 'ESRCH')}.get(code, ('error', 'UNEXPECTED'))


def first_readable_region(text):
    for line in text.splitlines():
        fields = line.split()
        if len(fields) >= 2 and fields[1].startswith('r') and '-' in fields[0]:
            try:
                return int(fields[0].split('-')[0], 16)
            except ValueError:
                return None
    return None


def memory_outcome(pid):
    """P2's read: maps, then one byte of mem at the first readable region. maps being readable is already reachable."""
    text = read_proc_text('/proc/%d/maps' % pid)
    if isinstance(text, tuple):
        return text
    address = first_readable_region(text)
    if address is None:
        return ('reachable', 0)
    memory = read_one('/proc/%d/mem' % pid, address)
    return ('reachable', memory[1] if memory[0] == 'reachable' else 0)


def tally_tree(root, tally, depth=3):
    """Every regular file under root, to depth 3, through read_one. A refused listing is one target."""
    try:
        with os.scandir(root) as entries:
            found = list(entries)
    except OSError as error:
        tally.add(outcome_of(error))
        return
    for entry in found:
        try:
            if entry.is_dir(follow_symlinks=False):
                if depth > 1:
                    tally_tree(entry.path, tally, depth - 1)
            elif entry.is_file(follow_symlinks=True):
                tally.add(read_one(entry.path))
        except OSError as error:
            tally.add(outcome_of(error))


def tls_alert(error):
    reason = getattr(error, 'reason', None)
    return reason if reason in REFUSAL_ALERTS else None


def tls_probe(host, port, pair):
    """A TLS 1.3 client with no certificate or a throwaway one. Only a refusal passes; any HTTP byte fails.

    The broker's identity is not verified: the probe tests the broker's refusal, and sends no secret.
    A connect that fails is an ERROR, not a pass: the refusal was not tested.
    """
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    if pair is not None:
        context.load_cert_chain(pair[0], pair[1])
    try:
        raw = socket.create_connection((host, port), timeout=NET_TIMEOUT)
    except OSError as error:
        return ('ERROR', error_name(error))
    count = 0
    try:
        try:
            tls = context.wrap_socket(raw, server_hostname=None)
        except ssl.SSLError as error:
            alert = tls_alert(error)
            return ('PASS', alert) if alert else ('ERROR', 'TLS_ERROR')
        try:
            tls.sendall(b'HEAD / HTTP/1.1\r\nHost: vault-broker\r\nConnection: close\r\n\r\n')
            count = len(tls.recv(1))
        except (ssl.SSLZeroReturnError, ssl.SSLEOFError):
            return ('PASS', 'tls_bytes=0')
        except ssl.SSLError as error:
            alert = tls_alert(error)
            return ('PASS', alert) if alert else ('ERROR', 'TLS_ERROR')
        finally:
            tls.close()
    except OSError as error:
        if isinstance(error.errno, int) and error.errno in (errno.ECONNRESET, errno.EPIPE):
            return ('PASS', error_name(error))
        return ('ERROR', error_name(error))
    finally:
        raw.close()
    return ('FAIL', 'tls_bytes=%d' % count) if count else ('PASS', 'tls_bytes=0')


# ---- The checks, in the order of design doc 01a1fe13, section 2. Each returns (result, detail).

def check_i1(config):
    """I1: this uid is not the server's or the signer's, and holds no forbidden group (looked up through NSS)."""
    if 'server_uid' not in config:
        return ('NOT_RUN', 'NOT_CONFIGURED')
    uids = {os.getuid(), os.geteuid()}
    matches = sum(1 for key in ('server_uid', 'signer_uid') if key in config and config[key] in uids)
    gids = set(os.getgroups()) | {os.getgid(), os.getegid()}
    forbidden = 0
    for name in FORBIDDEN_GROUPS:
        try:
            gid = grp.getgrnam(name).gr_gid
        except KeyError:
            continue
        if gid in gids:
            forbidden += 1
    result = 'FAIL' if matches or forbidden else 'PASS'
    return (result, 'uid_matches=%d forbidden_groups=%d' % (matches, forbidden))


def check_i2(config):
    """I2: NoNewPrivs 1, and no effective or ambient capability."""
    text = read_proc_text('/proc/self/status')
    if isinstance(text, tuple):
        return ('ERROR', text[1])
    fields = {}
    for line in text.splitlines():
        key, _, value = line.partition(':')
        if key in ('NoNewPrivs', 'CapEff', 'CapAmb', 'CapBnd'):
            fields[key] = value.strip()
    try:
        no_new_privs = int(fields['NoNewPrivs'])
        effective = bin(int(fields['CapEff'], 16)).count('1')
        ambient = bin(int(fields['CapAmb'], 16)).count('1')
        bounding = bin(int(fields['CapBnd'], 16)).count('1')
    except (KeyError, ValueError):
        return ('ERROR', 'MALFORMED')
    result = 'PASS' if no_new_privs == 1 and effective == 0 and ambient == 0 else 'FAIL'
    return (result, 'no_new_privs=%d cap_eff_bits=%d cap_amb_bits=%d cap_bnd_bits=%d' % (no_new_privs, effective, ambient, bounding))


def check_i3(config):
    """I3: sudo -n true does not succeed."""
    ran = run_quiet(['sudo', '-n', 'true'])
    if ran[0] != 'ran':
        return ('PASS', ran[1]) if ran[0] in ('denied', 'hidden') else ('ERROR', ran[1])
    if ran[1] < 0:
        return ('ERROR', 'signal=%d' % -ran[1])
    return ('FAIL' if ran[1] == 0 else 'PASS', 'exit=%d' % ran[1])


def check_k1(config):
    """K1: the relay signing key cannot be opened."""
    if 'relay_key_path' not in config:
        return ('NOT_RUN', 'NOT_CONFIGURED')
    return single(read_one(config['relay_key_path']))


def check_k2(config):
    """K2: the relay TLS client key cannot be opened."""
    if 'relay_tls_key_path' not in config:
        return ('NOT_RUN', 'NOT_CONFIGURED')
    return single(read_one(config['relay_tls_key_path']))


def check_k3(config):
    """K3: no directory from a key file up to / is writable by this uid, nor the key file itself (an extension).

    A sticky directory such as /tmp counts as writable here, though the relay's R2 allows one: keep
    the keys out of such directories.
    """
    paths = [config[key] for key in ('relay_key_path', 'relay_tls_key_path') if key in config]
    if not paths:
        return ('NOT_RUN', 'NOT_CONFIGURED')
    checked = writable = 0
    for path in paths:
        current = path
        while True:
            checked += 1
            if os.access(current, os.W_OK):
                writable += 1
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent
    return ('FAIL' if writable else 'PASS', 'checked=%d writable=%d' % (checked, writable))


def check_k4(config):
    """K4: no vault socket accepts this uid: the broker's, the fill worker's, and any configured (the signer's)."""
    tally = Tally()
    for path in unique(list(DEFAULT_VAULT_SOCKETS) + list(config.get('vault_sockets', []))):
        tally.add(connect_unix(path))
    return tally.verdict()


def check_p1(config):
    """P1: the server's environment cannot be opened."""
    if 'server_pid' not in config:
        return ('NOT_RUN', 'NOT_CONFIGURED')
    return single(read_one('/proc/%d/environ' % config['server_pid']))


def check_p2(config):
    """P2: the server's memory map cannot be read (and so neither can its memory)."""
    if 'server_pid' not in config:
        return ('NOT_RUN', 'NOT_CONFIGURED')
    outcome = memory_outcome(config['server_pid'])
    if outcome[0] == 'reachable':
        return ('FAIL', 'maps_readable=1 mem_bytes=%d' % outcome[1])
    return single(outcome)


def check_p3(config):
    """P3: the server cannot be ptrace-attached."""
    if 'server_pid' not in config:
        return ('NOT_RUN', 'NOT_CONFIGURED')
    outcome = ptrace_outcome(config['server_pid'])
    return ('FAIL', 'attached=1') if outcome[0] == 'reachable' else single(outcome)


def check_p4(config):
    """P4: the server's file descriptors cannot be listed."""
    if 'server_pid' not in config:
        return ('NOT_RUN', 'NOT_CONFIGURED')
    try:
        count = len(os.listdir('/proc/%d/fd' % config['server_pid']))
    except OSError as error:
        return single(outcome_of(error))
    return ('FAIL', 'fds=%d' % count)


def check_p5(config):
    """P5: another agent session's environment, memory map and ptrace, and its home, are out of reach."""
    if not config.get('sibling_pids') and not config.get('sibling_homes'):
        return ('NOT_RUN', 'NOT_CONFIGURED')
    tally = Tally()
    for pid in config.get('sibling_pids', []):
        tally.add(read_one('/proc/%d/environ' % pid))
        outcome = memory_outcome(pid)
        tally.add(('reachable', 1) if outcome[0] == 'reachable' else outcome)
        tally.add(ptrace_outcome(pid))
    for home in config.get('sibling_homes', []):
        try:
            os.listdir(home)
            tally.add(('reachable', 1))
        except OSError as error:
            tally.add(outcome_of(error))
    return tally.verdict()


def check_p6(config):
    """P6: no process of the server's uid is visible. The hiding proc mount is reported, not required."""
    if 'server_uid' not in config:
        return ('NOT_RUN', 'NOT_CONFIGURED')
    mounts = read_proc_text('/proc/self/mounts')
    if isinstance(mounts, tuple):
        return ('ERROR', mounts[1])
    hiding = 0
    for line in mounts.splitlines():
        fields = line.split()
        if len(fields) >= 4 and fields[2] == 'proc' and fields[1] == '/proc':
            options = fields[3].split(',')
            if any(option in ('hidepid=2', 'hidepid=invisible', 'hidepid=4', 'hidepid=ptraceable') for option in options):
                hiding = 1
    try:
        names = os.listdir('/proc')
    except OSError as error:
        return ('ERROR', error_name(error))
    visible = 0
    for name in names:
        if name.isdigit():
            try:
                if os.stat('/proc/' + name).st_uid == config['server_uid']:
                    visible += 1
            except OSError:
                continue
    return ('FAIL' if visible else 'PASS', 'server_pids_visible=%d hidepid_hiding=%d' % (visible, hiding))


def check_h1(config):
    """H1: /root cannot be listed and /etc/shadow cannot be opened."""
    tally = Tally()
    try:
        os.listdir('/root')
        tally.add(('reachable', 1))
    except OSError as error:
        tally.add(outcome_of(error))
    tally.add(read_one('/etc/shadow'))
    return tally.verdict()


def check_h2(config):
    """H2: no host credential file can be opened."""
    if 'server_home' not in config:
        return ('NOT_RUN', 'NOT_CONFIGURED')
    home = config['server_home']
    files = [os.path.join(home, name) for name in ('.docker/config.json', '.kube/config', '.aws/credentials', '.pgpass')]
    files += list(config.get('credential_files', []))
    dirs = [os.path.join(home, name) for name in ('.ssh', '.config/gcloud')] + ['/etc/tm8', '/etc/ssl/private']
    dirs += list(config.get('credential_dirs', []))
    tally = Tally()
    for path in unique(files):
        tally.add(read_one(path))
    for path in unique(dirs):
        tally_tree(path, tally)
    return tally.verdict()


def check_h3(config):
    """H3: the journal shows no entry of the server's uid, nor of its unit when one is named.

    It also reads one byte of each system journal file. That catches a host with no journalctl,
    and a journal shared with a group this uid is in.
    """
    if 'server_uid' not in config:
        return ('NOT_RUN', 'NOT_CONFIGURED')
    queries = [['_UID=%d' % config['server_uid']]]
    if 'server_unit' in config:
        queries.append(['--unit=' + config['server_unit']])
    ran_count = entries = nonzero = 0
    for query in queries:
        ran = run_quiet(['journalctl', '--no-pager', '--quiet', '--output=json', '--lines=1'] + query, count_json_entries=True)
        if ran[0] == 'error':
            return ('ERROR', ran[1])
        if ran[0] == 'ran':
            ran_count += 1
            nonzero += 1 if ran[1] != 0 else 0
            entries += ran[2]
    files = readable = 0
    for pattern in JOURNAL_FILE_PATTERNS:
        for path in sorted(glob.glob(pattern)):
            files += 1
            if read_one(path)[0] == 'reachable':
                readable += 1
    detail = 'queries_run=%d entries=%d nonzero_exits=%d journal_files=%d readable_files=%d' % (ran_count, entries, nonzero, files, readable)
    return ('FAIL' if entries or readable else 'PASS', detail)


def check_h4(config):
    """H4: the cloud metadata server cannot be reached. One GET, for the email path only."""
    connection = http.client.HTTPConnection(METADATA_HOST, 80, timeout=3)
    try:
        try:
            connection.connect()
        except OSError as error:
            if isinstance(error, socket.timeout) or error.errno in (errno.ECONNREFUSED, errno.ENETUNREACH, errno.EHOSTUNREACH, errno.ETIMEDOUT):
                return ('PASS', error_name(error))
            return ('ERROR', error_name(error))
        try:
            connection.request('GET', METADATA_PATH, headers={'Metadata-Flavor': 'Google'})
            status = connection.getresponse().status
        except (http.client.HTTPException, OSError):
            status = 0
        return ('FAIL', 'connected=1 status=%d' % status)
    finally:
        connection.close()


def check_d1(config):
    """D1: the docker socket does not accept this uid. A connect is enough: the design's _ping is not sent."""
    tally = Tally()
    for path in DOCKER_SOCKETS:
        tally.add(connect_unix(path))
    return tally.verdict()


def check_d2(config):
    """D2: no other container runtime's socket accepts this uid."""
    paths = [path for path in CONTAINER_SOCKETS if path not in DOCKER_SOCKETS]
    for pattern in CONTAINER_SOCKET_PATTERNS:
        for path in sorted(glob.glob(pattern)):
            try:
                if not stat.S_ISSOCK(os.stat(path).st_mode):
                    continue
            except OSError:
                pass
            paths.append(path)
    tally = Tally()
    for path in unique(paths):
        tally.add(connect_unix(path))
    return tally.verdict()


def check_d3(config):
    """D3: docker ps does not succeed."""
    ran = run_quiet(['docker', 'ps'])
    if ran[0] != 'ran':
        return ('PASS', ran[1]) if ran[0] in ('denied', 'hidden') else ('ERROR', ran[1])
    if ran[1] < 0:
        return ('ERROR', 'signal=%d' % -ran[1])
    return ('FAIL' if ran[1] == 0 else 'PASS', 'exit=%d' % ran[1])


def check_w1(config):
    """W1: no file can be created in the server's code and data directories or the vault's."""
    dirs = config.get('refused_write_dirs', [])
    if not dirs:
        return ('NOT_RUN', 'NOT_CONFIGURED')
    tally = Tally()
    removed = 0
    for directory in unique(dirs):
        name = os.path.join(directory, '.tm8-boundary-probe-' + os.urandom(8).hex())
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        except OSError as error:
            # A directory that does not exist means the config is wrong: an ERROR, not a pass.
            denied = isinstance(error.errno, int) and error.errno in (errno.EACCES, errno.EPERM, errno.EROFS)
            tally.add(('denied', error_name(error)) if denied else ('error', error_name(error)))
            continue
        os.close(fd)
        try:
            os.unlink(name)
            removed += 1
        except OSError:
            pass
        tally.add(('reachable', 1))
    return tally.verdict(' removed=%d' % removed)


def check_n1(config):
    """N1: the broker refuses a TLS client with no certificate."""
    if 'broker_host' not in config or 'broker_port' not in config:
        return ('NOT_RUN', 'NOT_CONFIGURED')
    return tls_probe(config['broker_host'], config['broker_port'], None)


def check_n2(config):
    """N2: the broker refuses a throwaway self-signed client certificate."""
    if 'broker_host' not in config or 'broker_port' not in config:
        return ('NOT_RUN', 'NOT_CONFIGURED')
    workdir = tempfile.mkdtemp(prefix='tm8-boundary-probe-')
    try:
        key = os.path.join(workdir, 'probe.key')
        cert = os.path.join(workdir, 'probe.crt')
        made = run_quiet(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
                          '-subj', '/CN=tm8-boundary-probe', '-days', '1', '-keyout', key, '-out', cert])
        if made[0] != 'ran':
            return ('NOT_RUN', made[1])
        if made[1] != 0:
            return ('NOT_RUN', 'exit=%d' % made[1] if made[1] >= 0 else 'signal=%d' % -made[1])
        return tls_probe(config['broker_host'], config['broker_port'], (cert, key))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


CHECKS = (
    ('I1', check_i1), ('I2', check_i2), ('I3', check_i3),
    ('K1', check_k1), ('K2', check_k2), ('K3', check_k3), ('K4', check_k4),
    ('P1', check_p1), ('P2', check_p2), ('P3', check_p3), ('P4', check_p4), ('P5', check_p5), ('P6', check_p6),
    ('H1', check_h1), ('H2', check_h2), ('H3', check_h3), ('H4', check_h4),
    ('D1', check_d1), ('D2', check_d2), ('D3', check_d3),
    ('W1', check_w1),
    ('N1', check_n1), ('N2', check_n2),
)

CHECK_IDS = tuple(check_id for check_id, _ in CHECKS)


def valid(kind, value):
    def number(low, high):
        return isinstance(value, int) and not isinstance(value, bool) and low <= value <= high

    def path(item):
        return isinstance(item, str) and 0 < len(item) <= 4096 and item.startswith('/') and '\x00' not in item

    if kind == 'text':
        return isinstance(value, str) and len(value) <= 64
    if kind == 'uid':
        return number(1, 4294967294)
    if kind == 'pid':
        return number(1, 4194304)
    if kind == 'port':
        return number(1, 65535)
    if kind == 'host':
        return isinstance(value, str) and HOST.fullmatch(value) is not None
    if kind == 'unit':
        return isinstance(value, str) and UNIT.fullmatch(value) is not None
    if kind == 'path':
        return path(value)
    if kind == 'paths':
        return isinstance(value, list) and len(value) <= MAX_LIST and all(path(item) for item in value)
    if kind == 'pids':
        return isinstance(value, list) and len(value) <= MAX_LIST and all(
            isinstance(item, int) and not isinstance(item, bool) and 1 <= item <= 4194304 for item in value)
    return False


def load_config(path):
    """The config as a dict, or None. It holds paths, pids and uids only."""
    if not os.path.isabs(path):
        return None
    try:
        with open(path, 'rb') as handle:
            data = handle.read(MAX_CONFIG_BYTES + 1)
    except OSError:
        return None
    if len(data) > MAX_CONFIG_BYTES:
        return None
    try:
        config = json.loads(data.decode('utf-8'))
    except ValueError:
        return None
    if not isinstance(config, dict):
        return None
    for key, value in config.items():
        kind = SCHEMA.get(key)
        if kind is None or not valid(kind, value):
            return None
    return config


def parse_args(argv):
    """(config path, positive control) for exactly the documented arguments, else None."""
    staging = control = False
    config = None
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == '--staging-run' and not staging:
            staging = True
        elif arg == '--positive-control' and not control:
            control = True
        elif arg == '--config' and config is None and index + 1 < len(argv):
            config = argv[index + 1]
            index += 1
        else:
            return None
        index += 1
    if not staging or config is None:
        return None
    return (config, control)


def main(argv):
    parsed = parse_args(argv)
    if parsed is None:
        return refuse('usage')
    if not sys.flags.isolated:
        return refuse('isolated')
    if os.getuid() == 0 or os.geteuid() == 0:
        return refuse('root')
    config = load_config(parsed[0])
    if config is None:
        return refuse('config')
    if config.get('environment') != 'staging':
        return refuse('environment')
    results = {}
    for check_id, check in CHECKS:
        try:
            result, detail = check(config)
        except Exception:
            # Never print the exception: its text can carry a path or bytes.
            result, detail = 'ERROR', 'UNEXPECTED'
        emit(check_id, result, detail)
        results[check_id] = result
    tallies = {name: sum(1 for value in results.values() if value == name) for name in RESULTS}
    if parsed[1]:
        failed = sum(1 for check_id in CONTROL_CHECKS if results.get(check_id) == 'FAIL')
        detected = failed == len(CONTROL_CHECKS)
        emit('CONTROL', 'PASS' if detected else 'FAIL', 'required_fail=%d seen_fail=%d' % (len(CONTROL_CHECKS), failed))
        return 0 if detected else 1
    summary = 'pass=%d fail=%d error=%d not_run=%d' % (tallies['PASS'], tallies['FAIL'], tallies['ERROR'], tallies['NOT_RUN'])
    if tallies['FAIL'] > 0:
        emit('SUMMARY', 'FAIL', summary)
        return 1
    if tallies['ERROR'] > 0 or tallies['NOT_RUN'] > 0:
        emit('SUMMARY', 'ERROR', summary)
        return 2
    emit('SUMMARY', 'PASS', summary)
    return 0


def run(argv):
    # stderr carries only the fixed refusals: no warning text either.
    warnings.simplefilter('ignore')
    try:
        return main(argv)
    except BaseException:
        # No traceback: it can carry a path or bytes.
        refuse('internal')
        return 4


if __name__ == '__main__':
    sys.exit(run(sys.argv[1:]))
