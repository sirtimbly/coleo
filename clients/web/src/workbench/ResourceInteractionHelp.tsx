import { formatKeyboardBinding } from "../../../../server/src/workbench/interaction-definition";

import type { ReactNode } from "react";
import type { ResolvedInteractions } from "../../../../server/src/workbench/interaction-definition";

export function ResourceInteractionHelp({ interactions }: { interactions: ResolvedInteractions }): ReactNode {
	return <div className="max-h-64 overflow-auto border-b border-border bg-surface-secondary p-3 text-xs" aria-label="Resolved interaction bindings">
		<table className="w-full text-left">
			<thead><tr><th>Operation</th><th>Keyboard / scope</th><th>CLI</th><th>Shortcut availability</th></tr></thead>
			<tbody>{interactions.bindings.map((binding) => <tr key={binding.id}>
				<td className="py-1 pr-3">{binding.label}</td>
				<td className="pr-3">{binding.keyboard.map((key) => `${formatKeyboardBinding(key)} (${key.scope})`).join(", ") || "—"}</td>
				<td className="pr-3">{binding.cli ? "flag" in binding.cli ? `${binding.cli.flag}${binding.cli.alias ? ` / ${binding.cli.alias}` : ""}${binding.value ? ` <${binding.value.type}>` : ""}`
					: `${binding.cli.subcommand}${binding.value ? ` <${binding.target ?? binding.value.type}>` : ""}` : "—"}</td>
				<td>{binding.available ? "Available" : binding.diagnostic}</td>
			</tr>)}</tbody>
		</table>
	</div>;
}
