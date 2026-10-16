"""Arm operations against the selected API, including explicit partial results."""
from .activity_cli import signature, tail_transcript, transcript_options, transcript_params
from .remote_common import Parser, checked, encoded, integer, nonblank, polling_options, polls, records
from .remote_names import name, suggestions


def arm_path(identifier):
    return "/api/arms/" + encoded(identifier)


async def remove_arm(api, identifier):
    path = arm_path(identifier)
    current = checked(await api.request(path))
    if current.get("arm", {}).get("status") != "stopped":
        raise ValueError(f"Arm {identifier} is not stopped; use arms kill first")
    return checked(await api.request(path, method="DELETE"))


async def watch_messages(api, output, options, identifier):
    previous = {}
    session = None
    async for index in polls(options):
        payload = await api.request(arm_path(identifier) + "/messages", params={"limit": 200})
        messages = records(payload, "messages")
        next_session = payload.get("sessionId")
        current = {}
        visible = []
        for message in messages:
            info = message.get("info", {})
            key = str(info.get("id") or message.get("id") or signature(message))
            filtered = dict(message)
            if options.no_tools:
                filtered["parts"] = [part for part in message.get("parts", [])
                                     if part.get("type") not in ("tool", "tool-invocation")]
            current[key] = signature(filtered)
            if not (options.no_system and info.get("role", message.get("role")) == "system"):
                visible.append((key, filtered))
        if index and next_session == session and previous and (payload.get("truncated") or len(messages) >= 200) and not previous.keys() & current.keys():
            output.emit("stream.gap", {"ok": False, "armId": identifier, "sessionId": next_session,
                        "message": "Message window no longer overlaps previous poll; history may be missing."}, stream=True)
            return 2
        if not index:
            visible = visible[-options.history:] if options.history else []
        for key, message in visible:
            if not index or next_session != session or previous.get(key) != current[key]:
                output.emit("arm.message", {"armId": identifier, "sessionId": next_session,
                            "record": message}, stream=True)
        if options.verbose:
            output.emit("arm.watch.snapshot", {"armId": identifier, "sessionId": next_session,
                        "count": len(messages), "truncated": bool(payload.get("truncated"))}, stream=True)
        previous, session = current, next_session
    return 0


async def spawn_arm(api, output, options):
    identifier = options.name or name()
    # A collection lookup avoids confusing authentication/transport failures with a missing ID.
    existing = next((arm for arm in records(await api.request("/api/arms", params={"includeAll": "true"}), "arms")
                     if arm.get("id") == identifier), None)
    if existing and existing.get("status") != "stopped" and not options.recover:
        raise ValueError(f"Arm {identifier} already exists; kill it first or use --recover")
    fields = {key: value for key, value in {
        "name": identifier, "workdir": options.workdir, "provider": options.provider,
        "model": options.model, "template": options.template, "harness": options.harness,
        "domain": options.domain,
    }.items() if value is not None}
    created = False
    if not existing:
        checked(await api.request("/api/arms", fields))
        created = True
    body = {**fields, "recover": options.recover}
    if options.prompt is not None:
        body["initialPrompt"] = options.prompt
    if options.agent_id:
        body.update(agentId=options.agent_id, preferAgent=True, allowLocalFallback=False)
    try:
        result = checked(await api.request(arm_path(identifier) + "/spawn", body))
        if result.get("spawned") is False:
            raise ValueError("Server did not spawn the arm")
    except ValueError as exc:
        # Do not delete a record that may now own a runtime after an ambiguous timeout.
        output.emit("arms.spawn", {"armId": identifier, "ok": False, "created": created,
                    "stage": "spawn", "error": str(exc), "outcome": "unknown",
                    "nextStep": f"coleo-client arms status {identifier}"})
        return 2
    output.emit("arms.spawn", {**result, "armId": identifier, "created": created}, stream=options.watch)
    if options.watch:
        options.history, options.no_tools, options.no_system, options.verbose = 0, False, False, False
        return await watch_messages(api, output, options, identifier)
    return 0


