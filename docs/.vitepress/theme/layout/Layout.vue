<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import { useRoute, Content } from 'vitepress'
import { computed, watchEffect } from 'vue'

const route = useRoute()
const { Layout: DefaultLayout } = DefaultTheme
const isHome = computed(() => {
  // Prefer source-relative path when available
  // Fallback to tolerant path checks
  const rel = (route.data && route.data.relativePath) || ''
  if (rel === 'index.md') return true
  const p = route.path || ''
  return p === '/' || p.endsWith('/index.html') || p === ''
})

watchEffect(() => {
  // Debug route detection for homepage layout
  // Note: this logs on route changes and dev HMR updates
  // eslint-disable-next-line no-console
  console.log('[layout]', { path: route.path, rel: route.data?.relativePath, isHome: isHome.value })
})
</script>

<template>
  <!-- Use a minimal layout for the homepage to match marketing visuals -->
  <div v-if="isHome" class="marketing-root">
    <Content />
  </div>
  <DefaultLayout v-else />
  
</template>
