"""Server-owned plan synchronization and task reset workflows."""
from rich.table import Table
from rich.text import Text

from .presentation import clean


async def run_maintenance(api, operation):
    result = await api.request(f"/api/tasks/maintenance/{operation}", {})
    if (result.get("schemaVersion") != 1 or result.get("kind") != "module.maintenance"
            or result.get("module") != "tasks" or result.get("operation") != operation
            or any(type(result.get(key)) is not int or result[key] < 0
                   for key in ("added", "updated", "deleted", "unclaimed", "skipped"))
            or not isinstance(result.get("files"), list) or not isinstance(result.get("errors"), list)
            or any(not isinstance(error, str) for error in result["errors"])
            or any(not isinstance(row, dict) or not isinstance(row.get("path"), str)
                   or type(row.get("tasks")) is not int or type(row.get("phases")) is not int
                   or type(row.get("skipped")) is not bool for row in result["files"])):
        raise ValueError("Incompatible maintenance response; check server state before retrying")
    return result


def render_maintenance(result, verbose=False):
    table = Table(title=f"Tasks · {result['operation']}")
    table.add_column("Result")
    table.add_column("Details")
    if result.get("workspace"):
        table.add_row("Server workspace", Text(clean(result["workspace"])))
    keys = ("unclaimed",) if result["operation"] == "unclaim" else ("added", "updated", "deleted", "skipped")
    for key in keys:
        table.add_row(key.title(), str(result[key]))
    if result["operation"] != "unclaim":
        table.add_row("Plan files", str(len(result["files"])))
    if verbose:
        for row in result["files"]:
            table.add_row(Text(clean(row["path"])), "Unchanged" if row["skipped"] else
                          f"{row['tasks']} tasks · {row['phases']} phases")
    for error in result["errors"]:
        table.add_row("Error", Text(clean(error), style="yellow"))
    return table
