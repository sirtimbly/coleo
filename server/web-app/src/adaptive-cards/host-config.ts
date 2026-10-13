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
		lineColor: "var(--color-border)",
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
			foregroundColors: {
				default: {
					default: "var(--color-foreground)",
					subtle: "var(--color-muted-foreground)",
				},
				accent: {
					default: "var(--color-accent)",
					subtle: "var(--color-accent)",
				},
				good: {
					default: "var(--color-success)",
					subtle: "var(--color-success)",
				},
				warning: {
					default: "var(--color-warning)",
					subtle: "var(--color-warning)",
				},
				attention: {
					default: "var(--color-danger)",
					subtle: "var(--color-danger)",
				},
				dark: {
					default: "var(--color-foreground)",
					subtle: "var(--color-muted-foreground)",
				},
				light: {
					default: "var(--color-foreground)",
					subtle: "var(--color-muted-foreground)",
				},
			},
		},
		emphasis: {
			backgroundColor: "var(--adaptive-card-emphasis)",
			foregroundColors: {
				default: {
					default: "var(--adaptive-card-emphasis-foreground)",
					subtle: "var(--adaptive-card-emphasis-muted)",
				},
				accent: { default: "var(--color-accent)", subtle: "var(--color-accent)" },
				good: { default: "var(--color-success)", subtle: "var(--color-success)" },
				warning: { default: "var(--color-warning)", subtle: "var(--color-warning)" },
				attention: { default: "var(--color-danger)", subtle: "var(--color-danger)" },
				dark: {
					default: "var(--adaptive-card-emphasis-foreground)",
					subtle: "var(--adaptive-card-emphasis-muted)",
				},
				light: {
					default: "var(--adaptive-card-emphasis-foreground)",
					subtle: "var(--adaptive-card-emphasis-muted)",
				},
			},
		},
		good: {
			backgroundColor: "var(--adaptive-card-good)",
			foregroundColors: {
				default: {
					default: "var(--adaptive-card-good-foreground)",
					subtle: "var(--adaptive-card-good-muted)",
				},
				accent: { default: "var(--color-accent)", subtle: "var(--color-accent)" },
				good: {
					default: "var(--adaptive-card-good-foreground)",
					subtle: "var(--adaptive-card-good-muted)",
				},
				warning: { default: "var(--color-warning)", subtle: "var(--color-warning)" },
				attention: { default: "var(--color-danger)", subtle: "var(--color-danger)" },
				dark: {
					default: "var(--adaptive-card-good-foreground)",
					subtle: "var(--adaptive-card-good-muted)",
				},
				light: {
					default: "var(--adaptive-card-good-foreground)",
					subtle: "var(--adaptive-card-good-muted)",
				},
			},
		},
		warning: {
			backgroundColor: "var(--adaptive-card-warning)",
			foregroundColors: {
				default: {
					default: "var(--adaptive-card-warning-foreground)",
					subtle: "var(--adaptive-card-warning-muted)",
				},
				accent: { default: "var(--color-accent)", subtle: "var(--color-accent)" },
				good: { default: "var(--color-success)", subtle: "var(--color-success)" },
				warning: {
					default: "var(--adaptive-card-warning-foreground)",
					subtle: "var(--adaptive-card-warning-muted)",
				},
				attention: { default: "var(--color-danger)", subtle: "var(--color-danger)" },
				dark: {
					default: "var(--adaptive-card-warning-foreground)",
					subtle: "var(--adaptive-card-warning-muted)",
				},
				light: {
					default: "var(--adaptive-card-warning-foreground)",
					subtle: "var(--adaptive-card-warning-muted)",
				},
			},
		},
		attention: {
			backgroundColor: "var(--adaptive-card-attention)",
			foregroundColors: {
				default: {
					default: "var(--adaptive-card-attention-foreground)",
					subtle: "var(--adaptive-card-attention-muted)",
				},
				accent: { default: "var(--color-accent)", subtle: "var(--color-accent)" },
				good: { default: "var(--color-success)", subtle: "var(--color-success)" },
				warning: { default: "var(--color-warning)", subtle: "var(--color-warning)" },
				attention: {
					default: "var(--adaptive-card-attention-foreground)",
					subtle: "var(--adaptive-card-attention-muted)",
				},
				dark: {
					default: "var(--adaptive-card-attention-foreground)",
					subtle: "var(--adaptive-card-attention-muted)",
				},
				light: {
					default: "var(--adaptive-card-attention-foreground)",
					subtle: "var(--adaptive-card-attention-muted)",
				},
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
