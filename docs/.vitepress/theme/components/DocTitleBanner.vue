<script setup lang="ts">
import { computed } from "vue";
import { useData, useRoute } from "vitepress";

type DocBannerVariant =
  | "guide"
  | "architecture"
  | "workbench"
  | "operations"
  | "release"
  | "reference";

interface DocBannerOptions {
  src?: string;
  alt?: string;
  eyebrow?: string;
  position?: string;
  variant?: DocBannerVariant;
}

const { frontmatter, title } = useData();
const route = useRoute();

function getFallbackBanner(path: string): DocBannerOptions {
  if (path.startsWith("/guides/")) {
    return { eyebrow: "Field Guide", variant: "guide" };
  }
  if (path.startsWith("/architecture/")) {
    return { eyebrow: "System Anatomy", variant: "architecture" };
  }
  if (path.startsWith("/workbench/")) {
    return { eyebrow: "Observatory Notes", variant: "workbench" };
  }
  if (path.startsWith("/usage/")) {
    return { eyebrow: "Operations", variant: "operations" };
  }
  if (path.startsWith("/releases/")) {
    return { eyebrow: "Release Log", variant: "release" };
  }
  if (path.startsWith("/maintenance/")) {
    return { eyebrow: "Maintenance Log", variant: "operations" };
  }
  if (path.startsWith("/diagrams/")) {
    return { eyebrow: "System Map", variant: "architecture" };
  }
  return { eyebrow: "Coleo Reference", variant: "reference" };
}

const banner = computed<DocBannerOptions>(() => {
  const value: unknown = frontmatter.value.banner;

  if (typeof value === "string") {
    return { src: value };
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "src" in value &&
    typeof value.src === "string"
  ) {
    return value as DocBannerOptions;
  }

  return getFallbackBanner(route.path);
});

const imagePosition = computed(() => banner.value?.position ?? "center");
const pageTitle = computed(() => {
  const value: unknown = frontmatter.value.title;
  const resolved = typeof value === "string" ? value : title.value;
  return resolved.replace(/\s*\|\s*Coleo$/, "");
});
</script>

<template>
  <header
    class="doc-title-banner"
    :class="[
      !banner.src && 'doc-title-banner--generated',
      `doc-title-banner--${banner.variant ?? 'image'}`,
    ]"
  >
    <img
      v-if="banner.src"
      class="doc-title-banner__image"
      :src="banner.src"
      :alt="banner.alt ?? ''"
      :style="{ objectPosition: imagePosition }"
    />
    <svg
      v-else
      class="doc-title-banner__diagram"
      viewBox="0 0 760 320"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <path d="M352 160 C278 73 192 50 62 83" />
      <path d="M352 160 C250 140 151 160 38 248" />
      <path d="M352 160 C430 74 537 42 706 71" />
      <path d="M352 160 C458 142 570 177 734 267" />
      <path d="M352 160 C366 211 407 250 487 292" />
      <circle cx="352" cy="160" r="34" />
      <circle cx="62" cy="83" r="8" />
      <circle cx="38" cy="248" r="8" />
      <circle cx="706" cy="71" r="8" />
      <circle cx="734" cy="267" r="8" />
      <circle cx="487" cy="292" r="8" />
    </svg>
    <div class="doc-title-banner__wash" aria-hidden="true"></div>
    <div class="doc-title-banner__title">
      <p v-if="banner.eyebrow" class="doc-title-banner__eyebrow">
        {{ banner.eyebrow }}
      </p>
      <h1 id="page-title">{{ pageTitle }}</h1>
    </div>
  </header>
</template>

<style scoped>
:global(body:not(.coleo-home) .VPDoc .content) {
  container-type: inline-size;
}

.doc-title-banner {
  position: relative;
  left: 50%;
  isolation: isolate;
  width: calc(100cqw + 24px);
  min-height: clamp(240px, 43vw, 326px);
  margin: -24px 0 34px;
  overflow: hidden;
  border-bottom: 1px solid rgba(78, 205, 196, 0.28);
  border-radius: 11px 11px 0 0;
  background: #071423;
  transform: translateX(-50%);
}

