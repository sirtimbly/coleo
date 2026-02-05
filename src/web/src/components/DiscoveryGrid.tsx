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
		<div className="grid grid-cols-[48px_24px_minmax(0,1fr)_80px_80px_80px_100px_48px] items-center gap-3 p-3 text-xs font-semibold text-muted-foreground border-b border-border bg-muted/50">
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
		<div className={cn('border border-border rounded-lg bg-card overflow-hidden', className)}>
			<DiscoveryGridHeader />
			<div className="overflow-y-auto p-1">
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