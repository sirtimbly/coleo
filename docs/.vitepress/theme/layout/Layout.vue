<script setup lang="ts">
import DefaultTheme from "vitepress/theme";
import { useRoute, Content } from "vitepress";
import { computed, watch, watchEffect, nextTick } from "vue";
import SiteNav from "../components/SiteNav.vue";

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
      (window as any).__homeAnim?.initHomeAnimation?.();
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
    <!-- Desktop navigation (mobile uses VitePress default navbar + hamburger) -->
    <div class="coleo-site-nav">
      <SiteNav />
    </div>
    <DefaultLayout />
  </div>
</template>
