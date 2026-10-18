"""Small API-only command helpers; no runtime or filesystem dependencies."""
import argparse
import asyncio
import json
from datetime import datetime, timezone
from urllib.parse import quote

from rich.console import Console
from rich.pretty import Pretty
from rich.table import Table
from rich.text import Text


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(f"{message}\n{self.format_usage().strip()}")


def integer(minimum, maximum):
    def parse(value):
        try:
            result = int(value)
        except ValueError:
            raise argparse.ArgumentTypeError("Expected an integer") from None
        if not minimum <= result <= maximum:
            raise argparse.ArgumentTypeError(f"Must be {minimum}–{maximum}")
        return result
    return parse


def nonblank(value):
    if not value.strip():
        raise argparse.ArgumentTypeError("Must not be blank")
    return value


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError:
        raise argparse.ArgumentTypeError("Expected an ISO timestamp with timezone") from None


def encoded(value):
    return quote(value, safe="")


def envelope(kind, payload):
    return {**payload, "schemaVersion": 1, "kind": kind}


def checked(payload):
    if payload.get("error"):
        raise ValueError(str(payload["error"]))
    return payload


def records(payload, key):
    checked(payload)
    rows = payload.get(key)
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError(f"Invalid API response: expected {key} array")
    return rows


class Output:
    def __init__(self, stdout, options):
        self.stdout = stdout
        self.json = options.json
        self.console = Console(file=stdout, width=options.width, highlight=False,
                               force_terminal={"always": True, "never": False}.get(options.color),
                               no_color=options.color == "never")

    def emit(self, kind, payload, stream=False):
        result = envelope(kind, payload)
        if self.json:
            print(json.dumps(result, ensure_ascii=False, indent=None if stream else 2),
                  file=self.stdout, flush=stream)
            return
        self.console.print(kind.replace(".", " "), style="bold")
        for key, value in payload.items():
            if isinstance(value, list) and value and all(isinstance(item, dict) for item in value):
                columns = list(dict.fromkeys(k for item in value for k in item))
                preferred = [k for k in ("id", "name", "agentId", "hostname", "status", "armId",
                                        "timestamp", "action", "text", "content") if k in columns]
                # Full details remain available for nested data and message parts.
                if preferred and len(columns) <= 12:
                    table = Table(*preferred, title=key)
                    for item in value:
                        table.add_row(*(Text(str(item.get(k, ""))) for k in preferred))
                    self.console.print(table)
                else:
                    self.console.print(Pretty(value))
            else:
                self.console.print(key + ":", markup=False)
                self.console.print(Pretty(value))
        if stream:
            self.stdout.flush()


def polling_options(parser):
    parser.add_argument("--interval-ms", "--interval", type=integer(250, 30000), default=2000)
    parser.add_argument("--polls", type=integer(1, 100000))
    parser.add_argument("--once", action="store_true")


async def polls(options):
    limit = 1 if options.once else options.polls
    index = 0
    while limit is None or index < limit:
        if index:
            await asyncio.sleep(options.interval_ms / 1000)
        yield index
        index += 1
