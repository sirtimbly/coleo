import { createArmAvatarSource } from "@/adaptive-cards/card-creators";
import { cn } from "@/lib";

export function ArmAvatar({
	armId,
	className,
}: {
	armId: string;
	className?: string;
}) {
	return (
		<img
			src={createArmAvatarSource(armId)}
			alt=""
			aria-hidden="true"
			draggable={false}
			className={cn(
				"block h-8 w-8 shrink-0 object-cover [image-rendering:pixelated]",
				className,
			)}
		/>
	);
}
