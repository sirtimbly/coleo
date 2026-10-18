"""Own a disposable production-route fixture process; always terminate it."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

root = Path(__file__).resolve().parents[2]
port = os.environ.get("COLEO_FIXTURE_PORT", "8092")
url = f"http://127.0.0.1:{port}"
key = "python-bakeoff-integration-key"
env = {**os.environ, "PORT": port, "API_KEY": key, "COLEO_TEST_API_URL": url, "COLEO_API_KEY": key,
       "COLEO_TEST_FIXTURE_WRITES": "1"}
# Fail if occupied: never mistake another process for the server owned here.
import socket
with socket.socket() as probe:
    probe.bind(("127.0.0.1", int(port)))
with tempfile.TemporaryFile(mode="w+t") as log:
    server = subprocess.Popen(["bun", "e2e/support/terminal-bake-off/server.ts"], cwd=root, env=env, stdout=log, stderr=log)
    try:
        deadline = time.monotonic() + 30
        while True:
            if server.poll() is not None:
                raise RuntimeError("Fixture process exited during startup")
            try:
                with urlopen(url + "/api/health", timeout=.5) as response:
                    if response.status == 200:
                        break
            except OSError:
                pass
            if time.monotonic() >= deadline:
                raise TimeoutError("Fixture startup timeout")
            time.sleep(.1)
        result = subprocess.run([sys.executable, "-m", "pytest", "clients/python/tests", "-q"], cwd=root, env=env)
        if result.returncode:
            log.seek(0)
            print(log.read(), file=sys.stderr)
        raise SystemExit(result.returncode)
    except Exception:
        log.seek(0)
        print(log.read(), file=sys.stderr)
        raise
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
