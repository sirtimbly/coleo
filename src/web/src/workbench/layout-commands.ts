/**
 * Small command bridge between settings panels and the Golden Layout shell.
 *
 * A settings panel cannot directly access the shell's GoldenLayout instance,
 * so named save/restore requests use typed browser events while persistence
 * remains owned by the shell.
 */

export const SAVE_WORKSPACE_LAYOUT_EVENT = "coleo:workspace-layout-save";
export const RESTORE_WORKSPACE_LAYOUT_EVENT = "coleo:workspace-layout-restore";

export interface SaveWorkspaceLayoutDetail {
	name: string;
	shared: boolean;
}

export interface RestoreWorkspaceLayoutDetail {
	layoutId: string;
}

export function requestWorkspaceLayoutSave(detail: SaveWorkspaceLayoutDetail): void {
	window.dispatchEvent(new CustomEvent(SAVE_WORKSPACE_LAYOUT_EVENT, { detail }));
}

export function requestWorkspaceLayoutRestore(layoutId: string): void {
	window.dispatchEvent(new CustomEvent(RESTORE_WORKSPACE_LAYOUT_EVENT, {
		detail: { layoutId } satisfies RestoreWorkspaceLayoutDetail,
	}));
}
