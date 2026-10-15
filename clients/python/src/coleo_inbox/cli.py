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
from .modules import DOMAIN_MODULES, MODULES
from .module_catalog import ModuleCatalog, catalog_arguments


async def run(args, api=None, stdout=None, stderr=None):
    api = api or Api()
    stdout, stderr = stdout or sys.stdout, stderr or sys.stderr
    def emit(value):
        print(json.dumps(value, ensure_ascii=False, indent=2), file=stdout)
    domain_command = False
    try:
        args, catalog_path = catalog_arguments(args)
        if args and args[0] == "modules":
            command = [a for a in args[1:] if a != "--json"]
            if command[:1] == ["choose"] and len(command) == 2:
                catalog = ModuleCatalog(command[1])
                catalog.choose(command[1])
            else:
                if command not in ([], ["list"], ["reload"], ["path"]):
                    raise ValueError("Usage: coleo-inbox modules [list|reload|path|choose <path>] [--json] [--catalog <path>]")
                catalog = ModuleCatalog(catalog_path)
            if command == ["path"]:
                emit(dict(catalogPath=str(catalog.path))) if "--json" in args else print(catalog.path, file=stdout)
                return 0
            modules = [dict(id=m.id, title=m.title, description=m.description, renderer=m.renderer) for m in catalog.modules.values()]
            emit(dict(schemaVersion=1, catalogPath=str(catalog.path), modules=modules)) if "--json" in args else print(
                "\n".join(f"{m['id']:12} {m['description']}" for m in modules), file=stdout)
            return 0
        catalog = ModuleCatalog(catalog_path)
        recipe = catalog.modules.get(args[0]) if args else None
        if args and args[0] in DOMAIN_MODULES and recipe is None:
            raise ValueError(f"Module {args[0]} is not in {catalog.path}")
        if recipe and recipe.renderer != "messaging":
            domain_command = True
            from .module_cli import run_module
            return await run_module(args, api, stdout, recipe=recipe)
        if len(args) >= 2 and args[0] == "tui" and not args[1].startswith("-"):
            if args[1] not in catalog.modules:
                raise ValueError(f"Module {args[1]} is not in {catalog.path}")
            if args[2:]:
                raise ValueError("Usage: coleo-inbox tui <module-id> [--catalog <path>]")
            from .module_app import run_workbench
            await run_workbench(api, args[1], catalog=catalog)
            return 0
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
        if recipe:
            args = args[1:]
        if tui and not args:
            from .module_app import run_workbench
            await run_workbench(api, "inbox" if "inbox" in catalog.modules else next(iter(catalog.modules)), catalog=catalog)
            return 0
        if recipe is None:
            recipe = catalog.modules.get("inbox")
        if any(a.split("=", 1)[0] == "--view" for a in args):
            recipe = None
        view_id = recipe.namedView if recipe and recipe.renderer == "messaging" and not any(a.split("=", 1)[0] == "--view" for a in args) else requested_view(args)
        try:
            view = await api.view(view_id)
        except Exception:
            if view_id != "inbox-triage" or not any(a in ("--help", "-h") for a in args):
                raise
            print("Notice: API unavailable; help uses the bundled inbox-triage definition.", file=stderr)
            view = json.loads(files("coleo_inbox").joinpath("fixtures/cli-view.json").read_text())
        options = parse(args, view, recipe=recipe if recipe and recipe.renderer == "messaging" else None)
        if options.help:
            print(help_text(view), file=stdout)
            print("\nModules: modules | " + " | ".join(catalog.modules) + "\n"
                  "Use <module> --help for commands, or tui <module> for Textual.\n"
                  "--catalog <path> selects an external catalog for this invocation.\n"
                  "Inside the TUI: Ctrl+O opens the module picker and catalog controls.", file=stdout)
            return 0
        if tui:
            if options.json or options.command:
                raise ValueError("tui does not accept --json or a snapshot command")
            from .module_app import run_workbench
            await run_workbench(api, inbox_view=view, inbox_options=options, catalog=catalog)
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
            emit(dict(schemaVersion=1, kind="module.error" if domain_command or args and args[0] in (*DOMAIN_MODULES, "modules") else "inbox.error", error=str(exc)))
        else:
            label = "Coleo" if args and args[0] in (*DOMAIN_MODULES, "modules") else "Inbox"
            print(f"{label}: {clean(exc)}", file=stderr)
        return 1
    finally:
        await api.close()


def main():
    try:
        code = asyncio.run(run(sys.argv[1:]))
    except KeyboardInterrupt:
        code = 130
    raise SystemExit(code)
