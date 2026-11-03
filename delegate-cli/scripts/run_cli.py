#!/usr/bin/env python3
"""Run one Codex/Pi/Cursor job; keep transport status separate from task verification.

Python 3.9+, macOS/Linux/WSL. No API keys or third-party Python packages needed.
"""
import argparse
import difflib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import shlex
from progress import Progress, cursor_partial

AGENTS = ('codex', 'pi', 'cursor')
EXECUTABLES = {'codex': 'codex', 'pi': 'pi', 'cursor': 'cursor-agent'}
MODEL_LIST_ARGS = {'codex': ['debug', 'models'], 'pi': ['--list-models'], 'cursor': ['models']}
SKILL_DIR = Path(__file__).resolve().parent.parent
EFFORTS = ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
SESSION_ID = re.compile(r'[A-Za-z0-9_-]+')
# A blueprint task ID as the panel's blueprint tool assigns it (T1, T2-review).
TASK_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}')
# Known refusals that are environment preconditions, not code failures.
BLOCKERS = (
    ('Workspace Trust Required', 'Cursor workspace is not trusted; add --cursor-trust approved '
     'only when the user has authorized trusting this directory'),
    ('Not inside a trusted directory', 'Codex refuses a non-Git/untrusted directory; add '
     '--skip-git-check when running outside a Git repository is intended'),
    ('model is not supported', 'The CLI account rejected the model; list valid IDs with doctor --models'),
)


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def save(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temp.replace(path)


def inspect_cli(agent, cwd):
    executable = shutil.which(EXECUTABLES[agent])
    if not executable:
        return {'agent': agent, 'available': False, 'error': EXECUTABLES[agent] + ' not found on PATH'}
    info = {'agent': agent, 'available': True, 'executable': executable}
    commands = {'version': ['--version'], 'help': ['--help']}
    if agent == 'codex':
        commands.update(exec_help=['exec', '--help'], resume_help=['exec', 'resume', '--help'])
    for key, args in commands.items():
        result = subprocess.run([executable, *args], cwd=cwd, capture_output=True,
                                text=True, encoding='utf-8', errors='replace', timeout=20)
        info[key] = (result.stdout + result.stderr).strip()
        if result.returncode:
            raise RuntimeError(agent + ' ' + ' '.join(args) + ' failed; inspect CLI configuration')
    return info


def require_flags(help_text, flags):
    missing = [flag for flag in flags if not re.search(re.escape(flag) + r'(?![\w-])', help_text)]
    if missing:
        raise RuntimeError('Installed CLI does not advertise: ' + ', '.join(missing))


def load_models_config():
    path = SKILL_DIR / 'models.json'
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except ValueError as error:
        raise ValueError('models.json is not valid JSON: ' + str(error))


def list_models(agent, info, cwd):
    """Return ({model_id: thinking levels or None}, raw text) from the CLI's own catalog."""
    result = subprocess.run([info['executable'], *MODEL_LIST_ARGS[agent]], cwd=cwd, capture_output=True,
                            text=True, encoding='utf-8', errors='replace', timeout=60)
    if result.returncode:
        raise RuntimeError('model list failed: ' + (result.stderr or result.stdout).strip()[:200])
    models = {}
    if agent == 'codex':
        for item in json.loads(result.stdout).get('models', []):
            if isinstance(item, dict) and item.get('slug'):
                levels = [level.get('effort') if isinstance(level, dict) else level
                          for level in item.get('supported_reasoning_levels') or []]
                models[item['slug']] = [level for level in levels if level] or None
    elif agent == 'pi':
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0] != 'provider':
                models[parts[0] + '/' + parts[1]] = None
    else:
        for line in result.stdout.splitlines():
            match = re.match(r'^(\S+) - ', line.strip())
            if match:
                models[match.group(1)] = None
    if not models:
        raise RuntimeError('model list was empty or unreadable')
    return models, result.stdout


def normalize(text):
    return re.sub(r'[^a-z0-9]', '', str(text).lower())


def lookup(table, name):
    """Alias lookup that ignores case and punctuation: grok4.7 == Grok-4.7."""
    if not isinstance(table, dict) or not name:
        return None
    if name in table:
        return table[name]
    key = normalize(name)
    for alias, target in table.items():
        if normalize(alias) == key:
            return target
    return None


