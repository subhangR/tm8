"""
Unit tests for device_test.py. No docker, no tm8 and no network: containers and the recorder
are faked. The replay fixtures are trimmed from real agent-device 0.21.27 runs on this host.

  python3 -I tools/device-test/test_device_test.py
"""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import re
import subprocess
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('device_test', HERE / 'device_test.py')
dt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dt)

# sha256 of the upstream profile in canonical form (sorted keys, no whitespace), computed from
# moby/moby docker-v29.7.2 vendor/github.com/moby/profiles/seccomp/default.json (blob ea5a494a).
DOCKER_DEFAULT_CANONICAL_SHA256 = '9da637d2ab0a204fcbd91bd88f1be9e004a3acab61c571a9f5b8870e588a17d2'

PASSED = {'success': True, 'data': {'replayed': 6, 'healed': 0, 'session': 'smoke', 'sessionActive': False,
                                    'artifactPaths': ['/out/viewport.png', '/out/fullpage.png'],
                                    'message': 'Replayed 6 steps in 8.3s'}}
DIVERGED = {'success': False, 'error': {
    'code': 'REPLAY_DIVERGENCE',
    'message': 'Replay failed at step 3 (wait "text" "${EXPECT_TEXT}" 5000): wait timed out for text: <var:EXPECT_TEXT>. '
               'Current surface: Skip to content, tm8 home, Claim a free seat.',
    'details': {'reason': 'wait_target_absent', 'replayPath': '/specs/smoke.ad', 'step': 3, 'action': 'wait',
                'artifactPaths': [],
                'divergence': {'version': 1, 'kind': 'action-failure',
                               'step': {'index': 3, 'source': {'path': '/specs/smoke.ad', 'line': 4}},
                               'action': 'wait "text" "${EXPECT_TEXT}" 5000',
                               'cause': {'code': 'COMMAND_FAILED',
                                         'message': 'wait timed out for text: <var:EXPECT_TEXT>. Current surface: '
                                                    'Skip to content, tm8 home, Claim a free seat.'}}}}}
NO_SESSION = {'success': False, 'error': {'code': 'SESSION_NOT_FOUND', 'message': 'No active session. Run open first.',
                                          'details': {'dispatched': 'no'}}}

SCRUBBED = ('DEVICE_TEST_', 'LIMRUN_', 'LIM_', 'AGENT_DEVICE_', 'TM8_RUN_DIR')


