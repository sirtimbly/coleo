from .contracts import hierarchy, sources


def metadata_values(items, summaries, fields):
    """Shared CLI/live-panel scoped metadata recipe; None always means unknown."""
    return [dict(field=f, label={"unread": "Unread", "requiresAction": "Needs action", "timestamp": "Latest loaded item"}[f],
                 value=max((i["timestamp"] for i in items), default=None) if f == "timestamp" else summaries[f],
                 scope="loaded-window" if f == "timestamp" else "query")
            for f in fields if f in ("unread", "requiresAction", "timestamp")]


async def load(api, view, options):
    pages, diagnostics, items, seen = [], [], {}, set()
    cursor, complete = options.cursor, True
    for _ in range(options.pages):
        if cursor in seen:
            raise ValueError("Repeated continuation cursor")
        seen.add(cursor)
        p = await api.page(options.query, cursor)
        if p["nextCursor"] and p["nextCursor"] in seen:
            raise ValueError("Repeated continuation cursor")
        pages.append(p)
        for item in p["items"]:
            if item["id"] in items:
                complete = False
                diagnostics.append(f"Repeated item across pages: {item['id']}; traversal stopped")
            else:
                items[item["id"]] = item
        for source in sources(options.query):
            if source not in [s["id"] for s in p["sources"]]:
                complete = False
                diagnostics.append(f"Source {source} did not report freshness/completeness")
        for s in p["sources"]:
            if s["status"] != "fresh" or not s["complete"]:
                complete = False
                diagnostics.append(f"{s['id']}: {s['status']}" + (" / incomplete" if not s["complete"] else "") + (f" ({s['error']['message']})" if s.get("error") else ""))
        if not p["summaries"]["complete"]:
            complete = False
            diagnostics.append("Query-wide counts are incomplete")
        if not complete or not p["nextCursor"]:
            break
        cursor = p["nextCursor"]
    presentation = next(r for r in view["definition"]["presentation"]["renderers"] if r["id"] == options.presentation)
    feature = next((f for f in view["features"]["presentation"] if f["id"] == options.presentation), {})
    if feature.get("diagnostic"):
        diagnostics.append(feature["diagnostic"])
    if feature.get("implementation") not in ("collection.grid", "collection.list"):
        diagnostics.append(f"No CLI renderer for {feature.get('implementation') or presentation['renderer']}; showing the declared fields as text")
    fields = presentation["fields"]
    def row(identifier, parent, depth, selectable, data):
        return dict(id=identifier, parentId=parent, depth=depth, selectable=selectable,
                    values={f: data.get(f) if isinstance(data.get(f), (str, bool, int, float)) else None for f in fields})
    rows = []
    for item in items.values():
        rows.append(row(item["id"], None, 0, not bool(item.get("thread")), item))
        if item.get("thread") and options.tree:
            hrows, children = hierarchy(item["thread"])
            visible = set(item["thread"]["hierarchy"]["rootIds"])
            for n, depth in hrows:
                if n["id"] not in visible:
                    continue
                if options.expansion == "all" or options.expansion == "roots" and depth == 0:
                    visible.update(children[n["id"]])
                if n["id"] != item["id"]:
                    rows.append(row(n["id"], n["parentId"], depth, n["selectable"], n["data"]))
            diagnostics.extend(f"{item['id']}: {d['message']}" for d in item["thread"]["diagnostics"])
    panel = next((p for p in view["definition"].get("insights", {}).get("panels", []) if p["id"] == options.metadata), {})
    metadata = metadata_values(list(items.values()), pages[0]["summaries"], panel.get("fields", []))
    for f in view["features"].get("insights", []):
        if f["id"] == options.metadata and f.get("diagnostic"):
            diagnostics.append(f["diagnostic"])
    return dict(schemaVersion=1, kind="inbox.snapshot", view=view, query=options.query,
                presentation=dict(id=presentation["id"], implementation=feature.get("implementation"), fields=fields),
                pages=pages, items=list(items.values()), rows=rows, metadata=metadata, metadataPanelId=options.metadata,
                diagnostics=list(dict.fromkeys(diagnostics)), complete=complete,
                traversal=dict(loadedPages=len(pages), requestedPages=options.pages, nextCursor=pages[-1]["nextCursor"] if complete else None,
                               retryCursor=None if complete else pages[-1]["cursor"], exhausted=complete and pages[-1]["nextCursor"] is None))
