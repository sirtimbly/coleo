"""Independent, versioned client connections (credentials stored owner-only)."""
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.parse import urlsplit

from .module_catalog import config_directory

DEFAULT_SERVER = "http://127.0.0.1:8080"
CONNECTION_COMMANDS = {"connect", "connections", "use", "doctor"}
REMOTE_COMMANDS = {"arm", "arms", "agents", "activity", "status", "mail", "discoveries", "config", "status-reports"}


def validate_url(value):
    try:
        if not isinstance(value, str) or any(c.isspace() or ord(c) < 32 for c in value):
            raise ValueError()
        url = urlsplit(value)
        valid = url.scheme in ("http", "https") and url.hostname and url.port != 0
        if not valid or url.username is not None or url.password is not None or url.query or url.fragment:
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError("Invalid server URL: use http(s)://host[:port], without credentials, query or fragment") from None
    return value.rstrip("/")


def validate_name(name):
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name):
        raise ValueError("Connection name must contain letters, numbers, dots, underscores or hyphens")
    return name


@dataclass(frozen=True)
class Connection:
    url: str
    key: str = field(repr=False)
    name: str | None = None
    sources: dict = field(default_factory=dict)

    def public(self):
        return dict(server=self.url, connection=self.name, credentialPresent=bool(self.key), sources=self.sources)


class Connections:
    def __init__(self, path=None):
        self.path = Path(path) if path else config_directory() / "connections.json"
        self.data = dict(schemaVersion=1, active=None, connections={})
        if self.path.exists():
            try:
                self.data = json.loads(self.path.read_text(encoding="utf-8"))
                self.validate(self.data)
            except (OSError, ValueError, TypeError, KeyError):
                raise ValueError(f"Invalid connections file {self.path}; repair or move it aside, then run coleo-client connect") from None

    @staticmethod
    def validate(data):
        if not isinstance(data, dict) or type(data.get("schemaVersion")) is not int or data["schemaVersion"] != 1 or not isinstance(data.get("connections"), dict):
            raise ValueError("Unsupported connections schema")
        for name, profile in data["connections"].items():
            validate_name(name)
            if not isinstance(profile, dict) or not isinstance(profile.get("key", ""), str):
                raise ValueError("Invalid connection")
            validate_url(profile["url"])
        if data.get("active") is not None and data["active"] not in data["connections"]:
            raise ValueError("Unknown active connection")

    def write(self, data):
        self.validate(data)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent, delete=False) as target:
                temporary = Path(target.name)
                os.chmod(temporary, 0o600)
                json.dump(data, target, indent=2)
                target.flush()
                os.fsync(target.fileno())
            temporary.replace(self.path)
            self.data = data
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)

    def save(self, name, url, key):
        validate_name(name)
        self.write(dict(schemaVersion=1, active=name, connections={**self.data["connections"], name: dict(url=validate_url(url), key=key)}))

    def use(self, name):
        if name not in self.data["connections"]:
            raise ValueError("Unknown connection; run coleo-client connections")
        self.write({**self.data, "active": name})

    def public(self):
        return dict(schemaVersion=1, kind="client.connections", active=self.data["active"], connections=[
            dict(name=name, server=p["url"], credentialPresent=bool(p.get("key")))
            for name, p in self.data["connections"].items()])

    def resolve(self, connection=None, server=None, environ=None):
        env = os.environ if environ is None else environ
        name = connection if connection is not None else env.get("COLEO_CONNECTION", self.data["active"])
        if name is not None and name not in self.data["connections"]:
            raise ValueError("Unknown connection; run coleo-client connections or connect URL --name NAME")
        saved = self.data["connections"].get(name, {})
        url = server if server is not None else env.get("COLEO_API_URL", saved.get("url", DEFAULT_SERVER))
        key = env.get("COLEO_API_KEY", saved.get("key", ""))
        sources = dict(connection="flag" if connection is not None else "environment" if "COLEO_CONNECTION" in env else "saved" if name else "default",
                       server="flag" if server is not None else "environment" if "COLEO_API_URL" in env else "saved" if "url" in saved else "default",
                       credential="environment" if "COLEO_API_KEY" in env else "saved" if "key" in saved else "default")
        return Connection(validate_url(url), key, name, sources)


def connection_arguments(args):
    remaining, flags = [], {}
    args = iter(args)
    for token in args:
        name, sep, value = token.partition("=")
        if name not in ("--connection", "--server"):
            remaining.append(token)
            continue
        value = value if sep else next(args, "")
        if not value or value.startswith("-") or name[2:] in flags:
            raise ValueError(f"{name} requires one value")
        flags[name[2:]] = value
    return remaining, flags
