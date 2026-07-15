import { Chip } from "@heroui/react";

import { DenseRowSkeleton, DenseSection } from "@/components/DenseList";
import type { AgentProviderStatus } from "@/lib";

interface ArmHostProvidersSectionProps {
	hosts: AgentProviderStatus[];
	isLoading: boolean;
	onOpenArms: () => void;
}

export function ArmHostProvidersSection({
	hosts,
	isLoading,
	onOpenArms,
}: ArmHostProvidersSectionProps) {
	return (
		<DenseSection title="Arm Hosts & Providers" onHeaderClick={onOpenArms}>
			{isLoading ? (
				<>
					<DenseRowSkeleton />
					<DenseRowSkeleton />
				</>
			) : hosts.length === 0 ? (
				<div className="px-4 py-6 text-center text-sm text-muted-foreground">
					No arm hosts are connected.
				</div>
			) : (
				hosts.map((host) => (
					<div key={host.agentId} className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center">
						<div className="flex min-w-0 items-center gap-3 sm:w-64 sm:shrink-0">
							<span
								className={`h-2 w-2 shrink-0 rounded-full ${host.error ? "bg-warning" : "bg-success"}`}
							/>
							<div className="min-w-0">
								<p className="truncate text-sm font-medium">{host.hostname}</p>
								<p className="truncate font-mono text-[10.5px] text-muted-foreground/70">
									{host.agentId} · v{host.version}
								</p>
							</div>
						</div>

						<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 sm:justify-end">
							{host.error ? (
								<span className="text-xs text-warning">{host.error}</span>
							) : host.configuredProviders.length === 0 ? (
								<span className="text-xs text-muted-foreground">No providers configured</span>
							) : (
								host.configuredProviders.map((provider) => (
									<Chip key={provider.id} size="sm" variant="soft" color="success">
										{provider.name}
									</Chip>
								))
							)}
							{!host.error && (
								<span className="ml-1 text-[10.5px] text-muted-foreground">
									{host.configuredProviders.length}/{host.availableProviderCount} configured
								</span>
							)}
						</div>
					</div>
				))
			)}
		</DenseSection>
	);
}
