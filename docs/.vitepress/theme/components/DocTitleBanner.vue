<script setup lang="ts">
import { computed } from "vue";
import { useData } from "vitepress";

interface DocBannerOptions {
  src: string;
  alt?: string;
  eyebrow?: string;
  position?: string;
}

const { frontmatter, title } = useData();

const banner = computed<DocBannerOptions | null>(() => {
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

  return null;
});

const imagePosition = computed(() => banner.value?.position ?? "center");
const pageTitle = computed(() => {
  const value: unknown = frontmatter.value.title;
  return typeof value === "string" ? value : title.value;
});
</script>

<template>
  <header v-if="banner" class="doc-title-banner">
    <img
      class="doc-title-banner__image"
      :src="banner.src"
      :alt="banner.alt ?? ''"
      :style="{ objectPosition: imagePosition }"
    />
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
.doc-title-banner__wash {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
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
  color: #79e7dc;
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
