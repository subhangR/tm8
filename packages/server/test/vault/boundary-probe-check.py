"""Static checks on the agent-side boundary probe, deploy/vault/boundary-probe.py (review F03).

The probe must not run on this host or any other until the owner approves a staging run (owner
instruction, F03 code-only preparation). This only reads its source, from stdin: ast.parse, compile
(which builds a code object, drops it and runs none of it), symtable, and ast.literal_eval on
literal nodes. It never imports the probe, executes it, or calls anything the probe defines.

boundary-probe.test.ts runs this file with python3 -I, from an empty directory, under audit hooks
installed after these imports and before this file's code runs. The process ends at once if it
executes code from anywhere but this file and the standard library, constructs a function or code
object directly, starts a process, sends a signal, loads a library, opens a socket, removes or
changes a file, opens a file outside those two places, or opens any file for writing.

It pins the probe's reach: every stdlib name and the functions that may use it, the builtins, the
one writer to stdout and its guard, the one-byte read, the four commands, the metadata path,
PTRACE_SEIZE, the refusals before any check, and the 23 checks in the design's order. A change to
any of them fails the test until this file changes with it, so that change is reviewed too.

Output on stdout: one JSON object, {"checks": {name: [problem, ...]}, "facts": {...}}. An empty
list passes. The test compares the facts with the TypeScript constants they mirror. Whether a
module has a name is answered by the Python running this, not by the staging host's.
"""

import ast
import builtins
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
import symtable
import sys
import tempfile
import warnings

PROBE = 'deploy/vault/boundary-probe.py'
M = '<module>'

# The probe's imports, in its order, and the modules its attribute chains resolve against here.
IMPORTS = ('ctypes', 'errno', 'glob', 'grp', 'http.client', 'json', 'os', 're', 'shutil', 'socket', 'ssl',
           'stat', 'subprocess', 'sys', 'tempfile', 'warnings')
MODULES = {
    'ctypes': ctypes, 'errno': errno, 'glob': glob, 'grp': grp, 'http': http, 'json': json, 'os': os,
    're': re, 'shutil': shutil, 'socket': socket, 'ssl': ssl, 'stat': stat, 'subprocess': subprocess,
    'sys': sys, 'tempfile': tempfile, 'warnings': warnings,
}

# Every stdlib name the probe uses, and the functions that may use it (M: module level). This is
# the probe's whole reach into the OS: anything not listed (os.write, os.system, os.kill,
# subprocess.Popen, urllib, ...) fails, and so does a listed name used anywhere else.
MODULE_USES = {
    'ctypes.CDLL': ('ptrace_outcome',),
    'ctypes.c_long': ('ptrace_outcome',),
    'ctypes.c_void_p': ('ptrace_outcome',),
    'ctypes.get_errno': ('ptrace_outcome',),
    'errno.EACCES': (M, 'check_w1', 'ptrace_outcome'),
    'errno.ECONNREFUSED': ('check_h4', 'connect_unix'),
    'errno.ECONNRESET': ('tls_probe',),
    'errno.EHOSTUNREACH': ('check_h4',),
    'errno.ENETUNREACH': ('check_h4',),
    'errno.ENOENT': (M,),
    'errno.ENOTDIR': (M,),
    'errno.EPERM': (M, 'check_w1', 'ptrace_outcome'),
    'errno.EPIPE': ('tls_probe',),
    'errno.EROFS': ('check_w1',),
    'errno.ESRCH': (M, 'ptrace_outcome'),
    'errno.ETIMEDOUT': ('check_h4',),
    'errno.errorcode.get': ('error_name',),
    'errno.errorcode.values': (M,),
    'glob.glob': ('check_d2', 'check_h3'),
    'grp.getgrnam': ('check_i1',),
    'http.client.HTTPConnection': ('check_h4',),
    'http.client.HTTPException': ('check_h4',),
    'json.dumps': ('emit',),
    'json.loads': ('load_config',),
    'os.O_CLOEXEC': ('check_w1', 'read_one'),
    'os.O_CREAT': ('check_w1',),
    'os.O_EXCL': ('check_w1',),
    'os.O_NOCTTY': ('read_one',),
    'os.O_NOFOLLOW': ('check_w1',),
    'os.O_NONBLOCK': ('read_one',),
    'os.O_RDONLY': ('read_one',),
    'os.O_WRONLY': ('check_w1',),
    'os.SEEK_SET': ('read_one',),
    'os.WEXITSTATUS': ('ptrace_outcome',),
    'os.WIFEXITED': ('ptrace_outcome',),
    'os.W_OK': ('check_k3',),
    'os._exit': ('ptrace_outcome',),
    'os.access': ('check_k3',),
    'os.close': ('check_w1', 'read_one'),
    'os.fork': ('ptrace_outcome',),
    'os.getegid': ('check_i1',),
    'os.geteuid': ('check_i1', 'main'),
    'os.getgid': ('check_i1',),
    'os.getgroups': ('check_i1',),
    'os.getuid': ('check_i1', 'main'),
    'os.listdir': ('check_h1', 'check_p4', 'check_p5', 'check_p6'),
    'os.lseek': ('read_one',),
    'os.open': ('check_w1', 'read_one'),
    'os.path.dirname': ('check_k3',),
    'os.path.isabs': ('load_config',),
    'os.path.join': ('check_h2', 'check_n2', 'check_w1'),
    'os.read': ('read_one',),
    'os.scandir': ('tally_tree',),
    'os.stat': ('check_d2', 'check_p6'),
    'os.unlink': ('check_w1',),
    'os.urandom': ('check_w1',),
    'os.waitpid': ('ptrace_outcome',),
    're.compile': (M,),
    'shutil.rmtree': ('check_n2',),
    'socket.AF_UNIX': ('connect_unix',),
    'socket.SOCK_STREAM': ('connect_unix',),
    'socket.create_connection': ('tls_probe',),
    'socket.socket': ('connect_unix',),
    'socket.timeout': ('check_h4', 'connect_unix', 'error_name'),
    'ssl.CERT_NONE': ('tls_probe',),
    'ssl.PROTOCOL_TLS_CLIENT': ('tls_probe',),
    'ssl.SSLContext': ('tls_probe',),
    'ssl.SSLEOFError': ('tls_probe',),
    'ssl.SSLError': ('tls_probe',),
    'ssl.SSLZeroReturnError': ('tls_probe',),
    'ssl.TLSVersion.TLSv1_3': ('tls_probe',),
    'stat.S_ISSOCK': ('check_d2',),
    'subprocess.DEVNULL': ('run_quiet',),
    'subprocess.PIPE': ('run_quiet',),
    'subprocess.TimeoutExpired': ('run_quiet',),
    'subprocess.run': ('run_quiet',),
    'sys.argv': (M,),
    'sys.exit': (M,),
    'sys.flags.isolated': ('main',),
    'sys.stderr.flush': ('refuse',),
    'sys.stderr.write': ('refuse',),
    'sys.stdout.flush': ('emit', 'ptrace_outcome'),
    'sys.stdout.write': ('emit',),
    'tempfile.mkdtemp': ('check_n2',),
    'warnings.simplefilter': ('run',),
}

