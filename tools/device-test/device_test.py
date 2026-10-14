#!/usr/bin/env python3
"""
device-test: real-screen tests for tm8 on web, Android and iOS, driven by callstack's agent-device.

Each run drives one screen and records itself as a `c:test_run` entity with its screenshots
attached, so a test is a thing in the graph that a person or an agent can open, not a line in
a log.

  web      Chromium (Chrome for Testing 156) in a gVisor sandbox on this host, driven by
           agent-device's web backend (agent-browser). A profile sets the viewport and user
           agent: `iphone` and `pixel` are Chromium at that size, not the phone.
  android  a real emulator or simulator in a device cloud (Limrun), or behind an agent-device
  ios      proxy on a Mac or a KVM host. This host can run neither: it is a Hyper-V guest
           without /dev/kvm, and iOS Simulators need macOS. Without a provider credential the
           run is recorded as `blocked`, with that evidence, instead of being faked.

Stdlib only and self-contained: the engine Dockerfile, the built-in checks and the seccomp
profile are embedded, because tm8 stores a tool as this one file and runs it with `python3 -I`.

  python3 -I tools/device-test/device_test.py --target https://tm8-hub.com/ \\
      --expect-text "one live graph" --profiles desktop,iphone,pixel --task <task-id>

Exit status: 0 passed, 1 failed, 2 error (the harness failed, not the product), 3 blocked,
64 bad arguments. A batch exits with its worst result.
"""
import argparse
import datetime
import hashlib
import ipaddress
import json
import os
import pathlib
import platform as host_platform
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
from dataclasses import dataclass, field

EXIT_CODES = {'passed': 0, 'failed': 1, 'error': 2, 'blocked': 3}
EXIT_USAGE = 64
# Worst last: a harness error says nothing about the product, so it outranks every verdict.
SEVERITY = ['passed', 'blocked', 'failed', 'error']

AGENT_DEVICE_VERSION = '0.21.27'
AGENT_BROWSER_VERSION = '0.27.1'
BROWSER = 'Chrome for Testing 156.0.8078.4'
ENGINE = f'agent-device {AGENT_DEVICE_VERSION} · agent-browser {AGENT_BROWSER_VERSION} · {BROWSER}'
MOBILE_ENGINE = f'agent-device {AGENT_DEVICE_VERSION}'

ENGINE_DOCKERFILE = r'''# tm8 device-test engine: agent-device (callstack) driving Chromium through agent-browser
# (vercel-labs), on the official Playwright image for its browsers and system libraries.
# Every input is pinned: the base by digest, both npm tarballs by the sha512 of the bytes
# that were reviewed, and no package install script runs (--ignore-scripts).
# Run Chromium with the seccomp profile device_test.py derives: on a host whose CPU advertises
# memory protection keys that its hypervisor does not honour (this one), Chrome 156 crashes.
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
ARG AGENT_DEVICE_VERSION=0.21.27
ARG AGENT_DEVICE_SHA512=73ed8d56ef90abda8f68b658c07ae9e2862ef1f193a13d5cb66b6504f062d1ddbec27cbd5724f1db0cec9945271a7aea7f6059df4688be512b50be0b63c4fe18
# The version agent-device ${AGENT_DEVICE_VERSION} pins for its managed web backend.
ARG AGENT_BROWSER_VERSION=0.27.1
ARG AGENT_BROWSER_SHA512=94bce958357b9e556c039926ef23021f5c29a6f9cb2cdc75eb484bc0b7435240acb7dc77f14861c688939a6276aab78e9c26bf1e9e3f1a6e807646a186d6fa1e
ENV AGENT_DEVICE_STATE_DIR=/opt/agent-device \
    AGENT_DEVICE_NO_UPDATE_NOTIFIER=1 \
    AGENT_BROWSER_EXECUTABLE_PATH=/ms-playwright/chromium-1248/chrome-linux64/chrome \
    AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage,--disable-gpu \
    NPM_CONFIG_UPDATE_NOTIFIER=false
# adb: agent-device reaches a remote Android device (Limrun) through a local adb client.
# zip: agent-device packages an iOS .app with it before a remote install.
RUN apt-get update && apt-get install -y --no-install-recommends adb zip && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/pkgs
RUN npm pack --silent agent-device@${AGENT_DEVICE_VERSION} agent-browser@${AGENT_BROWSER_VERSION} \
 && echo "${AGENT_DEVICE_SHA512}  agent-device-${AGENT_DEVICE_VERSION}.tgz" | sha512sum -c - \
 && echo "${AGENT_BROWSER_SHA512}  agent-browser-${AGENT_BROWSER_VERSION}.tgz" | sha512sum -c - \
 && npm install -g --ignore-scripts --no-audit --no-fund ./agent-device-${AGENT_DEVICE_VERSION}.tgz \
 && grep -q "\`${AGENT_BROWSER_VERSION}\`" /usr/lib/node_modules/agent-device/dist/src/agent-browser-tool.js \
 && dir=${AGENT_DEVICE_STATE_DIR}/tools/agent-browser/${AGENT_BROWSER_VERSION} \
 && npm install --prefix $dir/package --no-global --ignore-scripts --no-audit --no-fund --no-save ./agent-browser-${AGENT_BROWSER_VERSION}.tgz \
 && printf '{"package":"agent-browser","version":"%s","node":"%s","installedAt":"%s"}\n' \
      "${AGENT_BROWSER_VERSION}" "$(node --version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > $dir/manifest.json \
 && chmod -R a+rwX ${AGENT_DEVICE_STATE_DIR} \
 && cd / && rm -rf /tmp/pkgs
WORKDIR /work
'''
IMAGE = 'tm8-device-test-engine:' + hashlib.sha256(ENGINE_DOCKERFILE.encode()).hexdigest()[:12]
RUNNER_SHA = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()

# Chromium runs with --no-sandbox, because its own sandbox needs privileges the container does not
# have, so the container is the boundary. gVisor gives it a kernel of its own: a browser exploit
# from an untrusted page meets gVisor, not this host's kernel, and Chrome needs no seccomp change.
# Docker's --network host gives a gVisor container no network at all on the tm8 host (ENETUNREACH,
# loopback included), so a run that must reach this machine uses runc.
SANDBOXES = {'gvisor': 'runsc', 'runc': 'runc'}
SANDBOX_NAMES = {'gvisor': 'gVisor sandbox', 'runc': 'runc container'}


@dataclass(frozen=True)
class Profile:
    name: str
    width: int
    height: int
    device: str
    user_agent: str = ''


PROFILES = {p.name: p for p in [
    Profile('desktop', 1280, 900, f'{BROWSER}, desktop'),
    Profile('iphone', 390, 844, f'{BROWSER} at iPhone size with a Safari user agent (emulated, not iOS)',
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
            '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'),
    Profile('pixel', 412, 915, f'{BROWSER} at Pixel size with an Android user agent (emulated, not Android)',
            'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 '
            '(KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36'),
]}
DEVICES = {'limrun': {'android': 'Limrun Android emulator (remote)', 'ios': 'Limrun iOS simulator (remote)'},
           'proxy': {'android': 'Android device behind an agent-device proxy',
                     'ios': 'iOS device or simulator behind an agent-device proxy'}}
