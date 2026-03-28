import { memo, useCallback } from 'react';
import { type Discovery } from '@/lib/api';
import { DiscoveryGridRow, type DiscoveryUpdate } from './DiscoveryGridRow';
import { cn } from '@/lib';

interface DiscoveryGridProps {
	discoveries: Discovery[];
	selectedDiscoveryId?: string;
	onOpenDetails?: (discovery: Discovery) => void;
	onUpdateDiscovery?: (discoveryId: string, updates: DiscoveryUpdate) => void;
	onDelete?: (discoveryId: string) => void;
	className?: string;
}

export const DiscoveryGridHeader = memo(function DiscoveryGridHeader() {
	return (
		<div className="grid grid-cols-[48px_24px_minmax(0,1fr)_80px_80px_80px_100px_48px] items-center gap-3 border-b border-border px-4 py-3 text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
			<div className="text-right pr-1">#</div>
			<div />

			<div>Title</div>
			<div>Kind</div>
			<div>Severity</div>
			<div>Status</div>
			<div className="text-right">Actions</div>
		</div>
	);
});

export function DiscoveryGrid({
	discoveries,
	selectedDiscoveryId,
	onOpenDetails,
	className,
	onUpdateDiscovery,
	onDelete,
}: DiscoveryGridProps) {
	const handleUpdate = useCallback(
		(discoveryId: string, updates: DiscoveryUpdate) => {
			onUpdateDiscovery?.(discoveryId, updates);
		},
		[onUpdateDiscovery]
	);

	const handleDelete = useCallback(
		(discoveryId: string) => {
			onDelete?.(discoveryId);
		},
		[onDelete]
	);

	return (
		<div className={cn('overflow-hidden rounded-md border border-border bg-card', className)}>
			<DiscoveryGridHeader />
			<div className="overflow-y-auto p-2">
				{discoveries.length === 0 ? (
					<div className="p-6 text-center text-muted-foreground text-sm">No discoveries found</div>
				) : (
					<ul className="space-y-0.5">
						{discoveries.map((discovery, index) => (
							<DiscoveryGridRow
								key={discovery.id}
								discovery={discovery}
								index={index}
								isSelected={discovery.id === selectedDiscoveryId}
								onOpenDetails={onOpenDetails}
								onUpdateDiscovery={handleUpdate}
								onDelete={handleDelete}
							/>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
