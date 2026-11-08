"""One native interactive turn in a real PTY; HTTP is captured by capture.py, not TUI scraping."""
import errno
import fcntl
import json
import os
import pty
import select
import shlex
import signal
import struct
import sys
import termios
import time
import tty
from pathlib import Path


def private_write(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(text)


def run(command, root, timeout=120):
    marker = root / 'pty-stop'
    settings = root / 'pty-settings.json'
    hook = shlex.join([sys.executable, str(Path(__file__).resolve()), '--mark-stop'])
    private_write(settings, json.dumps({'hooks': {'Stop': [
        {'hooks': [{'type': 'command', 'command': hook, 'timeout': 5}]}]}}))
    # Supply settings before the positional prompt; preserve Claude's native system prompt.
    command = [command[0], '--settings', str(settings), *command[1:]]
    env = dict(os.environ)
    for name in list(env):
        if name.upper() in {'CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE'}:
            del env[name]
    env['TERM'] = 'xterm-256color'
    pid, terminal = pty.fork()
    if pid == 0:
        os.execvpe(command[0], command, env)
    fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    output = None
    if env.get('CLAUDE_TRACE_PRIVATE') == '1':
        fd = os.open(root / 'private-terminal.log', os.O_WRONLY | os.O_CREAT, 0o600)
        output = os.fdopen(fd, 'wb')
    started = time.monotonic()
    stopped_at = None
    reason = 'timeout'
    status = None

    def interrupted(signum, frame):
        raise KeyboardInterrupt

    previous = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGTERM, signal.SIGINT)}
    keyboard = sys.stdin.fileno() if sys.stdin.isatty() else None
    original_terminal = termios.tcgetattr(keyboard) if keyboard is not None else None
    try:
        if keyboard is not None:
            tty.setraw(keyboard)
        while time.monotonic() - started < timeout:
            if marker.exists() and stopped_at is None:
                stopped_at = time.monotonic()
            # Allow the hook and final HTTP collector callbacks to finish before shutdown.
            if stopped_at is not None and time.monotonic() - stopped_at >= 0.5:
                reason = 'stop-hook'
                break
            done, child_status = os.waitpid(pid, os.WNOHANG)
            if done:
                status = child_status
                reason = 'stop-hook' if stopped_at is not None else 'early-exit'
                break
            readable = select.select([terminal, *([keyboard] if keyboard is not None else [])], [], [], 0.05)[0]
            if keyboard is not None and keyboard in readable:
                keys = os.read(keyboard, 4096)
                if b'\x03' in keys:
                    raise KeyboardInterrupt
                os.write(terminal, keys)
            if terminal in readable:
                try:
                    data = os.read(terminal, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b''
                if output:
                    output.write(data)
                if sys.stdout.isatty():
                    os.write(sys.stdout.fileno(), data)
                # Answer terminal position probes; do not auto-accept trust/login dialogs.
                if b'\x1b[6n' in data:
                    os.write(terminal, b'\x1b[1;1R')
    except KeyboardInterrupt:
        reason = 'interrupted'
    finally:
        if original_terminal is not None:
            termios.tcsetattr(keyboard, termios.TCSADRAIN, original_terminal)
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        if status is None:
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                done, child_status = os.waitpid(pid, os.WNOHANG)
                if done:
                    status = child_status
                    break
                time.sleep(0.05)
            if status is None:
                os.killpg(pid, signal.SIGKILL)
                _, status = os.waitpid(pid, 0)
        os.close(terminal)
        if output:
            output.close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        private_write(root / 'pty-result.json', json.dumps({
            'completion': reason, 'childExit': os.waitstatus_to_exitcode(status),
            'elapsedSeconds': round(time.monotonic() - started, 3)}))
    if reason != 'stop-hook':
        print('PTY did not finish a turn (' + reason + '). Check login/workspace trust with tty mode; '
              'use --private-wire to inspect terminal output.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    root = Path(os.environ['CLAUDE_TRACE_DIR'])
    if sys.argv[1:] == ['--mark-stop']:
        # Drain hook JSON without persisting prompt, transcript path, or assistant text.
        sys.stdin.read()
        private_write(root / 'pty-stop', 'stop\n')
    elif len(sys.argv) > 2 and sys.argv[1] == '--':
        sys.exit(run(sys.argv[2:], root))
    else:
        sys.exit('usage: pty.py -- claude [interactive arguments]')
