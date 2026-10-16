import { cn } from '@/lib/utils';

interface ProgressBarProps {
	percent: number;
	size?: 'sm' | 'md' | 'lg';
	color?: 'default' | 'accent' | 'success' | 'warning' | 'danger';
	showLabel?: boolean;
	className?: string;
}

const sizeClasses: Record<'sm' | 'md' | 'lg', string> = {
	sm: 'h-1.5',
	md: 'h-2',
	lg: 'h-3',
};

const colorClasses: Record<'default' | 'accent' | 'success' | 'warning' | 'danger', string> = {
	default: 'bg-default-foreground',
	accent: 'bg-accent',
	success: 'bg-success',
	warning: 'bg-warning',
	danger: 'bg-danger',
};

const bgContainerColor: Record<'default' | 'accent' | 'success' | 'warning' | 'danger', string> = {
	default: 'bg-default-300',
	accent: 'bg-default-200',
	success: 'bg-success/20',
	warning: 'bg-warning/20',
	danger: 'bg-danger/20',
};

/**
 * Horizontal progress bar showing completion percentage.
 */
export function ProgressBar({
	percent,
	size = 'md',
	color = 'accent',
	showLabel = true,
	className,
}: ProgressBarProps) {
	const clamped = Math.max(0, Math.min(100, percent));

	return (
		<div className={cn('flex items-center gap-2', className)}>
			<div className={cn('flex-1 rounded-full overflow-hidden', bgContainerColor[color], sizeClasses[size])}>
				<div
					className={cn('h-full transition-all duration-300 ease-out rounded-full', colorClasses[color])}
					style={{ width: `${clamped}%` }}
				/>
			</div>
			{showLabel && (
				<span className="text-xs text-default-500 w-12 text-right font-mono">
					{Math.round(clamped)}%
				</span>
			)}
		</div>
	);
}
