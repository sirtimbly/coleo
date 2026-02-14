import { defineConfig } from "vitepress";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	title: "Coleo",
	description:
		"Self-hosted control plane for coding agents with web and CLI observability.",
	titleTemplate: ":title | Coleo",
	ignoreDeadLinks: true,
	themeConfig: {
		// Shown in the default VitePress navbar on documentation pages
		logo: "/coleo-logo.png",
		sidebar: {
			"/": [
				{
					text: "Guides",
					items: [
						{ text: "Getting Started", link: "/guides/getting-started" },
						{ text: "CLI", link: "/guides/cli" },
						{ text: "Docker", link: "/guides/docker" },
						{ text: "IMAP Gateway", link: "/guides/imap-gateway" },
					],
				},
				{ text: "Philosophy", link: "/philosophy" },
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
		// Fonts to match marketing2.html
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
				href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600&display=swap",
			},
		],
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
