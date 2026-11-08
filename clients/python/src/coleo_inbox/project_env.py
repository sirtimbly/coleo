"""Discover project launch defaults without executing shell code."""
import os
from pathlib import Path


def read_env(path):
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("export "):
            line = line[7:].strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = (part.strip() for part in line.split("=", 1))
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key.startswith("COLEO_"):
            values[key] = value
    return values


def project_environment():
    """Return file defaults separately so explicit connection flags can bypass them."""
    if os.environ.get("COLEO_DIR"):
        return read_env(Path(os.environ["COLEO_DIR"]) / ".env")
    start = Path(os.environ.get("COLEO_PROJECT_DIR") or Path.cwd()).resolve()
    for root in (start, *start.parents):
        values = read_env(root / ".env")
        if (root / ".coleo").is_dir() or values.get("COLEO_DIR"):
            runtime = Path(values.get("COLEO_DIR") or root / ".coleo")
            if not runtime.is_absolute():
                runtime = root / runtime
            return {**values, **read_env(runtime / ".env")}
    return {}