async def run_arms(args, api, output):
    parser = Parser(prog="coleo-client arms", add_help=False, allow_abbrev=False,
                    description="Selected-server arms. --json is JSONL for watch/tail. Ctrl+C cancels.")
    parser.add_argument("--help", "-h", action="store_true")
    sub = parser.add_subparsers(dest="operation")
    def command(operation):
        return sub.add_parser(operation, add_help=False, allow_abbrev=False)
    listing = command("list")
    listing.add_argument("--all", action="store_true")
    listing.add_argument("--watch", action="store_true")
    polling_options(listing)
    listing.add_argument("-i", dest="interval_ms", type=integer(250, 30000), default=2000)
    names = command("names")
    names.add_argument("--count", "-c", type=integer(1, 100), default=10)
    names.add_argument("--stats", action="store_true")
    spawn = command("spawn")
    spawn.add_argument("--name", "-n", type=nonblank)
    spawn.add_argument("--workdir", "-w", type=nonblank,
                       help="Path on the selected server/agent; default is resolved remotely")
    spawn.add_argument("--prompt", "-p", type=nonblank)
    spawn.add_argument("--harness", choices=("opencode-api",))
    for flag in ("provider", "model", "template", "domain"):
        spawn.add_argument("--" + flag, type=nonblank)
    spawn.add_argument("--agent", "--agent-id", dest="agent_id", type=nonblank)
    spawn.add_argument("--recover", action="store_true")
    spawn.add_argument("--watch", action="store_true")
    polling_options(spawn)
    for operation in ("show", "status", "kill", "recover", "remove", "todos", "messages", "prompt", "watch", "transcript", "logs"):
        child = command(operation)
        child.add_argument("id", type=nonblank)
        if operation == "prompt":
            child.add_argument("message", type=nonblank)
            child.add_argument("--interrupt", "-i", action="store_true")
        if operation == "messages":
            child.add_argument("--count", "--limit", "-n", type=integer(1, 200), default=50)
        if operation == "watch":
            child.add_argument("--history", "-n", type=integer(0, 200), default=2)
            child.add_argument("--no-tools", action="store_true")
            child.add_argument("--no-system", action="store_true")
            child.add_argument("--verbose", "-v", action="store_true")
            polling_options(child)
        if operation == "transcript":
            transcript_options(child)
    command("cleanup")
    tail = command("tail")
    tail.add_argument("id", nargs="?", type=nonblank)
    tail.add_argument("--all", "-a", action="store_true")
    tail.add_argument("--filter", "-f", type=nonblank)
    transcript_options(tail, 10)
    polling_options(tail)
    if "--help" in args or "-h" in args:
        target = sub.choices.get(args[0], parser) if args else parser
        print(target.format_help(), file=output.stdout)
        return 0
    options = parser.parse_args(args or ["list"])
    op = options.operation
    if op is None:
        raise ValueError("Expected an arms operation; use arms --help")
    if op == "logs":
        raise ValueError("Local log files belong to the Arm Host; use arms watch ID or arms tail ID for API observations")
    if op == "spawn":
        if not options.watch and (options.polls or options.once or options.interval_ms != 2000):
            raise ValueError("Polling options require --watch")
        return await spawn_arm(api, output, options)
    if op == "watch":
        return await watch_messages(api, output, options, options.id)
    if op in ("tail", "transcript"):
        if options.arm and (options.id or getattr(options, "all", False)):
            raise ValueError("Use either an ID, --arm, or --all")
        options.arm = None if getattr(options, "all", False) else options.id or options.arm
        if op == "tail":
            filters = [part.strip() for part in (options.filter or "").split(",") if part.strip()]
            return await tail_transcript(api, output, options,
                                         lambda row: not filters or any(part in row.get("action", "") for part in filters))
        payload = await api.request("/api/activity/transcript", params=transcript_params(options))
        records(payload, "transcript")
    elif op == "list":
        if options.once and options.polls and options.polls != 1:
            raise ValueError("--once conflicts with --polls greater than 1")
        if not options.watch and options.polls:
            raise ValueError("--polls requires --watch")
        if not options.watch:
            options.once = True
        async for _ in polls(options):
            payload = await api.request("/api/arms", params={"includeAll": "true"} if options.all else None)
            rows = records(payload, "arms")
            payload["arms"] = rows if options.all else [arm for arm in rows if arm.get("status") != "stopped"]
            output.emit("arms.list", payload, stream=options.watch)
        return 0
    elif op == "names":
        payload = suggestions(options.count, options.stats)
    elif op == "cleanup":
        arms = records(await api.request("/api/arms", params={"includeAll": "true"}), "arms")
        results = []
        for arm in arms:
            if arm.get("status") != "stopped":
                continue
            identifier = arm.get("id")
            if not isinstance(identifier, str) or not identifier:
                raise ValueError("Invalid arm ID in cleanup response")
            try:
                result = await remove_arm(api, identifier)
                results.append({"id": identifier, "ok": True, "result": result})
            except ValueError as exc:
                results.append({"id": identifier, "ok": False, "error": str(exc)})
        payload = {"results": results, "ok": all(row["ok"] for row in results)}
    elif op == "remove":
        payload = await remove_arm(api, options.id)
    elif op in ("show", "status"):
        payload = await api.request(arm_path(options.id))
    elif op in ("todos", "messages"):
        payload = await api.request(arm_path(options.id) + "/" + op,
                                    params={"limit": options.count} if op == "messages" else None)
        records(payload, op)
    else:
        body = {"prompt": options.message, "interrupt": options.interrupt} if op == "prompt" else {}
        payload = await api.request(arm_path(options.id) + "/" + op, body)
    checked(payload)
    output.emit("arms." + op, payload)
    return 2 if payload.get("ok") is False or (op == "transcript" and payload.get("message")) else 0