# The builtins the probe uses: no print, no exec or eval, no input, no vars or globals.
BUILTINS_USED = (
    'BaseException', 'Exception', 'KeyError', 'OSError', 'ValueError', '__name__', 'all', 'any', 'bin', 'bool',
    'dict', 'frozenset', 'getattr', 'int', 'isinstance', 'len', 'list', 'open', 'set', 'sorted', 'str', 'sum',
    'tuple',
)
# These may appear only as isinstance's second argument: no str() or dict() of anything.
TYPE_ONLY = ('bool', 'dict', 'str')

# Attribute names on objects that are not modules. No write, send, makefile, fileno or format.
OBJECT_ATTRIBUTES = (
    'add', 'append', 'argtypes', 'check_hostname', 'close', 'connect', 'count', 'counts', 'decode', 'errno',
    'fullmatch', 'get', 'getresponse', 'gr_gid', 'hex', 'is_dir', 'is_file', 'isdigit', 'items',
    'load_cert_chain', 'minimum_version', 'partition', 'path', 'ptrace', 'read', 'recv', 'request', 'restype',
    'returncode', 'sendall', 'settimeout', 'split', 'splitlines', 'st_mode', 'st_uid', 'startswith', 'status',
    'stdout', 'strip', 'targets', 'values', 'verdict', 'verify_mode', 'wrap_socket',
)
OBJECT_ATTRIBUTE_OWNERS = {
    'argtypes': ('ptrace_outcome',),
    'connect': ('check_h4', 'connect_unix'),
    'getresponse': ('check_h4',),
    'load_cert_chain': ('tls_probe',),
    'ptrace': ('ptrace_outcome',),
    'read': ('load_config', 'read_proc_text'),
    'recv': ('tls_probe',),
    'request': ('check_h4',),
    'restype': ('ptrace_outcome',),
    'sendall': ('tls_probe',),
    'stdout': ('run_quiet',),
    'wrap_socket': ('tls_probe',),
}

# Functions pinned whole (docstrings aside): the output, the reads, the commands, the sockets,
# the trace, and the error handler. Comments are not part of the comparison.
PINNED_FUNCTIONS = {
    'emit': r"""
def emit(check, result, detail):
    if check not in CHECK_IDS and check not in ('SUMMARY', 'CONTROL'):
        check, result, detail = 'SUMMARY', 'ERROR', 'DETAIL_REFUSED'
    if result not in RESULTS:
        result, detail = 'ERROR', 'DETAIL_REFUSED'
    if not isinstance(detail, str) or not (detail in ERROR_NAMES or COUNTS.fullmatch(detail)):
        result, detail = 'ERROR', 'DETAIL_REFUSED'
    sys.stdout.write(json.dumps({'check': check, 'result': result, 'detail': detail}, separators=(',', ':')) + '\n')
    sys.stdout.flush()
""",
    'refuse': r"""
def refuse(reason):
    sys.stderr.write(REFUSALS[reason] + '\n')
    sys.stderr.flush()
    return 3
""",
    'read_one': r"""
def read_one(path, offset=None):
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
""",
    'read_proc_text': r"""
def read_proc_text(path):
    if not path.startswith('/proc/'):
        raise ValueError('read_proc_text reads /proc only')
    try:
        with open(path, 'rb') as handle:
            data = handle.read(MAX_PROC_TEXT)
    except OSError as error:
        return outcome_of(error)
    return data.decode('ascii', 'replace')
""",
    'connect_unix': r"""
def connect_unix(path):
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
""",
    'run_quiet': r"""
def run_quiet(argv, count_json_entries=False):
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
""",
    'ptrace_outcome': r"""
def ptrace_outcome(pid):
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
""",
    'run': r"""
def run(argv):
    warnings.simplefilter('ignore')
    try:
        return main(argv)
    except BaseException:
        refuse('internal')
        return 4
""",
}

