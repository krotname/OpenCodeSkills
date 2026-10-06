"""Tests for the gh wrappers in inspect_pr_checks.py.

The real gh is replaced by the Python interpreter itself, so each case is a
tiny inline program: a stalled API call and UTF-8 job logs with Cyrillic.
"""

from __future__ import annotations

import importlib.util
import sys
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "inspect_pr_checks.py"
spec = importlib.util.spec_from_file_location("inspect_pr_checks", SCRIPT)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)


class GhWrapperTests(unittest.TestCase):
    def setUp(self) -> None:
        self._executable = module.gh_executable
        self._timeout = module.GH_TIMEOUT_SECONDS
        module.gh_executable = lambda: sys.executable
        module.GH_TIMEOUT_SECONDS = 2

    def tearDown(self) -> None:
        module.gh_executable = self._executable
        module.GH_TIMEOUT_SECONDS = self._timeout

    def test_stalled_gh_call_times_out(self) -> None:
        started = time.monotonic()
        result = module.run_gh_command(["-c", "import time; time.sleep(60)"], Path.cwd())
        self.assertLess(time.monotonic() - started, 30)
        self.assertEqual(result.returncode, 124)
        self.assertIn("timed out", result.stderr)

    def test_stalled_raw_call_times_out(self) -> None:
        started = time.monotonic()
        code, _, stderr = module.run_gh_command_raw(["-c", "import time; time.sleep(60)"], Path.cwd())
        self.assertLess(time.monotonic() - started, 30)
        self.assertEqual(code, 124)
        self.assertIn("timed out", stderr)

    def test_utf8_output_is_decoded(self) -> None:
        program = "import sys; sys.stdout.buffer.write('ошибка сборки'.encode('utf-8'))"
        result = module.run_gh_command(["-c", program], Path.cwd())
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "ошибка сборки")


class SnippetTests(unittest.TestCase):
    def test_snippet_keeps_failure_line_when_context_exceeds_max_lines(self) -> None:
        lines = [f"step {i}" for i in range(100)]
        lines[50] = "Error: build broke"
        snippet = module.extract_failure_snippet("\n".join(lines), max_lines=10, context=30)
        self.assertEqual(len(snippet.splitlines()), 10)
        self.assertIn("Error: build broke", snippet)

    def test_snippet_default_window_is_unchanged(self) -> None:
        lines = [f"step {i}" for i in range(100)]
        lines[50] = "Error: build broke"
        snippet = module.extract_failure_snippet("\n".join(lines), max_lines=160, context=30)
        self.assertEqual(snippet.splitlines(), lines[20:80])


if __name__ == "__main__":
    unittest.main()