PROVIDER_NAMES = {'none': 'no device', 'limrun': 'Limrun', 'proxy': 'agent-device proxy'}

# The container scripts are fixed text: every value reaches them as an argument or a named
# environment variable, never by interpolation into shell code.
WEB_SCRIPT = r'''set -u
spec=$1 session=$2; shift 2
exec agent-device replay "$spec" --platform web --session "$session" --json "$@" > /out/replay.json 2> /out/replay.log
'''
# Every command names one session: without --session, connect makes a fresh remote session, and a
# command under any other name looks for devices inside this container. connect only saves the
# connection, and a replay cannot lease a device, so `open` takes the lease first: that is where
# the provider is first reached, and where an unreachable or refusing provider shows.
# A replay that diverges closes its session; `disconnect` then releases the provider. If the
# container is killed first, the provider ends the idle lease itself: keep-alive stays off.
MOBILE_SCRIPT = r'''set -u
platform=$1 provider=$2 spec=$3 session=$4; shift 4
if [ "$provider" = proxy ]; then
  agent-device connect proxy --daemon-base-url "$DEVICE_TEST_PROXY_URL" --session "$session" --json > /out/connect.json 2> /out/connect.log
else
  agent-device connect limrun --platform "$platform" --session "$session" --json > /out/connect.json 2> /out/connect.log
fi
[ $? -eq 0 ] || exit 90
if agent-device open --platform "$platform" --session "$session" --json > /out/lease.json 2> /out/lease.log; then
  agent-device replay "$spec" --platform "$platform" --session "$session" --json "$@" > /out/replay.json 2> /out/replay.log
  rc=$?
else
  rc=91
fi
agent-device disconnect --session "$session" --json > /out/disconnect.json 2>&1
exit $rc
'''
# The exit codes of MOBILE_SCRIPT's provider steps: the step, its output file and what a failure means.
PROVIDER_STEPS = {90: ('connect', 'connect', 'The device provider refused the connection'),
                  91: ('open (the device lease)', 'lease', 'The device provider did not lease a device')}
LIMRUN_INSTANCE_ENV = {'android': ['LIM_ANDROID_INSTANCE_URL', 'LIM_ANDROID_INSTANCE_TOKEN', 'LIM_ANDROID_INSTANCE_ADB_URL'],
                       'ios': ['LIM_IOS_INSTANCE_URL', 'LIM_IOS_INSTANCE_TOKEN']}
PROXY_TOKEN_ENV = 'AGENT_DEVICE_DAEMON_AUTH_TOKEN'


def env_default(name, fallback=''):
    """tm8 runs a tool with no arguments and its inputs in the environment."""
    value = os.environ.get(name, '')
    return value if value != '' else fallback


def env_bool(name, fallback):
    value = os.environ.get(name, '').strip().lower()
    return fallback if value == '' else value in ('1', 'true', 'yes', 'on')


def iso_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


# ---------------------------------------------------------------------------------------- checks

def check_text(name, value):
    """Text reaches agent-device as a replay variable; keep it to one printable line."""
    if re.search(r'[\x00-\x1f\x7f]', value) or '${' in value:
        raise ValueError(f'{name} must be one line of printable text without "${{"')
    return value


def web_spec(expect_text):
    """Load, screenshot, then assert: a failed assertion keeps the screenshot it failed on."""
    lines = ['context timeout=90000', 'open "${TARGET_URL}"', 'viewport ${VIEWPORT_W} ${VIEWPORT_H}', 'wait 1500',
             'screenshot "${OUT}/01-loaded.png"']
    if expect_text:
        lines.append('wait text "${EXPECT_TEXT}" 20000')
    lines += ['screenshot "${OUT}/02-full-page.png" --fullscreen', 'close']
    return '\n'.join(lines) + '\n'


def mobile_spec(expect_text):
    """Opens the URL in the device's own browser: Chrome on Android, Safari on iOS."""
    lines = ['context timeout=240000', 'open "${TARGET_URL}"', 'wait 3000', 'screenshot "${OUT}/01-loaded.png"']
    if expect_text:
        lines += ['wait text "${EXPECT_TEXT}" 45000', 'screenshot "${OUT}/02-checked.png"']
    lines.append('close')
    return '\n'.join(lines) + '\n'


def count_steps(spec):
    """Replay numbers every command line from 1; `context` headers and comments are not steps."""
    return sum(1 for line in spec.splitlines()
               if line.strip() and not line.lstrip().startswith(('#', 'context ')))


def is_loopback(host):
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host == 'localhost'


def check_target(target, platform, has_suite):
    """A URL, or (for a suite that drives a native app) the app id the suite opens."""
    parsed = urllib.parse.urlsplit(target)
    if parsed.scheme in ('http', 'https') and parsed.hostname:
        return parsed.hostname
    if platform != 'web' and has_suite and re.fullmatch(r'[A-Za-z0-9._-]{1,200}', target):
        return target
    raise ValueError('--target must be an http(s) URL with a host'
                     + ('' if platform == 'web' else ', or the app id a --suite opens'))


def allowed_domains(target_host, extra):
    """agent-browser refuses navigation, sub-resources and websockets outside this list."""
    try:
        ipaddress.ip_address(target_host)
        domains = [target_host]
    except ValueError:
        domains = [target_host] if target_host == 'localhost' else [target_host, f'*.{target_host}']
    for item in extra:
        item = item.strip().lower()
        if not item:
            continue
        if not re.fullmatch(r'(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*', item):
            raise ValueError(f'--allow-domains entry is not a domain or *.domain: {item}')
        if item not in domains:
            domains.append(item)
    return domains


def check_mount(name, path):
    """A host path bound into the container; `-v` splits on ':' so it cannot carry one."""
    real = os.path.realpath(path)
    if not os.path.exists(real):
        raise ValueError(f'{name} does not exist: {path}')
    if re.search(r'[:,\x00-\x1f]', real):
        raise ValueError(f'{name} path cannot contain ":" "," or control characters: {real}')
    return real


def chrome_seccomp_profile():
    """Docker's default profile with one change: pkey_alloc answers ENOSPC ("no keys left").

    This host's CPU advertises memory protection keys (pku, ospke) but faults on them under
    Hyper-V, so every Chrome 156 child process dies of protection-key page faults (error code
    bit 5). When pkey_alloc fails, Chrome and V8 run without keys, as on a CPU that has none.
    Every other syscall keeps Docker's own answer.
    """
    profile = json.loads(DOCKER_DEFAULT_SECCOMP)
    allowed = [rule for rule in profile['syscalls'] if rule['action'] == 'SCMP_ACT_ALLOW' and 'pkey_alloc' in rule['names']]
    if len(allowed) != 1 or set(allowed[0]) != {'names', 'action'}:
        raise RuntimeError('embedded seccomp profile changed shape: pkey_alloc must sit in one unconditional allow rule')
    allowed[0]['names'] = [name for name in allowed[0]['names'] if name != 'pkey_alloc']
    profile['syscalls'].append({'names': ['pkey_alloc'], 'action': 'SCMP_ACT_ERRNO', 'errnoRet': 28})
    return profile


# ---------------------------------------------------------------------------------------- devices

# systemd-detect-virt names a hypervisor by its vendor.
GUEST_NAMES = {'microsoft': 'Hyper-V', 'oracle': 'VirtualBox'}


