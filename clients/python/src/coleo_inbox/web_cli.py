"""Launch the independently installed web host with the selected API connection."""
import asyncio
import os
import shutil
import signal

HELP = """Usage: coleo-client [--connection NAME] web [--host 127.0.0.1] [--port 3000]
Run the installed web client in the foreground. Press Ctrl+C to stop.
Install the optional component with: coleo-install install web
"""


async def run_web(args, api, stdout):
    if any(arg in ("--help", "-h") for arg in args):
        print(HELP, file=stdout)
        return 0
    host, port = "127.0.0.1", "3000"
    remaining = list(args)
    while remaining:
        flag, equal, value = remaining.pop(0).partition("=")
        if flag not in ("--host", "--port"):
            raise ValueError(HELP.strip())
        if not equal:
            if not remaining:
                raise ValueError(f"{flag} requires a value")
            value = remaining.pop(0)
        if flag == "--port":
            if not value.isascii() or not value.isdecimal() or not 1 <= int(value) <= 65535:
                raise ValueError("--port must be an integer from 1 to 65535")
            port = value
        else:
            if not value or value.startswith("-"):
                raise ValueError("--host requires a hostname or IP address")
            host = value
    executable = shutil.which(os.environ.get("COLEO_WEB_EXECUTABLE") or "coleo-web")
    if not executable:
        raise ValueError("Web component not installed. Run: coleo-install install web")
    env = dict(os.environ, COLEO_API_URL=api.url, COLEO_API_KEY=api.key)
    try:
        process = await asyncio.create_subprocess_exec(executable, "--host", host, "--port", port, env=env)
    except OSError:
        raise ValueError("Cannot launch web component. Run: coleo-install install web") from None
    try:
        code = await process.wait()
        return 128 - code if code < 0 else code
    except asyncio.CancelledError:
        if process.returncode is None:
            try:
                process.send_signal(signal.SIGINT)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        return 130
