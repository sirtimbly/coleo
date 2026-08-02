/**
 * Provides keyboard-first navigation and project-wide resource search.
 * Its destinations follow the same route registry used by every launcher.
 */
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ComponentType,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
	Bot,
	Bug,
	Command,
	FileText,
	ListTodo,
	Loader2,
	Mail,
	Search,
	Sparkles,
} from "lucide-react";
import { createPortal } from "react-dom";
import { NAVIGATION_ROUTES } from "@/app/routes";
import { api } from "@/lib/api";
import { armsKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

export type CommandPaletteMode = "actions" | "search";

export interface WorkspaceCommandAction {
	id: string;
	label: string;
	description?: string;
	shortcut?: string;
	group: string;
	icon?: ComponentType<{ className?: string }>;
	run: () => void;
}

interface WorkspaceCommandPaletteProps {
	mode: CommandPaletteMode | null;
	onClose: () => void;
	actions: WorkspaceCommandAction[];
	onOpenRoute: (pathname: string, search?: string) => void;
	onOpenArm: (armId: string) => void;
}

interface PaletteItem {
	id: string;
	label: string;
	description?: string;
	status?: string;
	group: string;
	icon?: ComponentType<{ className?: string }>;
	shortcut?: string;
	run: () => void;
}

const TYPE_ICONS: Record<string, ComponentType<{ className?: string }>> = {
	arm: Bot,
	bug: Bug,
	task: ListTodo,
	discovery: Sparkles,
	mail: Mail,
	status_report: FileText,
};

function routeForSearchResult(type: string, id: string): { pathname: string; search?: string } | null {
	switch (type) {
		case "arm":
			return { pathname: "/viewer", search: `?arm=${encodeURIComponent(id)}` };
		case "bug":
			return { pathname: "/bugs", search: `?bug=${encodeURIComponent(id)}` };
		case "task":
			return { pathname: "/tasks", search: `?task=${encodeURIComponent(id)}` };
		case "discovery":
			return { pathname: "/grid" };
		case "mail":
		case "message":
			return { pathname: "/messaging", search: "?facet=messages&mailbox=inbox" };
		case "status_report":
			return { pathname: "/messaging", search: "?facet=history" };
		default:
			return null;
	}
}

function filterByQuery<T extends { label: string; description?: string }>(
	items: T[],
	query: string,
): T[] {
	const q = query.trim().toLowerCase();
	if (!q) return items;
	return items.filter((item) => {
		const hay = `${item.label} ${item.description ?? ""}`.toLowerCase();
		return hay.includes(q);
	});
}

function searchResultStatus(result: { type: string; metadata: Record<string, unknown> }): string | undefined {
	if (result.type !== "bug" && result.type !== "task") return undefined;
	return typeof result.metadata.status === "string" ? result.metadata.status : undefined;
}

export function WorkspaceCommandPalette({
	mode,
	onClose,
	actions,
	onOpenRoute,
	onOpenArm,
}: WorkspaceCommandPaletteProps) {
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const isOpen = mode !== null;
	const isSearch = mode === "search";

	const { data: arms = [] } = useQuery({
		queryKey: armsKeys.list(),
		queryFn: async () => {
			const response = await api.listArms();
			return response.arms.filter((arm) => arm.status !== "stopped");
		},
		enabled: isOpen,
		staleTime: 5_000,
	});

	const searchQuery = query.trim();
	const { data: searchResponse, isFetching: isSearching } = useQuery({
		queryKey: ["workspace-search", searchQuery],
		queryFn: () =>
			api.search({
				query: searchQuery,
				limit: 24,
				keywordWeight: 1,
				semanticWeight: 0,
			}),
		enabled: isSearch && searchQuery.length >= 2,
		staleTime: 10_000,
	});

	useEffect(() => {
		if (!isOpen) {
			setQuery("");
			setActiveIndex(0);
			return;
		}
		const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
		return () => window.clearTimeout(timer);
	}, [isOpen]);

	useEffect(() => {
		setActiveIndex(0);
	}, [query, mode]);

	const items = useMemo((): PaletteItem[] => {
		if (!mode) return [];

		if (mode === "actions") {
			const navItems: PaletteItem[] = NAVIGATION_ROUTES.map((route) => ({
				id: `nav:${route.id}`,
				label: route.label,
				description: `Open ${route.label}`,
				group: "Views",
				icon: route.icon,
				run: () => onOpenRoute(route.href),
			}));

			const actionItems: PaletteItem[] = actions.map((action) => ({
				id: action.id,
				label: action.label,
				description: action.description,
				group: action.group,
				icon: action.icon,
				shortcut: action.shortcut,
				run: action.run,
			}));

			return filterByQuery([...actionItems, ...navItems], query);
		}

		const armItems: PaletteItem[] = arms.map((arm) => ({
			id: `arm:${arm.id}`,
			label: arm.name || arm.id,
			description: [
				arm.status,
				arm.currentTaskSubject || arm.currentBugTitle || "No current work",
			]
				.filter(Boolean)
				.join(" · "),
			group: "Arms",
			icon: Bot,
			run: () => onOpenArm(arm.id),
		}));

		const filteredArms = filterByQuery(armItems, query);

		const remoteItems: PaletteItem[] = [...(searchResponse?.results ?? [])]
			.filter((result) => result.type !== "arm")
			.sort((left, right) => {
				const leftStatus = searchResultStatus(left);
				const rightStatus = searchResultStatus(right);
				if (leftStatus && rightStatus) {
					const statusOrder = leftStatus.localeCompare(rightStatus);
					if (statusOrder !== 0) return statusOrder;
				}
				if (leftStatus !== rightStatus) return leftStatus ? -1 : 1;
				return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
			})
			.map((result) => {
				const Icon = TYPE_ICONS[result.type] ?? Search;
				const route = routeForSearchResult(result.type, result.id);
				const status = searchResultStatus(result);
				return {
					id: `search:${result.type}:${result.id}`,
					label: result.title || result.id,
					description: `${result.type}${result.content ? ` · ${result.content.slice(0, 90)}` : ""}`,
					status,
					group: "Results",
					icon: Icon,
					run: () => {
						if (route) {
							onOpenRoute(route.pathname, route.search);
						}
					},
				};
			});

		if (!searchQuery) {
			return filteredArms.slice(0, 12);
		}

		return [...filteredArms, ...remoteItems];
	}, [actions, arms, mode, onOpenArm, onOpenRoute, query, searchQuery, searchResponse?.results]);

	const runItem = useCallback(
		(item: PaletteItem) => {
			// Close first, then run so actions that reopen a palette (e.g. switch
			// search ↔ commands) are not immediately cleared by onClose.
			onClose();
			queueMicrotask(() => {
				item.run();
			});
		},
		[onClose],
	);

	useEffect(() => {
		if (!isOpen) return;

		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				event.preventDefault();
				onClose();
				return;
			}

			if (event.key === "ArrowDown") {
				event.preventDefault();
				setActiveIndex((current) =>
					items.length === 0 ? 0 : (current + 1) % items.length,
				);
				return;
			}

			if (event.key === "ArrowUp") {
				event.preventDefault();
				setActiveIndex((current) =>
					items.length === 0 ? 0 : (current - 1 + items.length) % items.length,
				);
				return;
			}

			if (event.key === "Enter") {
				event.preventDefault();
				const item = items[activeIndex];
				if (item) runItem(item);
			}
		}

		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [activeIndex, isOpen, items, onClose, runItem]);

	useEffect(() => {
		const active = listRef.current?.querySelector<HTMLElement>(
			`[data-palette-index="${activeIndex}"]`,
		);
		active?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	if (!isOpen) return null;

	const title = isSearch ? "Search" : "Command Palette";
	const placeholder = isSearch
		? "Search arms, bugs, tasks, mail…"
		: "Type a command or view name…";

	const grouped = items.reduce<Array<{ group: string; items: PaletteItem[] }>>(
		(acc, item) => {
			const last = acc[acc.length - 1];
			if (last && last.group === item.group) {
				last.items.push(item);
			} else {
				acc.push({ group: item.group, items: [item] });
			}
			return acc;
		},
		[],
	);

	let runningIndex = -1;

	return createPortal(
		<div className="workspace-palette-root" role="presentation">
			<button
				type="button"
				className="workspace-palette-backdrop"
				aria-label="Close command palette"
				onClick={onClose}
			/>
			<div
				className="workspace-palette-dialog"
				role="dialog"
				aria-modal="true"
				aria-label={title}
			>
				<div className="workspace-palette-header">
					{isSearch ? (
						<Search className="h-4 w-4 text-muted-foreground" />
					) : (
						<Command className="h-4 w-4 text-muted-foreground" />
					)}
					<input
						ref={inputRef}
						className="workspace-palette-input"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={placeholder}
						autoComplete="off"
						spellCheck={false}
					/>
					{isSearch && isSearching ? (
						<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
					) : (
						<kbd className="workspace-palette-kbd">esc</kbd>
					)}
				</div>

				<div className="workspace-palette-list" ref={listRef}>
					{items.length === 0 ? (
						<div className="workspace-palette-empty">
							{isSearch && searchQuery.length < 2
								? "Type at least 2 characters to search the database"
								: "No matches"}
						</div>
					) : (
						grouped.map((section) => (
							<div key={section.group} className="workspace-palette-section">
								<div className="workspace-palette-section-label">{section.group}</div>
								{section.items.map((item) => {
									runningIndex += 1;
									const index = runningIndex;
									const Icon = item.icon ?? Search;
									return (
										<button
											key={item.id}
											type="button"
											data-palette-index={index}
											className={cn(
												"workspace-palette-item",
												index === activeIndex && "workspace-palette-item--active",
											)}
											onMouseEnter={() => setActiveIndex(index)}
											onClick={() => runItem(item)}
										>
											<Icon className="h-4 w-4 shrink-0 opacity-70" />
											<span className="min-w-0 flex-1 text-left">
												<span className="block truncate font-medium">{item.label}</span>
												{item.description ? (
													<span className="block truncate text-xs text-muted-foreground">
														{item.description}
													</span>
												) : null}
											</span>
											{item.shortcut ? (
												<kbd className="workspace-palette-kbd">{item.shortcut}</kbd>
											) : null}
											{item.status ? (
												<span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium capitalize text-muted-foreground">
													{item.status.replaceAll("_", " ")}
												</span>
											) : null}
										</button>
									);
								})}
							</div>
						))
					)}
				</div>

				<div className="workspace-palette-footer">
					<span>
						{isSearch ? "⌘P search" : "⌘⇧P commands"} · ↑↓ navigate · ↵ open
					</span>
				</div>
			</div>
		</div>,
		document.body,
	);
}
