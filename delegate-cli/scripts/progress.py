"""Incremental, best-effort display. Never used to decide job success."""
import json
import shlex
import time
from pathlib import Path

# A finished tool gets its own line only when it failed, exited non-zero, edited files or ran this long.
SLOW_SECONDS = 3
# Without a line for this long the runner writes a heartbeat; the panel treats 3 silent minutes as stale.
HEARTBEAT_SECONDS = 60
SHELLS = {('/bin/zsh', '-lc'), ('/bin/bash', '-lc'), ('zsh', '-lc'), ('bash', '-lc'), ('/bin/sh', '-c'), ('sh', '-c')}
EDITS = {'edit', 'write', 'delete', 'multiedit', 'apply_patch', 'search_replace', 'str_replace'}


def clean(value, limit=240):
    return ''.join(c if c.isprintable() else ' ' for c in str(value))[:limit]


def unwrap(command):
    """`/bin/zsh -lc 'npm test'` is shown as `npm test`."""
    try:
        parts = shlex.split(str(command))
    except ValueError:
        return str(command)
    return parts[2] if len(parts) == 3 and tuple(parts[:2]) in SHELLS else str(command)


def cursor_tool(call):
    """Name, arguments and outcome of a Cursor tool_call payload."""
    for key, value in call.items():
        if not isinstance(value, dict) or not (key.endswith('ToolCall') or key == 'function'):
            continue
        name = key[:-len('ToolCall')] if key.endswith('ToolCall') else value.get('name', key)
        args = value.get('args') or value.get('arguments') or {}
        result = value.get('result')
        success = result.get('success') if isinstance(result, dict) else None
        exit_code = success.get('exitCode') if isinstance(success, dict) else None
        failed = isinstance(result, dict) and bool({'error', 'failure', 'rejected'} & set(result))
        return name, args, not failed and exit_code in (None, 0), exit_code
    return 'tool', {}, True, None


