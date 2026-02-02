<script setup lang="ts">
// Simple shared navbar used on both home and inner pages
</script>

<template>
  <nav class="navbar-custom">
    <div class="container flex justify-between items-center">
      <div class="flex items-center gap-2 group">
        <img src="/coleo-logo.png" alt="Coleo Logo" class="brand-logo block" />
        <span class="brand-title font-display font-bold text-2xl tracking-tight">Coleo</span>
      </div>
      <div class="hidden md:flex items-center space-x-8">
        <a href="/philosophy" class="nav-link text-sm font-medium transition-colors">Philosophy</a>
        <a href="/architecture/overview" class="nav-link text-sm font-medium transition-colors">Architecture</a>
        <a href="/architecture/components#observatory-web-ui-api" class="nav-link text-sm font-medium transition-colors">Observatory</a>
        <a href="/licensing" class="nav-link text-sm font-medium transition-colors">License</a>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.container { max-width: 80rem; margin: 0 auto; width: 100%; }
</style>
