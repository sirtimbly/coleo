"""Explicit domain commands alongside the existing named Messaging view CLI."""
import argparse
import json
import os

from rich.console import Console

from .modules import MODULES, brain_action, collection, inspect_record, overview, render_module
from .csv_cli import run_csv, render_csv
from .discussion_cli import run_discussion, render_discussions
from .maintenance_cli import run_maintenance, render_maintenance


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(f"{message}\n{self.format_usage().strip()}")


async def run_module(args, api, stdout, recipe=None):
    module = recipe.renderer if recipe else args[0]
    parser = Parser(prog=f"coleo-client {args[0]}", description=recipe.description if recipe else MODULES[module].description, add_help=False)
    if module == "brain":
        parser.epilog = ("Controls target the selected API server. For local process lifecycle use "
                         "coleo-server brain run/start/stop/restart/status/logs. "
                         "Legacy brain prompt:task and prompt:context remain local diagnostics.")
    elif module == "tasks":
        parser.epilog = ("sync/reparse operate on the server workspace, not the client working directory. "
                         "Explicit list shows newest first and defaults to 20 rows; "
                         "the default module snapshot uses workspace order and 100 rows.")
    parser.add_argument("--help", "-h", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--width", type=int, default=100)
    parser.add_argument("--color", choices=("auto", "always", "never"), default="auto")
    if module in ("tasks", "bugs"):
        operations = ("list", "show", "csv-export", "csv-import", "csv-edit")
        parser.add_argument("operation", choices=operations + (("discuss", "discussions", "sync", "reparse", "unclaim") if module == "tasks" else ()), nargs="?")
        parser.add_argument("id", nargs="?")
        if module == "tasks":
            parser.add_argument("message", nargs="?")
            parser.add_argument("--reply-to", "-r")
            parser.add_argument("--verbose", "-v", action="store_true")
        parser.add_argument("--filter", "-f", choices=("all", "pending", "not-completed"), default=None)
        parser.add_argument("--search", default="")
        parser.add_argument("--status", "-s", choices=("all", *MODULES[module].statuses), default="all")
        parser.add_argument("--limit", "-n", type=int, default=None)
        parser.add_argument("--offset", type=int, default=0)
    elif module == "brain":
        parser.add_argument("operation", choices=("status", "start", "stop", "pause", "resume"), nargs="?", default="status")
    if "--help" in args or "-h" in args:
        print(parser.format_help(), file=stdout)
        return 0
    options = parser.parse_args(args[1:])
    if not 30 <= options.width <= 500:
        raise ValueError("Width must be 30–500")
    if module in ("tasks", "bugs"):
        explicit_task_list = module == "tasks" and options.operation == "list"
        options.operation = options.operation or "list"
        maintenance = options.operation in ("sync", "reparse", "unclaim")
        if getattr(options, "verbose", False) and not maintenance:
            raise ValueError("--verbose is only supported by sync, reparse, and unclaim")
        if maintenance and (options.id is not None or options.limit is not None or options.offset
                            or options.search or options.status != "all" or options.filter is not None):
            raise ValueError("Maintenance commands do not accept IDs, filters, or pagination")
        if options.limit is None:
            options.limit = 20 if options.operation == "discussions" or explicit_task_list else 100
        if options.operation not in ("discuss", "discussions") and (
                getattr(options, "message", None) is not None or getattr(options, "reply_to", None) is not None):
            raise ValueError("Message and --reply-to are only supported by discuss")
        if maintenance:
            result = await run_maintenance(api, options.operation)
        elif options.operation in ("discuss", "discussions"):
            if options.search or options.status != "all" or options.filter is not None:
                raise ValueError("Discussions do not accept collection filters")
            if options.operation == "discuss" and (options.offset or options.limit != 100):
                raise ValueError("discuss does not accept pagination")
            result = await run_discussion(api, options.operation, options.id, options.message,
                                          options.reply_to, options.limit, options.offset)
        elif options.operation.startswith("csv-"):
            if options.search or options.status != "all" or options.offset or options.limit != 100:
                raise ValueError("CSV commands use --filter, not collection filters or pagination")
            if options.operation == "csv-import" and options.filter is not None:
                raise ValueError("csv-import does not accept --filter")
            result = await run_csv(api, module, options.operation, options.id, options.filter or "all")
        elif options.filter is not None:
            raise ValueError("--filter is only supported by csv-export and csv-edit")
        elif options.operation == "show":
            if not options.id:
                raise ValueError(f"Usage: coleo-inbox {module} show <ID>")
            if options.search or options.status != "all" or options.offset or options.limit != 100:
                raise ValueError("show does not accept collection filters or pagination")
            result = await inspect_record(api, module, options.id)
        else:
            if options.id:
                raise ValueError("Use show <ID> to inspect a record")
            result = await collection(api, module, search=options.search, status=options.status,
                                      limit=options.limit, offset=options.offset,
                                      sort="created-desc" if explicit_task_list else None)
    elif module == "brain" and options.operation != "status":
        result = await brain_action(api, options.operation)
    else:
        result = await overview(api, module)
    if recipe and recipe.id != module:
        result["moduleId"] = recipe.id
    if options.json:
        print(json.dumps(result, ensure_ascii=False, indent=2), file=stdout)
    else:
        console = Console(file=stdout, width=options.width, highlight=False,
                          force_terminal=True if options.color == "always" else False if options.color == "never" else None,
                          no_color=options.color == "never" or options.color == "auto" and "NO_COLOR" in os.environ)
        if result.get("kind") == "module.maintenance":
            console.print(render_maintenance(result, options.verbose))
        elif result.get("kind", "").startswith("module.csv."):
            console.print(render_csv(result))
        elif result.get("kind") in ("module.discussion", "module.discussions"):
            console.print(render_discussions(result))
        else:
            console.print(render_module(result, title=recipe.title if recipe else None))
    if result.get("invalid"):
        return 1
    return 2 if result.get("errors") or result.get("missing") or result.get("conflicts") else 0
