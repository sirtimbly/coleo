"""Discovery filtering and resolution through the selected server."""
from .api import encoded
from .communication_mail import pages, select_unique


async def discoveries(api, options):
    if options.operation == "show":
        return await api.request(f"/api/discoveries/{encoded(options.id)}")
    if options.operation == "resolve":
        records = await pages(api, "/api/discoveries", "discoveries", {"status": "open"})
        selected = select_unique(records, options.id, title=True)
        path = f"/api/discoveries/{encoded(selected['id'])}"
        detail = (await api.request(path))["discovery"]
        if detail.get("id") != selected["id"] or detail.get("status") != "open":
            raise ValueError("Discovery changed during lookup; run the command again")
        if "metadata" not in detail:
            raise ValueError("Server lacks resolution metadata support; upgrade the server before resolving discoveries")
        result = await api.request(path, {"status": options.resolution, "reason": options.reason,
                                          "resolvedBy": "cli"}, method="PATCH")
        return {**result, "id": selected["id"], "status": options.resolution, "reason": options.reason}
    params = {key: getattr(options, attribute) for key, attribute in (
        ("armId", "arm_id"), ("kind", "kind"), ("severity", "severity"), ("since", "since"))
        if getattr(options, attribute, None)}
    params["status"] = "all" if options.operation == "history" else options.status
    records = await pages(api, "/api/discoveries", "discoveries", params)
    if options.operation == "history":
        records = [record for record in records if record["status"] in ("resolved", "dismissed")]
        records.sort(key=lambda record: record["updatedAt"], reverse=True)
    if options.phase:
        records = [record for record in records if record.get("phase") == options.phase]
    if options.task_id:
        records = [record for record in records if record.get("taskId") == options.task_id]
    records = records[options.offset:options.offset + options.limit]
    result = {"discoveries": records}
    if options.operation == "history" and any("metadata" not in record for record in records):
        result["warnings"] = ["Server does not expose resolution metadata; reasons are unavailable"]
    return result