def canonical(profile):
    return hashlib.sha256(json.dumps(profile, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def clean_env(**extra):
    env = {k: v for k, v in os.environ.items() if not k.startswith(SCRUBBED)}
    return mock.patch.dict(os.environ, {**env, **extra}, clear=True)


class FakeRecorder(dt.Recorder):
    def __init__(self):
        super().__init__()
        self.created, self.updates, self.uploads, self.posts = [], [], [], []

    def call(self, args, stdin=None):
        raise AssertionError('tests never reach the tm8 CLI')

    def create_run(self, title, fields, task):
        self.created.append((title, dict(fields), task))
        return f'01a00000-0000-7000-8000-00000000000{len(self.created)}'

    def adopt_run(self, run_id):
        return run_id

    def update_run(self, run_id, title, fields):
        self.updates.append((run_id, title, copy.deepcopy(fields)))

    def upload(self, path, name, run_id):
        self.uploads.append((os.path.basename(path), name, run_id))
        return f'file-{len(self.uploads)}'

    def post(self, anchor, body, attachments):
        self.posts.append((anchor, body, list(attachments)))


def quiet_main(argv, recorder):
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return dt.main(argv, recorder)


class SeccompTest(unittest.TestCase):
    def test_embedded_profile_is_dockers_default(self):
        self.assertEqual(canonical(json.loads(dt.DOCKER_DEFAULT_SECCOMP)), DOCKER_DEFAULT_CANONICAL_SHA256)

    def test_chrome_profile_differs_only_in_pkey_alloc(self):
        default = json.loads(dt.DOCKER_DEFAULT_SECCOMP)
        derived = dt.chrome_seccomp_profile()
        self.assertEqual(derived['syscalls'][-1], {'names': ['pkey_alloc'], 'action': 'SCMP_ACT_ERRNO', 'errnoRet': 28})
        allowed = [rule for rule in derived['syscalls'] if rule['action'] == 'SCMP_ACT_ALLOW']
        self.assertFalse(any('pkey_alloc' in rule['names'] for rule in allowed))
        self.assertTrue(any({'pkey_free', 'pkey_mprotect'} <= set(rule['names']) for rule in allowed))
        restored = copy.deepcopy(derived)
        restored['syscalls'].pop()
        first = next(rule for rule in default['syscalls'] if 'pkey_alloc' in rule['names'])
        position = first['names'].index('pkey_alloc')
        rule = next(r for r in restored['syscalls'] if r['names'] == [n for n in first['names'] if n != 'pkey_alloc'])
        rule['names'].insert(position, 'pkey_alloc')
        self.assertEqual(canonical(restored), canonical(default))


class EngineTest(unittest.TestCase):
    def test_dockerfile_pins_what_the_runner_reports(self):
        text = dt.ENGINE_DOCKERFILE
        self.assertIn(f'ARG AGENT_DEVICE_VERSION={dt.AGENT_DEVICE_VERSION}\n', text)
        self.assertIn(f'ARG AGENT_BROWSER_VERSION={dt.AGENT_BROWSER_VERSION}\n', text)
        self.assertRegex(text, r'\nFROM mcr\.microsoft\.com/playwright:v[\d.]+-noble@sha256:[0-9a-f]{64}\n')
        self.assertRegex(text, r'ARG AGENT_DEVICE_SHA512=[0-9a-f]{128}\n')
        self.assertRegex(text, r'ARG AGENT_BROWSER_SHA512=[0-9a-f]{128}\n')
        self.assertEqual(len(re.findall(r'npm install ', text)), 2)
        self.assertEqual(len(re.findall(r'npm install [^\n]*--ignore-scripts', text)), 2)
        self.assertIn('sha512sum -c', text)

    def test_image_tag_is_the_dockerfile_hash(self):
        self.assertEqual(dt.IMAGE, 'tm8-device-test-engine:' + hashlib.sha256(dt.ENGINE_DOCKERFILE.encode()).hexdigest()[:12])


class SpecTest(unittest.TestCase):
    def test_web_check_screenshots_before_it_asserts(self):
        lines = dt.web_spec('one live graph').splitlines()
        self.assertLess(lines.index('screenshot "${OUT}/01-loaded.png"'), lines.index('wait text "${EXPECT_TEXT}" 20000'))
        self.assertEqual(lines[-1], 'close')
        self.assertEqual(dt.count_steps(dt.web_spec('one live graph')), 7)
        self.assertEqual(dt.count_steps(dt.web_spec('')), 6)

    def test_mobile_check(self):
        self.assertEqual(dt.count_steps(dt.mobile_spec('')), 4)
        self.assertEqual(dt.count_steps(dt.mobile_spec('Sign in')), 6)

    def test_step_count_matches_agent_device(self):
        # exp6: this script replayed as 6 steps
        spec = ('context timeout=90000\nopen "${TARGET_URL}"\nviewport ${VIEWPORT_W} ${VIEWPORT_H}\n'
                'wait text "${EXPECT_TEXT}" 20000\nscreenshot "${OUT}/viewport.png"\n'
                'screenshot "${OUT}/fullpage.png" --fullscreen\nclose\n')
        self.assertEqual(dt.count_steps(spec), 6)

    def test_expect_text_is_one_plain_line(self):
        self.assertEqual(dt.check_text('t', 'one live graph'), 'one live graph')
        for bad in ('two\nlines', 'a ${HOME} b', 'tab\there', 'nul\x00'):
            with self.assertRaises(ValueError):
                dt.check_text('t', bad)


class TargetTest(unittest.TestCase):
    def test_target(self):
        self.assertEqual(dt.check_target('https://tm8-hub.com/', 'web', False), 'tm8-hub.com')
        self.assertEqual(dt.check_target('http://127.0.0.1:17777/', 'web', False), '127.0.0.1')
        self.assertEqual(dt.check_target('com.example.app', 'android', True), 'com.example.app')
        for target, platform, suite in (('ftp://x.org/', 'web', False), ('com.example.app', 'web', True),
                                         ('com.example.app', 'ios', False), ('', 'web', False), ('https:///', 'web', False)):
            with self.assertRaises(ValueError):
                dt.check_target(target, platform, suite)

    def test_allowed_domains(self):
        self.assertEqual(dt.allowed_domains('tm8-hub.com', ['']), ['tm8-hub.com', '*.tm8-hub.com'])
        self.assertEqual(dt.allowed_domains('127.0.0.1', []), ['127.0.0.1'])
        self.assertEqual(dt.allowed_domains('localhost', []), ['localhost'])
        self.assertEqual(dt.allowed_domains('a.com', [' fonts.gstatic.com', '*.cdn.net', 'a.com']),
                         ['a.com', '*.a.com', 'fonts.gstatic.com', '*.cdn.net'])
        for bad in ('evil.com/path', 'a b', '*', 'x.com,y.com'):
            with self.assertRaises(ValueError):
                dt.allowed_domains('a.com', [bad])

    def test_plan_refusals(self):
        cases = [
            ['--target', 'http://127.0.0.1:17777/'],
            ['--platform', 'android', '--target', 'http://localhost:8080/'],
            ['--target', 'https://a.com/', '--profiles', 'tablet'],
            ['--target', 'https://a.com/', '--app', __file__],
            ['--target', 'https://a.com/', '--expect-text', 'a\nb'],
        ]
        for argv in cases:
            with clean_env(), self.subTest(argv=argv), self.assertRaises(ValueError):
                dt.plan(dt.parse_args(argv))

    def test_plan_accepts_loopback_on_host_network(self):
        with clean_env():
            p = dt.plan(dt.parse_args(['--target', 'http://127.0.0.1:17777/', '--network', 'host', '--profiles', 'pixel']))
        self.assertEqual(p.domains, ['127.0.0.1'])
        self.assertEqual([profile.name for profile in p.profiles], ['pixel'])


class ParseReplayTest(unittest.TestCase):
    variables = {'TARGET_URL': 'https://tm8-hub.com/', 'EXPECT_TEXT': 'not on this page', 'OUT': '/out'}

    def test_passed(self):
        outcome = dt.parse_replay(json.dumps(PASSED), 6, self.variables)
        self.assertEqual((outcome.result, outcome.steps_total, outcome.steps_passed), ('passed', 6, 6))
        self.assertEqual(outcome.summary, 'Replayed 6 steps in 8.3s')

    def test_divergence_is_a_product_failure_with_values_restored(self):
        outcome = dt.parse_replay(json.dumps(DIVERGED), 6, self.variables)
        self.assertEqual((outcome.result, outcome.steps_passed, outcome.steps_failed), ('failed', 2, 1))
        self.assertIn('step 3 (spec line 4)', outcome.failure)
        self.assertIn('wait "text" "not on this page" 5000', outcome.failure)
        self.assertIn('wait timed out for text: not on this page', outcome.failure)
        self.assertNotIn('<var:', outcome.failure)

    def test_anything_else_is_a_harness_error(self):
        for stdout in ('', 'Error: boom', '[]', json.dumps(NO_SESSION)):
            with self.subTest(stdout=stdout):
                self.assertEqual(dt.parse_replay(stdout, 6, self.variables).result, 'error')
        self.assertIn('SESSION_NOT_FOUND', dt.parse_replay(json.dumps(NO_SESSION), 6, {}).summary)


class ContainerTest(unittest.TestCase):
    def test_hardening_and_secrets_by_name(self):
        with clean_env(LIMRUN_API_KEY='sk-test-value', LIMRUN_REGION='eu'):
            inherited = dt.provider_env('android', 'limrun')
            argv = dt.container_argv('n', 'bridge', '/x/seccomp.json', [('/s', '/specs', 'ro')], [('A', 'b')], inherited,
                                     'true', ['arg'])
        self.assertEqual(inherited, ['LIMRUN_API_KEY', 'LIMRUN_REGION'])
        joined = ' '.join(argv)
        for flag in ('--cap-drop ALL', '--security-opt no-new-privileges', '--security-opt seccomp=/x/seccomp.json',
                     '--pids-limit 1024', '--memory 3g', '--network bridge', '-v /s:/specs:ro', '-e A=b',
                     '-e LIMRUN_API_KEY', f'--user {os.getuid()}:{os.getgid()}'):
            self.assertIn(flag, joined)
        self.assertNotIn('sk-test-value', joined)
        self.assertEqual(argv[argv.index(dt.IMAGE) + 1:], ['bash', '-c', 'true', 'device-test', 'arg'])

    def test_proxy_sees_only_its_token(self):
        with clean_env(LIMRUN_API_KEY='k', AGENT_DEVICE_DAEMON_AUTH_TOKEN='t'):
            self.assertEqual(dt.provider_env('ios', 'proxy'), ['AGENT_DEVICE_DAEMON_AUTH_TOKEN'])

    def test_mount_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(dt.check_mount('--app', tmp), os.path.realpath(tmp))
            bad = os.path.join(tmp, 'a:b')
            os.mkdir(bad)
            with self.assertRaises(ValueError):
                dt.check_mount('--app', bad)
            with self.assertRaises(ValueError):
                dt.check_mount('--app', os.path.join(tmp, 'missing'))


class ProviderTest(unittest.TestCase):
    def test_limrun_credentials(self):
        with clean_env():
            self.assertIn('LIMRUN_API_KEY', dt.provider_problem('android', 'limrun', '', ''))
        with clean_env(LIMRUN_API_KEY='k'):
            self.assertIsNone(dt.provider_problem('ios', 'limrun', '', ''))
        with clean_env(LIM_IOS_INSTANCE_URL='u', LIM_IOS_INSTANCE_TOKEN='t'):
            self.assertIsNone(dt.provider_problem('ios', 'limrun', '', ''))
            self.assertIn('LIMRUN_API_KEY', dt.provider_problem('ios', 'limrun', '', '/app.zip'))
        with clean_env(LIMRUN_API_KEY='k', LIM_ANDROID_INSTANCE_URL='u'):
            self.assertIn('partial', dt.provider_problem('android', 'limrun', '', ''))

    def test_proxy_and_none(self):
        with clean_env():
            self.assertIn('--proxy-url and AGENT_DEVICE_DAEMON_AUTH_TOKEN', dt.provider_problem('ios', 'proxy', '', ''))
            self.assertIn('no device provider', dt.provider_problem('ios', 'none', '', ''))
        with clean_env(AGENT_DEVICE_DAEMON_AUTH_TOKEN='t'):
            self.assertIsNone(dt.provider_problem('android', 'proxy', 'https://mac.example/agent-device', ''))


class BlockedTextTest(unittest.TestCase):
    """A blocked run names what this host lacks, with only the facts that bear on that platform."""

    def test_android_without_kvm_gives_the_host_facts(self):
        with mock.patch.object(dt.os.path, 'exists', return_value=False), \
                mock.patch.object(dt, 'local_device_facts', return_value=['/dev/kvm absent', 'a Hyper-V guest']):
            text = dt.blocked_text('android', 'no device provider chosen')
        self.assertIn('an Android emulator needs KVM, which this host does not have (/dev/kvm absent; a Hyper-V guest).',
                      text)
        self.assertIn('Options: Limrun Android', text)

    def test_ios_names_the_host_system_and_no_kvm_facts(self):
        with mock.patch.object(dt, 'local_device_facts', side_effect=AssertionError('KVM says nothing about iOS')), \
                mock.patch.object(dt.host_platform, 'system', return_value='Linux'), \
                mock.patch.object(dt.host_platform, 'release', return_value='6.8.0'):
            text = dt.blocked_text('ios', 'no device provider chosen')
        self.assertIn('iOS Simulators need macOS with Xcode, and this host runs Linux 6.8.0.', text)
        self.assertIn('Options: Limrun iOS', text)

    def test_the_hypervisor_is_named(self):
        detected = subprocess.CompletedProcess(['systemd-detect-virt'], 0, 'microsoft\n', '')
        with mock.patch.object(dt.shutil, 'which', return_value='/usr/bin/systemd-detect-virt'), \
                mock.patch.object(dt.subprocess, 'run', return_value=detected):
            self.assertIn('a Hyper-V guest', dt.local_device_facts())


class CliTest(unittest.TestCase):
    def test_journal_line_is_not_json(self):
        stdout = '{"id": "x", "version": {"to": 3}}\n[journal: ~47k est chars-over-4 this session]\n'
        self.assertEqual(dt.version_of(dt.parse_cli_json(stdout)), 3)
        self.assertEqual(dt.version_of({'version': 7}), 7)
        with self.assertRaises(RuntimeError):
            dt.version_of({'id': 'x'})

    def test_bad_arguments_exit_64(self):
        with clean_env():
            self.assertEqual(quiet_main(['--target', 'nope'], FakeRecorder()), 64)
            with self.assertRaises(SystemExit) as raised, contextlib.redirect_stderr(io.StringIO()):
                dt.main(['--platform', 'windows'], FakeRecorder())
            self.assertEqual(raised.exception.code, 64)

    def test_inputs_arrive_through_the_environment(self):
        with clean_env(DEVICE_TEST_TARGET='https://a.com/', DEVICE_TEST_PROFILES='iphone', DEVICE_TEST_RECORD='false',
                       DEVICE_TEST_TIMEOUT='42'):
            args = dt.parse_args([])
        self.assertEqual((args.target, args.profiles, args.record, args.timeout), ('https://a.com/', 'iphone', False, 42))


class RecorderSpaceTest(unittest.TestCase):
    """A tool run starts with TM8_TOOL_SESSION and no TM8_SPACE_ID: the recorder reads the Space once."""

    SPACE = '019fbd5a-3c5b-71ea-9b91-1d3baa50da25'

    def calls(self, env, session_reply=None):
        seen = []

        def fake_run(argv, input=None, env=None, **kwargs):
            seen.append((argv[1:-2], env.get('TM8_SPACE_ID')))
            if argv[1:3] == ['entity', 'get']:
                reply = session_reply or {'id': argv[3], 'kind': 'session', 'state': {'toolRun': {'spaceId': self.SPACE}}}
            else:
                reply = {'id': 'run-1', 'version': {'to': 1}}
            return subprocess.CompletedProcess(argv, 0, json.dumps(reply) + '\n[journal: ~1k]\n', '')

        recorder = dt.Recorder()
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(dt.subprocess, 'run', side_effect=fake_run):
            recorder.call(['entity', 'create', 'c:test_run', 'one'])
            recorder.call(['message', 'send', '--to', 'task', '-'], stdin='body')
        return seen

    def test_a_tool_run_reads_its_space_from_the_tool_session_once(self):
        self.assertEqual(self.calls({'TM8_TOOL_SESSION': 'tool-session-1'}),
                         [(['entity', 'get', 'tool-session-1'], None),
                          (['entity', 'create', 'c:test_run', 'one'], self.SPACE),
                          (['message', 'send', '--to', 'task', '-'], self.SPACE)])

    def test_a_space_from_the_host_or_outside_a_tool_run_is_left_to_the_cli(self):
        self.assertEqual(self.calls({'TM8_TOOL_SESSION': 'tool-session-1', 'TM8_SPACE_ID': 'host-space'}),
                         [(['entity', 'create', 'c:test_run', 'one'], 'host-space'),
                          (['message', 'send', '--to', 'task', '-'], 'host-space')])
        self.assertEqual(self.calls({}), [(['entity', 'create', 'c:test_run', 'one'], None),
                                          (['message', 'send', '--to', 'task', '-'], None)])

    def test_a_tool_session_that_names_no_space_is_an_error(self):
        with self.assertRaisesRegex(RuntimeError, 'tool session tool-session-1 names no Space'):
            self.calls({'TM8_TOOL_SESSION': 'tool-session-1'}, session_reply={'id': 'tool-session-1', 'state': {}})


class ToolSpecTest(unittest.TestCase):
    """tool.json is how tm8 runs this file: each input must reach the runner under the name it reads."""

    # packages/contract/src/tools.ts: tm8 refuses these as tool input environment names.
    RESERVED_NAMES = {'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TERM', 'COLORTERM', 'LANG', 'TMPDIR', 'ENV',
                      'BASH_ENV', 'IFS', 'CDPATH', 'GLOBIGNORE', 'SHELLOPTS', 'BASHOPTS', 'PS4', 'PROMPT_COMMAND',
                      'PWD', 'OLDPWD'}
    RESERVED_PREFIXES = ('TM8_', 'LD_', 'DYLD_', 'BASH_FUNC_', 'PYTHON', 'LC_')
    SAMPLE = {'string': 'x', 'path': '/tmp', 'int': 42, 'bool': False}

    def setUp(self):
        self.spec = json.loads((HERE / 'tool.json').read_text())
        self.inputs = {item['name']: item for item in self.spec['inputs']}
        self.options = {action.dest: action for action in dt.build_parser()._actions
                        if action.option_strings and action.dest not in ('help', 'print_dockerfile', 'print_seccomp')}

    def test_every_option_is_an_input_with_its_flag_and_variable(self):
        runner = {name for name, item in self.inputs.items() if item['env'].startswith('DEVICE_TEST_')}
        self.assertEqual(runner, set(self.options))
        for name, action in self.options.items():
            item = self.inputs[name]
            self.assertEqual('--' + item.get('flag', name.replace('_', '-')), action.option_strings[0])
            self.assertEqual(item['env'], 'DEVICE_TEST_' + name.upper())
            with clean_env():
                default = dt.parse_args([]).__dict__[name]
            if 'default' in item:
                self.assertEqual(item['default'], default, name)
            if item['type'] == 'enum':
                self.assertEqual(item['options'], list(action.choices), name)
            value = item['options'][-1] if item['type'] == 'enum' else self.SAMPLE[item['type']]
            with clean_env(**{item['env']: str(value).lower() if isinstance(value, bool) else str(value)}):
                self.assertEqual(dt.parse_args([]).__dict__[name], value, f'{item["env"]} is not read')

    def test_provider_inputs_and_secrets(self):
        provider = {item['env']: item['type'] for item in self.spec['inputs'] if not item['env'].startswith('DEVICE_TEST_')}
        instance = [name for names in dt.LIMRUN_INSTANCE_ENV.values() for name in names]
        self.assertEqual(set(provider), {'LIMRUN_API_KEY', 'LIMRUN_REGION', dt.PROXY_TOKEN_ENV, *instance})
        secrets = {env for env, kind in provider.items() if kind == 'secret'}
        self.assertEqual(secrets, {'LIMRUN_API_KEY', dt.PROXY_TOKEN_ENV, *(n for n in instance if n.endswith('_TOKEN'))})

    def test_names_tm8_accepts(self):
        flags = [item.get('flag', name.replace('_', '-')) for name, item in self.inputs.items()]
        self.assertEqual(len(flags), len(set(flags)))
        self.assertLessEqual(len(self.inputs), 64)
        for name, item in self.inputs.items():
            self.assertRegex(name, r'^[a-z][a-z0-9_]{0,63}$')
            self.assertNotIn(item['env'].upper(), self.RESERVED_NAMES)
            self.assertFalse(item['env'].upper().startswith(self.RESERVED_PREFIXES), item['env'])
        self.assertEqual(self.spec['tm8Access'], 'write')
        # The first run builds the engine (up to 1200s), then each web profile gets 300s.
        self.assertGreaterEqual(self.spec['timeoutSeconds'], 1200 + len(dt.PROFILES) * 300)


class MainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_mobile_without_a_provider_is_blocked_with_evidence(self):
        recorder = FakeRecorder()
        with clean_env():
            code = quiet_main(['--platform', 'ios', '--target', 'https://tm8-hub.com/', '--task', 'task-1',
                               '--out', self.tmp.name], recorder)
        self.assertEqual(code, 3)
        run_id, title, fields = recorder.updates[-1]
        self.assertEqual(fields['result'], 'blocked')
        self.assertEqual(title, 'ios · tm8-hub.com · no device — blocked')
        self.assertEqual(fields['engine'], f'agent-device {dt.AGENT_DEVICE_VERSION}')
        self.assertIn('iOS Simulators need macOS with Xcode', fields['blocker'])
        self.assertNotIn('/dev/kvm', fields['blocker'])
        self.assertIn('Limrun iOS', fields['blocker'])
        self.assertEqual(recorder.created[0][2], 'task-1')
        self.assertEqual(recorder.posts[0][0], 'task-1')
        self.assertIn('- **ios**: **blocked**', recorder.posts[0][1])
        report = json.loads(pathlib.Path(self.tmp.name, 'report.json').read_text())
        self.assertEqual(report[0]['result'], 'blocked')

    def test_web_run_records_screenshots_and_verdict(self):
        recorder, seen = FakeRecorder(), {}

        def fake_container(argv, name, timeout):
            out = next(a.split(':')[0] for a in argv if a.endswith(':/out:rw'))
            seen.setdefault('argv', argv)
            pathlib.Path(out, '01-loaded.png').write_bytes(b'\x89PNG')
            pathlib.Path(out, '02-full-page.png').write_bytes(b'\x89PNG')
            pathlib.Path(out, 'replay.json').write_text(json.dumps({**PASSED, 'data': {**PASSED['data'], 'replayed': 7}}))
            return 0, 4321, ''

        with clean_env(), mock.patch.object(dt, 'docker_problem', return_value=None), \
                mock.patch.object(dt, 'ensure_image'), mock.patch.object(dt, 'run_container', side_effect=fake_container):
            code = quiet_main(['--target', 'https://tm8-hub.com/', '--expect-text', 'one live graph', '--profiles',
                               'desktop,pixel', '--task', 'task-1', '--out', self.tmp.name], recorder)
        self.assertEqual(code, 0)
        self.assertEqual(len(recorder.created), 2)
        self.assertEqual({fields['result'] for _, fields, _ in recorder.created}, {'queued'})
        states = [(run_id, fields['result']) for run_id, _, fields in recorder.updates]
        self.assertEqual([state for run_id, state in states if run_id == states[0][0]], ['running', 'passed'])
        finals = {run_id: fields for run_id, _, fields in recorder.updates}
        self.assertTrue(all(fields['started_at'] <= fields['finished_at'] for fields in finals.values()))
        self.assertEqual({fields['result'] for fields in finals.values()}, {'passed'})
        self.assertEqual({fields['viewport'] for fields in finals.values()}, {'1280×900', '412×915'})
        self.assertEqual(len(recorder.uploads), 4)
        self.assertEqual(recorder.posts[0][2], ['file-1', 'file-2', 'file-3', 'file-4'])
        self.assertIn('2 passed', recorder.posts[0][1])
        argv = seen['argv']
        seccomp = argv[argv.index('--security-opt', argv.index('no-new-privileges')) + 1].split('=', 1)[1]
        self.assertEqual(json.loads(pathlib.Path(seccomp).read_text()), dt.chrome_seccomp_profile())
        self.assertIn('AGENT_BROWSER_ALLOWED_DOMAINS=tm8-hub.com,*.tm8-hub.com', argv)
        self.assertIn('EXPECT_TEXT=one live graph', argv)

    def test_a_missing_engine_is_an_error_not_a_verdict(self):
        recorder = FakeRecorder()
        with clean_env(), mock.patch.object(dt, 'docker_problem', return_value='docker is not installed on this host'):
            code = quiet_main(['--target', 'https://a.com/', '--out', self.tmp.name], recorder)
        self.assertEqual(code, 2)
        self.assertEqual(recorder.updates[-1][2]['result'], 'error')
        self.assertIn('docker is not installed', recorder.updates[-1][2]['failure'])

    def test_worst_result_wins(self):
        self.assertEqual(max(['passed', 'failed', 'blocked'], key=dt.SEVERITY.index), 'failed')
        self.assertEqual(max(['failed', 'error'], key=dt.SEVERITY.index), 'error')


if __name__ == '__main__':
    unittest.main()
