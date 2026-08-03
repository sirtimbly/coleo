/**
 * Session-stable option discovery for resource tag MultiSelect cells.
 *
 * A tag removed from its final visible row must remain in the option source so
 * Tabulator can redo or undo that edit. Newly loaded tags are merged into
 * the known set without changing the column settings for unrelated row edits.
 */

import { useEffect, useMemo, useState } from "react";

import { collectTagOptions } from "./tag-values";

export function useKnownTagOptions<T>(
	rows: readonly T[],
	readTags: (row: T) => string[],
): string[] {
	const discoveredKey = useMemo(
		() => JSON.stringify(collectTagOptions(rows.map(readTags))),
		[readTags, rows],
	);
	const [knownOptions, setKnownOptions] = useState<string[]>(
		() => JSON.parse(discoveredKey) as string[],
	);

	useEffect(() => {
		const discovered = JSON.parse(discoveredKey) as string[];
		setKnownOptions((current) => {
			const merged = collectTagOptions([current, discovered]);
			return JSON.stringify(merged) === JSON.stringify(current)
				? current
				: merged;
		});
	}, [discoveredKey]);

	return knownOptions;
}
