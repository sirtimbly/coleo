"""Activity history and bounded, cancellable transcript polling."""
import json
import math
from datetime import datetime, timezone

from .remote_common import Parser, integer, nonblank, polling_options, polls, records, timestamp


def add_filters(parser):
    parser.add_argument("--arm", type=nonblank)
    parser.add_argument("--host", type=nonblank)
    parser.add_argument("--project", type=nonblank)


def transcript_options(parser, default=100):
    parser.add_argument("--count", "--limit", "-n", type=integer(1, 1000), default=default)
    add_filters(parser)
    parser.add_argument("--since", type=timestamp)
    parser.add_argument("--until", type=timestamp)


def transcript_params(options):
    if options.since and options.until and instant(options.since) > instant(options.until):
        raise ValueError("--since must not be after --until")
    arm_ids = list(dict.fromkeys(part.strip() for part in (options.arm or "").split(",") if part.strip()))
    if options.arm and not arm_ids:
        raise ValueError("--arm requires at least one ID")
    if len(arm_ids) > 100:
        raise ValueError("Transcript supports at most 100 arm IDs")
    return {key: value for key, value in {
        "limit": options.count, "scanLimit": 5000, "armId": ",".join(arm_ids) if arm_ids else None,
        "host": options.host, "project": options.project,
        "since": options.since, "until": options.until,
    }.items() if value is not None}


def signature(row):
    return json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def instant(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError):
        raise ValueError("API event contains an invalid timestamp") from None


def ordered(rows):
    # Preserve server order for ties; its action tie-breaker is deterministic.
    return sorted(rows, key=lambda row: (instant(row.get("timestamp")), row.get("sequence") or 0,
                                          row.get("action", "")))


async def tail_transcript(api, output, options, event_filter=None):
    params = transcript_params(options)
    # Older servers ignore this optional query parameter. Only the explicit
    # cursorMode response opts us into stream-sequence ordering/continuation.
    params["afterSequence"] = 0
    cursor = 0
    cursor_supported = None
    boundary = params.get("since")
    seen = set()
    async for index in polls(options):
        started = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        if index:
            params["limit"] = 1000
            if boundary and not cursor_supported:
                params["since"] = boundary
        payload = await api.request("/api/activity/transcript", params=params)
        rows = records(payload, "transcript")
        if payload.get("message"):
            output.emit("stream.notice", {"message": payload["message"], "ok": False}, stream=True)
            return 2
        pagination = payload.get("pagination", {})
        if pagination.get("cursorMode") == "sequence-v1":
            cursor_supported = True
            next_cursor = pagination.get("nextCursor")
            high_watermark = pagination.get("highWatermark")
            if type(next_cursor) is not int or type(high_watermark) is not int:
                raise ValueError("Transcript API returned an invalid sequence cursor")
            if pagination.get("gap"):
                output.emit("stream.gap", {"ok": False, "afterSequence": cursor,
                            "pagination": pagination,
                            "message": "Transcript history has a retention, deletion, or stream-reset gap."}, stream=True)
                return 2
            if not cursor <= next_cursor <= high_watermark or (pagination.get("hasMore") and next_cursor == cursor):
                raise ValueError("Transcript API returned a non-progressing sequence cursor")
            previous_sequence = cursor
            for row in rows:
                sequence = row.get("sequence")
                if type(sequence) is not int or not previous_sequence < sequence <= next_cursor:
                    raise ValueError("Transcript events are not in ascending sequence order")
                previous_sequence = sequence
            for row in rows:
                if not event_filter or event_filter(row):
                    output.emit("activity.event", {"record": row}, stream=True)
            cursor = next_cursor
            params["afterSequence"] = cursor
            continue
        if cursor_supported:
            raise ValueError("Transcript API stopped providing sequence cursors during streaming")
        cursor_supported = False
        params.pop("afterSequence", None)
        rows = ordered(rows)
        latest = boundary
        next_seen = set(seen)
        emitted = set(seen)
        for row in rows:
            stamp = row.get("timestamp")
            if not isinstance(stamp, str):
                raise ValueError("Transcript event is missing its timestamp")
            key = signature(row)
            if boundary and instant(stamp) < instant(boundary):
                continue
            if key not in emitted and (not event_filter or event_filter(row)):
                output.emit("activity.event", {"record": row}, stream=True)
            emitted.add(key)
            if latest is None or instant(stamp) > instant(latest):
                latest, next_seen = stamp, set()
            if instant(stamp) == instant(latest):
                next_seen.add(key)
        saturated = payload.get("pagination", {}).get("hasMore") or len(rows) >= params["limit"]
        if index and saturated and latest and boundary and instant(latest) == instant(boundary):
            output.emit("stream.gap", {"ok": False, "since": boundary,
                        "message": "Transcript window saturated without cursor progress; server sequence cursor required."},
                        stream=True)
            return 2
        boundary = latest or started
        seen = next_seen
    return 0


