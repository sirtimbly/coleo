/**
 * Creatable-option adapter for Handsontable's native MultiSelect editor.
 *
 * Handsontable intentionally treats a MultiSelect source as a closed list.
 * Resource sheets use this adapter when a column needs search-to-create
 * behavior without replacing the editor's selection, validation, or history
 * integration.
 */

import Handsontable from "handsontable";
import type { ColumnSettings } from "handsontable/settings";

export interface CreatableMultiSelectConfig {
	options?: string[];
	optionLabel?: string;
}

interface CreatableMultiSelectEditor {
	cellProperties: ColumnSettings;
	dropdownContainerElement: HTMLDivElement | null;
	dropdownController: {
		fillDropdown: (entries: string[], checkedValues?: unknown[]) => void;
	} | null;
	getInputElement: () => HTMLInputElement;
	getValue: () => unknown;
	refreshDimensions: () => void;
}

function isCreatableMultiSelectEditor(editor: unknown): editor is CreatableMultiSelectEditor {
	if (!editor || typeof editor !== "object") return false;
	const candidate = editor as Partial<CreatableMultiSelectEditor>;
	return typeof candidate.getInputElement === "function" &&
		typeof candidate.getValue === "function" &&
		typeof candidate.refreshDimensions === "function" &&
		"dropdownController" in candidate;
}

export function creatableMultiSelectValidator(
	value: unknown,
	callback: (valid: boolean) => void,
): void {
	callback(
		Array.isArray(value) &&
		value.every((item) => typeof item === "string" && item.trim().length > 0),
	);
}

export function decorateCreatableMultiSelect(
	hot: Handsontable,
	config: CreatableMultiSelectConfig,
): void {
	const editor = hot.getActiveEditor();
	if (!isCreatableMultiSelectEditor(editor)) return;
	const input = editor.getInputElement();
	const wrapper = input.closest<HTMLElement>(".ht-multi-select-editor-search-input-wrapper");
	if (!wrapper) return;

	let createButton = wrapper.querySelector<HTMLButtonElement>(".coleo-multiselect-create");
	if (!createButton) {
		createButton = hot.rootDocument.createElement("button");
		createButton.type = "button";
		createButton.className = "coleo-multiselect-create";
		wrapper.appendChild(createButton);
	}

	const optionLabel = config.optionLabel ?? "option";
	const readSource = (): string[] => (
		Array.isArray(editor.cellProperties.source)
			? editor.cellProperties.source.filter((value): value is string => typeof value === "string")
			: []
	);
	const readSelected = (): string[] => {
		const value = editor.getValue();
		return Array.isArray(value)
			? value.filter((item): item is string => typeof item === "string")
			: [];
	};
	const availableOptions = Array.from(new Set([
		...(config.options ?? []),
		...readSource(),
		...readSelected(),
	])).sort((left, right) => left.localeCompare(right));
	editor.cellProperties.source = availableOptions;
	editor.dropdownController?.fillDropdown(availableOptions, readSelected());

	const resolveQuery = () => {
		const query = input.value.trim();
		const existing = readSource().find(
			(value) => value.toLocaleLowerCase() === query.toLocaleLowerCase(),
		);
		const value = existing ?? query;
		const selected = readSelected().some(
			(item) => item.toLocaleLowerCase() === value.toLocaleLowerCase(),
		);
		return { query, value, existing, selected };
	};
	const updateButton = () => {
		if (!createButton) return;
		const { query, value, existing, selected } = resolveQuery();
		createButton.disabled = query.length === 0 || selected;
		createButton.textContent = selected
			? "Selected"
			: existing
				? "Select"
				: `Add ${optionLabel}`;
		createButton.setAttribute(
			"aria-label",
			selected
				? `${optionLabel} "${value}" is already selected`
				: existing
					? `Select existing ${optionLabel} "${value}"`
					: query
						? `Add "${value}" as a ${optionLabel}`
						: `Type a new ${optionLabel} to add it`,
		);
	};
	const createAndSelect = () => {
		const { query, value, existing, selected } = resolveQuery();
		if (!query || selected || !editor.dropdownController || !editor.dropdownContainerElement) return;
		const source = readSource();
		const nextSource = existing
			? source
			: [...source, value].sort((left, right) => left.localeCompare(right));
		editor.cellProperties.source = nextSource;
		editor.dropdownController.fillDropdown(nextSource, readSelected());
		const checkbox = Array.from(
			editor.dropdownContainerElement.querySelectorAll<HTMLInputElement>(
				'input[type="checkbox"][data-value]',
			),
		).find((candidate) => candidate.dataset.value === value);
		if (!checkbox) return;
		checkbox.checked = true;
		checkbox.dispatchEvent(new Event("change", { bubbles: true }));
		input.value = "";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		updateButton();
		editor.refreshDimensions();
		input.focus();
	};

	input.oninput = updateButton;
	input.onkeydown = (event) => {
		if (event.key !== "Enter" || createButton?.disabled) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		createAndSelect();
	};
	createButton.onmousedown = (event) => {
		event.preventDefault();
		event.stopPropagation();
	};
	createButton.onclick = (event) => {
		event.preventDefault();
		event.stopPropagation();
		createAndSelect();
	};
	updateButton();
}