def match_model(name, catalog, aliases):
    if catalog is not None and name in catalog:
        return name
    target = lookup(aliases, name)
    if target or catalog is None:
        return target or name
    key = normalize(name)
    for candidates in ([m for m in catalog if normalize(m) == key],
                       [m for m in catalog if normalize(m.split('/')[-1]) == key]):
        if len(candidates) == 1:
            return candidates[0]
    return None


def unknown_model(agent, name, catalog):
    pool = list(catalog or [])
    key = normalize(name)
    near = [m for m in pool if key and key in normalize(m)][:5] + difflib.get_close_matches(name, pool, n=5, cutoff=0.4)
    hint = ' Did you mean: ' + ', '.join(list(dict.fromkeys(near))[:6]) + '?' if near else ''
    return ValueError('Unknown ' + agent + " model '" + name + "'." + hint +
                      ' List IDs with: run_cli.py doctor --agent ' + agent + ' --models')


def effort_parts(model_id):
    """Split a Cursor ID into (family, effort, fast); the family marks the effort's place with *.

    gpt-5.5-extra-high-fast -> (gpt-5.5-*, xhigh, True); claude-4.6-opus-max-thinking ->
    (claude-4.6-opus-*-thinking, max, False); gpt-5.2-fast -> (gpt-5.2-*, None, True).
    """
    tokens = model_id.split('-')
    fast = len(tokens) > 1 and tokens[-1] == 'fast'
    if fast:
        tokens = tokens[:-1]
    for i in range(len(tokens) - 1, 0, -1):
        if tokens[i] == 'high' and tokens[i - 1] == 'extra' and i > 1:
            return '-'.join(tokens[:i - 1] + ['*'] + tokens[i + 1:]), 'xhigh', fast
        if tokens[i] in EFFORTS:
            return '-'.join(tokens[:i] + ['*'] + tokens[i + 1:]), tokens[i], fast
    return '-'.join(tokens + ['*']), None, fast


def cursor_effort(model, thinking, catalog):
    """Cursor encodes effort in the ID: pick the same family and speed at the asked effort."""
    family, _, fast = effort_parts(model)
    effort = 'xhigh' if thinking == 'extra-high' else thinking
    if catalog is None:
        return family.replace('*', effort) + ('-fast' if fast else '')
    members = {}
    for candidate in catalog:
        cand_family, cand_effort, cand_fast = effort_parts(candidate)
        if cand_family == family:
            members[(cand_effort, cand_fast)] = candidate
    if (effort, fast) in members:
        return members[(effort, fast)]
    levels = sorted({e for e, f in members if f == fast and e}, key=EFFORTS.index)
    raise ValueError("Cursor model family '" + family.replace('-*', '') + "' has no " + effort +
                     (' fast' if fast else '') + ' variant' +
                     ('; available: ' + ', '.join(levels) if levels else '; list IDs with doctor --models'))


def resolve_model(args, info, cwd, config):
    """Turn shorthand (astra, grok4.7 + 中) into exact IDs before any model is called."""
    agent = args.agent
    aliases = (config.get('aliases') or {}).get(agent) or {}
    default = ((config.get('defaults') or {}).get(agent) or {}).get('model')
    thinking = args.thinking
    if thinking:
        thinking = (lookup(config.get('thinking'), thinking) or thinking).strip().lower()
    plan = {'model': None, 'thinking': thinking, 'model_check': 'not_requested', 'models_text': None}
    requested = args.model or default
    if not requested:
        return plan  # Keep the CLI's own configured default model.
    try:
        catalog, plan['models_text'] = list_models(agent, info, cwd)
        plan['model_check'] = 'verified'
    except (RuntimeError, ValueError, OSError, subprocess.TimeoutExpired) as error:
        catalog = None
        plan['model_check'] = 'unavailable: ' + str(error)[:200]
    if agent == 'cursor' and '[' in requested:
        # A parameterized ID carries its own effort: claude-opus-4-8[context=1m,effort=high].
        base = requested.split('[', 1)[0]
        if thinking:
            raise ValueError('Put the effort inside the brackets instead: ' + base + '[effort=' + thinking + ']')
        if catalog is not None and not any(effort_parts(m)[0] == effort_parts(base)[0] for m in catalog):
            raise unknown_model(agent, base, catalog)
        plan.update(model=requested, thinking=None)
        return plan
    model = match_model(requested, catalog, aliases)
    if agent == 'cursor' and thinking:
        model = cursor_effort(model or requested, thinking, catalog)
        plan['thinking'] = None
    if not model or (catalog is not None and model not in catalog):
        raise unknown_model(agent, model or requested, catalog)
    if agent == 'codex' and thinking and catalog is not None and catalog.get(model):
        if thinking not in catalog[model]:
            raise ValueError('Codex model ' + model + ' supports thinking: ' + ', '.join(catalog[model]))
    plan['model'] = model
    return plan


