"""Selected-server arm configuration and status reports."""
from pathlib import Path
import re
import tomllib

from .api import encoded
from .communication_mail import pages


async def settings(api, options):
    if options.operation == "list":
        return await api.request("/api/config/arms")
    name = options.name
    if not re.fullmatch(r"[\w -][\w .-]*", name) or name in (".", ".."):
        raise ValueError("Arm config name must be a filename, without directory separators")
    path = f"/api/config/arms/{encoded(name)}"
    if options.operation == "show":
        return await api.request(path)
    if options.operation == "delete":
        return await api.request(path, method="DELETE")
    try:
        raw = Path(options.file).read_text(encoding="utf-8")
        config = tomllib.loads(raw)
    except (OSError, ValueError) as exc:
        raise ValueError(f"Cannot import arm config: {exc}") from exc
    arm = config.get("arm")
    if not isinstance(arm, dict) or not isinstance(arm.get("name"), str) or not arm["name"].strip():
        raise ValueError("Arm config requires [arm] with a nonempty name")
    for harness in (arm.get("harness"), config.get("harness")):
        if harness is not None and harness != "opencode-api":
            raise ValueError("Arm harness must be opencode-api")
    return await api.request(path, {"raw": raw}, method="PUT")


async def status_reports(api, options):
    if options.operation == "show":
        return await api.request(f"/api/status-reports/{encoded(options.id)}")
    params = {key: getattr(options, attribute) for key, attribute in (
        ("taskId", "task_id"), ("armId", "arm_id"), ("status", "status"), ("since", "since"))
        if getattr(options, attribute)}
    return {"reports": await pages(api, "/api/status-reports", "reports", params,
                                    limit=options.limit, offset=options.offset)}
