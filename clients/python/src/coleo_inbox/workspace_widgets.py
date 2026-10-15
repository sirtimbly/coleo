"""Small compound widgets built on Textual's public containers/input APIs."""
from textual import events
from textual.containers import Horizontal
from textual.widgets import Static


class ColumnDivider(Static, can_focus=True):
    """One-cell split handle, operable by mouse or focused Left/Right keys."""
    DEFAULT_CSS = """
    ColumnDivider { width: 1; height: 1fr; background: $panel; }
    ColumnDivider:hover, ColumnDivider:focus { background: $primary; }
    """
    BINDINGS = [("left", "adjust(-2)", "Narrow pane"), ("right", "adjust(2)", "Widen pane")]

    def __init__(self, column, **kwargs):
        super().__init__(**kwargs)
        self.column = column
        self.drag_start = None
        self.tooltip = "Drag to resize · focus and use Left/Right"

    def action_adjust(self, delta):
        self.parent.resize_column(self.column, delta)

    def on_mouse_down(self, event: events.MouseDown):
        if event.button == 1:
            self.drag_start = event.screen_x
            self.capture_mouse()
            self.focus()
            event.stop()

    def on_mouse_move(self, event: events.MouseMove):
        if self.drag_start is not None:
            self.action_adjust(event.screen_x - self.drag_start)
            self.drag_start = event.screen_x
            event.stop()

    def on_mouse_up(self, event: events.MouseUp):
        self.drag_start = None
        self.release_mouse()
        event.stop()


class WorkspaceColumns(Horizontal):
    """Sidebar / collection / detail; user widths survive polling and tab switches."""
    DEFAULT_CSS = """
    WorkspaceColumns { height: 1fr; }
    WorkspaceColumns > .workspace-sidebar { width: 18; min-width: 18; background: $panel; }
    WorkspaceColumns > .workspace-collection { width: 64; min-width: 24; }
    WorkspaceColumns > .workspace-detail { width: 1fr; min-width: 28; }
    WorkspaceColumns.compact > .workspace-collection { width: 1fr; }
    WorkspaceColumns.compact > .workspace-detail { display: none; }
    WorkspaceColumns.compact > .detail-divider { display: none; }
    WorkspaceColumns.compact.inspecting > .workspace-collection { display: none; }
    WorkspaceColumns.compact.inspecting > .workspace-detail { display: block; width: 1fr; }
    WorkspaceColumns.compact.inspecting > .workspace-sidebar,
    WorkspaceColumns.compact.inspecting > .sidebar-divider { display: none; }
    """

    def __init__(self, *children, **kwargs):
        super().__init__(*children, **kwargs)
        self.sidebar_width = 18
        self.middle_width = 64
        self.wide = True
        self.sidebar_override = None

    def on_resize(self):
        self.apply_widths()

    def set_presentation(self, wide):
        if wide != self.wide:
            self.wide = wide
            self.middle_width = 64 if wide else 34
        self.apply_widths()

    def toggle_sidebar(self):
        visible = self.sidebar_override if self.sidebar_override is not None else self.size.width >= 100
        self.sidebar_override = not visible
        self.apply_widths()

    def resize_column(self, column, delta):
        if column == "sidebar":
            self.sidebar_width = max(18, min(30, self.sidebar_width + delta))
        else:
            sidebar = self.query_one(".workspace-sidebar")
            available = self.size.width - (sidebar.size.width + 1 if sidebar.display else 0) - 29
            self.middle_width = max(24, min(available, self.middle_width + delta))
        self.apply_widths()

    def apply_widths(self):
        if not self.is_mounted or not self.size.width:
            return
        compact = self.size.width < 100
        self.set_class(compact, "compact")
        sidebar = self.query_one(".workspace-sidebar")
        visible = self.sidebar_override if self.sidebar_override is not None else not compact
        sidebar.display = visible
        sidebar.styles.width = self.sidebar_width
        self.query_one(".sidebar-divider").display = visible
        middle = self.query_one(".workspace-collection")
        if compact:
            middle.styles.width = "1fr"
        else:
            available = self.size.width - (self.sidebar_width + 1 if visible else 0) - 29
            middle.styles.width = max(24, min(self.middle_width, available))
