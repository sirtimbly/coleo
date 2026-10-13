from dataclasses import dataclass, field

from .contracts import normalize

HOST = {"--view": True, "--json": False, "--cursor": True, "--pages": True, "--profile": True,
        "--tree": False, "--expand": True, "--branch": False, "--metadata": True,
        "--help": False, "-h": False, "--width": True, "--color": True}


@dataclass
class Options:
    query: dict
    presentation: str = "grid"
    pages: int = 1
    cursor: str | None = None
    tree: bool = False
    expansion: str = "all"
    metadata: str | None = None
    width: int | None = None
    color: str = "auto"
    json: bool = False
    help: bool = False
    branch: bool = False
    command: dict | None = None
    ids: list = field(default_factory=list)


def requested_view(args):
    result = "inbox-triage"
    for i, token in enumerate(args):
        if token.split("=", 1)[0] == "--view":
            result = token.split("=", 1)[1] if "=" in token else (args[i + 1] if i + 1 < len(args) else "")
            if not result or result.startswith("-"):
                raise ValueError("--view requires a named view ID")
    return result


def parse(args, view):
    flags, commands = {}, {}
    for b in view["interactions"]["bindings"]:
        if not b["available"] or not b.get("cli"):
            continue
        cli = b["cli"]
        if "flag" in cli:
            for name in [cli["flag"]] + ([cli["alias"]] if cli.get("alias") else []):
                if name in flags or name in HOST and b["operation"] != "collection.help":
                    raise ValueError(f"Conflicting flag {name}")
                flags[name] = b
        else:
            if cli["subcommand"] in ("tui", "views", "validate") or cli["subcommand"] in commands:
                raise ValueError("Conflicting command")
            commands[cli["subcommand"]] = b
    supplied, bound, positions = {}, {}, []
    i = 0
    while i < len(args):
        token = args[i]
        i += 1
        if not token.startswith("-"):
            positions.append(token)
            continue
        name, sep, inline = token.partition("=")
        b = flags.get(name)
        if b is None and name not in HOST:
            raise ValueError(f"Unknown Inbox option {name}")
        takes = bool(b.get("value")) if b else HOST[name]
        value = True
        if takes:
            value = inline if sep else (args[i] if i < len(args) else "")
            i += not bool(sep)
            if not value or not sep and value.startswith("-"):
                raise ValueError(f"{name} requires a value")
        elif sep:
            raise ValueError(f"{name} does not accept a value")
        key = b["id"] if b else name
        dest = bound if b else supplied
        if key in dest:
            raise ValueError(f"Repeated option {name}")
        if b and b.get("value"):
            spec = b["value"]
            if spec["type"] == "integer":
                if not value.isdecimal():
                    raise ValueError(f"{name} requires an integer")
                value = int(value)
                if not spec.get("minimum", value) <= value <= spec.get("maximum", value):
                    raise ValueError(f"{name} out of range")
            if spec.get("choices") and value not in spec["choices"]:
                raise ValueError(f"{name}: choose {', '.join(spec['choices'])}")
        dest[key] = (b, value) if b else value
    definition = view["definition"]
    q = normalize(definition["query"])
    presentation = definition["presentation"]["active"]
    changes = {}
    for b, value in bound.values():
        if b["operation"] == "collection.help":
            supplied["--help"] = True
            continue
        binding = b.get("binding", "")
        changes[binding] = value
        if binding in ("query.search", "query.facet", "query.mailbox", "query.brainCategory", "query.limit"):
            q[binding[6:]] = value
        elif binding == "query.sort.direction":
            q["sort"] = {"field": "timestamp", "direction": value}
        elif binding == "presentation.active":
            presentation = value
        else:
            raise ValueError(f"Unsupported snapshot binding {binding}")
    if "query.mailbox" in changes:
        if "query.facet" in changes and q["facet"] != "messages":
            raise ValueError("--mailbox requires messages facet")
        q["facet"] = "messages"
    if "query.brainCategory" in changes:
        if "query.mailbox" in changes or "query.facet" in changes and q["facet"] != "brain":
            raise ValueError("--brain-category requires brain facet")
        q["facet"] = "brain"
    if "--profile" in supplied:
        q["profileId"] = supplied["--profile"]
    def integer(name, default, low, high):
        raw = supplied.get(name, str(default))
        if not raw.isdecimal() or not low <= int(raw) <= high:
            raise ValueError(f"{name} must be {low}–{high}")
        return int(raw)
    expansion = supplied.get("--expand", definition.get("hierarchy", {}).get("initialExpansion", "all"))
    color = supplied.get("--color", "auto")
    metadata = supplied.get("--metadata", definition.get("insights", {}).get("active"))
    if metadata == "none":
        metadata = None
    if expansion not in ("all", "roots", "collapsed") or color not in ("auto", "always", "never"):
        raise ValueError("Invalid expansion/color mode")
    if presentation not in [r["id"] for r in definition["presentation"]["renderers"]]:
        raise ValueError("Unknown presentation")
    if metadata and metadata not in [p["id"] for p in definition.get("insights", {}).get("panels", [])]:
        raise ValueError("Unknown metadata panel")
    name = positions.pop(0) if positions else None
    command = commands.get(name)
    if name and command is None:
        raise ValueError(f"Unknown Inbox command {name}")
    # Positional command validity is checked separately from option values.
    positional_name = next((name for name in commands if command is commands[name]), None)
    if "--branch" in supplied and (not command or command["operation"] != "inbox.mark-read"):
        raise ValueError("--branch applies to mark-read")
    help_requested = bool(supplied.get("--help") or supplied.get("-h"))
    if command and not help_requested:
        if not positions or any(not p.strip() for p in positions) or command.get("value", {}).get("type") == "string" and len(positions) != 1:
            raise ValueError(f"{positional_name} requires explicit reference(s)")
    return Options(normalize(q), presentation, integer("--pages", 1, 1, 100), supplied.get("--cursor"),
                   "--tree" in supplied or "--expand" in supplied, expansion, metadata,
                   integer("--width", 80, 20, 300) if "--width" in supplied else None, color,
                   "--json" in supplied, help_requested, "--branch" in supplied, command, positions)


def help_text(view):
    lines = ["Usage: coleo-inbox [tui|views|show <ref>|mark-read <refs...>] [options]", f"Named view: {view['definition']['id']}", "", "Definition-driven options / commands:"]
    for b in view["interactions"]["bindings"]:
        if b.get("cli"):
            names = ", ".join(b["cli"].values())
            spec = b.get("value", {})
            arg = " <" + "|".join(spec.get("choices", [spec.get("type", "")])) + ">" if spec else ""
            lines.append(f"  {names}{arg}: {b['label']}" + ("" if b["available"] else f" [{b.get('diagnostic')}]") )
    lines += ["", "Host options: " + ", ".join(n + (" <value>" if v else "") for n, v in HOST.items()),
              "Expansion: collapsed|roots|all. Color: auto|always|never. Metadata: declared panel ID|none.",
              "Exit: 0 complete requested window; 2 incomplete sources/refresh; 1 input/transport/action error."]
    return "\n".join(lines)
