"""Host inventory, harness runtimes and managed service connections."""
from .remote_common import Parser, checked, encoded, nonblank
from .arms_cli import run_arms


async def run_hosts(args, api, output, family="hosts"):
    if family == "harnesses":
        if args[:1] == ["start"]:
            parser = Parser(prog="coleo-client harnesses start", add_help=False, allow_abbrev=False)
            parser.add_argument("id", type=nonblank)
            if "--help" in args or "-h" in args:
                print(parser.format_help(), file=output.stdout)
                return 0
            options = parser.parse_args(args[1:])
            result = checked(await api.request("/api/arms/" + encoded(options.id) + "/spawn", {}))
            if result.get("spawned") is False:
                raise ValueError("Server did not spawn the harness")
            output.emit("harnesses.start", result)
            return 0
        if args[:1] in (["create"], ["stop"], ["delete"]):
            args = [{"create": "spawn", "stop": "kill", "delete": "remove"}[args[0]], *args[1:]]
        if args[:1] == ["edit"]:
            parser = Parser(prog="coleo-client harnesses edit")
            parser.add_argument("id", type=nonblank)
            for key in ("name", "provider", "model", "domain"):
                parser.add_argument("--" + key, type=nonblank)
            if "--help" in args or "-h" in args:
                print(parser.format_help(), file=output.stdout)
                return 0
            options = parser.parse_args(args[1:])
            body = {key: value for key, value in vars(options).items() if key != "id" and value is not None}
            if not body:
                raise ValueError("Provide a field to edit: --name, --provider, --model, --domain")
            output.emit("harnesses.edit", checked(await api.request("/api/arms/" + encoded(options.id), body, method="PATCH")))
            return 0
        if args[:1] in (["pause"], ["resume"]):
            if len(args) != 2:
                raise ValueError("harnesses pause/resume requires an ID")
            output.emit("harnesses." + args[0], checked(await api.request("/api/arms/" + encoded(args[1]) + "/" + args[0], {})))
            return 0
        if args[:1] == ["list"] or not args:
            args = ["list", "--all", *args[1:]]
        if "--help" in args or "-h" in args:
            print("Harnesses are Arm runtimes. Commands: list, show ID, create --name NAME [--agent ID], "
                  "edit ID, start ID, pause ID, resume ID, stop ID, delete ID.\n"
                  "Create accepts the same flags as arms spawn. Stop before deleting. Model edits apply on next start.", file=output.stdout)
            return 0
        return await run_arms(args, api, output)

    parser = Parser(prog="coleo-client " + family, add_help=False, allow_abbrev=False)
    sub = parser.add_subparsers(dest="operation")
    sub.add_parser("list", add_help=False)
    if family == "services":
        child = sub.add_parser("configure", add_help=False)
        for flag in ("host", "port", "nats-url", "db-path"):
            child.add_argument("--" + flag, type=nonblank)
        child = sub.add_parser("restart", add_help=False)
        child.add_argument("--yes", action="store_true", help="Apply saved settings and restart the managed API")
    else:
        for operation in ("show", "delete", "create", "edit"):
            child = sub.add_parser(operation, add_help=False)
            if operation != "create":
                child.add_argument("id", type=nonblank)
            if operation in ("create", "edit"):
                for flag in ("name", "hostname", "roles", "agent-id", "notes"):
                    child.add_argument("--" + flag, required=operation == "create" and flag in ("name", "hostname", "roles"))
    if "--help" in args or "-h" in args:
        target = sub.choices.get(args[0], parser) if args else parser
        print(target.format_help(), file=output.stdout)
        if family == "hosts":
            print("Roles: arm,api,nats,database. Deleting a host removes inventory only. Discovered hosts can be registered with create.", file=output.stdout)
        return 0
    options = parser.parse_args(args or ["list"])
    op = options.operation
    path = "/api/hosts/services" if family == "services" else "/api/hosts"
    body, method = None, None
    if op is None:
        raise ValueError("Expected an operation; use --help")
    if op == "configure":
        body = {key: getattr(options, flag) for key, flag in (("host", "host"), ("port", "port"), ("natsUrl", "nats_url"), ("dbPath", "db_path")) if getattr(options, flag) is not None}
        if not body:
            raise ValueError("Provide at least one connection setting")
        method = "PATCH"
    elif op == "restart":
        if not options.yes:
            raise ValueError("Restart disconnects clients. Stop harnesses first, then pass --yes to apply saved settings and restart the managed API")
        path += "/restart"
        body = {}
    elif op in ("show", "delete", "edit"):
        path += "/" + encoded(options.id)
        method = {"show": "GET", "delete": "DELETE", "edit": "PATCH"}[op]
    if op in ("create", "edit"):
        body = {key: getattr(options, flag) for key, flag in (("name", "name"), ("hostname", "hostname"), ("roles", "roles"), ("agentId", "agent_id"), ("notes", "notes")) if getattr(options, flag) is not None}
        if "roles" in body:
            body["roles"] = [value.strip() for value in body["roles"].split(",")]
        if not body:
            raise ValueError("Provide at least one host field")
    output.emit(family + "." + op, checked(await api.request(path, body, method=method)))
    return 0
