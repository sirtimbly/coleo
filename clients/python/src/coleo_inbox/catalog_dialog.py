from textual import on
from textual.containers import Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Static


class CatalogPathDialog(ModalScreen):
    BINDINGS = [("escape", "dismiss", "Cancel")]
    DEFAULT_CSS = """
    CatalogPathDialog { align: center middle; }
    #catalog-path-dialog { width: 76; max-width: 95%; height: auto; padding: 1 2; background: $surface; border: solid $accent; }
    """

    def __init__(self, path):
        super().__init__()
        self.path = path

    def compose(self):
        with Vertical(id="catalog-path-dialog"):
            yield Static("Choose module catalog · JSON file path", markup=False)
            yield Input(str(self.path), id="catalog-path")
            yield Static("Read in place at startup and on explicit reload. No copy is made.", markup=False)
            yield Button("Use catalog", id="catalog-use")

    @on(Input.Submitted, "#catalog-path")
    @on(Button.Pressed, "#catalog-use")
    def use_catalog(self):
        path = self.query_one(Input).value.strip()
        if path:
            self.dismiss(path)