def local_device_facts():
    """What this host could offer a local emulator or simulator: evidence for a blocked run."""
    facts = ['/dev/kvm present' if os.path.exists('/dev/kvm') else '/dev/kvm absent']
    try:
        with open('/proc/cpuinfo') as cpuinfo:
            flags = next((line.split(':', 1)[1].split() for line in cpuinfo if line.startswith('flags')), [])
        virt = [flag for flag in ('vmx', 'svm') if flag in flags]
        facts.append(f'CPU virtualization flags: {", ".join(virt)}' if virt else 'no vmx or svm CPU flag')
    except OSError:
        pass
    detect = shutil.which('systemd-detect-virt')
    if detect:
        guest = subprocess.run([detect], capture_output=True, text=True, timeout=10).stdout.strip()
        if guest and guest != 'none':
            facts.append(f'a {GUEST_NAMES.get(guest, guest)} guest')
    facts.append(f'{host_platform.system()} {host_platform.release()}')
    return facts


def provider_problem(platform, provider, proxy_url, app):
    """None when the provider has what it needs, else why the run is blocked."""
    if provider == 'limrun':
        instance = LIMRUN_INSTANCE_ENV[platform]
        present = [name for name in instance if os.environ.get(name)]
        if present and len(present) < len(instance):
            return f'Limrun instance variables are partial ({", ".join(present)}); {platform} needs all of {", ".join(instance)}'
        if app and not os.environ.get('LIMRUN_API_KEY'):
            return 'installing an app on Limrun needs LIMRUN_API_KEY (it uploads through Limrun asset storage)'
        if present or os.environ.get('LIMRUN_API_KEY'):
            return None
        return f'no Limrun credential: set LIMRUN_API_KEY (tool secret limrun_api_key), or all of {", ".join(instance)}'
    if provider == 'proxy':
        missing = [name for name, value in (('--proxy-url', proxy_url), (PROXY_TOKEN_ENV, os.environ.get(PROXY_TOKEN_ENV)))
                   if not value]
        return f'an agent-device proxy needs {" and ".join(missing)}' if missing else None
    return 'no device provider chosen (--provider limrun or --provider proxy)'


def provider_env(platform, provider):
    """The secret-bearing variables the container may see, passed by name only."""
    names = ['LIMRUN_API_KEY', 'LIMRUN_REGION', *LIMRUN_INSTANCE_ENV[platform]] if provider == 'limrun' else [PROXY_TOKEN_ENV]
    return [name for name in names if os.environ.get(name)]


def blocked_text(platform, problem):
    if platform == 'ios':
        system = host_platform.system()
        local = 'iOS Simulators need macOS with Xcode' + (
            '' if system == 'Darwin' else f', and this host runs {system} {host_platform.release()}')
        options = 'Limrun iOS (LIMRUN_API_KEY), or an agent-device proxy on a Mac: a Mac mini, an EC2 Mac or a macOS CI runner'
    elif os.path.exists('/dev/kvm'):
        local = (f'this host has /dev/kvm ({"; ".join(local_device_facts())}): run an emulator here behind an '
                 'agent-device proxy and pass --provider proxy')
        options = 'Limrun Android (LIMRUN_API_KEY), or an agent-device proxy here or on any KVM host'
    else:
        local = f'an Android emulator needs KVM, which this host does not have ({"; ".join(local_device_facts())})'
        options = 'Limrun Android (LIMRUN_API_KEY), or an agent-device proxy on a host with /dev/kvm or a USB-attached phone'
    return f'No {platform} device is reachable. Here: {local}. Remote: {problem}. Options: {options}.'


# ---------------------------------------------------------------------------------------- results

@dataclass
class Outcome:
    result: str
    summary: str
    steps_total: int = 0
    steps_passed: int = 0
    steps_failed: int = 0
    failure: str = ''
    blocker: str = ''


def readable(text, variables):
    """agent-device prints `${NAME}` and `<var:NAME>` where values go; put the values back."""
    for name, value in variables.items():
        text = text.replace('${' + name + '}', value).replace(f'<var:{name}>', value)
    return text


def parse_replay(stdout, steps_total, variables):
    """Turn agent-device's --json reply into a verdict.

    A divergence is the product failing a step: the page did not load or did not say what it
    should. Anything else (no JSON, a usage error, a crashed backend) is the harness failing.
    """
    try:
        reply = json.loads(stdout)
    except ValueError:
        return Outcome('error', 'agent-device printed no JSON result', steps_total)
    if not isinstance(reply, dict):
        return Outcome('error', 'agent-device printed an unexpected result', steps_total)
    if reply.get('success') is True:
        data = reply.get('data') or {}
        replayed = data.get('replayed') if isinstance(data.get('replayed'), int) else steps_total
        return Outcome('passed', data.get('message') or f'Replayed {replayed} steps', replayed, replayed)
    error = reply.get('error') or {}
    details = error.get('details') or {}
    if error.get('code') == 'REPLAY_DIVERGENCE':
        divergence = details.get('divergence') or {}
        step = details.get('step')
        if not isinstance(step, int):
            step = (divergence.get('step') or {}).get('index')
        line = ((divergence.get('step') or {}).get('source') or {}).get('line')
        action = readable(str(divergence.get('action') or details.get('action') or '?'), variables)
        cause = readable(str((divergence.get('cause') or {}).get('message') or error.get('message') or ''), variables)
        where = f'step {step}' + (f' (spec line {line})' if line else '')
        passed = step - 1 if isinstance(step, int) and step > 0 else 0
        return Outcome('failed', f'Failed at {where} of {steps_total}: {action}', steps_total, passed, 1,
                       failure=f'{where}: {action} — {cause}')
    message = readable(str(error.get('message') or 'unknown error'), variables)
    return Outcome('error', f'agent-device {error.get("code") or "error"}: {message}', steps_total, failure=message)


# ---------------------------------------------------------------------------------------- docker

def docker(args, timeout, **kwargs):
    return subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout, **kwargs)


def docker_problem(runtime):
    if not shutil.which('docker'):
        return 'docker is not installed on this host'
    try:
        probe = docker(['info', '--format', '{{json .Runtimes}}'], 30)
    except subprocess.TimeoutExpired:
        return 'docker did not answer within 30s'
    if probe.returncode != 0:
        return f'docker is unavailable: {probe.stderr.strip()[:300]}'
    try:
        runtimes = json.loads(probe.stdout)
    except ValueError:
        runtimes = {}
    if runtime in runtimes:
        return None
    return f'Docker on this host has no {runtime} runtime' + (
        ': install gVisor, or pass --sandbox runc to use Docker\'s default runtime' if runtime == 'runsc' else '')


def ensure_image(log_path, timeout):
    """Build the engine once per Dockerfile: its tag is the Dockerfile's hash."""
    if docker(['image', 'inspect', IMAGE], 60).returncode == 0:
        return
    print(f'building {IMAGE}: the first run on this host takes a few minutes', flush=True)
    with open(log_path, 'w') as log:
        build = subprocess.run(['docker', 'build', '--progress', 'plain', '-t', IMAGE, '-'], input=ENGINE_DOCKERFILE,
                               stdout=log, stderr=subprocess.STDOUT, text=True, timeout=timeout)
    if build.returncode != 0:
        raise RuntimeError(f'engine image build failed (exit {build.returncode}); see {log_path}')


