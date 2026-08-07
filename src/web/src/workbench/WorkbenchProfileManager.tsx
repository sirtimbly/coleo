/**
 * Profile registration, switching, import, and export controls.
 *
 * This is the installation flow for portable UI configuration: it manages only
 * saved projections and layouts, never project-domain data.
 */

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Button } from "@heroui/react";
import { Download, RotateCcw, Save, Trash2, Upload, UserPlus } from "lucide-react";

import { api } from "@/lib";

import { useWorkbenchProfile } from "./profile-context";
import {
	requestWorkspaceLayoutRestore,
	requestWorkspaceLayoutSave,
} from "./layout-commands";

import type { WorkbenchBundle, WorkbenchProfile } from "./types";

export function WorkbenchProfileManager() {
	const context = useWorkbenchProfile();
	const [profiles, setProfiles] = useState<WorkbenchProfile[]>([]);
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [layoutName, setLayoutName] = useState("");
	const [shareLayout, setShareLayout] = useState(false);
	const [busy, setBusy] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const refreshProfiles = async () => {
		setProfiles((await api.listWorkbenchProfiles()).profiles);
	};

	useEffect(() => {
		void refreshProfiles();
	}, []);

	const createProfile = async () => {
		if (!name.trim()) return;
		setBusy(true);
		try {
			const { profile } = await api.createWorkbenchProfile({
				name: name.trim(),
				email: email.trim() || undefined,
			});
			context.setActiveProfile(profile.id);
			setName("");
			setEmail("");
			await refreshProfiles();
		} finally {
			setBusy(false);
		}
	};

	const exportProfile = async () => {
		if (!context.profile) return;
		const { bundle } = await api.exportWorkbenchProfile(context.profile.id);
		const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `coleo-workbench-${context.profile.id}.json`;
		anchor.click();
		URL.revokeObjectURL(url);
	};

	const importProfile = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		if (!file) return;
		setBusy(true);
		try {
			const bundle = JSON.parse(await file.text()) as WorkbenchBundle;
			const imported = await api.importWorkbenchProfile(bundle, "copy");
			context.setActiveProfile(imported.profile.id);
			await refreshProfiles();
		} finally {
			setBusy(false);
			event.target.value = "";
		}
	};

	return (
		<div className="space-y-4">
			<div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
				<label className="space-y-1">
					<span className="text-xs font-medium text-muted-foreground">Profile name</span>
					<input
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="My Coleo workspace"
						className="h-9 w-full border border-border bg-surface px-3 text-sm outline-none focus:border-accent"
					/>
				</label>
				<label className="space-y-1">
					<span className="text-xs font-medium text-muted-foreground">Email (optional)</span>
					<input
						type="email"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						placeholder="name@example.com"
						className="h-9 w-full border border-border bg-surface px-3 text-sm outline-none focus:border-accent"
					/>
				</label>
				<Button
					className="self-end"
					variant="primary"
					isDisabled={busy || !name.trim()}
					onPress={() => void createProfile()}
				>
					<UserPlus className="h-4 w-4" />
					Create
				</Button>
			</div>

			<div className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
				<label className="min-w-56 flex-1 space-y-1">
					<span className="text-xs font-medium text-muted-foreground">Active profile</span>
					<select
						value={context.profile?.id ?? "local"}
						onChange={(event) => context.setActiveProfile(event.target.value)}
						className="h-9 w-full border border-border bg-surface px-3 text-sm outline-none focus:border-accent"
					>
						{profiles.map((profile) => (
							<option key={profile.id} value={profile.id}>{profile.name}</option>
						))}
					</select>
				</label>
				<Button variant="ghost" onPress={() => void exportProfile()} isDisabled={!context.profile}>
					<Download className="h-4 w-4" />
					Export
				</Button>
				<Button variant="ghost" onPress={() => fileInputRef.current?.click()} isDisabled={busy}>
					<Upload className="h-4 w-4" />
					Import
				</Button>
				<input
					ref={fileInputRef}
					type="file"
					accept="application/json,.json"
					onChange={(event) => void importProfile(event)}
					className="hidden"
				/>
			</div>

			<div className="space-y-3 border-t border-border pt-4">
				<div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto]">
					<label className="space-y-1">
						<span className="text-xs font-medium text-muted-foreground">Save current window layout as</span>
						<input
							value={layoutName}
							onChange={(event) => setLayoutName(event.target.value)}
							placeholder="Debugging workspace"
							className="h-9 w-full border border-border bg-surface px-3 text-sm outline-none focus:border-accent"
						/>
					</label>
					<label className="flex h-9 items-center gap-2 self-end border border-border px-3 text-xs">
						<input
							type="checkbox"
							checked={shareLayout}
							onChange={(event) => setShareLayout(event.target.checked)}
							className="accent-[var(--accent)]"
						/>
						Shared
					</label>
					<Button
						className="self-end"
						variant="ghost"
						isDisabled={!layoutName.trim()}
						onPress={() => {
							requestWorkspaceLayoutSave({
								name: layoutName.trim(),
								shared: shareLayout,
							});
							setLayoutName("");
						}}
					>
						<Save className="h-4 w-4" />
						Save layout
					</Button>
				</div>

				<div className="divide-y divide-border border border-border">
					{context.layouts.length === 0 ? (
						<p className="px-3 py-4 text-xs text-muted-foreground">
							The current workspace will appear here after its first automatic save.
						</p>
					) : context.layouts.map((layout) => {
						const owned = layout.profileId === context.profile?.id;
						return (
							<div key={layout.id} className="flex items-center gap-3 px-3 py-2">
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium">{layout.name}</p>
									<p className="text-xs text-muted-foreground">
										{layout.isDefault ? "Current" : "Named"} · {layout.shared ? "Shared" : "Private"}
										{owned ? "" : " · from another profile"}
									</p>
								</div>
								<Button
									size="sm"
									variant="ghost"
									onPress={() => requestWorkspaceLayoutRestore(layout.id)}
								>
									<RotateCcw className="h-3.5 w-3.5" />
									Restore
								</Button>
								{owned && !layout.isDefault ? (
									<Button
										isIconOnly
										size="sm"
										variant="ghost"
										aria-label={`Delete ${layout.name}`}
										onPress={() => {
											void api.deleteWorkbenchLayout(layout.id).then(() => context.refresh());
										}}
									>
										<Trash2 className="h-3.5 w-3.5" />
									</Button>
								) : null}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