class Progress:
    def __init__(self, meta):
        self.meta = meta
        self.offsets = {}
        self.pending = {}
        self.tools = {}
        self.cwd = str(meta.get('cwd') or '').rstrip('/')
        self.last_activity = time.monotonic()
        self.last_write = self.last_activity
        self.echo = False
        self.path = Path(meta['run_dir']) / 'progress.log'
        model = meta.get('model') or meta.get('requested_model') or '默认模型'
        if meta.get('thinking'):
            model += '/' + meta['thinking']
        mode = '只读' if meta.get('access') == 'read' else '可写'
        self.write('● ' + meta['agent'] + ' · ' + model + ' · ' + mode + ' | ' + meta['cwd'])

    def write(self, text):
        line = time.strftime('%H:%M:%S ') + clean(text, 1600)
        with self.path.open('a', encoding='utf-8') as out:
            out.write(line + '\n')
        self.last_write = time.monotonic()
        if self.echo:
            print(line, flush=True)

    def message(self, text):
        """An agent's words; line breaks become ' ⏎ ' so the log stays one line per event."""
        text = str(text).replace('\r', '').strip()
        if text:
            self.write('💬 ' + clean(text.replace('\n', ' ⏎ '), 1590))

    def echo_on(self):
        """Mirror progress to stdout, so a host's background-task view shows it live."""
        logged = self.path.read_text(encoding='utf-8').rstrip('\n') if self.path.exists() else ''
        if logged:
            print(logged, flush=True)
        self.echo = True

    def rel(self, path):
        path = str(path)
        if self.cwd and path == self.cwd:
            return '.'
        return path[len(self.cwd) + 1:] if self.cwd and path.startswith(self.cwd + '/') else path

    def describe(self, args):
        """The one argument worth showing: a command, a search, or a path relative to cwd."""
        if not isinstance(args, dict):
            return clean(args)
        if args.get('command'):
            return clean(unwrap(args['command']))
        target = args.get('path') or args.get('file_path') or args.get('directory') or args.get('targetDirectory')
        pattern = args.get('pattern') or args.get('globPattern') or args.get('glob') or args.get('query')
        if pattern:
            return clean('"' + str(pattern) + '"' + (' · ' + self.rel(target) if target else ''))
        if target:
            return clean(self.rel(target))
        for key in ('url', 'description', 'name'):
            if args.get(key):
                return clean(args[key])
        return clean(json.dumps(args, ensure_ascii=False))

    def started(self, key, name, detail):
        self.tools[key] = (name, detail, time.monotonic())
        self.write('▶ ' + name + ' ' + detail)

    def finished(self, key, ok, exit_code=None, seconds=None):
        name, detail, start = self.tools.pop(key, ('tool', '', None))
        if seconds is None:
            seconds = time.monotonic() - start if start else 0
        suffix = (' [exit=' + str(exit_code) + ']' if exit_code not in (None, 0) else '') + \
            (' (' + str(int(seconds)) + 's)' if seconds >= SLOW_SECONDS else '')
        if not ok:
            self.write('! ' + name + ' ' + detail + suffix)
        elif name.lower() in EDITS:
            self.write('✎ ' + detail + suffix)
        elif seconds >= SLOW_SECONDS:
            self.write('✓ ' + name + ' ' + detail + suffix)

    def lines(self, path):
        if not path.exists():
            return []
        key = str(path)
        with path.open('rb') as stream:
            stream.seek(self.offsets.get(key, 0))
            data = stream.read()
            self.offsets[key] = stream.tell()
        if data:
            self.last_activity = time.monotonic()
        parts = (self.pending.get(key, b'') + data).split(b'\n')
        self.pending[key] = parts.pop()
        return [line.decode('utf-8', errors='replace') for line in parts]

    def poll(self):
        root = Path(self.meta['run_dir'])
        agent = self.meta['agent']
        if agent in ('codex', 'cursor'):
            paths = [root / 'events.jsonl']
        else:
            paths = ([Path(self.meta['session_file'])] if self.meta.get('session_file')
                     else list((root / 'sessions').rglob('*.jsonl')))
        for path in paths:
            for line in self.lines(path):
                try:
                    e = json.loads(line)
                    if not isinstance(e, dict):
                        continue
                    if agent == 'codex':
                        self.codex(e)
                    elif agent == 'cursor':
                        self.cursor(e)
                    else:
                        self.pi(e, path)
                except (ValueError, TypeError, KeyError, AttributeError):
                    continue
        for line in self.lines(root / 'stderr.log'):
            if line.strip():
                self.write('! ' + clean(line))
        now = time.monotonic()
        if now - self.last_write >= HEARTBEAT_SECONDS:
            quiet = int(now - self.last_activity)
            self.write('… 已 ' + str(quiet) + ' 秒无新输出；不代表卡死' if quiet >= HEARTBEAT_SECONDS
                       else '… 仍在运行（思考或未展示的事件）')

    def session(self, value):
        if value and value != self.meta.get('session_id'):
            self.meta['session_id'] = value
            self.write('会话 ' + clean(value))

    def codex(self, e):
        kind = e.get('type')
        if kind == 'thread.started':
            self.session(e.get('thread_id'))
        elif kind in ('item.started', 'item.completed'):
            item = e.get('item') or {}
            t = item.get('type')
            key = item.get('id') or id(item)
            done = kind == 'item.completed'
            if t == 'command_execution':
                if not done:
                    self.started(key, 'shell', clean(unwrap(item.get('command', ''))))
                else:
                    if key not in self.tools:  # Started and finished within one poll.
                        self.started(key, 'shell', clean(unwrap(item.get('command', ''))))
                    code = item.get('exit_code')
                    self.finished(key, code in (0, None), code)
            elif t == 'file_change' and done:
                self.write('✎ ' + ', '.join(self.rel(c.get('path', '')) for c in item.get('changes', [])))
            elif t == 'agent_message' and done:
                self.message(item.get('text', ''))
            elif t == 'mcp_tool_call':
                name = 'mcp ' + clean(item.get('server', '')) + '/' + clean(item.get('tool', ''))
                if not done:
                    self.started(key, name.replace(' /', ' '), '')
                else:
                    self.finished(key, item.get('status') != 'failed')
        elif kind in ('turn.failed', 'error'):
            self.write('! ' + clean(e.get('error', e.get('message', kind))))
        elif kind == 'turn.completed':
            self.write('● 本轮完成；待主控验收')

    def cursor(self, e):
        kind = e.get('type')
        self.session(e.get('session_id'))
        if kind == 'system' and e.get('subtype') == 'init':
            self.write('模型 ' + clean(e.get('model', '')))
        elif kind == 'tool_call' and e.get('subtype') in ('started', 'completed'):
            name, args, ok, code = cursor_tool(e.get('tool_call') or {})
            key = e.get('call_id')
            if e['subtype'] == 'started':
                self.started(key, name, self.describe(args))
            else:
                if key not in self.tools:
                    self.started(key, name, self.describe(args))
                self.finished(key, ok, code)
        elif kind == 'assistant':
            parts = (e.get('message') or {}).get('content') or []
            text = ''.join(p.get('text', '') for p in parts if isinstance(p, dict) and p.get('type') == 'text')
            self.message(text)
        elif kind == 'result':
            self.write('! 本轮出错' if e.get('is_error') else '● 本轮完成；待主控验收')

    def pi(self, e, path):
        if e.get('type') == 'session':
            self.meta['session_file'] = str(path.resolve())
            self.session(e.get('id'))
        m = e.get('message') or {}
        if m.get('role') == 'assistant':
            for part in m.get('content', []):
                if not isinstance(part, dict):
                    continue
                if part.get('type') == 'toolCall':
                    self.started(part.get('id'), clean(part.get('name'), 60), self.describe(part.get('arguments', {})))
                elif part.get('type') == 'text':
                    self.message(part.get('text', ''))
        elif m.get('role') == 'toolResult':
            key = m.get('toolCallId')
            if key not in self.tools:
                self.tools[key] = (clean(m.get('toolName', 'tool'), 60), '', None)
            duration = m.get('durationMs')
            self.finished(key, not m.get('isError'),
                          seconds=duration / 1000 if isinstance(duration, (int, float)) else None)