def container_argv(name, runtime, network, seccomp, mounts, pairs, inherited, script, args):
    """No capabilities, no new privileges, this user's uid, bounded memory, CPU and processes."""
    argv = ['run', '--rm', '--init', '--runtime', runtime, '--name', name, '--user', f'{os.getuid()}:{os.getgid()}',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']
    if seccomp:
        argv += ['--security-opt', f'seccomp={seccomp}']
    argv += ['--shm-size', '1g', '--memory', '3g', '--cpus', '2', '--pids-limit', '1024', '--network', network,
             '-e', 'HOME=/tmp']
    for source, target, mode in mounts:
        argv += ['-v', f'{source}:{target}:{mode}']
    for key, value in pairs:
        argv += ['-e', f'{key}={value}']
    for key in inherited:
        argv += ['-e', key]  # docker copies the value from our environment, so a secret never sits in argv
    return argv + [IMAGE, 'bash', '-c', script, 'device-test', *args]


def run_container(argv, name, timeout):
    started = time.monotonic()
    try:
        proc = docker(argv, timeout)
        return proc.returncode, int((time.monotonic() - started) * 1000), proc.stderr
    except subprocess.TimeoutExpired:
        docker(['rm', '-f', name], 60)
        return None, int((time.monotonic() - started) * 1000), f'timed out after {timeout}s'


# ---------------------------------------------------------------------------------------- tm8

def parse_cli_json(stdout):
    """tm8 --format json prints one document; a trailing `[journal: …]` line is not part of it."""
    lines = stdout.rstrip().splitlines()
    while lines and lines[-1].startswith('[journal'):
        lines.pop()
    return json.loads('\n'.join(lines))


def version_of(document):
    version = document.get('version')
    if isinstance(version, dict):
        version = version.get('to')
    if not isinstance(version, int):
        raise RuntimeError(f'no entity version in tm8 reply: {json.dumps(document)[:300]}')
    return version


class Recorder:
    """Writes runs, screenshots and the verdict to tm8 through its CLI."""

    def __init__(self, binary='tm8'):
        self.binary = binary
        self.env = None

    def call(self, args, stdin=None):
        if self.env is None:
            self.env = self.space_env(dict(os.environ))
        return self.run_cli(args, stdin, self.env)

    def run_cli(self, args, stdin, env):
        proc = subprocess.run([self.binary, *args, '--format', 'json'], input=stdin, capture_output=True, text=True,
                              timeout=120, env=env)
        if proc.returncode != 0:
            raise RuntimeError(f'tm8 {" ".join(args[:2])} failed ({proc.returncode}): {(proc.stderr or proc.stdout).strip()[:500]}')
        return parse_cli_json(proc.stdout)

    def space_env(self, env):
        """A session's host names its Space in TM8_SPACE_ID, but a tool run gets only TM8_TOOL_SESSION, so the CLI
        would refuse every write. The tool session entity names the Space, and reading an entity by id needs none."""
        session = env.get('TM8_TOOL_SESSION', '').strip()
        if not session or env.get('TM8_SPACE_ID', '').strip():
            return env
        entity = self.run_cli(['entity', 'get', session], None, env)
        space = ((entity.get('state') or {}).get('toolRun') or {}).get('spaceId')
        if not space:
            raise RuntimeError(f'tool session {session} names no Space (state.toolRun.spaceId)')
        return {**env, 'TM8_SPACE_ID': space}

    def with_content(self, fields, args):
        handle = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False)
        try:
            with handle:
                json.dump({'fields': fields}, handle)
            return self.call([*args, '--content', f'@{handle.name}'])
        finally:
            os.unlink(handle.name)

    def create_run(self, title, fields, task):
        receipt = self.with_content(fields, ['entity', 'create', 'c:test_run', title, *(['--relate-to', task] if task else [])])
        return receipt['id']

    def adopt_run(self, run_id):
        entity = self.call(['entity', 'get', run_id])
        if entity.get('kind') != 'c:test_run':
            raise RuntimeError(f'{run_id} is a {entity.get("kind")}, not a c:test_run')
        return run_id

    def update_run(self, run_id, title, fields):
        version = version_of(self.call(['entity', 'get', run_id]))
        self.with_content(fields, ['entity', 'update', run_id, '--expect-version', str(version), '--title', title])

    def upload(self, path, name, run_id):
        receipt = self.call(['file', 'upload', path, '--mime', 'image/png', '--name', name, '--attach-to', run_id])
        return (receipt.get('entity') or {}).get('id') or receipt.get('id')

    def post(self, anchor, body, attachments):
        args = ['message', 'send', '--to', anchor, '-']
        for file_id in attachments:
            args += ['--attach', file_id]
        self.call(args, stdin=body)


class DryRecorder(Recorder):
    """--no-record: everything stays in the output directory."""

    def call(self, args, stdin=None):
        raise AssertionError('a dry run never calls tm8')

    def create_run(self, title, fields, task):
        return f'dry-{secrets.token_hex(4)}'

    def adopt_run(self, run_id):
        return run_id

    def update_run(self, run_id, title, fields):
        print(f'[dry] {run_id}: {title}')

    def upload(self, path, name, run_id):
        return None

    def post(self, anchor, body, attachments):
        print(f'[dry] verdict for {anchor}:\n{body}')


# ---------------------------------------------------------------------------------------- runs

@dataclass
class Plan:
    host: str
    expect: str
    spec: str
    spec_name: str
    profiles: list
    domains: list
    app: str


@dataclass
class Run:
    label: str
    title_head: str
    fields: dict
    run_id: str = ''
    out_dir: str = ''
    outcome: Outcome = None
    screenshots: list = field(default_factory=list)
    file_ids: list = field(default_factory=list)


def title_for(run):
    return f'{run.title_head} — {run.outcome.result if run.outcome else run.fields["result"]}'


def finish(recorder, run, outcome, duration_ms):
    """Attach the screenshots, then write the verdict into the run's fields."""
    run.outcome = outcome
    run.screenshots = sorted(name for name in os.listdir(run.out_dir) if name.endswith('.png'))
    for name in run.screenshots:
        file_id = recorder.upload(os.path.join(run.out_dir, name), f'{run.label}-{name}', run.run_id)
        if file_id:
            run.file_ids.append(file_id)
    count = len(run.screenshots)
    shots = f'{count} screenshot{"s" * (count != 1)}: {", ".join(run.screenshots)}' if count else 'no screenshots'
    run.fields.setdefault('started_at', iso_now())
    run.fields.update({
        'result': outcome.result, 'finished_at': iso_now(), 'duration_ms': duration_ms,
        'steps_total': outcome.steps_total, 'steps_passed': outcome.steps_passed, 'steps_failed': outcome.steps_failed,
        'screenshots': count, 'summary': f'{outcome.summary}; {shots}.',
    })
    for key in ('failure', 'blocker'):
        if getattr(outcome, key):
            run.fields[key] = getattr(outcome, key)[:4000]
    recorder.update_run(run.run_id, title_for(run), run.fields)


def read_text(path):
    try:
        with open(path) as handle:
            return handle.read()
    except OSError:
        return ''