# main up to and including the checks loop: every refusal comes before any check runs, and an
# exception from a check is never printed.
MAIN_HEAD = r"""
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
            result, detail = 'ERROR', 'UNEXPECTED'
        emit(check_id, result, detail)
        results[check_id] = result
"""
PARSE_ARGS_TAIL = r"""
def parse_args(argv):
    if not staging or config is None:
        return None
    return (config, control)
"""
LOAD_CONFIG_HEAD = r"""
def load_config(path):
    if not os.path.isabs(path):
        return None
"""
MAIN_GUARD = r"""
if __name__ == '__main__':
    sys.exit(run(sys.argv[1:]))
"""
PINNED_ASSIGNMENTS = (
    r"ERROR_NAMES = frozenset(errno.errorcode.values()) | frozenset(EXTRA_ERROR_NAMES)",
    r"CHECK_IDS = tuple(check_id for check_id, _ in CHECKS)",
    r"RESULTS = ('PASS', 'FAIL', 'ERROR', 'NOT_RUN')",
    r"CONTROL_CHECKS = ('K1', 'P1', 'D1')",
    r"PTRACE_SEIZE = 0x4206",
    r"METADATA_HOST = '169.254.169.254'",
    r"METADATA_PATH = '/computeMetadata/v1/instance/service-accounts/default/email'",
)

# Calls that touch a file, a socket, a process or the network. Outside the pinned functions each
# one must be exactly one of these, in that function, and each of these must be there once.
SENSITIVE_CALLS = (
    'open', 'os.open', 'os.read', 'os.unlink', 'os.fork', 'os._exit', 'ctypes.CDLL', 'tempfile.mkdtemp',
    'shutil.rmtree', 'socket.socket', 'socket.create_connection', 'http.client.HTTPConnection', 'subprocess.run',
    'run_quiet', '.read', '.recv', '.sendall', '.request', '.ptrace', '.connect', '.load_cert_chain',
    '.wrap_socket',
)
PINNED_CALLS = (
    ('load_config', r"open(path, 'rb')"),
    ('load_config', r"handle.read(MAX_CONFIG_BYTES + 1)"),
    ('tls_probe', r"context.load_cert_chain(pair[0], pair[1])"),
    ('tls_probe', r"socket.create_connection((host, port), timeout=NET_TIMEOUT)"),
    ('tls_probe', r"context.wrap_socket(raw, server_hostname=None)"),
    ('tls_probe', r"tls.sendall(b'HEAD / HTTP/1.1\r\nHost: vault-broker\r\nConnection: close\r\n\r\n')"),
    ('tls_probe', r"tls.recv(1)"),
    ('check_h4', r"http.client.HTTPConnection(METADATA_HOST, 80, timeout=3)"),
    ('check_h4', r"connection.connect()"),
    ('check_h4', r"connection.request('GET', METADATA_PATH, headers={'Metadata-Flavor': 'Google'})"),
    ('check_w1', r"os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)"),
    ('check_w1', r"os.unlink(name)"),
    ('check_n2', r"tempfile.mkdtemp(prefix='tm8-boundary-probe-')"),
    ('check_n2', r"shutil.rmtree(workdir, ignore_errors=True)"),
    ('check_i3', r"run_quiet(['sudo', '-n', 'true'])"),
    ('check_h3', r"run_quiet(['journalctl', '--no-pager', '--quiet', '--output=json', '--lines=1'] + query, "
                 r"count_json_entries=True)"),
    ('check_d3', r"run_quiet(['docker', 'ps'])"),
    ('check_n2', r"run_quiet(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', "
                 r"'-nodes', '-subj', '/CN=tm8-boundary-probe', '-days', '1', '-keyout', key, '-out', cert])"),
)

# Design doc 01a1fe13, section 2, in its order. The doc calls it a 24-check probe; its table has 23.
DESIGN_CHECKS = ('I1', 'I2', 'I3', 'K1', 'K2', 'K3', 'K4', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6',
                 'H1', 'H2', 'H3', 'H4', 'D1', 'D2', 'D3', 'W1', 'N1', 'N2')
REFUSAL_KEYS = ('config', 'environment', 'internal', 'isolated', 'root', 'usage')

