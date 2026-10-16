"""Mail, discoveries, arm settings and report commands; no local server state."""
import argparse
import json
import os

from rich.console import Console
from rich.text import Text

from .communication_discoveries import discoveries
from .communication_mail import mail
from .communication_settings import settings, status_reports


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(f"{message}\n{self.format_usage().strip()}")


def positive(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


def nonnegative(value):
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError("must be a nonnegative integer")
    return number


def nonempty(value):
    if not value.strip():
        raise argparse.ArgumentTypeError("must not be empty")
    return value


def _parser(family):
    parser = Parser(prog=f"coleo-client {family}", add_help=False,
                    description="Operate on the selected server API. --json, --width and --color apply to every operation.")
    parser.add_argument("--help", "-h", action="store_true")
    commands = parser.add_subparsers(dest="operation")

    def command(name, description):
        return commands.add_parser(name, help=description, description=description, add_help=False)

    def filters(target, *, discovery=False):
        target.add_argument("--limit", "-l", type=positive, default=20)
        target.add_argument("--offset", type=nonnegative, default=0)
        target.add_argument("--arm-id")
        target.add_argument("--task-id")
        target.add_argument("--since")
        if discovery:
            target.add_argument("--phase", "-p", choices=("exploration", "implementation", "verification"))
            target.add_argument("--kind")
            target.add_argument("--severity", choices=("info", "warning", "error"))
        else:
            target.add_argument("--status", choices=("on_track", "blocked", "issues_found", "needs_review",
                                                     "completed_with_issues"))

    if family == "mail":
        inbox = command("inbox", "List new then current inbox messages")
        inbox.add_argument("--count", "-n", type=positive, default=10)
        inbox.add_argument("--all", "-a", action="store_true", help="Include read messages (still bounded by count)")
        command("read", "Read latest or unique ID prefix; marks unseen mail read").add_argument(
            "id", nargs="?", type=nonempty)
        send = command("send", "Queue a message from human@local to brain@coleo.local")
        send.add_argument("message", type=nonempty)
        send.add_argument("--subject", "-s")
    elif family == "discoveries":
        listing = command("list", "List discoveries with complete details")
        filters(listing, discovery=True)
        listing.add_argument("--status", default="open", choices=("open", "acknowledged", "resolved", "dismissed", "all"))
        filters(command("history", "Resolved and dismissed discoveries, newest update first"), discovery=True)
        command("show", "Read a discovery by exact ID").add_argument("id", type=nonempty)
        resolve = command("resolve", "Resolve a unique title substring or exact ID")
        resolve.add_argument("id", type=nonempty)
        resolve.add_argument("--resolution", "-r", default="resolved", choices=("resolved", "dismissed"))
        resolve.add_argument("--reason", default="Manually resolved via CLI", type=nonempty)
        summarize = command("summarize", "Retained operator diagnostic: coleo discoveries summarize")
        summarize.add_argument("--task", "-t")
        summarize.add_argument("--verbose", "-v", action="store_true")
    elif family == "config":
        arms = command("arms", "Manage server arm configurations")
        operations = arms.add_subparsers(dest="arm_operation")
        for operation in ("list", "show", "import", "delete"):
            target = operations.add_parser(operation, add_help=False)
            if operation != "list":
                target.add_argument("name", type=nonempty)
            if operation == "import":
                target.add_argument("file", help="Explicit local TOML file; replaces the server config")
    elif family == "status-reports":
        filters(command("list", "List complete status reports"))
        command("show", "Read report by exact ID").add_argument("id", type=nonempty)
        backfill = command("backfill", "Retained operator repair: coleo status-reports backfill")
        backfill.add_argument("--project")
        backfill.add_argument("--task-id")
        backfill.add_argument("--arm-id")
        backfill.add_argument("--dry-run", action="store_true")
    else:
        raise ValueError(f"Unknown communication command: {family}")
    return parser


def _help(parser, args):
    # Resolve the help target without parsing required operands or opening connections.
    current = parser
    for argument in args:
        for action in current._actions:
            if isinstance(action, argparse._SubParsersAction) and argument in action.choices:
                current = action.choices[argument]
                break
    return current.format_help()


def _redact(value):
    if isinstance(value, dict):
        return {key: "[redacted]" if any(part in key.lower() for part in ("secret", "token", "password", "apikey", "api_key"))
                else _redact(item) for key, item in value.items() if key != "raw"}
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def _render(console, value, indent=0):
    if isinstance(value, dict):
        for key, item in value.items():
            if indent == 0 and key in ("schemaVersion", "kind"):
                continue
            console.print(Text(" " * indent + str(key), style="bold"))
            _render(console, item, indent + 2)
    elif isinstance(value, list):
        if not value:
            console.print(" " * indent + "(none)")
        for item in value:
            _render(console, item, indent)
            console.print()
    else:
        console.print(Text(" " * indent + (str(value) if value is not None else "(none)")), soft_wrap=True)


async def run_communication(args, api, stdout):
    """Run a family command; errors propagate as ValueError, partial results exit 2."""
    if not args:
        raise ValueError("Expected mail, discoveries, config, or status-reports")
    parser = _parser(args[0])
    if "--help" in args or "-h" in args or len(args) == 1:
        print(_help(parser, args[1:]), file=stdout)
        return 0
    output = Parser(add_help=False)
    output.add_argument("--json", action="store_true")
    output.add_argument("--width", type=int, default=100)
    output.add_argument("--color", choices=("auto", "always", "never"), default="auto")
    display, remaining = output.parse_known_args(args[1:])
    options = parser.parse_args(remaining)
    if not 30 <= display.width <= 500:
        raise ValueError("Width must be 30–500")
    if options.operation in ("summarize", "backfill"):
        raise ValueError(f"Retained operator diagnostic: run coleo {args[0]} {options.operation} on the server host; no equivalent API job exists")
    if args[0] == "config":
        if options.operation != "arms":
            raise ValueError("Use config arms")
        options.operation = options.arm_operation or "list"
    if not options.operation:
        raise ValueError("Choose an operation; see --help")
    handler = {"mail": mail, "discoveries": discoveries, "config": settings,
               "status-reports": status_reports}[args[0]]
    result = await handler(api, options)
    if args[0] == "config":
        result = _redact(result)
    result = {**result, "schemaVersion": 1, "kind": f"{args[0]}.{options.operation}"}
    if display.json:
        print(json.dumps(result, ensure_ascii=False, indent=2), file=stdout)
    else:
        console = Console(file=stdout, width=display.width, highlight=False,
                          force_terminal=True if display.color == "always" else False if display.color == "never" else None,
                          no_color=display.color == "never" or display.color == "auto" and "NO_COLOR" in os.environ)
        _render(console, result)
    return 2 if result.get("errors") else 0