def execute(recorder, run, argv, name, timeout, steps_total, variables):
    code, duration_ms, stderr = run_container(argv, name, timeout)
    replay = read_text(os.path.join(run.out_dir, 'replay.json'))
    if code is None:
        outcome = Outcome('error', f'The run timed out after {timeout}s', steps_total, failure=stderr)
    elif code in PROVIDER_STEPS:
        step, output, summary = PROVIDER_STEPS[code]
        reply = parse_replay(read_text(os.path.join(run.out_dir, f'{output}.json')), 0, variables)
        refused = (reply.summary.removeprefix('agent-device ') if reply.failure else
                   read_text(os.path.join(run.out_dir, f'{output}.log')).strip()[:500] or stderr.strip()[:500])
        outcome = Outcome('blocked', summary, steps_total, blocker=f'agent-device {step} failed: {refused or "no detail"}')
    elif replay:
        outcome = parse_replay(replay, steps_total, variables)
    else:
        outcome = Outcome('error', f'The engine container exited {code} without a result', steps_total,
                          failure=stderr.strip()[:1000])
    finish(recorder, run, outcome, duration_ms)


def verdict_message(runs, target, expect_text, sandbox):
    counts = {}
    for run in runs:
        counts[run.outcome.result] = counts.get(run.outcome.result, 0) + 1
    head = ', '.join(f'{n} {result}' for result, n in sorted(counts.items(), key=lambda item: SEVERITY.index(item[0])))
    lines = [f'**Device test: {head}** · `{target}`' + (f' · expects "{expect_text}"' if expect_text else ''), '']
    for run in runs:
        o = run.outcome
        parts = [f'**{o.result}**']
        if o.steps_total:
            parts.append(f'{o.steps_passed}/{o.steps_total} steps')
        parts += [f'{len(run.screenshots)} screenshots', f'run `{run.run_id}`']
        size = f' {run.fields["viewport"]}' if run.fields.get('viewport') else ''
        lines.append(f'- **{run.label}**{size}: ' + ', '.join(parts))
        if o.result != 'passed':
            lines.append(f'  {(o.failure or o.blocker or o.summary)[:600]}')
    if any(run.fields['platform'] == 'web' for run in runs):
        box = ('a gVisor sandbox with no capabilities and no new privileges' if sandbox == 'gvisor' else
               'a runc container with no capabilities, no new privileges and Docker\'s default seccomp profile less '
               'pkey_alloc')
        lines += ['', f'Engine: {ENGINE}, in {box}. `iphone` and `pixel` are Chromium at that size and user agent, '
                      'not the phone.']
    return '\n'.join(lines)


# ---------------------------------------------------------------------------------------- main

class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(EXIT_USAGE, f'{self.prog}: error: {message}\n')


