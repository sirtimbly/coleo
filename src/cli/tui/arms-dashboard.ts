import { mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  BoxRenderable,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { getCliEntrypoint } from "../entrypoint";
import {
  deleteArmProfile,
  fetchArmDetail,
  fetchDashboardSnapshot,
  killArmSession,
  markArmStuck,
  readFullBrainLogLines,
  readFullServerLogLines,
  restartBrainService,
  sendArmMessage,
  sendBrainMessage,
  type DashboardArmDetail,
  type DashboardSnapshot,
} from "./arms-dashboard-data";
import {
  applySearch,
  buildDashboardNodes,
  buildViewForNode,
  type DashboardNode,
} from "./arms-dashboard-view";

type FocusArea = "nav" | "body" | "input";
type InputMode = "search" | "arm-message" | "brain-message" | null;

interface ConfirmAction {
  prompt: string;
  execute: () => Promise<void>;
}

interface SidebarRow {
  nodeId: string | null;
  content: string;
  selected: boolean;
}

function truncateLine(value: string, maxLength = 140): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function padRight(value: string, width: number): string {
  if (value.length >= width) {
    return value.slice(0, width);
  }

  return value + " ".repeat(width - value.length);
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "export";
}

function buildVerticalScrollbar(height: number, scrollY: number, maxScrollY: number): string {
  if (height <= 0 || maxScrollY <= 0) {
    return "";
  }

  const thumbSize = Math.max(1, Math.round((height / (maxScrollY + height)) * height));
  const thumbStart = Math.min(
    height - thumbSize,
    Math.round((scrollY / Math.max(1, maxScrollY)) * Math.max(0, height - thumbSize)),
  );

  return Array.from({ length: height }, (_, index) =>
    index >= thumbStart && index < thumbStart + thumbSize ? "█" : "│"
  ).join("\n");
}

class ArmsDashboardTui {
  private renderer!: CliRenderer;
  private root!: BoxRenderable;
  private sidebarBox!: BoxRenderable;
  private sidebarListBox!: BoxRenderable;
  private mainBox!: BoxRenderable;
  private titleText!: TextRenderable;
  private bodyBox!: BoxRenderable;
  private bodyContentBox!: BoxRenderable;
  private statusBox!: BoxRenderable;
  private footerBox!: BoxRenderable;
  private bodyText!: TextRenderable;
  private bodyScrollbarText!: TextRenderable;
  private footerStatusText!: TextRenderable;
  private footerControlsText!: TextRenderable;
  private footerPromptText!: TextRenderable;
  private footerInput!: InputRenderable;

  private snapshot: DashboardSnapshot | null = null;
  private nodes: DashboardNode[] = [];
  private selectedNodeId = "brain";
  private selectedArmDetail: DashboardArmDetail | null = null;
  private armDetailCache = new Map<string, DashboardArmDetail>();
  private showHelp = false;
  private focusArea: FocusArea = "nav";
  private inputMode: InputMode = null;
  private confirmAction: ConfirmAction | null = null;
  private interruptBeforeSend = false;
  private notice = "Loading dashboard...";
  private searchQuery = "";
  private searchLinesOverride: string[] | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight = false;
  private destroyed = false;
  private closeResolver: (() => void) | null = null;
  private expandedNodeIds = new Set<string>(["arms"]);
  private navScrollOffset = 0;
  private sidebarRowRenderables: Array<BoxRenderable | TextRenderable> = [];
  private loadDetailRequestId = 0;
  private searchRequestId = 0;
  private refreshRequestId = 0;
  private footerInputEnterHandler: (() => void) | null = null;
  private keypressHandler: ((key: KeyEvent) => void) | null = null;

  async run(): Promise<void> {
    try {
      this.snapshot = await fetchDashboardSnapshot();
      this.nodes = buildDashboardNodes(this.snapshot);
    } catch (error) {
      console.error(`Failed to load dashboard: ${formatErrorMessage(error)}`);
      console.error("Please ensure the Coleo API server is running.");
      process.exit(1);
    }

    this.renderer = await createCliRenderer({
      screenMode: "alternate-screen",
      exitOnCtrlC: false,
      useMouse: true,
      autoFocus: true,
      externalOutputMode: "passthrough",
      consoleMode: "console-overlay",
      openConsoleOnError: true,
    });

    this.buildUi();
    this.wireEvents();

    this.setFocus("nav");
    this.render(true);
    this.renderer.start();

    this.refreshTimer = setInterval(() => {
      void this.refresh(false);
    }, 3000);

    await new Promise<void>((resolve) => {
      this.closeResolver = resolve;
    });
  }

  private buildUi(): void {
    this.root = new BoxRenderable(this.renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "row",
      backgroundColor: "#0b0f10",
    });
    this.renderer.root.add(this.root);

    this.sidebarBox = new BoxRenderable(this.renderer, {
      width: 32,
      height: "100%",
      border: true,
      title: "Navigator",
      flexDirection: "column",
      padding: 0,
      borderColor: "#34515e",
      backgroundColor: "#0b0f10",
    });
    this.root.add(this.sidebarBox);

    this.sidebarListBox = new BoxRenderable(this.renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: "#0b0f10",
    });
    this.sidebarBox.add(this.sidebarListBox);

    this.mainBox = new BoxRenderable(this.renderer, {
      flexGrow: 1,
      height: "100%",
      flexDirection: "column",
      paddingLeft: 1,
    });
    this.root.add(this.mainBox);

    this.titleText = new TextRenderable(this.renderer, {
      width: "100%",
      height: 1,
      wrapMode: "none",
      truncate: false,
      fg: "#f2f7f9",
      bg: "#0b0f10",
    });
    this.mainBox.add(this.titleText);

    this.bodyBox = new BoxRenderable(this.renderer, {
      flexGrow: 1,
      border: true,
      flexDirection: "row",
      borderColor: "#34515e",
      padding: 1,
      marginTop: 0,
      backgroundColor: "#0b0f10",
    });
    this.mainBox.add(this.bodyBox);

    this.bodyContentBox = new BoxRenderable(this.renderer, {
      flexGrow: 1,
      height: "100%",
      backgroundColor: "#0b0f10",
    });
    this.bodyBox.add(this.bodyContentBox);

    this.bodyText = new TextRenderable(this.renderer, {
      width: "100%",
      height: "100%",
      wrapMode: "word",
      truncate: false,
      fg: "#d7e3e8",
      bg: "#0b0f10",
    });
    this.bodyContentBox.add(this.bodyText);

    this.bodyScrollbarText = new TextRenderable(this.renderer, {
      width: 1,
      height: "100%",
      wrapMode: "none",
      truncate: false,
      fg: "#9fb9c6",
      bg: "#0b0f10",
      content: "",
    });
    this.bodyBox.add(this.bodyScrollbarText);

    this.statusBox = new BoxRenderable(this.renderer, {
      height: 3,
      border: true,
      title: "Status",
      borderColor: "#34515e",
      padding: 0,
      marginTop: 0,
      flexDirection: "column",
      backgroundColor: "#0b0f10",
    });
    this.mainBox.add(this.statusBox);

    this.footerStatusText = new TextRenderable(this.renderer, {
      width: "100%",
      height: 1,
      wrapMode: "none",
      truncate: true,
      fg: "#f6d365",
      bg: "#0b0f10",
    });
    this.statusBox.add(this.footerStatusText);

    this.footerBox = new BoxRenderable(this.renderer, {
      height: 5,
      border: true,
      title: "Commands",
      borderColor: "#34515e",
      padding: 0,
      marginTop: 0,
      flexDirection: "column",
      backgroundColor: "#0b0f10",
    });
    this.mainBox.add(this.footerBox);

    this.footerControlsText = new TextRenderable(this.renderer, {
      width: "100%",
      height: 1,
      wrapMode: "none",
      truncate: true,
      fg: "#9fb9c6",
      bg: "#0b0f10",
    });
    this.footerBox.add(this.footerControlsText);

    this.footerPromptText = new TextRenderable(this.renderer, {
      width: "100%",
      height: 1,
      wrapMode: "none",
      truncate: true,
      fg: "#d7e3e8",
      bg: "#0b0f10",
    });
    this.footerBox.add(this.footerPromptText);

    this.footerInput = new InputRenderable(this.renderer, {
      width: "100%",
      value: "",
      placeholder: "",
      backgroundColor: "#10222d",
      textColor: "#ffffff",
      focusedBackgroundColor: "#17313f",
      focusedTextColor: "#ffffff",
      placeholderColor: "#6b8794",
    });
    this.footerBox.add(this.footerInput);
  }

  private wireEvents(): void {
    this.footerInputEnterHandler = () => {
      if (!this.destroyed) {
        void this.submitInput();
      }
    };
    this.footerInput.on(InputRenderableEvents.ENTER, this.footerInputEnterHandler);

    this.keypressHandler = (key: KeyEvent) => {
      if (!this.destroyed) {
        void this.handleKeyPress(key);
      }
    };
    this.renderer.keyInput.on("keypress", this.keypressHandler);
  }

  private currentNode(): DashboardNode {
    return this.visibleNodes().find((node) => node.id === this.selectedNodeId)
      || this.nodes.find((node) => node.id === this.selectedNodeId)
      || this.visibleNodes()[0]
      || this.nodes[0]
      || {
      id: "brain",
      kind: "brain",
      label: "Brain",
      description: "",
     depth: 0,
    };
  }

  private nodeHasChildren(node: DashboardNode): boolean {
    return this.nodes.some((candidate) => candidate.depth === node.depth + 1 && this.parentNodeId(candidate) === node.id);
  }

  private isExpanded(node: DashboardNode): boolean {
    return this.expandedNodeIds.has(node.id);
  }

  private visibleNodes(): DashboardNode[] {
    const visible: DashboardNode[] = [];

    for (const node of this.nodes) {
      if (node.depth === 0) {
        visible.push(node);
        continue;
      }

      const parentId = this.parentNodeId(node);
      if (parentId && this.expandedNodeIds.has(parentId)) {
        visible.push(node);
      }
    }

    return visible;
  }

  private visibleNodeIndex(): number {
    const index = this.visibleNodes().findIndex((node) => node.id === this.selectedNodeId);
    return index >= 0 ? index : 0;
  }

  private selectNode(node: DashboardNode, resetScroll: boolean): void {
    if (this.selectedNodeId === node.id) {
      return;
    }

    this.selectedNodeId = node.id;
    this.searchQuery = "";
    this.searchLinesOverride = null;
    this.selectedArmDetail = node.kind === "arm" && node.armId
      ? (this.armDetailCache.get(node.armId) || null)
      : null;
    this.ensureNavSelectionVisible();
    this.render(resetScroll);

    if (node.kind === "arm") {
      void this.loadSelectedArmDetail();
    }
  }

  private ensureNavSelectionVisible(): void {
    const rows = this.buildSidebarRows();
    const selectedIndex = Math.max(0, rows.findIndex((row) => row.nodeId === this.selectedNodeId));
    const viewportHeight = Math.max(1, this.sidebarListBox.height);

    if (selectedIndex < this.navScrollOffset) {
      this.navScrollOffset = selectedIndex;
    } else if (selectedIndex >= this.navScrollOffset + viewportHeight) {
      this.navScrollOffset = selectedIndex - viewportHeight + 1;
    }

    const maxOffset = Math.max(0, rows.length - viewportHeight);
    this.navScrollOffset = Math.max(0, Math.min(this.navScrollOffset, maxOffset));
  }

  private async toggleCurrentNode(openOnly = false): Promise<void> {
    const node = this.currentNode();
    if (!this.nodeHasChildren(node)) {
      return;
    }

    const expanded = this.isExpanded(node);
    if (expanded && !openOnly) {
      this.expandedNodeIds.delete(node.id);
      const current = this.currentNode();
      if (current.depth > node.depth) {
        this.selectedNodeId = node.id;
      }
    } else {
      this.expandedNodeIds.add(node.id);
    }

    this.ensureNavSelectionVisible();
    this.render(true);
  }

  private async collapseCurrentNodeOrParent(): Promise<void> {
    const node = this.currentNode();

    if (node.kind === "arm") {
      const parent = this.nodes.find((candidate) => candidate.id === "arms");
      if (parent) {
        this.selectedNodeId = parent.id;
        this.ensureNavSelectionVisible();
        this.render(true);
      }
      return;
    }

    if (this.nodeHasChildren(node) && this.isExpanded(node)) {
      this.expandedNodeIds.delete(node.id);
      this.ensureNavSelectionVisible();
      this.render(true);
    }
  }

  private rebuildSidebar(): void {
    // Destroy and remove old renderables to prevent memory leaks
    for (const child of this.sidebarListBox.getChildren()) {
      child.destroy?.();
      this.sidebarListBox.remove(child.id);
    }
    for (const renderable of this.sidebarRowRenderables) {
      renderable.destroy?.();
    }
    this.sidebarRowRenderables = [];

    const visible = this.buildSidebarRows();
    this.ensureNavSelectionVisible();
    const viewportHeight = Math.max(1, this.sidebarListBox.height);
    const rows = visible.slice(this.navScrollOffset, this.navScrollOffset + viewportHeight);

    for (const rowData of rows) {
      const navFocused = this.focusArea === "nav";
      const rowBg = rowData.selected
        ? (navFocused ? "#2b617c" : "#21485c")
        : "#0b0f10";

      const row = new BoxRenderable(this.renderer, {
        width: "100%",
        height: 1,
        backgroundColor: rowBg,
      });
      this.sidebarRowRenderables.push(row);

      const text = new TextRenderable(this.renderer, {
        width: "100%",
        height: 1,
        wrapMode: "none",
        truncate: true,
        fg: rowData.selected ? "#ffffff" : "#d7e3e8",
        bg: rowBg,
        content: rowData.content,
      });
      this.sidebarRowRenderables.push(text);

      row.add(text);
      this.sidebarListBox.add(row);
    }
  }

  private setFocus(area: FocusArea): void {
    this.focusArea = area;

    if (area === "nav") {
      this.footerInput.blur();
    } else if (area === "input") {
      this.footerInput.focus();
    } else {
      this.footerInput.blur();
    }

    this.render(false);
  }

  private async loadSelectedArmDetail(): Promise<void> {
    const node = this.currentNode();
    if (node.kind !== "arm" || !node.armId) {
      this.selectedArmDetail = null;
      return;
    }

    const cachedDetail = this.armDetailCache.get(node.armId);
    if (cachedDetail) {
      this.selectedArmDetail = cachedDetail;
      this.render(false);
    }

    const requestId = ++this.loadDetailRequestId;

    try {
      const detail = await fetchArmDetail(node.armId);
      if (requestId === this.loadDetailRequestId && !this.destroyed) {
        this.selectedArmDetail = detail;
        if (detail) {
          this.armDetailCache.set(node.armId, detail);
        }
        this.render(false);
      }
    } catch (error) {
      if (requestId === this.loadDetailRequestId && !this.destroyed) {
        this.selectedArmDetail = null;
        this.notice = `Failed to load arm detail: ${truncateLine(formatErrorMessage(error), 80)}`;
      }
    }
  }

  private async refresh(resetScroll: boolean): Promise<void> {
    if (this.refreshInFlight || this.destroyed) {
      return;
    }

    const requestId = ++this.refreshRequestId;
    this.refreshInFlight = true;
    this.notice = "Refreshing dashboard...";
    this.render(false);

    try {
      const selectionAtStart = this.selectedNodeId;
      this.snapshot = await fetchDashboardSnapshot();
      this.nodes = buildDashboardNodes(this.snapshot);
      this.pruneArmDetailCache();

      if (requestId !== this.refreshRequestId || this.destroyed) {
        return;
      }

      const selectionStillExists = this.nodes.some((node) => node.id === this.selectedNodeId);
      if (!selectionStillExists) {
        const startSelectionStillExists = this.nodes.some((node) => node.id === selectionAtStart);
        this.selectedNodeId = startSelectionStillExists
          ? selectionAtStart
          : (this.nodes[0]?.id || "brain");
      }

      await this.loadSelectedArmDetail();
      if (requestId !== this.refreshRequestId || this.destroyed) {
        return;
      }

      await this.refreshSearchIfNeeded();
      if (requestId !== this.refreshRequestId || this.destroyed) {
        return;
      }

      this.notice = `Refreshed ${new Date().toLocaleTimeString()}`;
      this.render(resetScroll);
    } catch (error) {
      this.notice = `Refresh failed: ${truncateLine(formatErrorMessage(error), 100)}`;
      this.render(false);
    } finally {
      this.refreshInFlight = false;
    }
  }

  private async refreshSearchIfNeeded(): Promise<void> {
    if (!this.searchQuery) {
      this.searchLinesOverride = null;
      return;
    }

    // Capture the current search state to avoid race conditions
    const requestId = ++this.searchRequestId;
    const query = this.searchQuery;
    const node = this.currentNode();

    try {
      let lines: string[];

      if (node.kind === "brain") {
        lines = await readFullBrainLogLines();
      } else if (node.kind === "api") {
        lines = await readFullServerLogLines();
      } else if (this.snapshot) {
        const view = buildViewForNode(this.snapshot, node, this.selectedArmDetail);
        lines = view.lines;
      } else {
        lines = [];
      }

      // Only apply results if this is still the current search
      if (requestId === this.searchRequestId && !this.destroyed) {
        this.searchLinesOverride = applySearch(lines, query);
      }
    } catch (error) {
      if (requestId === this.searchRequestId && !this.destroyed) {
        this.searchLinesOverride = [`Search failed: ${truncateLine(formatErrorMessage(error), 80)}`];
      }
    }
  }

  private async applySearchQuery(query: string): Promise<void> {
    this.searchQuery = query.trim();
    await this.refreshSearchIfNeeded();
    this.notice = this.searchQuery
      ? `Search applied: ${this.searchQuery}`
      : "Search cleared";
    this.render(true);
  }

  private render(resetScroll: boolean): void {
    if (!this.snapshot) {
      return;
    }

    this.rebuildSidebar();
    const node = this.currentNode();
    const baseView = buildViewForNode(this.snapshot, node, this.selectedArmDetail);
    const view = this.showHelp
      ? {
        title: "Help",
        subtitle: "Arms dashboard keyboard commands",
        lines: this.buildHelpLines(node),
      }
      : baseView;
    const lines = this.showHelp ? view.lines : (this.searchLinesOverride || view.lines);

    const navFocused = this.focusArea === "nav";
    const bodyFocused = this.focusArea === "body";
    const inputFocused = this.focusArea === "input" || this.confirmAction !== null;

    this.sidebarBox.title = navFocused ? "Navigator *" : "Navigator";
    this.bodyBox.title = undefined;
    this.footerBox.title = inputFocused ? "Command *" : "Command";

    this.sidebarBox.borderColor = navFocused ? "#63b3d6" : "#34515e";
    this.bodyBox.borderColor = bodyFocused ? "#63b3d6" : "#34515e";
    this.statusBox.borderColor = this.notice.toLowerCase().includes("failed") ? "#b85c5c" : "#34515e";
    this.footerBox.borderColor = inputFocused ? "#63b3d6" : "#34515e";
    this.sidebarBox.backgroundColor = navFocused ? "#10222d" : "#0b0f10";
    this.sidebarListBox.backgroundColor = navFocused ? "#10222d" : "#0b0f10";
    this.bodyBox.backgroundColor = bodyFocused ? "#10222d" : "#0b0f10";
    this.bodyContentBox.backgroundColor = bodyFocused ? "#10222d" : "#0b0f10";
    this.statusBox.backgroundColor = "#0b0f10";
    this.footerBox.backgroundColor = inputFocused ? "#10222d" : "#0b0f10";
    this.titleText.bg = bodyFocused ? "#10222d" : "#0b0f10";
    this.titleText.fg = bodyFocused ? "#ffffff" : "#f2f7f9";

    this.titleText.content = this.showHelp ? `${view.title} - ${baseView.title}` : view.title;

    this.bodyText.bg = bodyFocused ? "#10222d" : "#0b0f10";
    this.bodyText.content = lines.join("\n");
    if (resetScroll) {
      this.bodyText.scrollY = 0;
    } else {
      this.bodyText.scrollY = Math.min(this.bodyText.scrollY, this.bodyText.maxScrollY);
    }

    if (bodyFocused && this.bodyText.maxScrollY > 0) {
      this.bodyScrollbarText.bg = "#10222d";
      this.bodyScrollbarText.content = buildVerticalScrollbar(
        this.bodyScrollbarText.height,
        this.bodyText.scrollY,
        this.bodyText.maxScrollY,
      );
    } else {
      this.bodyScrollbarText.bg = bodyFocused ? "#10222d" : "#0b0f10";
      this.bodyScrollbarText.content = "";
    }

    this.footerStatusText.content = truncateLine(this.notice, 240);
    this.footerStatusText.fg = this.notice.toLowerCase().includes("failed") ? "#ff9b9b" : "#f6d365";
    this.footerControlsText.content = truncateLine(
      this.buildFooterControls(node),
      240,
    );

    const activeArmLabel = node.label;

    if (this.confirmAction) {
      this.footerPromptText.content = this.confirmAction.prompt;
      this.footerInput.value = "";
      this.footerInput.placeholder = "";
      this.footerInput.blur();
    } else if (this.inputMode === "search") {
      this.footerPromptText.content = "Search current view. Brain/API search persisted logs.";
      this.footerInput.placeholder = "Search text";
    } else if (this.inputMode === "brain-message") {
      this.footerPromptText.content = "Send a message to the brain.";
      this.footerInput.placeholder = "Brain message";
    } else if (this.inputMode === "arm-message") {
      this.footerPromptText.content = `Send a message to ${activeArmLabel}. Interrupt=${this.interruptBeforeSend ? "on" : "off"}`;
      this.footerInput.placeholder = "Arm message";
    } else if (this.showHelp) {
      this.footerPromptText.content = "Help is open. Press ? or Esc to close.";
      this.footerInput.value = "";
      this.footerInput.placeholder = "";
    } else {
      this.footerPromptText.content = this.searchQuery
        ? `Active search: ${this.searchQuery}`
        : "Press ? for help.";
      this.footerInput.value = "";
      this.footerInput.placeholder = "";
    }

    this.renderer.requestRender();
  }

  private async handleKeyPress(key: KeyEvent): Promise<void> {
    if (this.destroyed) {
      return;
    }

    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      key.stopPropagation();
      this.close();
      return;
    }

    if (this.confirmAction) {
      if (key.name === "y") {
        key.preventDefault();
        key.stopPropagation();
        const action = this.confirmAction;
        this.confirmAction = null;
        await this.performAction(action.execute);
        return;
      }

      if (key.name === "escape" || key.name === "n" || key.name === "backspace") {
        key.preventDefault();
        key.stopPropagation();
        this.confirmAction = null;
        this.notice = "Action cancelled";
        this.render(false);
        return;
      }
    }

    if (this.inputMode) {
      if (key.name === "escape") {
        key.preventDefault();
        key.stopPropagation();
        this.inputMode = null;
        this.footerInput.value = "";
        this.setFocus("nav");
        this.notice = "Input cancelled";
        return;
      }

      // Let other keys pass through to the InputRenderable when focused
      if (this.focusArea === "input") {
        return;
      }
    }

    if (key.name === "?" || (key.shift && key.name === "slash")) {
      key.preventDefault();
      key.stopPropagation();
      this.showHelp = !this.showHelp;
      this.notice = this.showHelp ? "Help opened" : "Help closed";
      this.render(true);
      return;
    }

    const closeHelpForCommand = (): void => {
      if (this.showHelp) {
        this.showHelp = false;
      }
    };

    if (this.showHelp && key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      this.showHelp = false;
      this.notice = "Help closed";
      this.render(false);
      return;
    }

    if (key.name === "q") {
      key.preventDefault();
      key.stopPropagation();
      this.close();
      return;
    }

    if (key.name === "tab") {
      key.preventDefault();
      key.stopPropagation();
      closeHelpForCommand();
      this.cycleFocus(key.shift ? -1 : 1);
      return;
    }

    if (key.name === "r" && !key.shift) {
      key.preventDefault();
      key.stopPropagation();
      closeHelpForCommand();
      await this.refresh(false);
      return;
    }

    if (key.name === "/") {
      key.preventDefault();
      key.stopPropagation();
      closeHelpForCommand();
      this.inputMode = "search";
      this.footerInput.value = this.searchQuery;
      this.setFocus("input");
      return;
    }

    if (key.name === "e") {
      key.preventDefault();
      key.stopPropagation();
      closeHelpForCommand();
      await this.exportCurrentViewToEditor();
      return;
    }

    if (key.name === "n") {
      key.preventDefault();
      key.stopPropagation();
      closeHelpForCommand();
      await this.launchSpawnFlow();
      return;
    }

    if (this.focusArea === "nav") {
      if (key.name === "j" || key.name === "down") {
        key.preventDefault();
        key.stopPropagation();
        closeHelpForCommand();
        const visible = this.visibleNodes();
        const nextIndex = Math.min(visible.length - 1, this.visibleNodeIndex() + 1);
        const nextNode = visible[nextIndex];
        if (nextNode) {
          this.selectNode(nextNode, true);
        }
        return;
      }

      if (key.name === "k" || key.name === "up") {
        key.preventDefault();
        key.stopPropagation();
        closeHelpForCommand();
        const visible = this.visibleNodes();
        const nextIndex = Math.max(0, this.visibleNodeIndex() - 1);
        const nextNode = visible[nextIndex];
        if (nextNode) {
          this.selectNode(nextNode, true);
        }
        return;
      }

      if (key.name === "enter" || key.name === "l" || key.name === "right") {
        key.preventDefault();
        key.stopPropagation();
        closeHelpForCommand();
        if (this.nodeHasChildren(this.currentNode())) {
          await this.toggleCurrentNode(true);
        }
        this.setFocus("body");
        return;
      }

      if (key.name === "h" || key.name === "left") {
        key.preventDefault();
        key.stopPropagation();
        closeHelpForCommand();
        await this.collapseCurrentNodeOrParent();
        return;
      }
    }

    if (this.focusArea === "body") {
      if (key.name === "j" || key.name === "down") {
        key.preventDefault();
        key.stopPropagation();
        closeHelpForCommand();
        this.scrollBody(1);
        return;
      }

      if (key.name === "k" || key.name === "up") {
        key.preventDefault();
        key.stopPropagation();
        closeHelpForCommand();
        this.scrollBody(-1);
        return;
      }

      if (key.name === "pagedown") {
        key.preventDefault();
        key.stopPropagation();
        closeHelpForCommand();
        this.scrollBody(this.pageScrollAmount());
        return;
      }

      if (key.name === "pageup") {
        key.preventDefault();
        key.stopPropagation();
        closeHelpForCommand();
        this.scrollBody(-this.pageScrollAmount());
        return;
      }

      if (key.name === "home") {
        key.preventDefault();
        key.stopPropagation();
        closeHelpForCommand();
        this.bodyText.scrollY = 0;
        this.render(false);
        return;
      }

      if (key.name === "end") {
        key.preventDefault();
        key.stopPropagation();
        closeHelpForCommand();
        this.bodyText.scrollY = this.bodyText.maxScrollY;
        this.render(false);
        return;
      }

      if (key.name === "left" || key.name === "h") {
        key.preventDefault();
        key.stopPropagation();
        closeHelpForCommand();
        this.setFocus("nav");
        return;
      }
    }

    const node = this.currentNode();

    if (node.kind === "brain") {
      if (key.name === "m") {
        key.preventDefault();
        key.stopPropagation();
        closeHelpForCommand();
        this.inputMode = "brain-message";
        this.footerInput.value = "";
        this.setFocus("input");
        return;
      }

      if (key.name === "r" && key.shift) {
        key.preventDefault();
        key.stopPropagation();
        closeHelpForCommand();
        this.confirmAction = {
          prompt: "Restart the brain service? [y/N]",
          execute: async () => {
            await restartBrainService();
            await this.refresh(true);
            this.notice = "Brain service restarted";
            this.render(false);
          },
        };
        this.render(false);
        return;
      }
    }

    if (node.kind === "arm" && node.armId) {
      if (key.name === "m") {
        key.preventDefault();
        key.stopPropagation();
        closeHelpForCommand();
        this.inputMode = "arm-message";
        this.footerInput.value = "";
        this.setFocus("input");
        return;
      }

      if (key.name === "i") {
        key.preventDefault();
        key.stopPropagation();
        closeHelpForCommand();
        this.interruptBeforeSend = !this.interruptBeforeSend;
        this.notice = `Interrupt before send ${this.interruptBeforeSend ? "enabled" : "disabled"}`;
        this.render(false);
        return;
      }

      if (key.name === "s") {
        key.preventDefault();
        key.stopPropagation();
        closeHelpForCommand();
        await this.performAction(async () => {
          await markArmStuck(node.armId!);
          await this.refresh(true);
          this.notice = `Marked ${node.label} as stuck/idle for brain follow-up`;
          this.render(false);
        });
        return;
      }

      if (key.name === "x") {
        key.preventDefault();
        key.stopPropagation();
        closeHelpForCommand();
        // Capture values at creation time to avoid stale references
        const armId = node.armId!;
        const armLabel = node.label;
        this.confirmAction = {
          prompt: `Kill arm session for ${armLabel}? [y/N]`,
          execute: async () => {
            await killArmSession(armId);
            await this.refresh(true);
            this.notice = `Killed ${armLabel}`;
            this.render(false);
          },
        };
        this.render(false);
        return;
      }

      if (key.name === "d") {
        key.preventDefault();
        key.stopPropagation();
        closeHelpForCommand();
        // Capture values at creation time to avoid stale references
        const armId = node.armId!;
        const armLabel = node.label;
        this.confirmAction = {
          prompt: `Delete arm profile ${armLabel}? The arm must already be stopped. [y/N]`,
          execute: async () => {
            await deleteArmProfile(armId);
            this.selectedNodeId = "arms";
            await this.refresh(true);
            this.notice = `Deleted ${armLabel}`;
            this.render(false);
          },
        };
        this.render(false);
        return;
      }
    }
  }

  private scrollBody(delta: number): void {
    const next = Math.max(0, Math.min(this.bodyText.maxScrollY, this.bodyText.scrollY + delta));
    this.bodyText.scrollY = next;
    this.render(false);
  }

  private pageScrollAmount(): number {
    return Math.max(4, Math.floor(this.bodyText.height * 0.8));
  }

  private cycleFocus(direction: 1 | -1): void {
    const order: FocusArea[] = ["nav", "body"];
    const currentIndex = Math.max(0, order.indexOf(this.focusArea));
    const nextIndex = (currentIndex + direction + order.length) % order.length;
    this.setFocus(order[nextIndex] || "nav");
  }

  private async submitInput(): Promise<void> {
    const value = this.footerInput.value.trim();
    const node = this.currentNode();

    if (this.inputMode === "search") {
      this.inputMode = null;
      await this.applySearchQuery(value);
      this.setFocus("nav");
      return;
    }

    if (this.inputMode === "brain-message") {
      if (!value) {
        this.notice = "Brain message is empty";
        this.render(false);
        return;
      }

      this.inputMode = null;
      await this.performAction(async () => {
        await sendBrainMessage(value);
        this.footerInput.value = "";
        await this.refresh(false);
        this.notice = "Sent message to brain";
        this.render(false);
      });
      this.setFocus("nav");
      return;
    }

    if (this.inputMode === "arm-message" && node.kind === "arm" && node.armId) {
      if (!value) {
        this.notice = "Arm message is empty";
        this.render(false);
        return;
      }

      this.inputMode = null;
      const armId = node.armId;
      await this.performAction(async () => {
        await sendArmMessage(armId, value, this.interruptBeforeSend);
        this.footerInput.value = "";
        await this.refresh(false);
        this.notice = `Sent message to ${node.label}`;
        this.render(false);
      });
      this.setFocus("nav");
    }
  }

  private async performAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.notice = truncateLine(formatErrorMessage(error), 120);
      this.render(false);
    }
  }

  private async suspendForExternalCommand(cmd: string[]): Promise<number> {
    this.renderer.suspend();
    try {
      const proc = Bun.spawn({
        cmd,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: process.env,
      });
      return await proc.exited;
    } finally {
      this.renderer.resume();
      this.render(false);
    }
  }

  private async launchSpawnFlow(): Promise<void> {
    this.notice = "Opening arm spawn flow...";
    this.render(false);
    const exitCode = await this.suspendForExternalCommand([
      process.execPath,
      getCliEntrypoint(),
      "arm",
      "spawn",
    ]);
    this.notice = exitCode === 0 ? "Spawn flow finished" : `Spawn flow exited with code ${exitCode}`;
    await this.refresh(true);
  }

  private async exportCurrentViewToEditor(): Promise<void> {
    if (!this.snapshot) {
      return;
    }

    const node = this.currentNode();
    const view = buildViewForNode(this.snapshot, node, this.selectedArmDetail);
    const lines = this.searchLinesOverride || view.lines;
    const contents = [view.title, view.subtitle, "", ...lines].join("\n");
    const directory = await mkdtemp(join(tmpdir(), "coleo-arms-"));
    const filePath = join(directory, `${slugify(view.title)}.log`);
    await writeFile(filePath, contents, "utf-8");

    const editor = process.env.EDITOR?.trim() || "vi";
    // Parse editor command safely - split on whitespace but respect quoted strings
    const editorParts = editor.match(/[^\s"']+|"([^"]*)"|'([^']*)'/g) || ["vi"];
    const cmd = editorParts.map((part) => {
      // Remove quotes if present
      if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
        return part.slice(1, -1);
      }
      return part;
    });
    
    // Pass file path directly without shell interpretation
    await this.suspendForExternalCommand([...cmd, filePath]);
    this.notice = `Opened ${filePath} in ${editor}`;
    this.render(false);
  }

  private close(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    // Remove event listeners to prevent memory leaks
    if (this.footerInputEnterHandler) {
      try {
        this.footerInput.off?.(InputRenderableEvents.ENTER, this.footerInputEnterHandler);
      } catch {
        // EventEmitter may not support off(), ignore
      }
      this.footerInputEnterHandler = null;
    }

    if (this.keypressHandler) {
      try {
        this.renderer.keyInput.off?.("keypress", this.keypressHandler);
      } catch {
        // EventEmitter may not support off(), ignore
      }
      this.keypressHandler = null;
    }

    // Clean up sidebar renderables to prevent memory leaks
    for (const renderable of this.sidebarRowRenderables) {
      renderable.destroy?.();
    }
    this.sidebarRowRenderables = [];

    this.renderer.destroy();
    this.closeResolver?.();
  }

  private parentNodeId(node: DashboardNode): string | null {
    if (node.depth !== 1) {
      return null;
    }

    if (node.kind === "arm") {
      return "arms";
    }

    if (node.discoveryId) {
      return "discoveries";
    }

    if (node.mailId) {
      return "mail";
    }

    if (node.reportId) {
      return "status-reports";
    }

    return null;
  }

  private pruneArmDetailCache(): void {
    const activeArmIds = new Set(this.nodes.filter((node) => node.kind === "arm" && node.armId).map((node) => node.armId));

    for (const armId of this.armDetailCache.keys()) {
      if (!activeArmIds.has(armId)) {
        this.armDetailCache.delete(armId);
      }
    }
  }

  private buildSidebarRows(): SidebarRow[] {
    const rows: SidebarRow[] = [];
    const roots = this.nodes.filter((node) => node.depth === 0);
    const contentWidth = this.sidebarContentWidth();

    for (const root of roots) {
      const children = this.nodes.filter((node) => this.parentNodeId(node) === root.id);

      if (children.length === 0) {
        rows.push({
          nodeId: root.id,
          content: padRight(root.label, contentWidth),
          selected: root.id === this.selectedNodeId,
        });
        continue;
      }

      const expanded = this.isExpanded(root);
      const headerLabel = ` ${expanded ? "▾" : "▸"} ${root.label} `;
      const headerFill = Math.max(0, contentWidth - 2 - headerLabel.length);
      rows.push({
        nodeId: root.id,
        content: `┌${headerLabel}${"─".repeat(headerFill)}┐`,
        selected: root.id === this.selectedNodeId,
      });

      if (expanded) {
        for (const child of children) {
          const childLabel = `${child.id === this.selectedNodeId ? "▸" : "•"} ${child.label}`;
          rows.push({
            nodeId: child.id,
            content: `│${padRight(` ${childLabel} `, contentWidth - 2)}│`,
            selected: child.id === this.selectedNodeId,
          });
        }
      }

      rows.push({
        nodeId: null,
        content: `└${"─".repeat(Math.max(0, contentWidth - 2))}┘`,
        selected: false,
      });
    }

    return rows;
  }

  private sidebarContentWidth(): number {
    const width = typeof this.sidebarListBox.width === "number"
      ? this.sidebarListBox.width
      : (typeof this.sidebarBox.width === "number" ? this.sidebarBox.width - 2 : 30);

    return Math.max(8, width);
  }

  private buildFooterControls(node: DashboardNode): string {
    if (this.showHelp) {
      return "? close help  tab change focus  j/k scroll  q quit";
    }

    const global = "? help  / search  r refresh  q quit";

    if (this.focusArea === "nav") {
      const navActions = this.nodeHasChildren(node)
        ? "j/k move  enter open  h/l collapse-expand  tab details"
        : "j/k move  enter details  tab details";
      const nodeActions = node.kind === "arms-root" || node.kind === "arm" ? "  n spawn arm" : "";
      return `${navActions}  ${global}${nodeActions}`;
    }

    if (this.focusArea === "body") {
      const bodyActions = "j/k scroll  pgup/pgdn page  home/end jump  h nav";

      if (node.kind === "brain") {
        return `${bodyActions}  ${global}  m message brain  R restart brain`;
      }

      if (node.kind === "arm") {
        return `${bodyActions}  ${global}  m message  i interrupt=${this.interruptBeforeSend ? "on" : "off"}  s stuck  x kill  d delete`;
      }

      return `${bodyActions}  ${global}  e export`;
    }

    if (this.focusArea === "input") {
      return "enter submit  esc cancel  ? help";
    }

    return global;
  }

  private buildHelpLines(node: DashboardNode): string[] {
    const lines = [
      "Global",
      "------",
      "?            Toggle help",
      "tab          Switch focus between navigator and details",
      "S-tab        Switch focus backwards",
      "/            Search current view",
      "r            Refresh dashboard",
      "e            Export current detail view to $EDITOR",
      "n            Launch arm spawn flow",
      "q            Quit dashboard",
      "",
      "Navigator",
      "---------",
      "j / down     Move selection down",
      "k / up       Move selection up",
      "enter        Open selected node details",
      "l / right    Expand section and open details",
      "h / left     Collapse selected section or move to parent",
      "",
      "Details",
      "-------",
      "j / down     Scroll detail view down",
      "k / up       Scroll detail view up",
      "pgup/pgdn    Scroll by page",
      "home/end     Jump to top or bottom",
      "h / left     Return focus to navigator",
    ];

    if (node.kind === "brain") {
      lines.push(
        "",
        "Brain",
        "-----",
        "m            Send a message to the brain",
        "R            Restart the brain service",
      );
    }

    if (node.kind === "arm") {
      lines.push(
        "",
        `Arm: ${node.label}`,
        "-----------",
        "m            Send a message to this arm",
        `i            Toggle interrupt before send (${this.interruptBeforeSend ? "on" : "off"})`,
        "s            Mark arm stuck/idle for brain follow-up",
        "x            Kill arm session",
        "d            Delete arm profile",
      );
    }

    lines.push(
      "",
      "Input",
      "-----",
      "enter        Submit current prompt",
      "esc          Cancel input or close help",
    );

    return lines;
  }
}

export async function runArmsDashboardTui(): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("The arms dashboard requires an interactive TTY.");
    process.exit(1);
  }

  const tui = new ArmsDashboardTui();
  await tui.run();
}
