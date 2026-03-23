import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import type { AppLayoutMode } from '@/hooks/useLayoutMode';
import { ArmStatusBar } from "./ArmStatusBar";
import { AppSidebar } from './AppSidebar';

interface LayoutProps {
	children: ReactNode;
	layoutMode: AppLayoutMode;
}

export function Layout({ children, layoutMode }: LayoutProps) {
	const location = useLocation();
	const showArmStatusBar = location.pathname !== "/viewer";

	return (
		<div className="flex h-screen">
			<AppSidebar
				layoutMode={layoutMode}
			/>

			{/* Main content */}
			<main className="flex-1 overflow-auto flex flex-col">
				{showArmStatusBar && <ArmStatusBar />}
				{children}
			</main>
		</div>
	);
}
