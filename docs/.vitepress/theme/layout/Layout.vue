<script setup lang="ts">
import { useRoute, Content } from "vitepress";
import { computed, watch, watchEffect } from "vue";
import VPBackdrop from "vitepress/dist/client/theme-default/components/VPBackdrop.vue";
import VPContent from "vitepress/dist/client/theme-default/components/VPContent.vue";
import VPFooter from "vitepress/dist/client/theme-default/components/VPFooter.vue";
import VPSidebar from "vitepress/dist/client/theme-default/components/VPSidebar.vue";
import VPSkipLink from "vitepress/dist/client/theme-default/components/VPSkipLink.vue";
import { useData } from "vitepress/dist/client/theme-default/composables/data";
import { useCloseSidebarOnEscape, useSidebar } from "vitepress/dist/client/theme-default/composables/sidebar";
import SiteNav from "../components/SiteNav.vue";

const route = useRoute();
const { frontmatter } = useData();

const { isOpen: isSidebarOpen, open: openSidebar, close: closeSidebar } = useSidebar();

watch(() => route.path, closeSidebar);
useCloseSidebarOnEscape(isSidebarOpen, closeSidebar);

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
</script>

<template>
  <!-- Use a minimal layout for the homepage to match marketing visuals -->
  <div v-if="isHome" class="marketing-root">
    <Content />
  </div>

  <div v-else-if="frontmatter.layout !== false" class="coleo-docs">
    <VPSkipLink />
    <VPBackdrop class="backdrop" :show="isSidebarOpen" @click="closeSidebar" />

    <SiteNav @open-menu="openSidebar" />

    <div class="coleo-docs-grid">
      <div class="coleo-sidebar-col">
        <VPSidebar :open="isSidebarOpen">
          <template #sidebar-nav-before>
            <slot name="sidebar-nav-before" />
          </template>
          <template #sidebar-nav-after>
            <slot name="sidebar-nav-after" />
          </template>
        </VPSidebar>
      </div>

      <VPContent>
        <template #page-top><slot name="page-top" /></template>
        <template #page-bottom><slot name="page-bottom" /></template>

        <template #not-found><slot name="not-found" /></template>
        <template #home-hero-before><slot name="home-hero-before" /></template>
        <template #home-hero-info-before><slot name="home-hero-info-before" /></template>
        <template #home-hero-info><slot name="home-hero-info" /></template>
        <template #home-hero-info-after><slot name="home-hero-info-after" /></template>
        <template #home-hero-actions-after><slot name="home-hero-actions-after" /></template>
        <template #home-hero-image><slot name="home-hero-image" /></template>
        <template #home-hero-after><slot name="home-hero-after" /></template>
        <template #home-features-before><slot name="home-features-before" /></template>
        <template #home-features-after><slot name="home-features-after" /></template>

        <template #doc-footer-before><slot name="doc-footer-before" /></template>
        <template #doc-before><slot name="doc-before" /></template>
        <template #doc-after><slot name="doc-after" /></template>
        <template #doc-top><slot name="doc-top" /></template>
        <template #doc-bottom><slot name="doc-bottom" /></template>

        <template #aside-top><slot name="aside-top" /></template>
        <template #aside-bottom><slot name="aside-bottom" /></template>
        <template #aside-outline-before><slot name="aside-outline-before" /></template>
        <template #aside-outline-after><slot name="aside-outline-after" /></template>
        <template #aside-ads-before><slot name="aside-ads-before" /></template>
        <template #aside-ads-after><slot name="aside-ads-after" /></template>
      </VPContent>
    </div>

    <VPFooter />
  </div>

  <Content v-else />
</template>
