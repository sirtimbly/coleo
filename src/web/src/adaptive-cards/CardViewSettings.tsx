import { Button, Dropdown, Label, Separator } from "@heroui/react";
import {
	Check,
	LayoutList,
	Rows3,
	SlidersHorizontal,
	Undo2,
} from "lucide-react";

import type {
	CardPresentationMode,
	GlobalCardPresentationMode,
} from "./card-presentation";

export function CardViewSettings({
	mode,
	globalMode,
	hasOverride,
	onCardModeChange,
	onClearCardMode,
	onAllModeChange,
}: {
	mode: CardPresentationMode;
	globalMode: GlobalCardPresentationMode;
	hasOverride: boolean;
	onCardModeChange: (mode: CardPresentationMode) => void;
	onClearCardMode: () => void;
	onAllModeChange: (mode: GlobalCardPresentationMode) => void;
}) {
	return (
		<Dropdown>
			<Button
				isIconOnly
				size="sm"
				variant="ghost"
				aria-label="Card view settings"
				className="h-7 min-h-7 w-7 min-w-7"
			>
				<SlidersHorizontal className="h-3.5 w-3.5" />
			</Button>
			<Dropdown.Popover placement="bottom end" className="min-w-[230px]">
				<Dropdown.Menu
					onAction={(key) => {
						if (key === "card:compact") onCardModeChange("compact");
						if (key === "card:detail") onCardModeChange("detail");
						if (key === "card:clear") onClearCardMode();
						if (key === "all:compact") onAllModeChange("compact");
						if (key === "all:detail") onAllModeChange("detail");
						if (key === "all:surface") onAllModeChange("surface");
					}}
				>
					<Dropdown.Item id="card:compact" textValue="Compact this card">
						<Rows3 className="h-4 w-4 text-muted-foreground" />
						<Label className="flex-1">Compact this card</Label>
						{mode === "compact" && hasOverride ? <Check className="h-4 w-4" /> : null}
					</Dropdown.Item>
					<Dropdown.Item id="card:detail" textValue="Show full card details">
						<LayoutList className="h-4 w-4 text-muted-foreground" />
						<Label className="flex-1">Full details for this card</Label>
						{mode === "detail" && hasOverride ? <Check className="h-4 w-4" /> : null}
					</Dropdown.Item>
					<Dropdown.Item
						id="card:clear"
						textValue="Use shared card setting"
						isDisabled={!hasOverride}
					>
						<Undo2 className="h-4 w-4 text-muted-foreground" />
						<Label>Use shared setting</Label>
					</Dropdown.Item>
					<Separator />
					<Dropdown.Item id="all:compact" textValue="Compact all cards">
						<Rows3 className="h-4 w-4 text-muted-foreground" />
						<Label className="flex-1">Compact all cards</Label>
						{globalMode === "compact" ? <Check className="h-4 w-4" /> : null}
					</Dropdown.Item>
					<Dropdown.Item id="all:detail" textValue="Show all card details">
						<LayoutList className="h-4 w-4 text-muted-foreground" />
						<Label className="flex-1">Full details for all cards</Label>
						{globalMode === "detail" ? <Check className="h-4 w-4" /> : null}
					</Dropdown.Item>
					<Dropdown.Item id="all:surface" textValue="Use surface defaults">
						<Undo2 className="h-4 w-4 text-muted-foreground" />
						<Label className="flex-1">Use surface defaults</Label>
						{globalMode === "surface" ? <Check className="h-4 w-4" /> : null}
					</Dropdown.Item>
				</Dropdown.Menu>
			</Dropdown.Popover>
		</Dropdown>
	);
}
