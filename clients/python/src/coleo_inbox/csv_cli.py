"""Original Coleo CSV round trips, over HTTP rather than local database access."""
import asyncio
import os
from pathlib import Path
import shlex
import sys
import tempfile

from rich.table import Table
from rich.text import Text

from .presentation import clean


async def export_csv(api, module, path, filter):
    result = await api.request(f"/api/{module}/csv/export", params={"filter": filter})
    if (result.get("schemaVersion") != 1 or result.get("kind") != "module.csv.export"
            or result.get("module") != module or not isinstance(result.get("csv"), str)):
        raise ValueError("Incompatible CSV export response")
    path.write_text(result["csv"], encoding="utf-8")
    return dict(schemaVersion=1, kind="module.csv.export", module=module, path=str(path), filter=filter)


async def import_csv(api, module, path):
    csv = path.read_text(encoding="utf-8-sig")
    result = await api.request(f"/api/{module}/csv/import", {"csv": csv})
    if (result.get("schemaVersion") != 1 or result.get("kind") != "module.csv.import"
            or result.get("module") != module
            or any(not isinstance(result.get(key), list) for key in ("missing", "invalid", "conflicts", "changes"))
            or any(type(result.get(key)) is not int for key in ("totalRows", "changed", "unchanged"))):
        raise ValueError("Incompatible CSV import response; check server state before retrying")
    return result


async def run_csv(api, module, operation, path=None, filter="all"):
    if operation != "csv-edit":
        if not path:
            raise ValueError(f"{operation} requires a CSV path")
        target = Path(path).expanduser()
        return await (export_csv(api, module, target, filter) if operation == "csv-export"
                      else import_csv(api, module, target))
    if path:
        raise ValueError("csv-edit does not accept a path; use csv-import for an existing file")
    editor = next((os.environ[key].strip() for key in ("COLEO_CSV_EDITOR", "COLEO_EDITOR", "EDITOR")
                   if os.environ.get(key, "").strip()), "vi")
    command = shlex.split(editor)
    if not command:
        raise ValueError("Editor command is empty")
    with tempfile.TemporaryDirectory(prefix=f"coleo-{module}-") as directory:
        target = Path(directory) / f"{module}.csv"
        await export_csv(api, module, target, filter)
        process = await asyncio.create_subprocess_exec(*command, str(target), stdout=sys.stderr)
        try:
            code = await process.wait()
        except asyncio.CancelledError:
            if process.returncode is None:
                process.terminate()
            await process.wait()
            raise
        if code:
            raise ValueError(f"Editor exited with code {code}; no CSV changes imported")
        return await import_csv(api, module, target)


def render_csv(result):
    table = Table(title=f"{result['module'].title()} CSV", expand=True)
    table.add_column("Result")
    table.add_column("Details")
    if result["kind"] == "module.csv.export":
        table.add_row("Exported", Text(clean(result["path"])))
        table.add_row("Filter", result["filter"])
    else:
        for key in ("totalRows", "changed", "unchanged"):
            table.add_row(key, str(result[key]))
        for change in result["changes"]:
            table.add_row(Text(clean(change["id"])), Text(", ".join(change["fields"])))
        for key in ("missing", "invalid", "conflicts"):
            for value in result[key]:
                table.add_row(key, Text(clean(value), style="yellow"))
    return table