def resume_session(previous):
    session_id = previous.get('session_id')
    if not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id):
        raise RuntimeError('Prior run has no usable explicit session ID')
    return session_id


def build_command(args, info, run_dir, previous, plan):
    command = [info['executable']]
    model, thinking = plan['model'], plan['thinking']
    if args.agent == 'codex':
        flags = ['--json', '--sandbox', '--output-last-message', '--config']
        require_flags(info['exec_help'], flags + (['--skip-git-repo-check'] if args.skip_git_check else []))
        command += ['exec', '--sandbox', 'read-only' if args.access == 'read' else 'workspace-write',
                    '-c', 'approval_policy="never"', '--json',
                    '--output-last-message', str(run_dir / 'result.md')]
        if args.skip_git_check:
            command += ['--skip-git-repo-check']
        if model:
            require_flags(info['exec_help'], ['--model'])
            command += ['--model', model]
        if thinking:
            command += ['-c', 'model_reasoning_effort=' + json.dumps(thinking)]
        if previous:
            command += ['resume', resume_session(previous)]
        command += ['-']  # The task goes through stdin, never shell interpolation.
    elif args.agent == 'pi':
        require_flags(info['help'], ['--print', '--session-dir', '--session', '--tools'])
        command += ['--print']
        if previous:
            session_file = previous.get('session_file')
            if not session_file or not Path(session_file).is_file():
                raise RuntimeError('Prior run has no existing Pi session file')
            command += ['--session', str(Path(session_file).resolve())]
        else:
            command += ['--session-dir', str(run_dir / 'sessions')]
        if args.access == 'read':
            command += ['--tools', 'read,grep,find,ls']
            if '--no-mcp' in info['help']:
                command += ['--no-mcp']
        if model:
            require_flags(info['help'], ['--model'])
            command += ['--model', model]
        if thinking:
            require_flags(info['help'], ['--thinking'])
            command += ['--thinking', thinking]
        if args.pi_trust != 'existing':
            flag = '--approve' if args.pi_trust == 'approved' else '--no-approve'
            require_flags(info['help'], [flag])
            command += [flag]
    else:
        require_flags(info['help'], ['--print', '--output-format', '--mode', '--force', '--resume', '--trust',
                                     '--stream-partial-output'])
        command += ['--print', '--output-format', 'stream-json', '--stream-partial-output']
        if model:
            command += ['--model', model]
        # ask is Cursor's read-only mode; --force applies edits and runs commands (it also implies trust).
        command += ['--mode', 'ask'] if args.access == 'read' else ['--force']
        if args.cursor_trust == 'approved':
            command += ['--trust']
        if previous:
            command += ['--resume', resume_session(previous)]
        # The task goes through stdin, never argv: argv is visible in the process list.
    return command


def read_jsonl(path, counters):
    if not path.exists():
        return
    with path.open(encoding='utf-8', errors='replace') as stream:
        for line in stream:
            if not line.strip():
                continue
            try:
                event = json.loads(line)
                if not isinstance(event, dict):
                    raise ValueError('event must be an object')
            except ValueError:
                counters['invalid_event_lines'] += 1
                continue
            yield event


