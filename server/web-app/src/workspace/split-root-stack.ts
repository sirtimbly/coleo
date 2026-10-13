import { ContentItem } from "golden-layout";
import type { GoldenLayout, StackItemConfig } from "golden-layout";

/** Reparent the live stack so splitting never remounts its React panels. */
export function splitRootStack(layout: GoldenLayout, sibling: StackItemConfig): boolean {
	const root = layout.rootItem;
	if (!root || !ContentItem.isStack(root) || !root.parent) return false;
	layout.checkMinimiseMaximisedStack();
	const ground = root.parent;
	// Location selector 7 is Root; explicit selectors avoid the still-focused old stack.
	ground.removeChild(root, true);
	layout.addItemAtLocation({ type: "row", content: [] }, [{ typeId: 7 }]);
	const row = layout.rootItem;
	if (!row) {
		ground.addChild(root);
		return false;
	}
	row.addChild(root, 0, true);
	layout.addItemAtLocation(sibling, [{ typeId: 7 }]);
	layout.updateRootSize(true);
	return true;
}
