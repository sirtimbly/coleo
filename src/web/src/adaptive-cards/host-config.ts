/**
 * Coleo host configuration for Adaptive Cards schema 1.5.
 *
 * Values intentionally mirror Workbench density and defer colors to CSS
 * variables where the SDK permits host styling.
 */
export const COLEO_CARD_HOST_CONFIG = {
	supportsInteractivity: true,
	fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
	spacing: {
		small: 6,
		default: 10,
		medium: 16,
		large: 24,
		extraLarge: 32,
		padding: 16,
	},
	separator: {
		lineThickness: 1,
		lineColor: "#3f3f46",
	},
	fontSizes: {
		small: 12,
		default: 14,
		medium: 16,
		large: 20,
		extraLarge: 26,
	},
	fontWeights: {
		lighter: 300,
		default: 400,
		bolder: 600,
	},
	containerStyles: {
		default: {
			backgroundColor: "#18181b",
			foregroundColors: {
				default: { default: "#fafafa", subtle: "#a1a1aa" },
				accent: { default: "#60a5fa", subtle: "#93c5fd" },
				good: { default: "#4ade80", subtle: "#86efac" },
				warning: { default: "#fbbf24", subtle: "#fde68a" },
				attention: { default: "#f87171", subtle: "#fca5a5" },
				dark: { default: "#18181b", subtle: "#3f3f46" },
				light: { default: "#fafafa", subtle: "#d4d4d8" },
			},
		},
		emphasis: {
			backgroundColor: "#27272a",
			foregroundColors: {
				default: { default: "#fafafa", subtle: "#a1a1aa" },
				accent: { default: "#60a5fa", subtle: "#93c5fd" },
				good: { default: "#4ade80", subtle: "#86efac" },
				warning: { default: "#fbbf24", subtle: "#fde68a" },
				attention: { default: "#f87171", subtle: "#fca5a5" },
				dark: { default: "#18181b", subtle: "#3f3f46" },
				light: { default: "#fafafa", subtle: "#d4d4d8" },
			},
		},
		good: {
			backgroundColor: "#052e16",
			foregroundColors: {
				default: { default: "#f0fdf4", subtle: "#86efac" },
				accent: { default: "#93c5fd", subtle: "#bfdbfe" },
				good: { default: "#4ade80", subtle: "#86efac" },
				warning: { default: "#fde047", subtle: "#fef08a" },
				attention: { default: "#fca5a5", subtle: "#fecaca" },
				dark: { default: "#052e16", subtle: "#14532d" },
				light: { default: "#f0fdf4", subtle: "#dcfce7" },
			},
		},
		warning: {
			backgroundColor: "#422006",
			foregroundColors: {
				default: { default: "#fffbeb", subtle: "#fde68a" },
				accent: { default: "#93c5fd", subtle: "#bfdbfe" },
				good: { default: "#86efac", subtle: "#bbf7d0" },
				warning: { default: "#fbbf24", subtle: "#fde68a" },
				attention: { default: "#fca5a5", subtle: "#fecaca" },
				dark: { default: "#422006", subtle: "#713f12" },
				light: { default: "#fffbeb", subtle: "#fef3c7" },
			},
		},
		attention: {
			backgroundColor: "#450a0a",
			foregroundColors: {
				default: { default: "#fef2f2", subtle: "#fca5a5" },
				accent: { default: "#93c5fd", subtle: "#bfdbfe" },
				good: { default: "#86efac", subtle: "#bbf7d0" },
				warning: { default: "#fde047", subtle: "#fef08a" },
				attention: { default: "#f87171", subtle: "#fca5a5" },
				dark: { default: "#450a0a", subtle: "#7f1d1d" },
				light: { default: "#fef2f2", subtle: "#fee2e2" },
			},
		},
	},
	actions: {
		maxActions: 4,
		spacing: "default",
		buttonSpacing: 8,
		showCard: { actionMode: "inline", inlineTopMargin: 16 },
		actionsOrientation: "horizontal",
		actionAlignment: "left",
	},
} as const;