def add_usage(total, usage, agent):
    """Sum token usage; input_tokens always includes cached input, whatever the CLI's convention."""
    if not isinstance(usage, dict):
        return

    def num(key):
        value = usage.get(key)
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0

    if agent == 'codex':
        cached, parts = num('cached_input_tokens'), (num('input_tokens'), num('output_tokens'), num('reasoning_output_tokens'))
    elif agent == 'cursor':
        cached = num('cacheReadTokens')
        parts = (num('inputTokens') + cached + num('cacheWriteTokens'), num('outputTokens'), 0)
    else:
        cached = num('cacheRead')
        parts = (num('input') + cached + num('cacheWrite'), num('output'), num('reasoning'))
        cost = usage.get('cost')
        if isinstance(cost, dict) and isinstance(cost.get('total'), (int, float)):
            total['cost_usd'] = round(total.get('cost_usd', 0) + cost['total'], 6)
    for key, value in zip(('input_tokens', 'output_tokens', 'reasoning_tokens'), parts):
        total[key] = total.get(key, 0) + value
    total['cached_input_tokens'] = total.get('cached_input_tokens', 0) + cached
    total['total_tokens'] = total['input_tokens'] + total['output_tokens']


def parse_codex(path):
    result = {'session_id': None, 'turn_completed': False, 'last_event': None,
              'invalid_event_lines': 0, 'last_error': None}
    usage = {}
    for event in read_jsonl(path, result):
        kind = event.get('type')
        result['last_event'] = kind
        if kind == 'thread.started':
            result['session_id'] = event.get('thread_id')
        elif kind == 'turn.started':
            result['turn_completed'] = False
            result['last_error'] = None
        elif kind == 'turn.completed':
            result['turn_completed'] = True
            result['last_error'] = None  # A prior transient error may have recovered.
            add_usage(usage, event.get('usage'), 'codex')
        elif kind in ('turn.failed', 'error'):
            result['turn_completed'] = False
            result['last_error'] = event.get('error', event.get('message', kind))
    return result, usage or None


def parse_cursor(path):
    result = {'session_id': None, 'model': None, 'result_seen': False, 'is_error': None,
              'last_event': None, 'invalid_event_lines': 0}
    usage, last_text = {}, None
    for event in read_jsonl(path, result):
        kind = event.get('type')
        result['last_event'] = kind
        if isinstance(event.get('session_id'), str) and not result['session_id']:
            result['session_id'] = event['session_id']
        if kind == 'system' and event.get('subtype') == 'init':
            result['model'] = event.get('model')
        elif kind == 'assistant' and not cursor_partial(event):
            parts = (event.get('message') or {}).get('content') or []
            text = ''.join(part.get('text', '') for part in parts if isinstance(part, dict) and part.get('type') == 'text')
            if text.strip():
                last_text = text  # The final segment is the answer; `result` joins every segment.
        elif kind == 'result':
            result['result_seen'] = True
            result['is_error'] = bool(event.get('is_error')) or event.get('subtype') != 'success'
            if last_text is None and isinstance(event.get('result'), str):
                last_text = event['result']
            add_usage(usage, event.get('usage'), 'cursor')
    return result, usage or None, last_text


def pi_usage(session_file, offset):
    usage = {}
    with open(session_file, 'rb') as stream:
        stream.seek(offset)
        for raw in stream:
            try:
                event = json.loads(raw)
            except ValueError:
                continue
            message = event.get('message') if isinstance(event, dict) else None
            if isinstance(message, dict) and message.get('role') == 'assistant':
                add_usage(usage, message.get('usage'), 'pi')
    return usage or None


def explain_failure(meta, run_dir, cause):
    """Put the real cause in `error`; a known precondition becomes blocked and keeps its original line."""
    if isinstance(cause, dict):
        cause = cause.get('message') or json.dumps(cause, ensure_ascii=False)
    stderr = (run_dir / 'stderr.log').read_text(encoding='utf-8', errors='replace').splitlines()[-200:]
    lines = ([str(cause)] if cause else []) + [line.strip() for line in stderr if line.strip()]
    for needle, hint in BLOCKERS:
        hit = next((line for line in lines if needle in line), None)
        if hit:
            meta.update(status='blocked', error=hint, error_detail=hit[:500])
            return
    if lines:
        meta['error'] = lines[0][:500] if cause else lines[-1][:500]


