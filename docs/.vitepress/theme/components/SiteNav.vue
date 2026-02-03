<script setup lang="ts">
// Simple shared navbar used on inner pages.
defineEmits<{
	(e: "open-menu"): void;
}>();
</script>

<template>
  <nav class="navbar-custom">
    <div class="container flex justify-between items-center">
      <a href="/" class="flex items-center gap-2 group">

        <img src="/coleo-logo.png" alt="Coleo Logo" class="brand-logo block" />
        <span class="brand-title font-display font-bold text-2xl tracking-tight">Coleo</span>

      </a>
      <div class="hidden md:flex items-center space-x-8">
        <a href="/guides/getting-started" class="nav-link text-sm font-medium transition-colors">Get Started</a>
        <a href="/philosophy" class="nav-link text-sm font-medium transition-colors">Philosophy</a>
        <a href="/architecture/overview" class="nav-link text-sm font-medium transition-colors">Architecture</a>
        <a href="/licensing" class="nav-link text-sm font-medium transition-colors">License</a>
      </div>
      <button
        type="button"
        class="md:hidden nav-link text-sm font-semibold transition-colors"
        aria-label="Open sidebar navigation"
        @click="$emit('open-menu')"
      >
        Menu
      </button>
    </div>
  </nav>
</template>

<style scoped>
.container { max-width: 80rem; margin: 0 auto; width: 100%; }
</style>
