<script setup lang="ts">
import DefaultTheme from "vitepress/theme";
import { useRoute, Content } from "vitepress";
import { computed, watch, watchEffect, nextTick } from "vue";
import DocTitleBanner from "../components/DocTitleBanner.vue";

const { Layout: DefaultLayout } = DefaultTheme;

const route = useRoute();

const isHome = computed(() => {
  // Prefer source-relative path when available
  // Fallback to tolerant path checks
  const rel = (route.data && route.data.relativePath) || "";
  if (rel === "index.md") return true;
  const p = route.path || "";
  return p === "/" || p.endsWith("/index.html") || p === "";
});

// Make it easier (and more compatible) to scope styles without relying on `:has()`.
watchEffect(() => {
  if (typeof document === "undefined") return;
  document.body.classList.toggle("coleo-home", isHome.value);
  if (isHome.value) {
    document.body.classList.remove("light-mode", "dark-mode");
  }
});

const bootAnimations = async () => {
  if (typeof window === "undefined") return;
  await nextTick();
  setTimeout(async () => {
    const home = isHome.value;
    // Stop both animators before starting the appropriate one
    (window as any).__homeAnim?.stopHomeAnimation?.();
    (window as any).__innerAnim?.stopInnerAnimation?.();
    if (home) {
      try {
        await import("../anim.js");
      } catch (_) {}
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        (window as any).__homeAnim?.initHomeAnimation?.();
      }
    } else {
      try {
        await import("../anim-lite.js");
      } catch (_) {}
      (window as any).__innerAnim?.initInnerAnimation?.();
    }
  }, 0);
};

watch(
  () => route.path,
  () => {
    bootAnimations();
  },
  { immediate: true },
);
</script>

<template>
  <!-- Use a minimal layout for the homepage to match marketing visuals -->
  <div v-if="isHome" class="marketing-root">
    <Content />
  </div>

  <div v-else>
    <div class="depth-control" id="depthControl">
      <button type="button" id="depthIcon" aria-label="Toggle scene depth">💡</button>
      <label class="visually-hidden" for="depthSlider">Scene depth</label>
      <input type="range" id="depthSlider" name="scene-depth" min="0" max="100" value="70" />
    </div>
    <DefaultLayout>
      <template #sidebar-nav-before>
        <a class="docs-sidebar-brand" href="/">
          <img src="/coleo-logo.png" alt="" width="600" height="600" />
          <span>
            <strong>Coleo</strong>
            <small>Documentation</small>
          </span>
        </a>
      </template>
      <template #sidebar-nav-after>
        <a
          class="docs-sidebar-github"
          href="https://github.com/sirtimbly/coleo"
          target="_blank"
          rel="noreferrer"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.61-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.58 9.58 0 0 1 12 6.82a9.6 9.6 0 0 1 2.5.34c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.86v2.76c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
          </svg>
          <span>
            <strong>GitHub</strong>
            <small>Source &amp; issues</small>
          </span>
          <span class="docs-sidebar-github__arrow" aria-hidden="true">↗</span>
        </a>
      </template>
      <template #doc-before>
        <DocTitleBanner />
      </template>
    </DefaultLayout>
  </div>
</template>