# The detail grammar emit() enforces, tried on its own regex.
COUNTS_ACCEPT = (
    'reachable=1', 'reachable=1 bytes=1', 'exit=0', 'signal=9', 'tls_bytes=0',
    'targets=3 denied=1 hidden=2 reachable=0 errors=0 removed=0', 'a=1 b=2 c=3 d=4 e=5 f=6 g=7 h=8',
    'k' + 'x' * 31 + '=1', 'n=' + '9' * 20,
)
COUNTS_REJECT = (
    '', 'reachable', 'reachable=', '=1', 'Reachable=1', 'KEY=1', 'key=abc', 'key=-1', 'key=1.5', 'key=0x10',
    'key=1 ', ' key=1', 'key=1  b=2', 'key=1\n', 'key=1\nb=2', 'a=1,b=2', 'a=1\tb=2', '/etc/shadow',
    'path=/etc/shadow', 'key=1 /etc/shadow', 'a=1 b=2 c=3 d=4 e=5 f=6 g=7 h=8 i=9', 'k' + 'x' * 32 + '=1',
    'n=' + '9' * 21, 'k' + chr(0xe9) + '=1', 'key=' + chr(0x663), 'key=1' + chr(0),
)
COUNTS_FORMAT = re.compile(r'[a-z][a-z0-9_]{0,31}=(?:%d|[0-9]{1,20})(?: [a-z][a-z0-9_]{0,31}=(?:%d|[0-9]{1,20})){0,7}')
VERDICT_EXTRA = re.compile(r'(?: [a-z][a-z0-9_]{0,31}=%d){1,3}')
TALLY_FORMAT = 'targets=%d denied=%d hidden=%d reachable=%d errors=%d%s'
PATH_FORMATS = ('/proc/%d/environ', '/proc/%d/fd', '/proc/%d/maps', '/proc/%d/mem')
CAPS = re.compile(r'[A-Z][A-Z0-9_]+')


class Probe:
    """The parsed source, and where each node sits. Nothing in it is executed."""

    def __init__(self, source):
        self.source = source
        self.tree = ast.parse(source, PROBE, feature_version=(3, 8))
        self.owner = {}
        self.parent = {}
        self.functions = {}
        for statement in self.tree.body:
            label = statement.name if isinstance(statement, (ast.FunctionDef, ast.ClassDef)) else M
            for node in ast.walk(statement):
                self.owner[node] = label
            if isinstance(statement, ast.FunctionDef):
                self.functions[statement.name] = statement
            if isinstance(statement, ast.ClassDef):
                for item in statement.body:
                    if isinstance(item, ast.FunctionDef):
                        for node in ast.walk(item):
                            self.owner[node] = statement.name + '.' + item.name
        for node in ast.walk(self.tree):
            for child in ast.iter_child_nodes(node):
                self.parent[child] = node
        self.docstrings = set()
        for node in [self.tree] + [n for n in ast.walk(self.tree) if isinstance(n, (ast.FunctionDef, ast.ClassDef))]:
            body = node.body
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
                self.docstrings.add(id(body[0].value))
        self.assignments = {}
        for statement in self.tree.body:
            if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
                self.assignments.setdefault(statement.targets[0].id, []).append(statement)

    def where(self, node):
        return '%s line %d' % (self.owner.get(node, M), getattr(node, 'lineno', 0))

    def literal(self, name):
        found = self.assignments.get(name, [])
        if len(found) != 1:
            raise LookupError('%s is assigned %d times at module level' % (name, len(found)))
        return ast.literal_eval(found[0].value)

    def nodes(self, kind):
        return [node for node in ast.walk(self.tree) if isinstance(node, kind)]