def build_parser():
    """Each option reads DEVICE_TEST_<NAME> as its default: tool.json declares the same names."""
    p = Parser(prog='device-test', description=__doc__.split('\n\n')[0].strip(),
               formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--platform', choices=['web', 'android', 'ios'], default=env_default('DEVICE_TEST_PLATFORM', 'web'))
    p.add_argument('--target', default=env_default('DEVICE_TEST_TARGET'), help='http(s) URL to open')
    p.add_argument('--expect-text', default=env_default('DEVICE_TEST_EXPECT_TEXT'),
                   help='text the screen must show; the run fails if it does not appear')
    p.add_argument('--profiles', default=env_default('DEVICE_TEST_PROFILES', 'desktop'),
                   help=f'web only, comma-separated: {", ".join(PROFILES)}')
    p.add_argument('--suite', default=env_default('DEVICE_TEST_SUITE'),
                   help='an agent-device .ad replay script to run instead of the built-in check')
    p.add_argument('--app', default=env_default('DEVICE_TEST_APP'),
                   help='android and ios: an .apk, .app, .ipa or .zip for the suite to install, mounted read-only as ${APP}')
    p.add_argument('--allow-domains', default=env_default('DEVICE_TEST_ALLOW_DOMAINS'),
                   help='web only: more domains the page may load from, comma-separated (*.example.com allowed)')
    p.add_argument('--network', choices=['bridge', 'host'], default=env_default('DEVICE_TEST_NETWORK', 'bridge'),
                   help='host lets the browser reach services on this machine (127.0.0.1); bridge does not')
    p.add_argument('--sandbox', choices=list(SANDBOXES), default=env_default('DEVICE_TEST_SANDBOX', 'gvisor'),
                   help="gvisor gives each container a kernel of its own; runc is Docker's default runtime")
    p.add_argument('--provider', choices=['none', 'limrun', 'proxy'], default=env_default('DEVICE_TEST_PROVIDER', 'none'),
                   help='android and ios: where the device runs')
    p.add_argument('--proxy-url', default=env_default('DEVICE_TEST_PROXY_URL'),
                   help=f'agent-device proxy base URL; its token comes from {PROXY_TOKEN_ENV}')
    p.add_argument('--task', default=env_default('DEVICE_TEST_TASK'), help='task to relate each run to and post the verdict on')
    p.add_argument('--run', default=env_default('DEVICE_TEST_RUN'), help='record the first run into this existing c:test_run, such as one queued from the UI')
    p.add_argument('--revision', default=env_default('DEVICE_TEST_REVISION'), help='the build of the target under test')
    p.add_argument('--timeout', type=int, default=env_default('DEVICE_TEST_TIMEOUT', '0'),
                   help='seconds per run (default 300 for web, 900 for a device)')
    p.add_argument('--out', default=env_default('DEVICE_TEST_OUT'), help='directory for screenshots and logs')
    p.add_argument('--record', action=argparse.BooleanOptionalAction, default=env_bool('DEVICE_TEST_RECORD', True),
                   help='write runs to tm8 (default); --no-record keeps everything local')
    p.add_argument('--print-dockerfile', action='store_true', help='print the engine Dockerfile and exit')
    p.add_argument('--print-seccomp', action='store_true', help='print the seccomp profile web runs use under runc and exit')
    return p


def parse_args(argv):
    return build_parser().parse_args(argv)


def plan(args):
    """Validate everything before any container starts or any entity is written."""
    host = check_target(args.target, args.platform, bool(args.suite))
    expect = check_text('--expect-text', args.expect_text) if args.expect_text else ''
    suite = ''
    if args.suite:
        with open(check_mount('--suite', args.suite)) as handle:
            suite = handle.read()
    app = ''
    if args.app:
        if args.platform == 'web' or not args.suite:
            raise ValueError('--app needs --platform android or ios and a --suite that installs and opens it')
        app = check_mount('--app', args.app)
    if args.network == 'host' and args.sandbox == 'gvisor':
        raise ValueError('--network host needs --sandbox runc: a gVisor container on the host network has no network')
    profiles, domains = [], []
    if args.platform == 'web':
        names = [name.strip() for name in args.profiles.split(',') if name.strip()]
        unknown = [name for name in names if name not in PROFILES]
        if unknown or not names:
            raise ValueError(f'unknown profile {", ".join(unknown) or "(none)"}; choose from {", ".join(PROFILES)}')
        profiles = [PROFILES[name] for name in dict.fromkeys(names)]
        domains = allowed_domains(host, args.allow_domains.split(','))
        if is_loopback(host) and args.network != 'host':
            raise ValueError(f'{host} is this machine: pass --network host --sandbox runc so the browser can reach it')
    elif is_loopback(host):
        raise ValueError(f'a remote device cannot reach {host} on this machine; test a URL it can reach')
    if args.timeout < 0:
        raise ValueError('--timeout must be positive')
    spec = suite or (web_spec(expect) if args.platform == 'web' else mobile_spec(expect))
    spec_name = os.path.basename(args.suite) if args.suite else f'{args.platform}-check.ad'
    return Plan(host, expect, spec, spec_name, profiles, domains, app)


def make_runs(args, p):
    common = {'platform': args.platform, 'result': 'queued', 'target': args.target, 'engine': ENGINE,
              'suite': args.suite or f'built-in {args.platform} check' + (f' for "{p.expect}"' if p.expect else ''),
              'runner': f'tools/device-test {RUNNER_SHA[:12]} · {IMAGE} · {SANDBOXES[args.sandbox]}',
              **({'revision': args.revision} if args.revision else {})}
    if args.platform == 'web':
        return [Run(profile.name, f'web · {p.host} · {profile.name}',
                    {**common, 'device': profile.device, 'viewport': f'{profile.width}×{profile.height}',
                     'provider': f'tm8 host, {SANDBOX_NAMES[args.sandbox]}'})
                for profile in p.profiles]
    device = DEVICES.get(args.provider, {}).get(args.platform, 'none reachable')
    return [Run(args.platform, f'{args.platform} · {p.host} · {PROVIDER_NAMES[args.provider]}',
                {**common, 'engine': MOBILE_ENGINE, 'device': device, 'provider': args.provider})]


def replay_vars(variables):
    return [arg for key, value in variables.items() for arg in ('-e', f'{key}={value}')]


def main(argv=None, recorder=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.print_dockerfile:
        print(ENGINE_DOCKERFILE, end='')
        return 0
    if args.print_seccomp:
        print(json.dumps(chrome_seccomp_profile(), indent=1))
        return 0
    try:
        p = plan(args)
    except (ValueError, OSError) as error:
        print(f'device-test: {error}', file=sys.stderr)
        return EXIT_USAGE
    recorder = recorder or (Recorder() if args.record else DryRecorder())
    timeout = args.timeout or (300 if args.platform == 'web' else 900)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    base = os.path.realpath(args.out or os.path.join(os.environ.get('TM8_RUN_DIR') or os.getcwd(), 'device-test', stamp))
    spec_dir = os.path.join(base, 'specs')
    os.makedirs(spec_dir, exist_ok=True)
    with open(os.path.join(spec_dir, p.spec_name), 'w') as handle:
        handle.write(p.spec)
    try:
        runs = make_runs(args, p)
        for index, run in enumerate(runs):
            if args.run and index == 0:
                run.run_id = recorder.adopt_run(args.run)
                recorder.update_run(run.run_id, title_for(run), run.fields)
            else:
                run.run_id = recorder.create_run(title_for(run), run.fields, args.task)
            run.out_dir = os.path.join(base, run.label)
            os.makedirs(run.out_dir, exist_ok=True)
            print(f'{run.label}: run {run.run_id}, output {run.out_dir}', flush=True)

        blocked = problem = None
        if args.platform != 'web':
            reason = provider_problem(args.platform, args.provider, args.proxy_url, p.app)
            blocked = blocked_text(args.platform, reason) if reason else None
        if not blocked:
            problem = docker_problem(SANDBOXES[args.sandbox])
        if not blocked and not problem:
            try:
                ensure_image(os.path.join(base, 'engine-build.log'), max(timeout, 1200))
            except (RuntimeError, subprocess.TimeoutExpired) as error:
                problem = str(error)

        steps_total = count_steps(p.spec)
        variables = {'TARGET_URL': args.target, 'OUT': '/out', **({'EXPECT_TEXT': p.expect} if p.expect else {})}
        mounts = [(spec_dir, '/specs', 'ro')]
        for run in runs:
            if blocked:
                finish(recorder, run, Outcome('blocked', f'Blocked: no {args.platform} device', blocker=blocked), 0)
                continue
            if problem:
                finish(recorder, run, Outcome('error', 'The engine could not start', failure=problem), 0)
                continue
            name = f'tm8-device-test-{run.run_id[-12:]}-{run.label}'
            run_mounts = [*mounts, (run.out_dir, '/out', 'rw')]
            run_vars = dict(variables)
            if args.platform == 'web':
                profile = PROFILES[run.label]
                run_vars.update({'VIEWPORT_W': str(profile.width), 'VIEWPORT_H': str(profile.height)})
                pairs = [('AGENT_BROWSER_ALLOWED_DOMAINS', ','.join(p.domains))]
                if profile.user_agent:
                    pairs.append(('AGENT_BROWSER_USER_AGENT', profile.user_agent))
                seccomp = None
                if args.sandbox == 'runc':
                    seccomp = os.path.join(base, 'seccomp-chrome.json')
                    with open(seccomp, 'w') as handle:
                        json.dump(chrome_seccomp_profile(), handle)
                argv = container_argv(name, SANDBOXES[args.sandbox], args.network, seccomp, run_mounts, pairs, [],
                                      WEB_SCRIPT, [f'/specs/{p.spec_name}', f'web-{run.label}', *replay_vars(run_vars)])
            else:
                if p.app:
                    run_mounts.append((p.app, f'/app/{os.path.basename(p.app)}', 'ro'))
                    run_vars['APP'] = f'/app/{os.path.basename(p.app)}'
                argv = container_argv(name, SANDBOXES[args.sandbox], args.network, None, run_mounts,
                                      [('DEVICE_TEST_PROXY_URL', args.proxy_url)],
                                      provider_env(args.platform, args.provider), MOBILE_SCRIPT,
                                      [args.platform, args.provider, f'/specs/{p.spec_name}', f'{args.platform}-run',
                                       *replay_vars(run_vars)])
            run.fields.update({'result': 'running', 'started_at': iso_now()})
            recorder.update_run(run.run_id, title_for(run), run.fields)
            execute(recorder, run, argv, name, timeout, steps_total, run_vars)
            print(f'{run.label}: {run.outcome.result}. {run.outcome.summary}', flush=True)

        if args.task:
            attachments = [file_id for run in runs for file_id in run.file_ids][:12]
            recorder.post(args.task, verdict_message(runs, args.target, p.expect, args.sandbox), attachments)
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        print(f'device-test: {error}', file=sys.stderr)
        return EXIT_CODES['error']
    report = [{'run': run.run_id, 'label': run.label, 'result': run.outcome.result, 'fields': run.fields,
               'screenshots': run.screenshots, 'files': run.file_ids, 'out': run.out_dir} for run in runs]
    with open(os.path.join(base, 'report.json'), 'w') as handle:
        json.dump(report, handle, indent=2, ensure_ascii=False)
    worst = max((run.outcome.result for run in runs), key=SEVERITY.index)
    print(f'device-test: {worst} ({len(runs)} run{"s" * (len(runs) != 1)}); report {os.path.join(base, "report.json")}')
    return EXIT_CODES[worst]


# Docker 29.7.2's built-in default profile: moby/moby at tag docker-v29.7.2,
# vendor/github.com/moby/profiles/seccomp/default.json (git blob ea5a494afb8d64898fa0f4f47ae0c4f5ba9cbbc9),
# the same content re-serialised one rule per line. test_device_test.py pins its canonical sha256.
DOCKER_DEFAULT_SECCOMP = r'''
{"defaultAction": "SCMP_ACT_ERRNO", "defaultErrnoRet": 1,
 "archMap": [
  {"architecture": "SCMP_ARCH_X86_64", "subArchitectures": ["SCMP_ARCH_X86", "SCMP_ARCH_X32"]},
  {"architecture": "SCMP_ARCH_AARCH64", "subArchitectures": ["SCMP_ARCH_ARM"]},
  {"architecture": "SCMP_ARCH_MIPS64", "subArchitectures": ["SCMP_ARCH_MIPS", "SCMP_ARCH_MIPS64N32"]},
  {"architecture": "SCMP_ARCH_MIPS64N32", "subArchitectures": ["SCMP_ARCH_MIPS", "SCMP_ARCH_MIPS64"]},
  {"architecture": "SCMP_ARCH_MIPSEL64", "subArchitectures": ["SCMP_ARCH_MIPSEL", "SCMP_ARCH_MIPSEL64N32"]},
  {"architecture": "SCMP_ARCH_MIPSEL64N32", "subArchitectures": ["SCMP_ARCH_MIPSEL", "SCMP_ARCH_MIPSEL64"]},
  {"architecture": "SCMP_ARCH_S390X", "subArchitectures": ["SCMP_ARCH_S390"]},
  {"architecture": "SCMP_ARCH_RISCV64", "subArchitectures": null},
  {"architecture": "SCMP_ARCH_LOONGARCH64", "subArchitectures": null}],
 "syscalls": [
  {"names": [
    "accept", "accept4", "access", "adjtimex", "alarm", "bind", "brk", "cachestat", "capget", "capset",
    "chdir", "chmod", "chown", "chown32", "clock_adjtime", "clock_adjtime64", "clock_getres",
    "clock_getres_time64", "clock_gettime", "clock_gettime64", "clock_nanosleep", "clock_nanosleep_time64",
    "close", "close_range", "connect", "copy_file_range", "creat", "dup", "dup2", "dup3", "epoll_create",
    "epoll_create1", "epoll_ctl", "epoll_ctl_old", "epoll_pwait", "epoll_pwait2", "epoll_wait",
    "epoll_wait_old", "eventfd", "eventfd2", "execve", "execveat", "exit", "exit_group", "faccessat",
    "faccessat2", "fadvise64", "fadvise64_64", "fallocate", "fanotify_mark", "fchdir", "fchmod", "fchmodat",
    "fchmodat2", "fchown", "fchown32", "fchownat", "fcntl", "fcntl64", "fdatasync", "fgetxattr",
    "flistxattr", "flock", "fork", "fremovexattr", "fsetxattr", "fstat", "fstat64", "fstatat64", "fstatfs",
    "fstatfs64", "fsync", "ftruncate", "ftruncate64", "futex", "futex_requeue", "futex_time64",
    "futex_wait", "futex_waitv", "futex_wake", "futimesat", "getcpu", "getcwd", "getdents", "getdents64",
    "getegid", "getegid32", "geteuid", "geteuid32", "getgid", "getgid32", "getgroups", "getgroups32",
    "getitimer", "getpeername", "getpgid", "getpgrp", "getpid", "getppid", "getpriority", "getrandom",
    "getresgid", "getresgid32", "getresuid", "getresuid32", "getrlimit", "get_robust_list", "getrusage",
    "getsid", "getsockname", "getsockopt", "get_thread_area", "gettid", "gettimeofday", "getuid",
    "getuid32", "getxattr", "getxattrat", "inotify_add_watch", "inotify_init", "inotify_init1",
    "inotify_rm_watch", "io_cancel", "ioctl", "io_destroy", "io_getevents", "io_pgetevents",
    "io_pgetevents_time64", "ioprio_get", "ioprio_set", "io_setup", "io_submit", "ipc", "kill",
    "landlock_add_rule", "landlock_create_ruleset", "landlock_restrict_self", "lchown", "lchown32",
    "lgetxattr", "link", "linkat", "listen", "listmount", "listxattr", "listxattrat", "llistxattr",
    "_llseek", "lremovexattr", "lseek", "lsetxattr", "lstat", "lstat64", "madvise", "map_shadow_stack",
    "membarrier", "memfd_create", "memfd_secret", "mincore", "mkdir", "mkdirat", "mknod", "mknodat",
    "mlock", "mlock2", "mlockall", "mmap", "mmap2", "mprotect", "mq_getsetattr", "mq_notify", "mq_open",
    "mq_timedreceive", "mq_timedreceive_time64", "mq_timedsend", "mq_timedsend_time64", "mq_unlink",
    "mremap", "mseal", "msgctl", "msgget", "msgrcv", "msgsnd", "msync", "munlock", "munlockall", "munmap",
    "name_to_handle_at", "nanosleep", "newfstatat", "_newselect", "open", "openat", "openat2", "pause",
    "pidfd_open", "pidfd_send_signal", "pipe", "pipe2", "pkey_alloc", "pkey_free", "pkey_mprotect", "poll",
    "ppoll", "ppoll_time64", "prctl", "pread64", "preadv", "preadv2", "prlimit64", "process_mrelease",
    "pselect6", "pselect6_time64", "pwrite64", "pwritev", "pwritev2", "read", "readahead", "readlink",
    "readlinkat", "readv", "recv", "recvfrom", "recvmmsg", "recvmmsg_time64", "recvmsg", "remap_file_pages",
    "removexattr", "removexattrat", "rename", "renameat", "renameat2", "restart_syscall", "riscv_hwprobe",
    "rmdir", "rseq", "rt_sigaction", "rt_sigpending", "rt_sigprocmask", "rt_sigqueueinfo", "rt_sigreturn",
    "rt_sigsuspend", "rt_sigtimedwait", "rt_sigtimedwait_time64", "rt_tgsigqueueinfo", "sched_getaffinity",
    "sched_getattr", "sched_getparam", "sched_get_priority_max", "sched_get_priority_min",
    "sched_getscheduler", "sched_rr_get_interval", "sched_rr_get_interval_time64", "sched_setaffinity",
    "sched_setattr", "sched_setparam", "sched_setscheduler", "sched_yield", "seccomp", "select", "semctl",
    "semget", "semop", "semtimedop", "semtimedop_time64", "send", "sendfile", "sendfile64", "sendmmsg",
    "sendmsg", "sendto", "setfsgid", "setfsgid32", "setfsuid", "setfsuid32", "setgid", "setgid32",
    "setgroups", "setgroups32", "setitimer", "setpgid", "setpriority", "setregid", "setregid32",
    "setresgid", "setresgid32", "setresuid", "setresuid32", "setreuid", "setreuid32", "setrlimit",
    "set_robust_list", "setsid", "setsockopt", "set_thread_area", "set_tid_address", "setuid", "setuid32",
    "setxattr", "setxattrat", "shmat", "shmctl", "shmdt", "shmget", "shutdown", "sigaltstack", "signalfd",
    "signalfd4", "sigprocmask", "sigreturn", "socketcall", "socketpair", "splice", "stat", "stat64",
    "statfs", "statfs64", "statmount", "statx", "symlink", "symlinkat", "sync", "sync_file_range", "syncfs",
    "sysinfo", "tee", "tgkill", "time", "timer_create", "timer_delete", "timer_getoverrun", "timer_gettime",
    "timer_gettime64", "timer_settime", "timer_settime64", "timerfd_create", "timerfd_gettime",
    "timerfd_gettime64", "timerfd_settime", "timerfd_settime64", "times", "tkill", "truncate", "truncate64",
    "ugetrlimit", "umask", "uname", "unlink", "unlinkat", "uretprobe", "utime", "utimensat",
    "utimensat_time64", "utimes", "vfork", "vmsplice", "wait4", "waitid", "waitpid", "write", "writev"],
   "action": "SCMP_ACT_ALLOW"},
  {"names": ["process_vm_readv", "process_vm_writev", "ptrace"], "action": "SCMP_ACT_ALLOW", "includes": {"minKernel": "4.8"}},
  {"names": ["socket"], "action": "SCMP_ACT_ALLOW", "args": [{"index": 0, "value": 38, "op": "SCMP_CMP_LT"}]},
  {"names": ["socket"], "action": "SCMP_ACT_ALLOW", "args": [{"index": 0, "value": 39, "op": "SCMP_CMP_EQ"}]},
  {"names": ["socket"], "action": "SCMP_ACT_ALLOW", "args": [{"index": 0, "value": 40, "op": "SCMP_CMP_GT"}]},
  {"names": ["personality"], "action": "SCMP_ACT_ALLOW", "args": [{"index": 0, "value": 0, "op": "SCMP_CMP_EQ"}]},
  {"names": ["personality"], "action": "SCMP_ACT_ALLOW", "args": [{"index": 0, "value": 8, "op": "SCMP_CMP_EQ"}]},
  {"names": ["personality"], "action": "SCMP_ACT_ALLOW", "args": [{"index": 0, "value": 131072, "op": "SCMP_CMP_EQ"}]},
  {"names": ["personality"], "action": "SCMP_ACT_ALLOW", "args": [{"index": 0, "value": 131080, "op": "SCMP_CMP_EQ"}]},
  {"names": ["personality"], "action": "SCMP_ACT_ALLOW", "args": [{"index": 0, "value": 4294967295, "op": "SCMP_CMP_EQ"}]},
  {"names": ["sync_file_range2", "swapcontext"], "action": "SCMP_ACT_ALLOW", "includes": {"arches": ["ppc64le"]}},
  {"names": ["arm_fadvise64_64", "arm_sync_file_range", "sync_file_range2", "breakpoint", "cacheflush", "set_tls"], "action": "SCMP_ACT_ALLOW", "includes": {"arches": ["arm", "arm64"]}},
  {"names": ["arch_prctl"], "action": "SCMP_ACT_ALLOW", "includes": {"arches": ["amd64", "x32"]}},
  {"names": ["modify_ldt"], "action": "SCMP_ACT_ALLOW", "includes": {"arches": ["amd64", "x32", "x86"]}},
  {"names": ["s390_pci_mmio_read", "s390_pci_mmio_write", "s390_runtime_instr"], "action": "SCMP_ACT_ALLOW", "includes": {"arches": ["s390", "s390x"]}},
  {"names": ["riscv_flush_icache"], "action": "SCMP_ACT_ALLOW", "includes": {"arches": ["riscv64"]}},
  {"names": ["open_by_handle_at"], "action": "SCMP_ACT_ALLOW", "includes": {"caps": ["CAP_DAC_READ_SEARCH"]}},
  {"names": [
    "bpf", "clone", "clone3", "fanotify_init", "fsconfig", "fsmount", "fsopen", "fspick", "lookup_dcookie",
    "lsm_get_self_attr", "lsm_list_modules", "lsm_set_self_attr", "mount", "mount_setattr", "move_mount",
    "open_tree", "perf_event_open", "quotactl", "quotactl_fd", "setdomainname", "sethostname", "setns",
    "syslog", "umount", "umount2", "unshare"],
   "action": "SCMP_ACT_ALLOW", "includes": {"caps": ["CAP_SYS_ADMIN"]}},
  {"names": ["clone"], "action": "SCMP_ACT_ALLOW", "args": [{"index": 0, "value": 2114060288, "op": "SCMP_CMP_MASKED_EQ"}], "excludes": {"caps": ["CAP_SYS_ADMIN"], "arches": ["s390", "s390x"]}},
  {"names": ["clone"], "action": "SCMP_ACT_ALLOW", "args": [{"index": 1, "value": 2114060288, "op": "SCMP_CMP_MASKED_EQ"}], "comment": "s390 parameter ordering for clone is different", "includes": {"arches": ["s390", "s390x"]}, "excludes": {"caps": ["CAP_SYS_ADMIN"]}},
  {"names": ["clone3"], "action": "SCMP_ACT_ERRNO", "errnoRet": 38, "excludes": {"caps": ["CAP_SYS_ADMIN"]}},
  {"names": ["reboot"], "action": "SCMP_ACT_ALLOW", "includes": {"caps": ["CAP_SYS_BOOT"]}},
  {"names": ["chroot"], "action": "SCMP_ACT_ALLOW", "includes": {"caps": ["CAP_SYS_CHROOT"]}},
  {"names": ["delete_module", "init_module", "finit_module"], "action": "SCMP_ACT_ALLOW", "includes": {"caps": ["CAP_SYS_MODULE"]}},
  {"names": ["acct"], "action": "SCMP_ACT_ALLOW", "includes": {"caps": ["CAP_SYS_PACCT"]}},
  {"names": ["kcmp", "pidfd_getfd", "process_madvise", "process_vm_readv", "process_vm_writev", "ptrace"], "action": "SCMP_ACT_ALLOW", "includes": {"caps": ["CAP_SYS_PTRACE"]}},
  {"names": ["iopl", "ioperm"], "action": "SCMP_ACT_ALLOW", "includes": {"caps": ["CAP_SYS_RAWIO"]}},
  {"names": ["settimeofday", "stime", "clock_settime", "clock_settime64"], "action": "SCMP_ACT_ALLOW", "includes": {"caps": ["CAP_SYS_TIME"]}},
  {"names": ["vhangup"], "action": "SCMP_ACT_ALLOW", "includes": {"caps": ["CAP_SYS_TTY_CONFIG"]}},
  {"names": ["get_mempolicy", "mbind", "set_mempolicy", "set_mempolicy_home_node"], "action": "SCMP_ACT_ALLOW", "includes": {"caps": ["CAP_SYS_NICE"]}},
  {"names": ["syslog"], "action": "SCMP_ACT_ALLOW", "includes": {"caps": ["CAP_SYSLOG"]}},
  {"names": ["bpf"], "action": "SCMP_ACT_ALLOW", "includes": {"caps": ["CAP_BPF"]}},
  {"names": ["perf_event_open"], "action": "SCMP_ACT_ALLOW", "includes": {"caps": ["CAP_PERFMON"]}}]}
'''

if __name__ == '__main__':
    sys.exit(main())
