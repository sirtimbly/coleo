import { defineConfig } from "vitepress";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	title: "Coleo",
	description:
		"Self-hosted control plane for coding agents with web and CLI observability.",
	titleTemplate: ":title | Coleo",
	sitemap: {
		hostname: "https://coleo.dev",
	},
	ignoreDeadLinks: true,
	markdown: {
		theme: {
			light: "github-light",
			dark: "github-dark-high-contrast",
		},
	},
	themeConfig: {
		// Shown in the default VitePress navbar on documentation pages
		logo: "/coleo-logo.png",
		sidebar: {
			"/": [
				{ text: "Philosophy", link: "/philosophy" },
				{
					text: "Guides",
					items: [
						{ text: "Getting Started", link: "/guides/getting-started" },
						{ text: "Task Workflow", link: "/guides/task-workflow" },
						{ text: "Planning Gate", link: "/guides/planning-gate" },
						{ text: "CLI", link: "/guides/cli" },
						{ text: "Docker", link: "/guides/docker" },
						{ text: "IMAP Gateway", link: "/guides/imap-gateway" },
					],
				},
				{
					text: "Architecture",
					items: [
						{ text: "Overview", link: "/architecture/overview" },
						{ text: "Components", link: "/architecture/components" },
						{
							text: "Brain/API Boundary",
							link: "/architecture/brain-api-boundary",
						},
						{
							text: "Harness Contract",
							link: "/architecture/harness-contract",
						},
						{ text: "Security", link: "/architecture/security" },
					],
				},
			],
		},
	},
	head: [
		["meta", { name: "theme-color", content: "#071a21" }],
		["link", { rel: "shortcut icon", href: "/favicon.png" }],
		[
			"link",
			{
				rel: "icon",
				type: "image/png",
				href: "/favicon.png",
				sizes: "32x32",
			},
		],
		["meta", { property: "og:type", content: "website" }],
		["meta", { property: "og:site_name", content: "Coleo" }],
		["meta", { property: "og:title", content: "Coleo" }],
		[
			"meta",
			{
				property: "og:description",
				content:
					"Self-hosted control plane for coding agents. Run on your hardware, plug in CLI harnesses, and coordinate long-running work with full local visibility.",
			},
		],
		["meta", { property: "og:url", content: "https://coleo.dev/" }],
		[
			"meta",
			{
				property: "og:image",
				content: "https://coleo.dev/social-card.png",
			},
		],
		[
			"meta",
			{
				property: "og:image:alt",
				content: "Coleo social preview card",
			},
		],
		["meta", { property: "og:image:width", content: "1200" }],
		["meta", { property: "og:image:height", content: "630" }],
		["meta", { name: "twitter:card", content: "summary_large_image" }],
		["meta", { name: "twitter:title", content: "Coleo" }],
		[
			"meta",
			{
				name: "twitter:description",
				content:
					"Self-hosted control plane for coding agents with web and CLI observability.",
			},
		],
		[
			"meta",
			{
				name: "twitter:image",
				content: "https://coleo.dev/social-card.png",
			},
		],
		// Display, text, and utility faces used across docs and the field-manual homepage.
		[
			"link",
			{
				rel: "preconnect",
				href: "https://fonts.googleapis.com",
			},
		],
		[
			"link",
			{
				rel: "preconnect",
				href: "https://fonts.gstatic.com",
				crossorigin: "",
			},
		],
		[
			"link",
			{
				rel: "stylesheet",
				href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@300;400;500;600&family=Pathway+Extreme:wght@300;400;500;600;700;800&display=swap",
			},
		],
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
