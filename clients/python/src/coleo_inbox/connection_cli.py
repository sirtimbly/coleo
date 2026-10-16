import getpass
import json
import os
import sys
from importlib.util import find_spec

from .api import Api
from .connections import Connections, validate_name, validate_url

HELP = """Usage: coleo-client [--connection NAME] [--server URL] <command> [options]
API-only operations target the selected server.
  connect URL --name NAME [--save-only] [--key-stdin | --prompt-key]
  connections [--json]       List saved servers (credentials redacted)
  use NAME [--json]          Select a saved server offline
  doctor [--json]            Check selected server and optional TUI
  web [--host HOST] [--port PORT]  Run the installed web client
  modules | views | validate | tui | inbox | tasks | bugs | brain | dashboard
  arms | agents | activity | status | mail | discoveries | config | status-reports
  --profile ID              Named-view query profile, not a server connection
  --catalog PATH            Module catalog for domain commands
  --help | --version         Available offline
Precedence: flags > environment > saved connection > defaults.
"""


async def doctor(api, connection):
    checks = []
    try:
        status = await api.request("/api/status")
        checks.append(dict(name="authentication", ok=True, status="accepted-mode-unknown" if connection.key else "no-credential-required",
                           detail="Authenticated route accessible; development auth bypass or upstream authentication may apply. Server auth mode is not advertised."))
        # Only allow known metadata, never dump server configuration.
        metadata = {k: status[k] for k in ("version", "projectName", "cwd") if isinstance(status.get(k), str)}
        for key in {connection.key, getattr(api, "key", "")} - {""}:
            metadata = {k: v.replace(key, "[redacted]") for k, v in metadata.items()}
        checks.append(dict(name="server", ok=True, **metadata, capabilities="unknown"))
    except ValueError as exc:
        checks.append(dict(name="server", ok=False, category=getattr(exc, "category", "request"), detail=str(exc)))
    checks.append(dict(name="tui", ok=True, available=all(find_spec(name) is not None for name in ("textual", "websockets")), optional=True))
    return dict(schemaVersion=1, kind="client.doctor", component="client", **connection.public(),
                checks=checks, ok=all(c["ok"] for c in checks))


async def run_connection(args, flags, stdout, api=None):
    command, *rest = args
    as_json = "--json" in rest
    rest = [a for a in rest if a != "--json"]
    store = Connections()
    if command == "connections":
        if rest:
            raise ValueError("Usage: coleo-client connections [--json]")
        value = store.public()
    elif command == "use":
        if len(rest) != 1:
            raise ValueError("Usage: coleo-client use NAME")
        store.use(rest[0])
        value = dict(schemaVersion=1, kind="client.use", connection=rest[0], ok=True)
    elif command == "connect":
        if not rest or rest[0].startswith("-"):
            raise ValueError("Usage: coleo-client connect URL --name NAME [--save-only]")
        url = validate_url(rest.pop(0))
        name, save_only, prompt, key_stdin = None, False, False, False
        while rest:
            token = rest.pop(0)
            if token == "--name" and rest:
                name = validate_name(rest.pop(0))
            elif token == "--save-only":
                save_only = True
            elif token == "--prompt-key":
                prompt = True
            elif token == "--key-stdin":
                key_stdin = True
            else:
                raise ValueError("Unknown connect option; use coleo-client connect --help")
        if not name or prompt and key_stdin:
            raise ValueError("connect requires --name NAME and at most one credential input option")
        # Explicit URL is authoritative; selection flags would be ambiguous here.
        if flags:
            raise ValueError("connect takes its server URL positionally; omit --server and --connection")
        key = os.environ.get("COLEO_API_KEY", store.data["connections"].get(name, {}).get("key", ""))
        if key_stdin:
            key = sys.stdin.readline().rstrip("\r\n")
        elif prompt or not key and "COLEO_API_KEY" not in os.environ and sys.stdin.isatty():
            key = getpass.getpass("API key (blank for development auth bypass): ")
        if not save_only:
            client = api or Api(url, key)
            try:
                await client.request("/api/status")
            finally:
                if api is None:
                    await client.close()
        store.save(name, url, key)
        value = dict(schemaVersion=1, kind="client.connect", connection=name, server=url, credentialPresent=bool(key), validated=not save_only, ok=True)
    else:
        if rest:
            raise ValueError("Usage: coleo-client doctor [--json]")
        connection = store.resolve(**flags)
        client = api or Api(connection.url, connection.key)
        try:
            value = await doctor(client, connection)
        finally:
            if api is None:
                await client.close()
    if as_json:
        print(json.dumps(value, ensure_ascii=False, indent=2), file=stdout)
    elif command == "connections":
        print("\n".join(f"{'*' if p['name'] == value['active'] else ' '} {p['name']}: {p['server']} (credential {'saved' if p['credentialPresent'] else 'absent'})" for p in value["connections"]) or "No connections. Run coleo-client connect URL --name NAME", file=stdout)
    elif command == "doctor":
        print(json.dumps(value, indent=2), file=stdout)
    else:
        print(f"Selected connection: {value['connection']}\nNext: coleo-client tasks", file=stdout)
    return 0 if value.get("ok", True) else 2
