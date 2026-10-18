/**
 * Creatable multi-select editor and formatter for Tabulator resource sheets.
 *
 * Tabulator's built-in list editor cannot combine multi-select with free-text
 * creation. This single custom editor keeps that behavior explicit: users can
 * search existing values, toggle selections, or turn the current query into a
 * new selected option before applying the edit.
 */

import type {
	CellComponent,
	Editor,
	Formatter,
} from "tabulator-tables";

export interface CreatableMultiSelectConfig {
	options?: readonly string[];
	optionLabel?: string;
	allowCreate?: boolean;
	validateCreate?: (value: string) => string | undefined;
}

function stringValues(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export const tabulatorMultiSelectFormatter: Formatter = (cell) => {
	const values = stringValues(cell.getValue());
	const wrapper = document.createElement("span");
	wrapper.className = "coleo-tabulator-tag-list";
	if (values.length === 0) {
		wrapper.classList.add("is-empty");
		wrapper.textContent = "—";
		return wrapper;
	}
	for (const value of values) {
		const chip = document.createElement("span");
		chip.className = "coleo-tabulator-tag";
		chip.textContent = value;
		wrapper.appendChild(chip);
	}
	return wrapper;
};

export function createTabulatorMultiSelectEditor(
	config: CreatableMultiSelectConfig,
): Editor {
	return (
		cell: CellComponent,
		onRendered,
		success,
		cancel,
	) => {
		const initial = stringValues(cell.getValue());
		const selected = new Set(initial);
		const options = new Set([
			...(config.options ?? []),
			...initial,
		]);
		const label = config.optionLabel ?? "option";
		const root = document.createElement("div");
		const placeholder = document.createElement("span");
		placeholder.className = "coleo-tabulator-multiselect-anchor";
		root.className = "coleo-tabulator-multiselect-editor";
		root.setAttribute("role", "dialog");
		root.setAttribute("aria-label", `Edit ${label}s`);

		const search = document.createElement("input");
		search.type = "search";
		search.className = "coleo-tabulator-multiselect-search";
		search.placeholder = `Search or add ${label}`;
		search.setAttribute("aria-label", "Search options");

		const list = document.createElement("div");
		list.className = "coleo-tabulator-multiselect-options";

		const createButton = document.createElement("button");
		createButton.type = "button";
		createButton.className = "coleo-tabulator-multiselect-create";

		const footer = document.createElement("div");
		footer.className = "coleo-tabulator-multiselect-footer";
		const cancelButton = document.createElement("button");
		cancelButton.type = "button";
		cancelButton.textContent = "Cancel";
		const applyButton = document.createElement("button");
		applyButton.type = "button";
		applyButton.className = "is-primary";
		applyButton.textContent = "Apply";
		footer.append(cancelButton, applyButton);

		const normalizedMatch = (query: string): string | undefined => (
			Array.from(options).find(
				(option) => option.toLocaleLowerCase() === query.toLocaleLowerCase(),
			)
		);
		const orderedSelection = (): string[] => [
			...initial.filter((value) => selected.has(value)),
			...Array.from(selected).filter((value) => !initial.includes(value)),
		];
		let observer: MutationObserver | undefined;
		const cleanup = () => {
			observer?.disconnect();
			observer = undefined;
			root.remove();
		};
		const finish = () => {
			const next = orderedSelection();
			cleanup();
			if (sameValues(initial, next)) cancel(cell.getValue());
			else success(next);
		};
		const render = () => {
			const query = search.value.trim();
			const visibleOptions = Array.from(options)
				.filter((option) => option.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
				.sort((left, right) => left.localeCompare(right));
			list.replaceChildren();
			for (const option of visibleOptions) {
				const optionLabel = document.createElement("label");
				optionLabel.className = "coleo-tabulator-multiselect-option";
				const checkbox = document.createElement("input");
				checkbox.type = "checkbox";
				checkbox.checked = selected.has(option);
				checkbox.setAttribute("aria-label", option);
				checkbox.addEventListener("change", () => {
					if (checkbox.checked) selected.add(option);
					else selected.delete(option);
					updateCreateButton();
				});
				const text = document.createElement("span");
				text.textContent = option;
				optionLabel.append(checkbox, text);
				list.appendChild(optionLabel);
			}
			if (visibleOptions.length === 0) {
				const empty = document.createElement("span");
				empty.className = "coleo-tabulator-multiselect-empty";
				empty.textContent = "No matching options";
				list.appendChild(empty);
			}
			updateCreateButton();
		};
		const updateCreateButton = () => {
			const query = search.value.trim();
			const existing = normalizedMatch(query);
			const value = existing ?? query;
			const isSelected = value ? selected.has(value) : false;
			const validationError = existing ? undefined : config.validateCreate?.(query);
			createButton.hidden = config.allowCreate === false;
			createButton.disabled = query.length === 0 || isSelected || validationError !== undefined;
			createButton.textContent = validationError
				? validationError
				: isSelected
				? "Selected"
				: existing
					? `Select ${label}`
					: `Add ${label}`;
			createButton.setAttribute(
				"aria-label",
				validationError
					? validationError
					: isSelected
					? `${label} "${value}" is already selected`
					: existing
						? `Select existing ${label} "${value}"`
						: query
							? `Add "${value}" as a ${label}`
							: `Type a new ${label} to add it`,
			);
		};
		const createAndSelect = () => {
			const query = search.value.trim();
			if (!query) return;
			const existing = normalizedMatch(query);
			if (!existing && config.validateCreate?.(query)) return;
			const value = existing ?? query;
			options.add(value);
			selected.add(value);
			search.value = "";
			render();
			search.focus();
		};

		search.addEventListener("input", render);
		search.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				cleanup();
				cancel(cell.getValue());
				return;
			}
			if (event.key !== "Enter") return;
			event.preventDefault();
			event.stopPropagation();
			if (!createButton.disabled && config.allowCreate !== false) createAndSelect();
			else finish();
		});
		createButton.addEventListener("click", createAndSelect);
		cancelButton.addEventListener("click", () => {
			cleanup();
			cancel(cell.getValue());
		});
		applyButton.addEventListener("click", finish);
		const keepEditorOpen = (event: Event) => event.stopPropagation();
		root.addEventListener("pointerdown", keepEditorOpen);
		root.addEventListener("mousedown", keepEditorOpen);
		root.addEventListener("click", keepEditorOpen);
		root.append(search, list, createButton, footer);
		render();

		onRendered(() => {
			const bounds = cell.getElement().getBoundingClientRect();
			root.style.setProperty("--coleo-editor-left", `${Math.max(8, bounds.left)}px`);
			root.style.setProperty("--coleo-editor-top", `${Math.min(window.innerHeight - 330, bounds.bottom + 2)}px`);
			root.style.setProperty("--coleo-editor-width", `${Math.max(250, bounds.width)}px`);
			document.body.appendChild(root);
			observer = new MutationObserver(() => {
				if (!placeholder.isConnected) cleanup();
			});
			observer.observe(cell.getElement(), { childList: true });
			search.focus();
		});

		return placeholder;
	};
}
