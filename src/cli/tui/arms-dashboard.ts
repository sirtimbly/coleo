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
  buildFooterControls,
  buildViewForNode,
  type DashboardNode,
} from "./arms-dashboard-view";

type FocusArea = "nav" | "body" | "input";
type InputMode = "search" | "arm-message" | "brain-message" | null;

interface ConfirmAction {
  prompt: string;
  execute: () => Promise<void>;
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

  async run(): Promise<void> {
    this.snapshot = await fetchDashboardSnapshot();
    this.nodes = buildDashboardNodes(this.snapshot);

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
    await this.loadSelectionDetail();
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
      padding: 1,
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

    this.footerBox = new BoxRenderable(this.renderer, {
      height: 6,
      border: true,
      title: "Command",
      borderColor: "#34515e",
      padding: 1,
      marginTop: 1,
      flexDirection: "column",
      backgroundColor: "#0b0f10",
    });
    this.mainBox.add(this.footerBox);

    this.footerStatusText = new TextRenderable(this.renderer, {
      width: "100%",
      height: 1,
      wrapMode: "word",
      truncate: false,
      fg: "#f6d365",
      bg: "#0b0f10",
    });
    this.footerBox.add(this.footerStatusText);

    this.footerControlsText = new TextRenderable(this.renderer, {
      width: "100%",
      height: 1,
      wrapMode: "word",
      truncate: false,
      fg: "#9fb9c6",
      bg: "#0b0f10",
    });
    this.footerBox.add(this.footerControlsText);

    this.footerPromptText = new TextRenderable(this.renderer, {
      width: "100%",
      height: 1,
      wrapMode: "word",
      truncate: false,
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
    this.footerInput.on(InputRenderableEvents.ENTER, () => {
      void this.submitInput();
    });

    this.renderer.keyInput.on("keypress", (key: KeyEvent) => {
      void this.handleKeyPress(key);
    });
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
    return node.kind === "arms-root";
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

      if (node.depth === 1 && this.expandedNodeIds.has("arms")) {
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
    this.ensureNavSelectionVisible();
    void this.loadSelectionDetail().then(() => {
      this.render(resetScroll);
    });
  }

  private ensureNavSelectionVisible(): void {
    const visible = this.visibleNodes();
    const selectedIndex = Math.max(0, visible.findIndex((node) => node.id === this.selectedNodeId));
    const viewportHeight = Math.max(1, this.sidebarListBox.height);

    if (selectedIndex < this.navScrollOffset) {
      this.navScrollOffset = selectedIndex;
    } else if (selectedIndex >= this.navScrollOffset + viewportHeight) {
      this.navScrollOffset = selectedIndex - viewportHeight + 1;
    }

    const maxOffset = Math.max(0, visible.length - viewportHeight);
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
    for (const child of this.sidebarListBox.getChildren()) {
      this.sidebarListBox.remove(child.id);
    }

    const visible = this.visibleNodes();
    this.ensureNavSelectionVisible();
    const viewportHeight = Math.max(1, this.sidebarListBox.height);
    const rows = visible.slice(this.navScrollOffset, this.navScrollOffset + viewportHeight);

    for (const node of rows) {
      const selected = node.id === this.selectedNodeId;
      const isParent = this.nodeHasChildren(node);
      const icon = isParent ? (this.isExpanded(node) ? "▾" : "▸") : " ";
      const navFocused = this.focusArea === "nav";
      const rowBg = selected
        ? (navFocused ? "#2b617c" : "#21485c")
        : (navFocused ? "#10222d" : "#0b0f10");

      const row = new BoxRenderable(this.renderer, {
        width: "100%",
        height: 1,
        backgroundColor: rowBg,
      });

      const text = new TextRenderable(this.renderer, {
        width: "100%",
        height: 1,
        wrapMode: "none",
        truncate: true,
        fg: selected ? "#ffffff" : "#d7e3e8",
        bg: rowBg,
        content: `${"  ".repeat(node.depth)}${icon} ${node.label}`,
      });

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
      this.bodyBox.focus();
    }

    this.render(false);
  }

  private async loadSelectionDetail(): Promise<void> {
    const node = this.currentNode();
    if (node.kind !== "arm" || !node.armId) {
      this.selectedArmDetail = null;
      return;
    }

    this.selectedArmDetail = await fetchArmDetail(node.armId);
  }

  private async refresh(resetScroll: boolean): Promise<void> {
    if (this.refreshInFlight || this.destroyed) {
      return;
    }

    this.refreshInFlight = true;
    this.notice = "Refreshing dashboard...";
    this.render(false);

    try {
      const currentSelection = this.selectedNodeId;
      this.snapshot = await fetchDashboardSnapshot();
      this.nodes = buildDashboardNodes(this.snapshot);

      if (!this.nodes.some((node) => node.id === currentSelection)) {
        this.selectedNodeId = this.nodes[0]?.id || "brain";
      } else {
        this.selectedNodeId = currentSelection;
      }

      await this.loadSelectionDetail();
      await this.refreshSearchIfNeeded();
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

    const node = this.currentNode();
    if (node.kind === "brain") {
      this.searchLinesOverride = applySearch(await readFullBrainLogLines(), this.searchQuery);
      return;
    }

    if (node.kind === "api") {
      this.searchLinesOverride = applySearch(await readFullServerLogLines(), this.searchQuery);
      return;
    }

    if (!this.snapshot) {
      this.searchLinesOverride = null;
      return;
    }

    const view = buildViewForNode(this.snapshot, node, this.selectedArmDetail);
    this.searchLinesOverride = applySearch(view.lines, this.searchQuery);
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
    const view = buildViewForNode(this.snapshot, node, this.selectedArmDetail);
    const lines = this.searchLinesOverride || view.lines;

    const navFocused = this.focusArea === "nav";
    const bodyFocused = this.focusArea === "body";
    const inputFocused = this.focusArea === "input" || this.confirmAction !== null;

    this.sidebarBox.title = navFocused ? "Navigator *" : "Navigator";
    this.bodyBox.title = undefined;
    this.footerBox.title = inputFocused ? "Command *" : "Command";

    this.sidebarBox.borderColor = navFocused ? "#63b3d6" : "#34515e";
    this.bodyBox.borderColor = bodyFocused ? "#63b3d6" : "#34515e";
    this.footerBox.borderColor = inputFocused ? "#63b3d6" : "#34515e";
    this.sidebarBox.backgroundColor = navFocused ? "#10222d" : "#0b0f10";
    this.sidebarListBox.backgroundColor = navFocused ? "#10222d" : "#0b0f10";
    this.bodyBox.backgroundColor = bodyFocused ? "#10222d" : "#0b0f10";
    this.bodyContentBox.backgroundColor = bodyFocused ? "#10222d" : "#0b0f10";
    this.footerBox.backgroundColor = inputFocused ? "#10222d" : "#0b0f10";
    this.titleText.bg = bodyFocused ? "#10222d" : "#0b0f10";
    this.titleText.fg = bodyFocused ? "#ffffff" : "#f2f7f9";

    this.titleText.content = view.title;

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

    this.footerStatusText.content = truncateLine(this.notice, 200);
    this.footerControlsText.content = truncateLine(
      buildFooterControls(node, this.interruptBeforeSend),
      240,
    );

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
      this.footerPromptText.content = `Send a message to ${node.label}. Interrupt=${this.interruptBeforeSend ? "on" : "off"}`;
      this.footerInput.placeholder = "Arm message";
    } else {
      this.footerPromptText.content = this.searchQuery
        ? `Active search: ${this.searchQuery}`
        : "Press / to search, e to export, n to spawn, or tab to change focus.";
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
      this.cycleFocus();
      return;
    }

    if (key.name === "r" && !key.shift) {
      key.preventDefault();
      key.stopPropagation();
      await this.refresh(false);
      return;
    }

    if (key.name === "/") {
      key.preventDefault();
      key.stopPropagation();
      this.inputMode = "search";
      this.footerInput.value = this.searchQuery;
      this.setFocus("input");
      return;
    }

    if (key.name === "e") {
      key.preventDefault();
      key.stopPropagation();
      await this.exportCurrentViewToEditor();
      return;
    }

    if (key.name === "n") {
      key.preventDefault();
      key.stopPropagation();
      await this.launchSpawnFlow();
      return;
    }

    if (this.focusArea === "nav") {
      if (key.name === "j" || key.name === "down") {
        key.preventDefault();
        key.stopPropagation();
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
        await this.toggleCurrentNode(true);
        return;
      }

      if (key.name === "h" || key.name === "left") {
        key.preventDefault();
        key.stopPropagation();
        await this.collapseCurrentNodeOrParent();
        return;
      }
    }

    if (this.focusArea === "body") {
      if (key.name === "j" || key.name === "down") {
        key.preventDefault();
        key.stopPropagation();
        this.scrollBody(1);
        return;
      }

      if (key.name === "k" || key.name === "up") {
        key.preventDefault();
        key.stopPropagation();
        this.scrollBody(-1);
        return;
      }

      if (key.name === "pagedown") {
        key.preventDefault();
        key.stopPropagation();
        this.scrollBody(this.pageScrollAmount());
        return;
      }

      if (key.name === "pageup") {
        key.preventDefault();
        key.stopPropagation();
        this.scrollBody(-this.pageScrollAmount());
        return;
      }

      if (key.name === "home") {
        key.preventDefault();
        key.stopPropagation();
        this.bodyText.scrollY = 0;
        this.render(false);
        return;
      }

      if (key.name === "end") {
        key.preventDefault();
        key.stopPropagation();
        this.bodyText.scrollY = this.bodyText.maxScrollY;
        this.render(false);
        return;
      }
    }

    const node = this.currentNode();

    if (node.kind === "brain") {
      if (key.name === "m") {
        key.preventDefault();
        key.stopPropagation();
        this.inputMode = "brain-message";
        this.footerInput.value = "";
        this.setFocus("input");
        return;
      }

      if (key.name === "r" && key.shift) {
        key.preventDefault();
        key.stopPropagation();
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
        this.inputMode = "arm-message";
        this.footerInput.value = "";
        this.setFocus("input");
        return;
      }

      if (key.name === "i") {
        key.preventDefault();
        key.stopPropagation();
        this.interruptBeforeSend = !this.interruptBeforeSend;
        this.notice = `Interrupt before send ${this.interruptBeforeSend ? "enabled" : "disabled"}`;
        this.render(false);
        return;
      }

      if (key.name === "s") {
        key.preventDefault();
        key.stopPropagation();
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
        this.confirmAction = {
          prompt: `Kill arm session for ${node.label}? [y/N]`,
          execute: async () => {
            await killArmSession(node.armId!);
            await this.refresh(true);
            this.notice = `Killed ${node.label}`;
            this.render(false);
          },
        };
        this.render(false);
        return;
      }

      if (key.name === "d") {
        key.preventDefault();
        key.stopPropagation();
        this.confirmAction = {
          prompt: `Delete arm profile ${node.label}? The arm must already be stopped. [y/N]`,
          execute: async () => {
            await deleteArmProfile(node.armId!);
            this.selectedNodeId = "arms";
            await this.refresh(true);
            this.notice = `Deleted ${node.label}`;
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

  private cycleFocus(): void {
    if (this.focusArea === "nav") {
      this.setFocus("body");
      return;
    }

    if (this.focusArea === "body") {
      this.setFocus("nav");
      return;
    }

    this.setFocus("nav");
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

    if (this.inputMode === "arm-message" && node.armId) {
      if (!value) {
        this.notice = "Arm message is empty";
        this.render(false);
        return;
      }

      this.inputMode = null;
      await this.performAction(async () => {
        await sendArmMessage(node.armId!, value, this.interruptBeforeSend);
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
    const escapedPath = filePath.replace(/"/g, "\\\"");
    await this.suspendForExternalCommand(["sh", "-lc", `${editor} "${escapedPath}"`]);
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
    this.renderer.destroy();
    this.closeResolver?.();
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
