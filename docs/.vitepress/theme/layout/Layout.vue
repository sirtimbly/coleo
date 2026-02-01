<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import { useRoute, Content } from 'vitepress'

const route = useRoute()
const { Layout: DefaultLayout } = DefaultTheme
</script>

<template>
  <!-- Use a minimal layout for the homepage to match marketing visuals -->
  <div v-if="route.path === '/'" class="marketing-root">
    <Content />
  </div>
  <DefaultLayout v-else />
  
</template>

