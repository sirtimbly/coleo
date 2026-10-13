import io
import json
from copy import deepcopy

import pytest

from conftest import fixture
from coleo_inbox.cli import run
from coleo_inbox.validation import resolve


def test_resolved_validation_exact_parity():
    assert resolve(fixture("definition")) == fixture("cli-view")


@pytest.mark.parametrize("mutate", [
    lambda v: v.update(schemaVersion=2),
    lambda v: v.update(resource="future-resource"),
    lambda v: v.update(interactionProfile="future-profile"),
    lambda v: v["commands"].append("future.command"),
    lambda v: v["interactions"][0].update(operation="future.operation"),
    lambda v: v["slots"]["toolbar.primary.identity"][0].update(widget="future.widget"),
    lambda v: v["presentation"]["renderers"][0].update(renderer="future.renderer"),
    lambda v: v["presentation"]["renderers"][0]["fields"].append("futureField"),
    lambda v: v["presentation"].update(active="missing"),
    lambda v: v["insights"].update(active="missing"),
    lambda v: v.update(futureProperty=True),
    lambda v: v["interactions"][0].update(cli={"flag": "--json"}),
    lambda v: v["interactions"][0].update(cli={"flag": "--search"}),
    lambda v: v["interactions"].append({"id": "collision", "operation": "collection.help", "keyboard": {"shared": [{"key": "r"}]}}),
])
def test_unknown_or_incompatible_references_rejected(mutate):
    definition = deepcopy(fixture("definition"))
    mutate(definition)
    with pytest.raises(ValueError):
        resolve(definition)


async def test_validate_is_offline_and_structured(tmp_path, protocol):
    path = tmp_path / "view.json"
    path.write_text(json.dumps(fixture("definition")))
    output = io.StringIO()
    assert await run(["validate", str(path), "--json"], protocol.api(), output) == 0
    assert json.loads(output.getvalue()) == fixture("cli-view")
    assert not protocol.calls
    path.write_text('{"schemaVersion":2}')
    output = io.StringIO()
    assert await run(["validate", str(path), "--json"], protocol.api(), output) == 1
    assert json.loads(output.getvalue())["kind"] == "inbox.error"
    assert not protocol.calls
