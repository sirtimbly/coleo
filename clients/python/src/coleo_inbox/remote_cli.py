"""Selected-server commands. The caller owns Api lifetime and interruption handling."""
from .remote_common import Output, Parser, checked, encoded, integer, nonblank


async def run_remote(args, api, stdout):
    """Run arm/arms/agents/activity/status argv and return an exit status.

    Invalid input/request failures raise ValueError. Cancellation is deliberately
    propagated so the embedding CLI can terminate cleanly with status 130.
    """
    if not args or args[0] not in ("arm", "arms", "agents", "activity", "status"):
        raise ValueError("Expected arm, arms, agents, activity, or status")
    common = Parser(add_help=False, allow_abbrev=False)
    common.add_argument("--json", action="store_true")
    common.add_argument("--width", type=integer(30, 500), default=100)
    common.add_argument("--color", choices=("auto", "always", "never"), default="auto")
    options, rest = common.parse_known_args(args[1:])
    output = Output(stdout, options)
    if args[0] in ("arm", "arms"):
        from .arms_cli import run_arms
        return await run_arms(rest, api, output)
    if args[0] == "activity":
        from .activity_cli import run_activity
        return await run_activity(rest, api, output)
    parser = Parser(prog=f"coleo-client {args[0]}", add_help=False, allow_abbrev=False,
                    description="Selected-server API operation. Supports --json, --width, --color.")
    parser.add_argument("--help", "-h", action="store_true")
    if args[0] == "agents":
        parser.add_argument("operation", nargs="?", choices=("list", "status", "show", "arms"), default="list")
        parser.add_argument("id", nargs="?", type=nonblank)
    if "--help" in rest or "-h" in rest:
        print(parser.format_help(), file=stdout)
        return 0
    parsed = parser.parse_args(rest)
    path = "/api/status"
    kind = "status"
    if args[0] == "agents":
        detail = parsed.operation in ("show", "arms")
        if detail != bool(parsed.id):
            raise ValueError("agents show/arms require an ID; list/status do not accept an ID")
        path = "/api/agents"
        if detail:
            path += "/" + encoded(parsed.id)
        if parsed.operation == "arms":
            path += "/arms"
        kind = "agents." + parsed.operation
    output.emit(kind, checked(await api.request(path)))
    return 0
