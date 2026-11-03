"""Offline runner acceptance: real subprocesses, recorded CLI events, no model calls."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests' / 'fixtures'
RUNS = ROOT / 'runs'
sys.path.insert(0, str(ROOT / 'scripts'))
from progress import Progress
from run_cli import task_identity, parse_cursor

HELP = ('--json --sandbox --output-last-message --config --model --print --session-dir '
        '--session --tools --no-mcp --thinking --approve --no-approve --output-format '
        '--mode --force --resume --trust --stream-partial-output')

# Only the unavailable external CLI discovery/catalog and home directory are substituted.
# Parsing, argv construction, process management, polling and persistence run unchanged.
def offline_runner():
    script = Path(sys.argv[2])
    sys.path.insert(0, str(script.parent))
    spec = importlib.util.spec_from_file_location('offline_target', script)
    target = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(target)
    target.inspect_cli = lambda agent, cwd: {
        'available': True, 'agent': agent, 'executable': os.environ['TEST_CLI'],
        'version': 'offline fixture', 'help': HELP, 'exec_help': HELP, 'resume_help': HELP}

    def unavailable(*args):
        raise RuntimeError('offline catalog unavailable')

    target.list_models = unavailable
    target.Path.home = classmethod(lambda cls: Path(os.environ['TEST_HOME']))
    sys.argv = [str(script)] + sys.argv[3:]
    return target.main()


FAKE_CLI = r'''
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

if os.environ.get('TEST_CANCEL'):
    root = Path(os.environ['TEST_HOME'])
    child = '--child' in sys.argv
    name = 'child' if child else 'parent'
    def stopped(signum, frame):
        (root / (name + '.stopped')).write_text(str(os.getpid()))
        sys.exit(0)
    signal.signal(signal.SIGTERM, stopped)
    if not child:
        subprocess.Popen([sys.executable, __file__, '--child'])
    (root / (name + '.ready')).write_text(str(os.getpid()))
    while True:
        time.sleep(0.05)
else:
    for line in Path(os.environ['TEST_FIXTURE']).read_text().splitlines():
        print(line, flush=True)
        time.sleep(float(os.environ.get('TEST_DELAY', '0')))
'''


class RunnerTests(unittest.TestCase):
    def setUp(self):
        RUNS.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=str(RUNS))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.prompt = self.root / 'input.md'
        self.handoff = '说明\r\n目标： 完成离线测试  \r\n\r\n保留末尾空白  '
        self.prompt.write_bytes(self.handoff.encode('utf-8'))
        self.cli = self.root / 'fixture-cli'
        self.cli.write_text('#!' + sys.executable + '\n' + FAKE_CLI)
        self.cli.chmod(0o700)
        self.env = dict(os.environ, TEST_CLI=str(self.cli), TEST_HOME=str(self.root),
                        TEST_FIXTURE=str(FIXTURES / 'cursor-partial.jsonl'))

    def command(self, agent='cursor', extra=(), script=None):
        return [sys.executable, str(Path(__file__).resolve()), '--offline-runner',
                str(script or ROOT / 'scripts' / 'run_cli.py'), 'run', '--agent', agent,
                '--cwd', str(ROOT), '--prompt-file', str(self.prompt),
                '--run-root', str(self.root / 'jobs'), *extra]

    def run_offline(self, agent='cursor', extra=(), script=None):
        result = subprocess.run(self.command(agent, extra, script), env=self.env,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout, json.loads(result.stdout.splitlines()[-1])

    def progress(self, agent):
        meta = {'agent': agent, 'run_dir': str(self.root), 'cwd': '/private/tmp/dcli-partial.DDph',
                'access': 'read'}
        return Progress(meta), meta

    def events(self, filename):
        return [json.loads(line) for line in (FIXTURES / filename).read_text().splitlines()]

    def test_title_goal(self):
        self.assertEqual(task_identity('\n开头\n目标： 目标全文  \n目标:忽略', None),
                         ('目标全文', '目标全文'))
        self.assertEqual(task_identity('目标:英文冒号', None), ('英文冒号', '英文冒号'))
        self.assertEqual(task_identity('\n  首行非空  \n后续', None), ('首行非空', ''))
        self.assertEqual(task_identity('目标：' + '长' * 41, None), ('长' * 40 + '…', '长' * 41))
        self.assertEqual(task_identity('长' * 40, None), ('长' * 40, ''))
        self.assertEqual(task_identity('长' * 41, None), ('长' * 40 + '…', ''))
        self.assertEqual(task_identity('目标：内容', '  指定标题  '), ('指定标题', '内容'))
        self.assertEqual(task_identity('目标：内容', '   '), ('内容', '内容'))
        self.assertEqual(task_identity('目标：内容', ''), ('内容', '内容'))  # Empty --title means none.
        self.assertEqual(task_identity('目标：内容', '显' * 41), ('显' * 40 + '…', '内容'))

    def test_handoff_stdout_and_result(self):
        output, meta = self.run_offline()
        lines = output.splitlines()
        self.assertEqual(json.loads(lines[0])['status'], 'running')
        self.assertEqual(meta['status'], 'process_succeeded')
        self.assertEqual(meta['title'], '完成离线测试')
        self.assertEqual(meta['goal'], '完成离线测试')
        self.assertEqual(lines[1], '── 任务：完成离线测试 ──')
        block = '── 任务：完成离线测试 ──\n' + self.handoff.replace('\r\n', '\n') + '\n── 进度 ──\n'
        self.assertIn(block, output)
        self.assertIn('● cursor', output.split('── 进度 ──\n', 1)[1])
        self.assertTrue(Path(meta['handoff_file']).is_absolute())
        self.assertEqual(Path(meta['handoff_file']).read_bytes(), self.prompt.read_bytes())
        task = (Path(meta['run_dir']) / 'task.md').read_bytes()
        self.assertTrue(task.endswith(self.prompt.read_bytes()))
        self.assertIn(b'Delegated subtask:', task)
        self.assertIsNone(meta['activity'])
        self.assertEqual(meta['live_text'], '')
        self.assertIsNone(meta['task'])
        expected = '- `a.txt` 有两行，分别是 `alpha` 和 `beta`。\n- `b.txt` 只有一行，内容是 `gamma`。\n- 两个文件都是纯文本，每行一个英文单词。\n\n完成\n'
        self.assertEqual(Path(meta['result_file']).read_text(), expected)
        log = Path(meta['progress_file']).read_text()
        self.assertEqual(log.count('💬'), 2)
        self.assertIn('--stream-partial-output', meta['argv'])

    def test_quiet(self):
        output, meta = self.run_offline(extra=['--quiet', '--title', '指定'])
        self.assertEqual(len(output.splitlines()), 2)
        self.assertEqual(meta['title'], '指定')

    def test_task_recorded_and_kept_on_resume(self):
        _, first = self.run_offline(extra=['--quiet', '--task', ' T2 '])
        self.assertEqual(first['task'], 'T2')
        saved = json.loads((Path(first['run_dir']) / 'run.json').read_text())
        self.assertEqual(saved['task'], 'T2')
        _, resumed = self.run_offline(extra=['--quiet', '--resume-from', str(Path(first['run_dir']) / 'run.json')])
        self.assertEqual(resumed['task'], 'T2')
        self.assertNotEqual(resumed['run_dir'], first['run_dir'])
        _, moved = self.run_offline(extra=['--quiet', '--task', 'T3', '--resume-from', str(Path(resumed['run_dir']) / 'run.json')])
        self.assertEqual(moved['task'], 'T3')

    def test_bad_task_is_blocked_before_a_run_directory(self):
        result = subprocess.run(self.command(extra=['--task', 'T2; rm -rf /']), env=self.env,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        blocked = json.loads(result.stdout.splitlines()[-1])
        self.assertEqual(blocked['status'], 'blocked')
        self.assertIn('--task', blocked['error'])
        self.assertEqual(blocked['task'], 'T2; rm -rf /')
        self.assertFalse((self.root / 'jobs').exists())

    def test_cursor_activity_and_partial_replay(self):
        progress, meta = self.progress('cursor')
        self.assertEqual(meta['activity']['kind'], 'waiting')
        seen = set()
        for event in self.events('cursor-partial.jsonl'):
            before = dict(meta['activity'])
            progress.cursor(event)
            activity = meta['activity']
            seen.add(activity['kind'])
            self.assertIsInstance(activity['since'], float)
            if (before['kind'], before['label']) == (activity['kind'], activity['label']):
                self.assertEqual(before['since'], activity['since'])
            if event['type'] == 'thinking':
                self.assertEqual(activity['kind'], 'thinking' if event['subtype'] == 'delta' else 'waiting')
            elif event['type'] == 'assistant':
                if 'timestamp_ms' in event and 'model_call_id' not in event:
                    self.assertTrue(meta['live_text'])
                    self.assertEqual(activity['kind'], 'writing')
                else:
                    self.assertEqual(meta['live_text'], '')
                    self.assertEqual(activity['kind'], 'waiting')
            elif event['type'] == 'tool_call':
                self.assertEqual(activity['kind'], 'tool' if progress.tools else 'waiting')
                if progress.tools:
                    self.assertIn(activity['label'], ('read a.txt', 'read b.txt'))
        self.assertEqual(seen, {'waiting', 'thinking', 'writing', 'tool'})
        self.assertEqual(progress.path.read_text().count('💬'), 2)
        self.assertEqual(meta['live_text'], '')

    def test_cursor_plain_and_incomplete_tail(self):
        progress, meta = self.progress('cursor')
        events = self.events('cursor-plain.jsonl')
        for event in events:
            progress.cursor(event)
        self.assertEqual(meta['live_text'], '')
        self.assertEqual(progress.path.read_text().count('💬'),
                         sum(event['type'] == 'assistant' for event in events))
        path = self.root / 'tail.jsonl'
        path.write_text(json.dumps({'type': 'assistant', 'message': {'content': [
            {'type': 'text', 'text': '完整回答'}]}}) + '\n' + json.dumps({
            'type': 'assistant', 'timestamp_ms': 1, 'message': {'content': [
                {'type': 'text', 'text': '未完成片段'}]}}) + '\n')
        self.assertEqual(parse_cursor(path)[2], '完整回答')

    def test_codex_and_pi_activity(self):
        for agent, fixture in [('codex', 'codex-events.jsonl'), ('pi', 'pi-session.jsonl')]:
            with self.subTest(agent=agent):
                progress, meta = self.progress(agent)
                states = set()
                for event in self.events(fixture):
                    if agent == 'codex':
                        progress.codex(event)
                    else:
                        progress.pi(event, FIXTURES / fixture)
                    states.add(meta['activity']['kind'])
                    self.assertEqual(meta['activity']['kind'], 'tool' if progress.tools else 'waiting')
                    self.assertEqual(meta['live_text'], '')
                self.assertEqual(states, {'tool', 'waiting'})
                self.assertEqual(meta['activity']['kind'], 'waiting')
                if agent == 'codex':
                    self.assertIn('▶ shell wc -l < notes.txt', progress.path.read_text())

    def start_runner(self, **env):
        process = subprocess.Popen(self.command(), env=dict(self.env, **env),
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        def cleanup():
            if process.poll() is None:
                process.terminate()
            process.communicate(timeout=10)
        self.addCleanup(cleanup)
        first = json.loads(process.stdout.readline())
        return process, Path(first['run_file'])

    def test_live_text_persisted_during_run(self):
        process, path = self.start_runner(TEST_DELAY='0.02')
        seen = False
        deadline = time.monotonic() + 10
        while process.poll() is None and time.monotonic() < deadline:
            meta = json.loads(path.read_text())
            if meta['live_text']:
                seen = True
                self.assertEqual(meta['activity']['kind'], 'writing')
            time.sleep(0.02)
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0, stdout + stderr)
        self.assertTrue(seen)
        meta = json.loads(path.read_text())
        self.assertEqual(meta['live_text'], '')
        self.assertIsNone(meta['activity'])

    def test_sigterm_cancels_process_group(self):
        process, path = self.start_runner(TEST_CANCEL='1')
        deadline = time.monotonic() + 5
        while not (self.root / 'child.ready').exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue((self.root / 'child.ready').exists())
        process.send_signal(signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=8)
        self.assertEqual(process.returncode, 1, stdout + stderr)
        meta = json.loads(path.read_text())
        self.assertEqual(meta['status'], 'cancelled')
        self.assertIsNone(meta['activity'])
        self.assertEqual(meta['live_text'], '')
        self.assertIn('● cancelled', Path(meta['progress_file']).read_text())
        self.assertEqual(json.loads(stdout.splitlines()[-1])['status'], 'cancelled')
        for name in ('parent', 'child'):
            self.assertTrue((self.root / (name + '.stopped')).exists(), name)
        self.assertEqual(meta['runner_pid'], process.pid)

    def test_cursor_requires_partial_flag(self):
        from run_cli import build_command
        with self.assertRaisesRegex(RuntimeError, '--stream-partial-output'):
            build_command(SimpleNamespace(agent='cursor'),
                          {'executable': str(self.cli), 'help': HELP.replace(
                              '--stream-partial-output', '--stream-partial-output-other')},
                          self.root, None, {'model': None, 'thinking': None})

    def test_dry_run_argv_regression(self):
        old = ROOT.parent / 'delegate-cli' / 'scripts' / 'run_cli.py'
        if not old.exists():
            self.skipTest('Baseline checkout unavailable: ' + str(old))
        cases = [('codex', ['--access', 'read']),
                 ('codex', ['--access', 'write', '--model', 'gpt-6-astra', '--thinking', 'high']),
                 ('pi', ['--access', 'read']),
                 ('pi', ['--access', 'write', '--model', 'deepseek/deepseek-flash',
                         '--thinking', 'medium', '--pi-trust', 'approved'])]
        for agent, flags in cases:
            with self.subTest(agent=agent, flags=flags):
                _, before = self.run_offline(agent, flags + ['--dry-run'], old)
                _, after = self.run_offline(agent, flags + ['--dry-run'])
                self.assertEqual(before['model_check'], after['model_check'])
                if '--model' in flags:
                    self.assertTrue(after['model_check'].startswith('unavailable:'))
                else:
                    self.assertEqual(after['model_check'], 'not_requested')
                normalized = lambda meta: [arg.replace(meta['run_dir'], '<RUN>') for arg in meta['argv']]
                self.assertEqual(normalized(before), normalized(after))

    def test_python39_syntax(self):
        for filename in ('scripts/run_cli.py', 'scripts/progress.py', 'tests/test_runner.py'):
            ast.parse((ROOT / filename).read_text(), feature_version=(3, 9))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--offline-runner':
        sys.exit(offline_runner())
    unittest.main()
