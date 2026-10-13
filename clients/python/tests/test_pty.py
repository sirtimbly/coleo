"""Physical PTY driver smoke, opt-in with a reachable isolated API fixture."""
import os
import select
import subprocess
import sys
import time

import pytest

pytestmark = pytest.mark.skipif(os.name != "posix" or not os.getenv("COLEO_TEST_API_URL"),
                                reason="PTY smoke requires POSIX and COLEO_TEST_API_URL")


@pytest.mark.parametrize("quit_key", [b"\x11", b"\x03"])
def test_textual_pty_quit_restores_terminal(quit_key):
    import fcntl
    import pty
    import struct
    import termios
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 38, 120, 0, 0))
    before = termios.tcgetattr(slave)
    env = {**os.environ, "COLEO_API_URL": os.environ["COLEO_TEST_API_URL"], "TERM": "xterm-256color"}
    process = subprocess.Popen([sys.executable, "-c", "from coleo_inbox.cli import main; main()", "tui", "--facet", "messages"],
                               stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
    output = bytearray()
    def collect_until(predicate, timeout=15):
        end = time.monotonic() + timeout
        while not predicate() and time.monotonic() < end:
            if select.select([master], [], [], .05)[0]:
                output.extend(os.read(master, 65536))
            if process.poll() is not None:
                break
        assert predicate(), bytes(output[-4000:]).decode(errors="replace")
    try:
        collect_until(lambda: b"authenticated" in output)
        assert b"\x1b[?1049h" in output
        during = termios.tcgetattr(slave)
        assert not during[3] & termios.ICANON
        # Resize the actual PTY and signal the child, then exercise normal quit.
        import signal
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 28, 70, 0, 0))
        process.send_signal(signal.SIGWINCH)
        time.sleep(.2)
        os.write(master, quit_key)
        collect_until(lambda: process.poll() is not None)
        while select.select([master], [], [], .05)[0]:
            output.extend(os.read(master, 65536))
        assert process.returncode == 0
        assert termios.tcgetattr(slave) == before
        assert b"\x1b[?1049l" in output
        assert b"Traceback" not in output
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        os.close(master)
        os.close(slave)