async def run_activity(args, api, output):
    parser = Parser(prog="coleo-client activity", add_help=False, allow_abbrev=False,
                    description="Selected-server activity. --json uses JSONL for tail; Ctrl+C cancels.")
    parser.add_argument("--help", "-h", action="store_true")
    sub = parser.add_subparsers(dest="operation")
    listing = sub.add_parser("list", add_help=False, allow_abbrev=False)
    listing.add_argument("--count", "--limit", "-n", type=integer(1, 200), default=20)
    group = listing.add_mutually_exclusive_group()
    group.add_argument("--actor", "-a", type=nonblank)
    group.add_argument("--producer", type=nonblank)
    listing.add_argument("--before-sequence", type=integer(1, 2**63 - 1))
    listing.add_argument("--pages", type=integer(1, 1000), default=1)
    transcript = sub.add_parser("transcript", add_help=False, allow_abbrev=False)
    transcript_options(transcript)
    tail = sub.add_parser("tail", add_help=False, allow_abbrev=False)
    transcript_options(tail, 10)
    polling_options(tail)
    search = sub.add_parser("search", add_help=False, allow_abbrev=False)
    search.add_argument("query", type=nonblank)
    search.add_argument("--count", "--limit", "-n", type=integer(1, 100), default=20)
    search.add_argument("--min-score", type=float, default=0.05)
    add_filters(search)
    if "--help" in args or "-h" in args:
        target = sub.choices.get(args[0], parser) if args else parser
        print(target.format_help(), file=output.stdout)
        return 0
    options = parser.parse_args(args or ["list"])
    if options.operation is None:
        raise ValueError("Expected activity list, transcript, search, or tail")
    if options.operation == "tail":
        return await tail_transcript(api, output, options)
    if options.operation == "transcript":
        payload = await api.request("/api/activity/transcript", params=transcript_params(options))
        payload["transcript"] = ordered(records(payload, "transcript"))
    elif options.operation == "list":
        if (options.before_sequence or options.pages > 1) and not options.producer:
            raise ValueError("Cursor pagination requires --producer; this API does not paginate actor/all history")
        params = {"limit": options.count}
        if options.actor:
            params["actor"] = options.actor
        if options.producer:
            params["producer"] = options.producer
        if options.before_sequence:
            params["beforeSequence"] = options.before_sequence
        accumulated, seen, cursors = [], set(), set()
        for _ in range(options.pages):
            payload = await api.request("/api/activity", params=params.copy())
            for row in records(payload, "activity"):
                key = row.get("sequence") or row.get("id") or signature(row)
                if key not in seen:
                    accumulated.append(row)
                    seen.add(key)
            pagination = payload.get("pagination", {})
            if not pagination.get("hasMore"):
                break
            cursor = pagination.get("nextCursor")
            if not isinstance(cursor, int) or cursor <= 0 or cursor in cursors:
                raise ValueError("Activity API returned a missing or repeated pagination cursor")
            cursors.add(cursor)
            params["beforeSequence"] = cursor
        payload["activity"] = ordered(accumulated)
    else:
        if not math.isfinite(options.min_score) or not 0 <= options.min_score <= 1:
            raise ValueError("--min-score must be between 0 and 1")
        arms = list(dict.fromkeys(part.strip() for part in (options.arm or "").split(",") if part.strip()))
        if options.arm and not arms:
            raise ValueError("--arm requires at least one ID")
        if len(arms) > 100:
            raise ValueError("Search supports at most 100 arm IDs")
        results = {}
        semantic, took = True, 0
        for arm in arms or [None]:
            filters = {k: v for k, v in {"arm_id": arm, "host": options.host,
                                         "project": options.project}.items() if v is not None}
            payload = await api.request("/api/search", {
                "query": options.query, "types": ["arm_transcript"], "limit": options.count,
                "minScore": options.min_score, "keywordWeight": 0, "semanticWeight": 1, "filters": filters,
            })
            for row in records(payload, "results"):
                key = row.get("id") or signature(row)
                if key not in results or row.get("score", 0) > results[key].get("score", 0):
                    results[key] = row
            semantic = semantic and bool(payload.get("semanticUsed"))
            took += payload.get("took", 0)
        payload = {"results": sorted(results.values(), key=lambda row: (-row.get("score", 0), str(row.get("id", ""))))[:options.count],
                   "semanticUsed": semantic, "took": took}
    output.emit("activity." + options.operation, payload)
    return 2 if payload.get("message") else 0
