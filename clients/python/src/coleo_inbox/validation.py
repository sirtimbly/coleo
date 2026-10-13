"""Offline schema-v1 Messaging registry adapter, frozen from canonical TS fixtures."""
import json
import re
from copy import deepcopy
from importlib.resources import files

from .contracts import compact, normalize

SLOTS = {"toolbar.primary." + s for s in ("identity", "context", "search", "actions", "state")} | {
    "toolbar.secondary." + s for s in ("filters", "sort", "presentation", "selection", "insights")}


def obj(value, required, optional=()):
    if not isinstance(value, dict) or set(value) - set(required) - set(optional) or set(required) - set(value):
        raise ValueError(f"Invalid object; required fields: {', '.join(required)}")
    return value


def text(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Expected nonempty string")
    return value.strip()


def array(value):
    if not isinstance(value, list):
        raise ValueError("Expected array")
    return value


def choice(value, choices):
    if value not in choices:
        raise ValueError(f"Unknown value/reference {value!r}; expected {list(choices)}")
    return value


def unique(values):
    if len(set(values)) != len(values):
        raise ValueError("Duplicate IDs, flags or commands")


def layout(value):
    obj(value, (), ("priority", "kind", "collapse", "overflow"))
    if "priority" in value and (type(value["priority"]) is not int or not 0 <= value["priority"] <= 100):
        raise ValueError("Invalid layout priority")
    if "kind" in value:
        choice(value["kind"], ("identity", "action", "choice", "toggle", "value", "status"))
    if "collapse" in value:
        choice(value["collapse"], ("none", "icon", "value", "hide"))
    if "overflow" in value and type(value["overflow"]) is not bool:
        raise ValueError("Invalid layout overflow")
    return value


def key_binding(k):
    obj(k, ("key",), ("modifiers", "scope"))
    key = k["key"]
    if not isinstance(key, str) or not (len(key) == 1 and not re.search("[A-Z]", key) or key in (
        "Space", "Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Backspace", "Delete") or re.fullmatch(r"F([1-9]|1[0-2])", key)):
        raise ValueError("Invalid keyboard key")
    modifiers = array(k.get("modifiers", []))
    unique(modifiers)
    for m in modifiers:
        choice(m, ("control", "meta", "alt", "shift", "primary"))
    if "primary" in modifiers and ({"control", "meta"} & set(modifiers)):
        raise ValueError("Primary modifier conflicts with control/meta")
    return dict(key=key, modifiers=modifiers, scope=choice(k.get("scope", "collection"), ("collection", "item", "tree", "help")))


def binding(b):
    obj(b, ("id", "operation"), ("disabled", "keyboard", "cli"))
    b["id"], b["operation"] = text(b["id"]), text(b["operation"])
    if "disabled" in b and type(b["disabled"]) is not bool:
        raise ValueError("Invalid disabled flag")
    if "cli" in b:
        c = b["cli"]
        if "flag" in c:
            obj(c, ("flag",), ("alias",))
            if not re.fullmatch(r"--[a-z][a-z0-9-]*", c["flag"]) or "alias" in c and not re.fullmatch(r"-[a-zA-Z]", c["alias"]):
                raise ValueError("Invalid CLI flag/alias")
        else:
            obj(c, ("subcommand",))
            if not re.fullmatch(r"[a-z][a-z0-9-]*", c["subcommand"]):
                raise ValueError("Invalid CLI command")
    if "keyboard" in b:
        obj(b["keyboard"], (), ("shared", "web", "tui"))
        b["keyboard"].setdefault("shared", [])
        for client, keys in b["keyboard"].items():
            b["keyboard"][client] = [key_binding(k) for k in array(keys)]
    return b


def validate_keys(bindings):
    for client in ("web", "tui"):
        seen = []
        for b in bindings:
            if b.get("disabled"):
                continue
            keys = b.get("keyboard", {}).get(client, b.get("keyboard", {}).get("shared", []))
            for k in keys:
                modifiers = set(k["modifiers"])
                variants = [modifiers]
                if "primary" in modifiers:
                    variants = [(modifiers - {"primary"}) | {m} for m in ("control", "meta")]
                key = " " if k["key"] == "Space" else k["key"]
                signatures = {(key, tuple(sorted(v))) for v in variants}
                if len(key) == 1 and not key.isalpha():
                    signatures |= {(key, tuple(sorted(v | {"shift"}))) for v in variants}
                for scope, prior in seen:
                    overlap = scope == k["scope"] or "help" not in (scope, k["scope"]) and "collection" in (scope, k["scope"])
                    if overlap and prior & signatures:
                        raise ValueError(f"{client}: conflicting keyboard binding {key}")
                seen.append((k["scope"], signatures))


def resolve(value):
    registry = json.loads(files("coleo_inbox").joinpath("fixtures/registry.json").read_text())
    v = deepcopy(value)
    obj(v, ("schemaVersion", "id", "panelKind", "resource", "query", "commands", "slots", "presentation"),
        ("interactionProfile", "interactions", "toolbar", "hierarchy", "insights"))
    if type(v["schemaVersion"]) is not int or v["schemaVersion"] != 1:
        raise ValueError("Unsupported view schemaVersion; only 1 is supported")
    v["id"] = text(v["id"])
    choice(v["panelKind"], ("collection",))
    choice(v["resource"], registry["resources"])
    resource = registry["resources"][v["resource"]]
    v["query"] = normalize(v["query"])
    v["commands"] = [choice(text(c), resource["commands"]) for c in array(v["commands"])]
    unique(v["commands"])
    if "hierarchy" in v:
        obj(v["hierarchy"], ("initialExpansion", "selectionScope"))
        choice(v["hierarchy"]["initialExpansion"], ("collapsed", "roots", "all"))
        choice(v["hierarchy"]["selectionScope"], ("loaded-descendants",))
    if "toolbar" in v:
        toolbar = obj(v["toolbar"], (), ("maxRows", "groups"))
        toolbar.setdefault("maxRows", 2)
        if type(toolbar["maxRows"]) is not int:
            raise ValueError("Invalid maxRows")
        choice(toolbar["maxRows"], (1, 2))
        for slot, group in obj(toolbar.setdefault("groups", {}), (), SLOTS).items():
            obj(group, ("label", "align"))
            group["label"] = text(group["label"])
            choice(group["align"], ("start", "end"))
    controls = []
    for slot, entries in obj(v["slots"], (), SLOTS).items():
        for c in array(entries):
            obj(c, ("id", "widget", "label"), ("binding", "command", "layout"))
            for k in ("id", "widget", "label", "binding", "command"):
                if k in c:
                    c[k] = text(c[k])
            controls.append(c["id"])
            choice(c["widget"], registry["widgets"])
            w = registry["widgets"][c["widget"]]
            choice(slot, w["slots"])
            if "binding" in c:
                choice(c["binding"], w["bindings"])
            if w.get("commands") and "command" not in c:
                raise ValueError("Widget requires command")
            if "command" in c:
                choice(c["command"], v["commands"])
                choice(c["command"], w.get("commands", []))
            c["layout"] = {"priority": 50, "collapse": "none", "overflow": False, **w.get("layout", {}), **layout(c.get("layout", {}))}
    unique(controls)
    for name, key in (("presentation", "renderers"), ("insights", "panels")):
        if name not in v:
            continue
        section = obj(v[name], ("active", key))
        renderers = array(section[key])
        if name == "presentation" and not renderers:
            raise ValueError("Presentation requires a renderer")
        for r in renderers:
            obj(r, ("id", "renderer", "label", "fields") + (("kind",) if name == "presentation" else ()))
            for k in ("id", "renderer", "label"):
                r[k] = text(r[k])
            choice(r["renderer"], registry["renderers"])
            choice(r.get("kind", "insight"), registry["renderers"][r["renderer"]]["kinds"])
            r["fields"] = [choice(text(f), resource["fields"]) for f in array(r["fields"])]
        unique([r["id"] for r in renderers])
        if section["active"] is not None or name == "presentation":
            section["active"] = choice(text(section["active"]), [r["id"] for r in renderers])
    interactions = registry["interactions"]
    inherited = []
    if "interactionProfile" in v:
        v["interactionProfile"] = choice(text(v["interactionProfile"]), interactions["profiles"])
        inherited = [binding(b) for b in interactions["profiles"][v["interactionProfile"]]["bindings"]]
    overrides = [binding(b) for b in array(v.get("interactions", []))]
    if "interactions" in v:
        v["interactions"] = overrides
    unique([b["id"] for b in overrides])
    merged = {b["id"]: b for b in inherited}
    merged.update({b["id"]: b for b in overrides})
    flags, commands, resolved = [], [], []
    for b in merged.values():
        choice(b["operation"], interactions["operations"])
        op = interactions["operations"][b["operation"]]
        if "command" in op:
            choice(op["command"], v["commands"])
        if b.get("disabled"):
            continue
        cli = b.get("cli")
        if cli:
            (flags if "flag" in cli else commands).extend(cli.values())
        supported = b["operation"] in {"collection.search", "inbox.facet", "inbox.mailbox", "inbox.brain-category",
            "collection.sort", "collection.limit", "collection.presentation", "collection.open", "inbox.mark-read", "collection.help"}
        available = bool(cli) and supported
        resolved.append({**op, "id": b["id"], "operation": b["operation"], "keyboard": [],
                         **({"cli": cli} if cli else {}), "available": available,
                         **({} if available else {"diagnostic": f"No cli {'adapter' if cli else 'CLI binding'} for {b['operation']}"})})
    unique(flags)
    unique(commands)
    validate_keys(list(merged.values()))
    def feature(identifier, registered, descriptors):
        current, seen = registered, set()
        while current:
            if current in seen:
                raise ValueError("Registry fallback cycle")
            seen.add(current)
            descriptor = descriptors[current]
            missing = [c for c in descriptor["capabilities"] if c not in ("table", "text")]
            if not missing:
                return {"id": identifier, "implementation": current, **({"diagnostic": f"Using {current} instead of {registered}"} if current != registered else {})}
            if not descriptor.get("fallback"):
                return dict(id=identifier, implementation=None, diagnostic="Requires capabilities: " + ", ".join(missing))
            current = descriptor["fallback"]
    result = dict(schemaVersion=1, client="cli", definition=v, queryIdentity=compact(v["query"]),
                  features=dict(slots={s: [feature(c["id"], c["widget"], registry["widgets"]) for c in cs] for s, cs in v["slots"].items()},
                                insights=[feature(r["id"], r["renderer"], registry["renderers"]) for r in v.get("insights", {}).get("panels", [])],
                                presentation=[feature(r["id"], r["renderer"], registry["renderers"]) for r in v["presentation"]["renderers"]]),
                  interactions=dict(schemaVersion=1, profileId=v.get("interactionProfile"), client="cli", bindings=resolved))
    from .options import parse
    parse([], result)  # also rejects host command/flag collisions
    return result
