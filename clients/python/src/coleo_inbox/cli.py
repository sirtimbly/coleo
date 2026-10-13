import asyncio
import json
import os
import sys
from importlib.resources import files

from rich.console import Console
from rich.text import Text

from .api import Api
from .options import help_text, parse, requested_view
from .presentation import clean, render, render_detail
from .selection import execute, targets
from .snapshot import load


async def run(args, api=None, stdout=None, stderr=None):
    api = api or Api()
    stdout, stderr = stdout or sys.stdout, stderr or sys.stderr
    def emit(value):
        print(json.dumps(value, ensure_ascii=False, indent=2), file=stdout)
    try:
        if args and args[0] == "views":
            if any(a != "--json" for a in args[1:]):
                raise ValueError("Usage: coleo-inbox views [--json]")
            views = await api.request("/api/workbench/named-views")
            emit(views) if "--json" in args else print("\n".join(views["views"]), file=stdout)
            return 0
        if args and args[0] == "validate":
            if len(args) not in (2, 3) or len(args) == 3 and args[2] != "--json":
                raise ValueError("Usage: coleo-inbox validate <JSON path> [--json]")
            from pathlib import Path
            from .validation import resolve
            view = resolve(json.loads(Path(args[1]).read_text()))
            emit(view) if "--json" in args else print(f"Valid named Messaging view: {clean(view['definition']['id'])}", file=stdout)
            return 0
        tui = bool(args and args[0] == "tui")
        args = args[1:] if tui else args
        view_id = requested_view(args)
        try:
            view = await api.view(view_id)
        except Exception:
            if view_id != "inbox-triage" or not any(a in ("--help", "-h") for a in args):
                raise
            print("Notice: API unavailable; help uses the bundled inbox-triage definition.", file=stderr)
            view = json.loads(files("coleo_inbox").joinpath("fixtures/cli-view.json").read_text())
        options = parse(args, view)
        if options.help:
            print(help_text(view), file=stdout)
            return 0
        if tui:
            if options.json or options.command:
                raise ValueError("tui does not accept --json or a snapshot command")
            from .app import InboxApp
            await InboxApp(api, view, options).run_async()
            return 0
        console = Console(file=stdout, width=options.width, force_terminal=True if options.color == "always" else False if options.color == "never" else None,
                          no_color=options.color == "never" or options.color == "auto" and "NO_COLOR" in os.environ, highlight=False)
        op = options.command["operation"] if options.command else None
        if op == "collection.open":
            target, detail = await api.inspect(options.ids[0], options.query["profileId"])
            output = dict(schemaVersion=1, kind="inbox.detail", viewId=view["definition"]["id"], query=options.query,
                          id=target["id"], detail=detail, complete=target["complete"], diagnostics=target["diagnostics"])
            if options.json:
                emit(output)
            else:
                console.print(render_detail(detail))
                for d in target["diagnostics"]:
                    console.print(Text(clean(d), style="yellow"))
            return 0 if target["complete"] else 2
        snapshot = await load(api, view, options)
        if not op:
            emit(snapshot) if options.json else console.print(render(snapshot, console.width))
            return 0 if snapshot["complete"] else 2
        if op != "inbox.mark-read":
            raise ValueError(f"Unsupported command {op}")
        result = await execute(api, targets(snapshot, options.ids, options.branch))
        output = dict(schemaVersion=1, kind="inbox.action", command=options.command["command"], result=result)
        if not result.get("error"):
            try:
                output["refreshed"] = await load(api, view, options)
            except Exception as exc:
                output["refreshError"] = str(exc)
        if options.json:
            emit(output)
        else:
            console.print(Text(f"Read: {len(result['completedItemIds'])} items / {len(result['completedMessageIds'])} messages; {len(result['skippedMemberIds'])} context members skipped"))
            if result.get("error") or output.get("refreshError"):
                console.print(Text(clean(result.get("error") or output["refreshError"]), style="red"))
            if "refreshed" in output:
                console.print(render(output["refreshed"], console.width))
        return 1 if result.get("error") else 2 if output.get("refreshError") or not output["refreshed"]["complete"] else 0
    except Exception as exc:
        if "--json" in args:
            emit(dict(schemaVersion=1, kind="inbox.error", error=str(exc)))
        else:
            print(f"Inbox: {clean(exc)}", file=stderr)
        return 1
    finally:
        await api.close()


def main():
    try:
        code = asyncio.run(run(sys.argv[1:]))
    except KeyboardInterrupt:
        code = 130
    raise SystemExit(code)