def dotted(node):
    """'a.b.c' for an attribute chain rooted at a name, else None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return '.'.join(reversed(parts))
    return None


def chain_root(node):
    while isinstance(node, ast.Attribute):
        node = node.value
    return node


def is_module_chain(node):
    root = chain_root(node)
    return isinstance(root, ast.Name) and root.id in MODULES


def outermost(probe, node):
    parent = probe.parent.get(node)
    return not (isinstance(parent, ast.Attribute) and parent.value is node)


def callee(call):
    func = call.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return dotted(func) if is_module_chain(func) else '.' + func.attr
    return None


def without_docstring(body):
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
        return body[1:]
    return body


def dump_all(statements):
    return [ast.dump(statement) for statement in statements]


def parsed_def(text):
    return ast.parse(text.strip() + '\n').body[0]


def expression(text):
    return ast.dump(ast.parse(text, mode='eval').body)


def check_parses(probe):
    compile(probe.source, PROBE, 'exec', dont_inherit=True)
    return []


def check_names(probe):
    problems = []
    table = symtable.symtable(probe.source, PROBE, 'exec')
    bound = set()
    for symbol in table.get_symbols():
        if symbol.is_assigned() or symbol.is_imported():
            bound.add(symbol.get_name())
    used = set()

    def walk(scope):
        for symbol in scope.get_symbols():
            name = symbol.get_name()
            if scope.get_type() != 'module':
                if name in MODULES and (symbol.is_local() or symbol.is_parameter()):
                    problems.append('%s shadows the module %s' % (scope.get_name(), name))
                if not symbol.is_global() or not symbol.is_referenced():
                    continue
            elif not symbol.is_referenced():
                continue
            if name not in bound:
                used.add(name)
        for child in scope.get_children():
            walk(child)

    walk(table)
    for name in sorted(used - set(BUILTINS_USED)):
        problems.append('%s is neither defined in the probe nor an allowed builtin' % name)
    for name in sorted(set(BUILTINS_USED) - used):
        problems.append('the allowed builtin %s is no longer used: update BUILTINS_USED' % name)
    for name in sorted(used & set(BUILTINS_USED)):
        if name != '__name__' and not hasattr(builtins, name):
            problems.append('%s is not a builtin of this Python' % name)
    for node in probe.nodes(ast.Name):
        if node.id in TYPE_ONLY and node.id not in bound:
            parent = probe.parent.get(node)
            ok = (isinstance(parent, ast.Call) and isinstance(parent.func, ast.Name) and parent.func.id == 'isinstance'
                  and len(parent.args) == 2 and parent.args[1] is node)
            if not ok:
                problems.append('%s used other than as isinstance\'s type at %s' % (node.id, probe.where(node)))
    for node in probe.nodes(ast.Call):
        if isinstance(node.func, ast.Name) and node.func.id == 'getattr':
            literal = len(node.args) >= 2 and isinstance(node.args[1], ast.Constant) and isinstance(node.args[1].value, str)
            if not literal:
                problems.append('getattr without a literal name at %s' % probe.where(node))
    return problems


def check_imports(probe):
    problems = []
    found = []
    for statement in probe.tree.body:
        if isinstance(statement, ast.Import):
            for alias in statement.names:
                if alias.asname is not None:
                    problems.append('import %s as %s' % (alias.name, alias.asname))
                found.append(alias.name)
    if tuple(found) != IMPORTS:
        problems.append('imports are %s, not %s' % (found, list(IMPORTS)))
    top = set(id(statement) for statement in probe.tree.body)
    for node in ast.walk(probe.tree):
        if isinstance(node, ast.ImportFrom):
            problems.append('from-import at %s' % probe.where(node))
        elif isinstance(node, ast.Import) and id(node) not in top:
            problems.append('import inside a function at %s' % probe.where(node))
    return problems


def resolves(name):
    parts = name.split('.')
    value = MODULES[parts[0]]
    for part in parts[1:]:
        if not hasattr(value, part):
            return False
        value = getattr(value, part)
    return True


def check_module_attributes(probe):
    problems = []
    seen = {}
    for node in probe.nodes(ast.Name):
        if node.id in MODULES:
            parent = probe.parent.get(node)
            if not (isinstance(parent, ast.Attribute) and parent.value is node):
                problems.append('the module %s is used bare at %s' % (node.id, probe.where(node)))
    for node in probe.nodes(ast.Attribute):
        if not is_module_chain(node) or not outermost(probe, node):
            continue
        name = dotted(node)
        owner = probe.owner.get(node, M)
        seen.setdefault(name, set()).add(owner)
        if not isinstance(node.ctx, ast.Load):
            problems.append('%s is assigned or deleted at %s' % (name, probe.where(node)))
        if name not in MODULE_USES:
            problems.append('%s is not an allowed stdlib name (%s)' % (name, probe.where(node)))
        elif owner not in MODULE_USES[name]:
            problems.append('%s is not allowed in %s (line %d)' % (name, owner, node.lineno))
        if not resolves(name):
            problems.append('%s does not exist (%s)' % (name, probe.where(node)))
    for name, owners in sorted(MODULE_USES.items()):
        unused = set(owners) - seen.get(name, set())
        if unused:
            problems.append('%s is allowed in %s but not used there: update MODULE_USES' % (name, sorted(unused)))
    return problems


def check_object_attributes(probe):
    problems = []
    seen = set()
    for node in probe.nodes(ast.Attribute):
        if is_module_chain(node):
            continue
        seen.add(node.attr)
        owner = probe.owner.get(node, M)
        if node.attr not in OBJECT_ATTRIBUTES:
            problems.append('.%s is not an allowed attribute (%s)' % (node.attr, probe.where(node)))
        elif node.attr in OBJECT_ATTRIBUTE_OWNERS and owner not in OBJECT_ATTRIBUTE_OWNERS[node.attr]:
            problems.append('.%s is not allowed in %s (line %d)' % (node.attr, owner, node.lineno))
    for name in sorted(set(OBJECT_ATTRIBUTES) - seen):
        problems.append('.%s is allowed but not used: update OBJECT_ATTRIBUTES' % name)
    return problems


def check_pinned_functions(probe):
    problems = []
    for name, text in sorted(PINNED_FUNCTIONS.items()):
        node = probe.functions.get(name)
        expected = parsed_def(text)
        if node is None:
            problems.append('%s is missing' % name)
            continue
        if ast.dump(node.args) != ast.dump(expected.args) or node.decorator_list or node.returns is not None:
            problems.append('%s has a different signature' % name)
        if dump_all(without_docstring(node.body)) != dump_all(expected.body):
            problems.append('%s differs from its pinned body' % name)
    main = probe.functions.get('main')
    expected = parsed_def(MAIN_HEAD)
    if main is None or dump_all(without_docstring(main.body)[:len(expected.body)]) != dump_all(expected.body):
        problems.append('main does not begin with the pinned refusals and checks loop')
    parse_args = probe.functions.get('parse_args')
    tail = parsed_def(PARSE_ARGS_TAIL).body
    if parse_args is None or dump_all(parse_args.body[-len(tail):]) != dump_all(tail):
        problems.append('parse_args does not end by refusing without --staging-run and --config')
    load_config = probe.functions.get('load_config')
    head = parsed_def(LOAD_CONFIG_HEAD).body
    if load_config is None or dump_all(without_docstring(load_config.body)[:len(head)]) != dump_all(head):
        problems.append('load_config does not begin by refusing a relative path')
    if ast.dump(probe.tree.body[-1]) != ast.dump(parsed_def(MAIN_GUARD)):
        problems.append('the last statement is not the pinned main guard')
    for text in PINNED_ASSIGNMENTS:
        expected = ast.parse(text).body[0]
        found = probe.assignments.get(expected.targets[0].id, [])
        if [ast.dump(statement) for statement in found] != [ast.dump(expected)]:
            problems.append('%s is not assigned once as pinned' % expected.targets[0].id)
    return problems


def check_pinned_calls(probe):
    problems = []
    expected = {}
    for owner, text in PINNED_CALLS:
        key = (owner, expression(text))
        expected[key] = expected.get(key, 0) + 1
    found = {}
    for node in probe.nodes(ast.Call):
        name = callee(node)
        owner = probe.owner.get(node, M)
        if name not in SENSITIVE_CALLS or owner in PINNED_FUNCTIONS:
            continue
        key = (owner, ast.dump(node))
        if key not in expected:
            problems.append('%s call at %s is not one of the pinned calls' % (name, probe.where(node)))
        found[key] = found.get(key, 0) + 1
    for key, count in expected.items():
        if found.get(key, 0) != count:
            problems.append('a pinned call in %s is there %d times, not %d' % (key[0], found.get(key, 0), count))
    return problems


def check_counts(probe):
    problems = []
    found = probe.assignments.get('COUNTS', [])
    if len(found) != 1:
        return ['COUNTS is assigned %d times' % len(found)]
    value = found[0].value
    if not (isinstance(value, ast.Call) and dotted(value.func) == 're.compile' and len(value.args) == 1
            and not value.keywords and isinstance(value.args[0], ast.Constant) and isinstance(value.args[0].value, str)):
        return ['COUNTS is not re.compile of one literal pattern']
    pattern = re.compile(value.args[0].value)
    for sample in COUNTS_ACCEPT:
        if pattern.fullmatch(sample) is None:
            problems.append('COUNTS refuses %r' % sample)
    for sample in COUNTS_REJECT:
        if pattern.fullmatch(sample) is not None:
            problems.append('COUNTS accepts %r' % sample)
    return problems


def check_detail_formats(probe):
    problems = []
    extras = set()
    for node in probe.nodes(ast.Call):
        if isinstance(node.func, ast.Attribute) and node.func.attr == 'verdict':
            if node.keywords or len(node.args) > 1:
                problems.append('verdict takes at most one argument (%s)' % probe.where(node))
            elif node.args:
                arg = node.args[0]
                ok = (isinstance(arg, ast.BinOp) and isinstance(arg.op, ast.Mod) and isinstance(arg.left, ast.Constant)
                      and isinstance(arg.left.value, str) and VERDICT_EXTRA.fullmatch(arg.left.value) is not None)
                if ok:
                    extras.add(id(arg.left))
                else:
                    problems.append('a verdict extra is not up to three " key=%%d" pairs (%s)' % probe.where(node))
    for node in probe.nodes(ast.Constant):
        if not isinstance(node.value, str) or '%' not in node.value or id(node) in extras or id(node) in probe.docstrings:
            continue
        owner = probe.owner.get(node, M)
        value = node.value
        if value in PATH_FORMATS:
            continue
        if value == '_UID=%d' and owner == 'check_h3':
            continue
        if value == TALLY_FORMAT and owner == 'Tally.verdict':
            continue
        if COUNTS_FORMAT.fullmatch(value) is None:
            problems.append('%r is not a counts format (%s)' % (value, probe.where(node)))
    for node in probe.nodes(ast.JoinedStr):
        problems.append('an f-string at %s' % probe.where(node))
    return problems


def check_error_names(probe):
    problems = []
    found = probe.assignments.get('EXTRA_ERROR_NAMES', [])
    if len(found) != 1:
        return ['EXTRA_ERROR_NAMES is assigned %d times' % len(found)]
    value = found[0].value
    if not (isinstance(value, ast.BinOp) and isinstance(value.op, ast.Add) and isinstance(value.right, ast.Name)
            and value.right.id == 'REFUSAL_ALERTS'):
        return ['EXTRA_ERROR_NAMES is not a literal tuple + REFUSAL_ALERTS']
    extra = tuple(ast.literal_eval(value.left)) + tuple(probe.literal('REFUSAL_ALERTS'))
    for name in extra:
        if not isinstance(name, str) or CAPS.fullmatch(name) is None:
            problems.append('%r is not an upper-case error name' % (name,))
    allowed = (set(DESIGN_CHECKS) | set(probe.literal('RESULTS')) | {'SUMMARY', 'CONTROL', 'GET'} | set(extra)
               | set(errno.errorcode.values()))
    for node in probe.nodes(ast.Constant):
        if isinstance(node.value, str) and CAPS.fullmatch(node.value) and node.value not in allowed:
            problems.append('%r is not a check id, result or error name (%s)' % (node.value, probe.where(node)))
    return problems


def check_reads(probe):
    problems = []
    for name, limit in (('MAX_PROC_TEXT', 1 << 20), ('MAX_CONFIG_BYTES', 1 << 16)):
        value = probe.literal(name)
        if not isinstance(value, int) or isinstance(value, bool) or not 0 < value <= limit:
            problems.append('%s is %r, not a positive int up to %d' % (name, value, limit))
    for node in probe.nodes(ast.Call):
        if callee(node) == 'open' and probe.owner.get(node) not in ('load_config', 'read_proc_text'):
            problems.append('open at %s' % probe.where(node))
    return problems


def check_metadata(probe):
    problems = []
    for number, line in enumerate(probe.source.splitlines(), 1):
        if 'token' in line.lower():
            problems.append('the word token is on line %d' % number)
    code = [node for node in probe.nodes(ast.Constant) if id(node) not in probe.docstrings]
    for text, name in (('169.254.169.254', 'METADATA_HOST'), ('computeMetadata', 'METADATA_PATH')):
        holders = [node for node in code if isinstance(node.value, (str, bytes)) and text in str(node.value)]
        expected = probe.assignments.get(name, [None])[0]
        if len(holders) != 1 or expected is None or holders[0] is not expected.value:
            problems.append('%s is in %d constants, not only in %s' % (text, len(holders), name))
    if not probe.literal('METADATA_PATH').endswith('/service-accounts/default/email'):
        problems.append('METADATA_PATH is not the email path')
    return problems


def check_ptrace(probe):
    problems = []
    if probe.literal('PTRACE_SEIZE') != 0x4206:
        problems.append('PTRACE_SEIZE is not 0x4206')
    for node in probe.nodes(ast.Name):
        if node.id.startswith('PTRACE_') and node.id != 'PTRACE_SEIZE':
            problems.append('%s at %s' % (node.id, probe.where(node)))
    calls = [node for node in probe.nodes(ast.Call) if callee(node) == '.ptrace']
    if len(calls) != 1 or not (isinstance(calls[0].args[0], ast.Name) and calls[0].args[0].id == 'PTRACE_SEIZE'):
        problems.append('ptrace is not called once, with PTRACE_SEIZE')
    return problems


def check_checks_table(probe):
    problems = []
    found = probe.assignments.get('CHECKS', [])
    if len(found) != 1 or not isinstance(found[0].value, ast.Tuple):
        return ['CHECKS is not one literal tuple']
    ids = []
    listed = []
    for item in found[0].value.elts:
        if not (isinstance(item, ast.Tuple) and len(item.elts) == 2 and isinstance(item.elts[0], ast.Constant)
                and isinstance(item.elts[1], ast.Name)):
            problems.append('a CHECKS entry is not (id, function) at line %d' % item.lineno)
            continue
        check_id, function = item.elts[0].value, item.elts[1].id
        ids.append(check_id)
        listed.append(function)
        if function != 'check_' + str(check_id).lower() or function not in probe.functions:
            problems.append('%s runs %s' % (check_id, function))
    if tuple(ids) != DESIGN_CHECKS:
        problems.append('CHECKS lists %s, not the design order' % ids)
    defined = sorted(name for name in probe.functions if name.startswith('check_'))
    if sorted(listed) != defined:
        problems.append('check functions %s, CHECKS lists %s' % (defined, sorted(listed)))
    return problems


INERT = (ast.Constant, ast.Tuple, ast.Dict, ast.Name, ast.BinOp, ast.Load, ast.Store, ast.operator, ast.Call,
         ast.Attribute, ast.GeneratorExp, ast.comprehension, ast.keyword)
INERT_CALLS = ('re.compile', 'frozenset', 'tuple', 'errno.errorcode.values')
FORBIDDEN_NODES = (ast.Global, ast.Nonlocal, ast.Lambda, ast.Yield, ast.YieldFrom, ast.Await, ast.AsyncFunctionDef,
                   ast.AsyncFor, ast.AsyncWith, ast.NamedExpr, ast.Delete, ast.Starred)


def check_top_level(probe):
    problems = []
    body = probe.tree.body
    if not (isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str)):
        problems.append('the module does not start with its docstring')
    names = {}
    for statement in body[1:-1]:
        if isinstance(statement, ast.Import):
            bound = [alias.name.split('.')[0] for alias in statement.names]
        elif isinstance(statement, (ast.FunctionDef, ast.ClassDef)):
            bound = [statement.name]
        elif isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
            bound = [statement.targets[0].id]
            for node in ast.walk(statement.value):
                if not isinstance(node, INERT):
                    problems.append('%s at module level (line %d)' % (type(node).__name__, statement.lineno))
                elif isinstance(node, ast.Call) and dotted(node.func) not in INERT_CALLS:
                    problems.append('a call at module level (line %d)' % statement.lineno)
        else:
            problems.append('%s at module level (line %d)' % (type(statement).__name__, statement.lineno))
            continue
        for name in bound:
            names[name] = names.get(name, 0) + 1
    for name, count in sorted(names.items()):
        if count != 1:
            problems.append('%s is bound %d times at module level' % (name, count))
    for node in ast.walk(probe.tree):
        if isinstance(node, FORBIDDEN_NODES):
            problems.append('%s at %s' % (type(node).__name__, probe.where(node)))
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.decorator_list:
            problems.append('a decorator on %s' % node.name)
        if isinstance(node, ast.FunctionDef):
            arguments = node.args
            for default in list(arguments.defaults) + [d for d in arguments.kw_defaults if d is not None]:
                if not isinstance(default, ast.Constant):
                    problems.append('a computed default in %s' % node.name)
            annotated = [a for a in arguments.args + arguments.kwonlyargs if a.annotation is not None]
            if annotated or node.returns is not None or arguments.vararg or arguments.kwarg:
                problems.append('%s has annotations or variadic arguments' % node.name)
        if isinstance(node, ast.ClassDef):
            if node.bases or node.keywords or any(not isinstance(item, ast.FunctionDef) for item in without_docstring(node.body)):
                problems.append('the class %s is not plain methods' % node.name)
        if isinstance(node, (ast.Subscript, ast.Attribute)) and isinstance(node.ctx, (ast.Store, ast.Del)):
            root = chain_root(node.value)
            if isinstance(root, ast.Name) and root.id in names:
                problems.append('module state %s changed at %s' % (root.id, probe.where(node)))
    return problems


def check_refusals(probe):
    problems = []
    refusals = probe.literal('REFUSALS')
    if tuple(sorted(refusals)) != REFUSAL_KEYS:
        problems.append('REFUSALS has %s' % sorted(refusals))
    for key, message in refusals.items():
        if not message.startswith('boundary probe: ') or '%' in message or '{' in message:
            problems.append('the %s refusal is not a fixed message' % key)
    for node in probe.nodes(ast.Call):
        if callee(node) == 'refuse':
            ok = (len(node.args) == 1 and isinstance(node.args[0], ast.Constant) and node.args[0].value in refusals)
            if not ok:
                problems.append('refuse without a literal REFUSALS key at %s' % probe.where(node))
    schema = probe.literal('SCHEMA')
    doc = ast.get_docstring(probe.tree) or ''
    config = doc.split('\nCONFIG', 1)[-1].split('\nOUTPUT', 1)[0]
    for key in schema:
        if re.search(r'\b%s\b' % re.escape(key), config) is None:
            problems.append('the CONFIG section does not document %s' % key)
    return problems


def check_positive_control(probe):
    problems = []
    doc = ast.get_docstring(probe.tree) or ''
    for text in ('DO NOT RUN THIS ON ANY HOST BUT A STAGING HOST, AND ONLY IN A RUN THE OWNER HAS APPROVED.',
                 'packages/server/test/vault/boundary-probe.test.ts', '\nPOSITIVE CONTROL',
                 'K1, P1 and D1 must each report FAIL', '\nWHAT A PASS MEANS', '\nSIDE EFFECTS', '\nNOT COVERED'):
        if text not in doc:
            problems.append('the docstring lacks %r' % text)
    if tuple(probe.literal('CONTROL_CHECKS')) != ('K1', 'P1', 'D1'):
        problems.append('CONTROL_CHECKS is not K1, P1, D1')
    return problems


CHECKERS = (
    ('parses', check_parses), ('names', check_names), ('imports', check_imports),
    ('module_attributes', check_module_attributes), ('object_attributes', check_object_attributes),
    ('pinned_functions', check_pinned_functions), ('pinned_calls', check_pinned_calls), ('counts', check_counts),
    ('detail_formats', check_detail_formats), ('error_names', check_error_names), ('reads', check_reads),
    ('metadata', check_metadata), ('ptrace', check_ptrace), ('checks_table', check_checks_table),
    ('top_level', check_top_level), ('refusals', check_refusals), ('positive_control', check_positive_control),
)


def facts_of(probe):
    facts = {}
    for key, name in (('forbidden_groups', 'FORBIDDEN_GROUPS'), ('default_vault_sockets', 'DEFAULT_VAULT_SOCKETS'),
                      ('docker_sockets', 'DOCKER_SOCKETS'), ('container_sockets', 'CONTAINER_SOCKETS'),
                      ('control_checks', 'CONTROL_CHECKS'), ('metadata_path', 'METADATA_PATH'),
                      ('ptrace_seize', 'PTRACE_SEIZE')):
        try:
            value = probe.literal(name)
            facts[key] = list(value) if isinstance(value, tuple) else value
        except (LookupError, ValueError):
            facts[key] = None
    checks = probe.assignments.get('CHECKS', [])
    try:
        facts['check_ids'] = [item.elts[0].value for item in checks[0].value.elts]
    except (IndexError, AttributeError):
        facts['check_ids'] = None
    return facts


def main():
    source = sys.stdin.buffer.read().decode('utf-8')
    try:
        probe = Probe(source)
    except SyntaxError as error:
        print(json.dumps({'checks': {'parses': ['SyntaxError at line %s' % error.lineno]}, 'facts': {}}))
        return 0
    checks = {}
    for name, checker in CHECKERS:
        try:
            checks[name] = checker(probe)
        except Exception as error:  # a probe shape this checker did not foresee: a failure, never a pass
            checks[name] = ['checker error: %s: %s' % (type(error).__name__, error)]
    print(json.dumps({'checks': checks, 'facts': facts_of(probe)}, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
