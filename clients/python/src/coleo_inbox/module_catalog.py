"""Runtime launch recipes. Renderer implementations remain in modules.py."""
import json
import os
import sys
from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path

from .contracts import normalize


@dataclass(frozen=True)
class ModuleRecipe:
    id: str
    title: str
    description: str
    symbol: str
    renderer: str
    namedView: str | None = None
    facet: str | None = None
    mailbox: str | None = None
    brainCategory: str | None = None
    presentation: str | None = None

    def apply(self, options, view):
        changes = {key: getattr(self, key) for key in ("facet", "mailbox", "brainCategory") if getattr(self, key) is not None}
        options.query = normalize({**options.query, **changes})
        if self.presentation is not None:
            if self.presentation not in {r["id"] for r in view["definition"]["presentation"]["renderers"]}:
                raise ValueError(f"Presentation {self.presentation} is not available in {self.namedView}")
            options.presentation = self.presentation


def decode_catalog(data):
    value = json.loads(data)
    if not isinstance(value, dict) or type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1:
        raise ValueError("Unsupported module catalog version")
    entries = value.get("modules")
    if not isinstance(entries, list) or not entries:
        raise ValueError("Catalog must contain at least one module")
    result = {}
    reserved = {"web", "tui", "modules", "views", "validate", "show", "mark-read",
                "connect", "connections", "use", "doctor", "arm", "arms", "agents", "activity", "status",
                "mail", "discoveries", "config", "status-reports"}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("Module must be an object")
        for key in ("id", "title", "description", "symbol", "renderer"):
            if not isinstance(entry.get(key), str) or key != "description" and not entry[key].strip():
                raise ValueError(f"Module needs a valid {key}")
        if entry["id"] in result or entry["id"] in reserved or entry["id"].startswith("-"):
            raise ValueError(f"Duplicate or reserved module ID: {entry['id']}")
        if entry["renderer"] not in {"messaging", "tasks", "bugs", "brain", "dashboard"}:
            raise ValueError(f"Unsupported renderer: {entry['renderer']}")
        for key in ("namedView", "facet", "mailbox", "brainCategory", "presentation"):
            if entry.get(key) is not None and (not isinstance(entry[key], str) or not entry[key]):
                raise ValueError(f"Invalid {key}")
        if entry["renderer"] == "messaging" and not entry.get("namedView"):
            raise ValueError("Messaging modules require namedView")
        recipe = ModuleRecipe(**{key: entry[key] for key in ModuleRecipe.__dataclass_fields__ if key in entry})
        normalize({key: getattr(recipe, key) for key in ("facet", "mailbox", "brainCategory") if getattr(recipe, key) is not None})
        result[recipe.id] = recipe
    return result


def config_directory():
    if path := os.environ.get("COLEO_CONFIG_DIR"):
        return Path(path).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/Coleo"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "coleo"


class ModuleCatalog:
    def __init__(self, path=None):
        self.settings_path = config_directory() / "python-client.json"
        selected = None
        if path is None and self.settings_path.exists():
            settings = json.loads(self.settings_path.read_text(encoding="utf-8"))
            if not isinstance(settings, dict):
                raise ValueError(f"Invalid client settings: {self.settings_path}")
            selected = settings.get("moduleCatalogPath")
            if selected is not None and not isinstance(selected, str):
                raise ValueError("Invalid saved module catalog path")
        self.path = Path(path or selected or config_directory() / "modules.json").expanduser().resolve()
        self.modules = {}
        if path is None and selected is None and not self.path.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            # Exclusive creation: never overwrite a catalog created by another client.
            try:
                with self.path.open("x", encoding="utf-8") as target:
                    target.write(files("coleo_inbox").joinpath("resources/modules.json").read_text(encoding="utf-8"))
            except FileExistsError:
                pass
        self.reload()

    def reload(self):
        try:
            modules = decode_catalog(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ValueError(f"Could not read {self.path}: {exc}") from exc
        self.modules = modules

    def choose(self, path):
        path = Path(path).expanduser().resolve()
        modules = decode_catalog(path.read_text(encoding="utf-8"))
        self.settings_path.parent.mkdir(parents=True, exist_ok=True)
        # Persist only after validation; replace atomically to avoid partial settings.
        from tempfile import NamedTemporaryFile
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.settings_path.parent, delete=False) as target:
            temporary = Path(target.name)
            json.dump({"moduleCatalogPath": str(path)}, target)
        try:
            temporary.replace(self.settings_path)
        finally:
            temporary.unlink(missing_ok=True)
        self.path, self.modules = path, modules


def catalog_arguments(args):
    """Host option accepted before or after the command; not a named-view flag."""
    args = list(args)
    remaining, path = [], None
    while args:
        token = args.pop(0)
        if token == "--catalog" or token.startswith("--catalog="):
            value = token.split("=", 1)[1] if "=" in token else args.pop(0) if args else ""
            if not value or value.startswith("--"):
                raise ValueError("--catalog requires a JSON path")
            path = value
        else:
            remaining.append(token)
    return remaining, path
