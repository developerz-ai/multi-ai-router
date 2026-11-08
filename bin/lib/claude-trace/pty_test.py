"""Exercise a real local PTY with a fake CLI, without provider calls or credentials."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('interactive_pty',
    Path(__file__).with_name('interactive-pty.py'))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class PtyTests(unittest.TestCase):
    def fake(self, root, body):
        cli = root / 'fake-cli'
        cli.write_text('#!' + sys.executable + '\n' + body)
        cli.chmod(0o700)
        return str(cli)

    def test_native_terminal_stop_hook_and_environment(self):
        with tempfile.TemporaryDirectory(prefix="trace space '") as tmp:
            root = Path(tmp)
            cli = self.fake(root, '''import json, os, subprocess, sys, time
assert all(os.isatty(fd) for fd in (0, 1, 2))
assert 'CLAUDE_CODE_ENTRYPOINT' not in os.environ
assert 'CLAUDECODE' not in os.environ
assert '-p' not in sys.argv and '--print' not in sys.argv
settings = json.load(open(sys.argv[sys.argv.index('--settings') + 1]))
hook = settings['hooks']['Stop'][0]['hooks'][0]['command']
subprocess.run(hook, shell=True, input='{}', text=True, check=True)
print('private assistant text', flush=True)
time.sleep(20)
''')
            with patch.dict(os.environ, {'CLAUDE_TRACE_DIR': tmp,
                    'CLAUDE_CODE_ENTRYPOINT': 'sdk-ts', 'CLAUDECODE': '1',
                    'CLAUDE_TRACE_PRIVATE': '0'}):
                self.assertEqual(driver.run([cli, 'synthetic prompt'], root, timeout=5), 0)
            result = json.loads((root / 'pty-result.json').read_text())
            self.assertEqual(result['completion'], 'stop-hook')
            self.assertFalse((root / 'private-terminal.log').exists())
            self.assertEqual((root / 'pty-settings.json').stat().st_mode & 0o777, 0o600)

    def test_timeout_is_failure_and_reaps_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cli = self.fake(root, 'import time\ntime.sleep(20)\n')
            with patch.dict(os.environ, {'CLAUDE_TRACE_DIR': tmp, 'CLAUDE_TRACE_PRIVATE': '0'}):
                self.assertEqual(driver.run([cli], root, timeout=0.2), 1)
            self.assertEqual(json.loads((root / 'pty-result.json').read_text())['completion'], 'timeout')


if __name__ == '__main__':
    unittest.main()