.doc-title-banner__image,
.doc-title-banner__diagram,
.doc-title-banner__wash {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.doc-title-banner--generated {
  --banner-accent: #79e7dc;
  --banner-glow: rgba(63, 204, 188, 0.34);
  background:
    radial-gradient(circle at 76% 30%, var(--banner-glow), transparent 34%),
    radial-gradient(circle at 58% 116%, rgba(31, 119, 139, 0.42), transparent 50%),
    linear-gradient(135deg, #061722 0%, #0a3440 54%, #08222e 100%);
}

.doc-title-banner--architecture {
  --banner-accent: #7ee8da;
  --banner-glow: rgba(45, 193, 179, 0.38);
}

.doc-title-banner--workbench {
  --banner-accent: #92c7ff;
  --banner-glow: rgba(70, 133, 210, 0.38);
}

.doc-title-banner--operations {
  --banner-accent: #ffd08d;
  --banner-glow: rgba(208, 139, 69, 0.34);
}

.doc-title-banner--release {
  --banner-accent: #f0a7d2;
  --banner-glow: rgba(200, 91, 160, 0.34);
}

.doc-title-banner--reference {
  --banner-accent: #b8d9e9;
  --banner-glow: rgba(103, 166, 191, 0.32);
}

.doc-title-banner__diagram {
  z-index: -2;
  left: auto;
  width: min(78%, 760px);
  color: var(--banner-accent);
  opacity: 0.62;
  filter: drop-shadow(0 0 18px var(--banner-glow));
}

.doc-title-banner__diagram path,
.doc-title-banner__diagram circle {
  vector-effect: non-scaling-stroke;
}

.doc-title-banner__diagram path {
  fill: none;
  stroke: currentColor;
  stroke-dasharray: 2 9;
  stroke-linecap: round;
  stroke-width: 2;
}

.doc-title-banner__diagram circle {
  fill: color-mix(in srgb, var(--banner-accent) 24%, #071423);
  stroke: currentColor;
  stroke-width: 2;
}

.doc-title-banner__image {
  z-index: -2;
  display: block;
  object-fit: cover;
  transform: scale(1.002);
}

.doc-title-banner__wash {
  z-index: -1;
  background:
    linear-gradient(180deg, rgba(4, 16, 28, 0.03) 22%, rgba(4, 16, 28, 0.9) 100%),
    linear-gradient(90deg, rgba(4, 16, 28, 0.84) 0%, rgba(4, 16, 28, 0.2) 64%, transparent 100%);
}

.doc-title-banner__title {
  position: absolute;
  right: clamp(18px, 4vw, 34px);
  bottom: clamp(20px, 4vw, 32px);
  left: clamp(18px, 4vw, 34px);
  max-width: 610px;
  color: rgba(255, 255, 255, 0.98);
  text-shadow: 0 3px 18px rgba(0, 0, 0, 0.5);
}

.doc-title-banner__eyebrow {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 8px;
  color: var(--banner-accent, #79e7dc);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  line-height: 1.4;
  text-transform: uppercase;
}

.doc-title-banner__eyebrow::before {
  width: 28px;
  height: 1px;
  background: currentColor;
  content: "";
}

.doc-title-banner h1 {
  margin: 0;
  border: 0;
  color: inherit;
  font-family: var(--font-display);
  font-size: clamp(2.15rem, 7vw, 4rem);
  font-weight: 720;
  letter-spacing: -0.045em;
  line-height: 0.98;
}

@media (min-width: 1280px) {
  .doc-title-banner {
    width: calc(100cqw + 48px);
  }
}

@media (max-width: 479px) {
  .doc-title-banner {
    min-height: 230px;
  }

  .doc-title-banner__wash {
    background: linear-gradient(
      180deg,
      rgba(4, 16, 28, 0.08) 16%,
      rgba(4, 16, 28, 0.92) 100%
    );
  }
}

@media (prefers-reduced-motion: reduce) {
  .doc-title-banner__image {
    transform: none;
  }
}
</style>