def stop_process_group(process):
    # This runner owns a fresh process group, including ordinary CLI children.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def task_identity(handoff, title):
    lines = handoff.splitlines()
    goal = next((line[3:].strip() for line in lines if line.startswith(('目标：', '目标:'))), '')
    title = (title or '').strip()
    if not title:
        title = goal.strip() or next((line.strip() for line in lines if line.strip()), '')
    if len(title) > 40:
        title = title[:40] + '…'
    return title, goal


def run_job(args):
    cwd = Path(args.cwd).expanduser().resolve(strict=True)
    if not cwd.is_dir():
        raise ValueError('--cwd must be a directory')
    if args.skip_git_check and args.agent != 'codex':
        raise ValueError('--skip-git-check only applies to --agent codex')
    handoff_bytes = Path(args.prompt_file).expanduser().read_bytes()
    handoff = handoff_bytes.decode('utf-8')
    title, goal = task_identity(handoff, args.title)
    prompt = handoff
    if not prompt.strip():
        raise ValueError('Task file is empty')
    prompt = ('Delegated subtask: complete only the task below. Do not invoke other AI CLIs '
              'or delegate-cli recursively. Follow the repository rules and report actual '
              'verification separately from unverified claims.\n\n' + prompt)
    previous = None
    if args.resume_from:
        previous = json.loads(Path(args.resume_from).read_text(encoding='utf-8'))
        if previous.get('agent') != args.agent or previous.get('cwd') != str(cwd):
            raise ValueError('Resume must use the same agent and canonical working directory')
        if previous.get('status') in ('running', 'preparing', 'planned'):
            raise ValueError('Prior run has not finished; inspect its background task first')
    # A resumed run stays on its task unless the caller names another.
    task_id = (args.task or '').strip() or (previous or {}).get('task') or None
    if task_id is not None and not TASK_ID.fullmatch(task_id):
        raise ValueError('--task must be 1-64 letters, digits, dots, underscores or hyphens')
    info = inspect_cli(args.agent, str(cwd))
    if not info['available']:
        raise RuntimeError(info['error'])
    plan = resolve_model(args, info, str(cwd), load_models_config())
    root = Path(args.run_root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    run_dir = Path(tempfile.mkdtemp(prefix=time.strftime('%Y%m%d-%H%M%S-') + args.agent + '-', dir=root))
    prompt = ('Your runner metadata (session_id is populated asynchronously): ' +
              str(run_dir / 'run.json') + '\nIf explicitly authorized to commit, wait for your actual '
              'session_id and include Agent-Session: ' + args.agent + ':<session_id> and '
              'Agent-Run: ' + args.agent + ':' + run_dir.name + ' as Git trailers. '
              'Never invent an ID. This does not authorize committing.\n\n' + prompt)
    (run_dir / 'task.md').write_text(prompt, encoding='utf-8')
    handoff_path = run_dir / 'handoff.md'
    handoff_path.write_bytes(handoff_bytes)
    meta = {'agent': args.agent, 'cwd': str(cwd), 'run_dir': str(run_dir),
            'title': title, 'goal': goal, 'task': task_id, 'handoff_file': str(handoff_path),
            'activity': None, 'live_text': '',
            'version': info['version'], 'argv': None, 'access': args.access,
            'requested_model': args.model, 'requested_thinking': args.thinking,
            'model': plan['model'], 'thinking': plan['thinking'], 'model_check': plan['model_check'],
            'pi_trust': args.pi_trust if args.agent == 'pi' else None,
            'cursor_trust': args.cursor_trust if args.agent == 'cursor' else None,
            'skip_git_check': args.skip_git_check,
            'claude_session_id': os.environ.get('CLAUDE_CODE_SESSION_ID'),
            'status': 'planned' if args.dry_run else 'preparing', 'verified': False,
            'session_id': previous.get('session_id') if previous else None,
            'session_file': previous.get('session_file') if previous else None,
            'result_file': str(run_dir / 'result.md'), 'timeout_seconds': args.timeout,
            'started_at': time.time(), 'progress_file': str(run_dir / 'progress.log'), 'usage': None,
            'watch_command': shlex.join([sys.executable, str(Path(__file__).resolve()), 'watch',
                                         '--run-file', str(run_dir / 'run.json')])}
    if args.agent == 'pi' and args.access == 'read':
        meta['restriction'] = 'Tool selection only; extensions and host permissions are not sandboxed'
    elif args.agent == 'cursor':
        meta['restriction'] = ('Cursor ask mode: read-only by tool selection, not an OS sandbox' if args.access == 'read'
                               else 'Cursor --force: commands run unless the Cursor config denies them')
    for key, value in info.items():
        if key.endswith('help'):
            (run_dir / (key + '.txt')).write_text(value, encoding='utf-8')
    if plan['models_text']:
        (run_dir / 'models.txt').write_text(plan['models_text'], encoding='utf-8')
    meta_path = run_dir / 'run.json'
    try:
        meta['argv'] = build_command(args, info, run_dir, previous, plan)
    except RuntimeError as error:
        meta.update(status='blocked', error=str(error), finished_at=time.time())
        save(meta_path, meta)
        emit(meta)
        return 2
    command = meta['argv']
    save(meta_path, meta)
    if args.dry_run:
        emit(meta)
        return 0
    # Read jobs share a checkout; write jobs require exclusive ownership.
    lock_root = Path.home() / '.claude' / 'cli-runs' / '.locks'
    lock_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_specs = [('cwd:' + str(cwd), fcntl.LOCK_SH if args.access == 'read' else fcntl.LOCK_EX)]
    if previous:
        session_key = meta['session_file'] if args.agent == 'pi' else meta['session_id']
        lock_specs.append(('session:' + args.agent + ':' + str(session_key), fcntl.LOCK_EX))
    locks = []
    try:
        for key, mode in lock_specs:
            lock_key = hashlib.sha256(key.encode()).hexdigest()
            lock = (lock_root / (lock_key + '.lock')).open('a')
            locks.append(lock)
            fcntl.flock(lock, mode | fcntl.LOCK_NB)
    except BlockingIOError:
        meta.update(status='blocked', finished_at=time.time(),
                    error='Conflicting job owns this checkout or session; wait or use another worktree/session')
        save(meta_path, meta)
        emit(meta)
        for lock in locks:
            lock.close()
        return 2
    interrupted = None
    process = None
    handlers = {}

    def on_signal(signum, _frame):
        raise InterruptedError(str(signum))

    for signum in (signal.SIGTERM, signal.SIGINT):
        handlers[signum] = signal.signal(signum, on_signal)
    progress = Progress(meta)
    pi_offset = 0
    # On resume, skip old Pi messages but keep reading new entries.
    if previous and args.agent == 'pi' and meta.get('session_file'):
        prior = Path(meta['session_file'])
        pi_offset = progress.offsets[str(prior)] = prior.stat().st_size
    out_path = run_dir / ('result.md' if args.agent == 'pi' else 'events.jsonl')
    try:
        with (run_dir / 'task.md').open('rb') as task, out_path.open('wb') as stdout, \
                (run_dir / 'stderr.log').open('wb') as stderr:
            process = subprocess.Popen(command, cwd=str(cwd), stdin=task, stdout=stdout,
                                       stderr=stderr, start_new_session=True)
            meta.update(status='running', pid=process.pid, runner_pid=os.getpid())
            save(meta_path, meta)
            emit({'status': 'running', 'run_file': str(meta_path), 'pid': process.pid,
                  'model': meta['model'], 'watch_command': meta['watch_command']})
            if not args.quiet:
                print('── 任务：' + title + ' ──', flush=True)
                print(handoff, end='' if handoff.endswith('\n') else '\n', flush=True)
                print('── 进度 ──', flush=True)
                progress.echo_on()  # First line stays JSON; the last line is the final JSON.
            try:
                deadline = time.monotonic() + args.timeout
                while True:
                    progress.poll()
                    save(meta_path, meta)
                    if process.poll() is not None:
                        break
                    if time.monotonic() >= deadline:
                        raise subprocess.TimeoutExpired(command, args.timeout)
                    time.sleep(0.25)
            except subprocess.TimeoutExpired:
                interrupted = 'timed_out'
                stop_process_group(process)
            except InterruptedError:
                interrupted = 'cancelled'
                stop_process_group(process)
        progress.poll()
        meta['exit_code'] = process.returncode
        complete = process.returncode == 0
        cause = None
        if args.agent == 'codex':
            parsed, meta['usage'] = parse_codex(out_path)
            meta['codex_events'] = parsed
            meta['session_id'] = parsed['session_id'] or meta['session_id']
            complete = complete and parsed['turn_completed'] and not parsed['invalid_event_lines']
            cause = parsed['last_error']
        elif args.agent == 'cursor':
            parsed, meta['usage'], text = parse_cursor(out_path)
            meta['cursor_events'] = parsed
            meta['session_id'] = parsed['session_id'] or meta['session_id']
            if text and text.strip():
                (run_dir / 'result.md').write_text(text.rstrip() + '\n', encoding='utf-8')
            complete = complete and parsed['result_seen'] and not parsed['is_error'] and not parsed['invalid_event_lines']
            cause = text if parsed['is_error'] else None
        else:
            if not previous:
                sessions = list((run_dir / 'sessions').rglob('*.jsonl'))
                if len(sessions) == 1:
                    meta['session_file'] = str(sessions[0].resolve())
            if meta['session_file']:
                with Path(meta['session_file']).open(encoding='utf-8') as session:
                    header = json.loads(session.readline())
                meta['session_id'] = header.get('id') if isinstance(header, dict) else None
                meta['usage'] = pi_usage(meta['session_file'], pi_offset)
        result_path = run_dir / 'result.md'
        complete = complete and result_path.exists() and bool(result_path.read_text(encoding='utf-8', errors='replace').strip())
        meta['status'] = interrupted or ('process_succeeded' if complete else 'failed')
        if meta['status'] == 'failed':
            explain_failure(meta, run_dir, cause)
    except Exception as error:  # Whatever broke, run.json must not stay "running".
        if process and process.poll() is None:
            stop_process_group(process)
        if isinstance(error, InterruptedError):
            meta['status'] = 'cancelled'
        else:
            meta.update(status='failed', error=type(error).__name__ + ': ' + str(error))
    finally:
        for signum, handler in handlers.items():
            signal.signal(signum, handler)
        usage = meta.get('usage')
        if usage:
            progress.write('● 用量 输入 {:,}（缓存 {:,}）/ 输出 {:,} tokens'.format(
                usage['input_tokens'], usage['cached_input_tokens'], usage['output_tokens']) +
                ('，约 ${:.4f}'.format(usage['cost_usd']) if usage.get('cost_usd') else ''))
        progress.write('● ' + meta['status'] + ('：' + meta['error'] if meta.get('error') else ''))
        meta['finished_at'] = time.time()
        meta.update(activity=None, live_text='')
        save(meta_path, meta)
        for lock in locks:
            lock.close()
    emit(meta)
    return 0 if meta['status'] == 'process_succeeded' else (124 if meta['status'] == 'timed_out' else 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest='action', required=True)
    doctor = actions.add_parser('doctor', help='Inspect installed versions/help; does not query a model')
    doctor.add_argument('--cwd', default=os.getcwd())
    doctor.add_argument('--agent', choices=[*AGENTS, 'all'], default='all')
    doctor.add_argument('--models', action='store_true', help='Also list each CLI\'s valid model IDs')
    run = actions.add_parser('run', help='Execute one non-interactive job and preserve logs')
    run.add_argument('--agent', required=True, choices=AGENTS)
    run.add_argument('--cwd', required=True)
    run.add_argument('--prompt-file', required=True)
    run.add_argument('--title', help='Task title; defaults to the handoff goal or first nonempty line')
    run.add_argument('--task', help='Blueprint task ID this run works on; a resumed run keeps the prior one')
    run.add_argument('--access', choices=['read', 'write'], default='read')
    run.add_argument('--model', help='Exact ID or an alias from models.json (astra, grok4.7, flash)')
    run.add_argument('--thinking', help='low/medium/high/xhigh/max or 低/中/高/超高/最高')
    run.add_argument('--pi-trust', choices=['existing', 'skip', 'approved'], default='existing')
    run.add_argument('--cursor-trust', choices=['existing', 'approved'], default='existing')
    run.add_argument('--skip-git-check', action='store_true',
                     help='Codex only: allow a working directory outside a Git repository')
    run.add_argument('--resume-from', help='Exact run.json from a finished job')
    run.add_argument('--run-root', default=str(Path.home() / '.claude' / 'cli-runs'))
    run.add_argument('--timeout', type=float, default=1800)
    run.add_argument('--dry-run', action='store_true', help='Check CLI flags and write a plan without invoking a model')
    run.add_argument('--quiet', action='store_true',
                     help='Print only the start and final JSON lines, not the live progress lines')
    watch = actions.add_parser('watch', help='Follow readable progress; exit when job ends')
    watch.add_argument('--run-file', required=True)
    watch.add_argument('--once', action='store_true')
    message = actions.add_parser('commit-message', help='Print a commit message with validated session trailers; does not commit')
    message.add_argument('--run-file', required=True, action='append')
    message.add_argument('--message-file', required=True)
    args = parser.parse_args()
    try:
        if args.action == 'watch':
            offset = 0
            while True:
                meta = json.loads(Path(args.run_file).read_text(encoding='utf-8'))
                path = Path(meta['run_dir']) / 'progress.log'
                if path.exists():
                    with path.open('rb') as stream:
                        stream.seek(offset)
                        data = stream.read()
                        # Do not split an in-flight UTF-8 line.
                        end = data.rfind(b'\n') + 1
                        offset += end
                    print(data[:end].decode('utf-8', errors='replace'), end='', flush=True)
                if args.once or meta['status'] not in ('preparing', 'running'):
                    if not path.exists():
                        print('No progress.log: this may be an older run. Inspect events.jsonl, result.md and stderr.log in ' + meta['run_dir'], file=sys.stderr)
                        return 2
                    return 0
                time.sleep(0.5)
        if args.action == 'commit-message':
            body = Path(args.message_file).read_text(encoding='utf-8').rstrip()
            if not body or re.search(r'(?im)^Agent-(?:Session|Run):', body):
                raise ValueError('Supply a nonempty message without preexisting Agent trailers')
            trailers = []
            for filename in args.run_file:
                meta = json.loads(Path(filename).read_text(encoding='utf-8'))
                sid = meta.get('session_id')
                if meta.get('status') != 'process_succeeded' or not isinstance(sid, str) or not SESSION_ID.fullmatch(sid):
                    raise ValueError('Commit provenance requires a completed run with a valid session ID')
                agent = meta.get('agent')
                if agent not in AGENTS:
                    raise ValueError('Unknown agent')
                trailers.extend(['Agent-Session: ' + agent + ':' + sid,
                                 'Agent-Run: ' + agent + ':' + Path(meta['run_dir']).name])
            print(body + '\n\n' + '\n'.join(dict.fromkeys(trailers)))
            return 0
        if args.action == 'doctor':
            agents = list(AGENTS) if args.agent == 'all' else [args.agent]
            info = []
            for agent in agents:  # One broken CLI must not hide the others.
                try:
                    info.append(inspect_cli(agent, args.cwd))
                except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
                    info.append({'agent': agent, 'available': False, 'error': str(error)})
            for item in info:
                item['flags'] = sorted(set(re.findall(r'--[a-z][a-z-]+', '\n'.join(
                    str(value) for key, value in item.items() if key.endswith('help')))))
                if args.models and item['available']:
                    try:
                        item['models'] = sorted(list_models(item['agent'], item, args.cwd)[0])
                    except (RuntimeError, ValueError, OSError, subprocess.TimeoutExpired) as error:
                        item['models_error'] = str(error)
                for key in list(item):
                    if key.endswith('help'):
                        del item[key]
            emit(info)
            return 0 if all(item['available'] for item in info) else 2
        if args.timeout <= 0:
            raise ValueError('--timeout must be positive')
        return run_job(args)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        blocked = {'status': 'blocked', 'error': str(error), 'verified': False}
        # A dispatch refused before it had a run directory still names its task.
        if getattr(args, 'task', None):
            blocked['task'] = args.task.strip()
        emit(blocked)
        return 2


if __name__ == '__main__':
    sys.exit(main())
