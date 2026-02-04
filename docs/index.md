---
layout: page
sidebar: false
aside: false
outline: false
lastUpdated: false
title: Coleo — Multi-Agent Development Coordination
---

<script setup>
</script>

<div class="depth-control" id="depthControl">
  <label>
    <span id="depthIcon">☀️</span>
  </label>
  <input type="range" id="depthSlider" min="0" max="100" value="70">
</div>

<div class="water-layer" id="waterLayer"></div>
<canvas class="rays-layer" id="raysCanvas"></canvas>
<canvas class="sparkles-layer" id="sparklesCanvas"></canvas>

<div class="home-content">
  <nav class="navbar-custom">
    <div class="container flex justify-between items-center">
      <div class="flex items-center gap-2 group">
        <img src="/coleo-logo.png" alt="Coleo Logo" class="brand-logo block" />
        <span class="brand-title font-display font-bold text-2xl tracking-tight">Coleo</span>
      </div>
      <div class="hidden md:flex items-center space-x-8">
        <a href="/guides/getting-started" class="nav-link text-sm font-medium transition-colors">Getting Started</a>
        <a href="/philosophy" class="nav-link text-sm font-medium transition-colors">Philosophy</a>
        <a href="/architecture/overview" class="nav-link text-sm font-medium transition-colors">Architecture</a>
        <a href="/licensing" class="nav-link text-sm font-medium transition-colors">License</a>
      </div>
    </div>
  </nav>

  <section class="hero-section">
    <div class="container mx-auto px-4 sm:px-6 lg:px-8">
      <div class="lg:grid lg:grid-cols-2 lg:gap-16 items-center">
        <div class="mb-12 lg:mb-0">
          <h1 class="hero-title font-display font-bold text-white tracking-tight mb-6 drop-shadow-lg">
            Many Arms.<br>
            <span class="text-white">One Mind.</span>
          </h1>
          <p class="text-xl text-white/90 mb-8 leading-relaxed max-w-lg drop-shadow-md">
            An experimental coordination layer that turns your favorite models into a team: many agents, one brain, visible work.
          </p>
          <div class="flex flex-col sm:flex-row gap-4 mt-6 mb-4">
            <a href="/architecture/overview" class="bg-accent text-white px-8 py-4 rounded-full text-sm font-semibold transition-all duration-300 shadow-lg flex items-center justify-center gap-2 text-center no-underline">
              <span>Explore the Architecture</span>
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"></path>
              </svg>
            </a>
            <a href="https://github.com" class="border-2 border-white/50 hover:border-white text-white px-8 py-4 rounded-full text-sm font-semibold transition-all duration-300 flex items-center justify-center gap-2 backdrop-blur-sm text-center no-underline">
              <span>View on GitHub</span>
            </a>
          </div>
          <p class="mt-4 text-xs text-white/70">Open Source under BSL 1.1 • Free for individual use</p>
        </div>
        <div class="relative">
          <div class="relative ui-box backdrop-blur-md rounded-3xl shadow-2xl p-8">
            <div class="absolute top-4 right-4 flex gap-2">
              <div class="w-3 h-3 rounded-full bg-red-400/80"></div>
              <div class="w-3 h-3 rounded-full bg-yellow-400/80"></div>
              <div class="w-3 h-3 rounded-full bg-green-400/80"></div>
            </div>
            <div class="mt-4 font-mono text-xs sm:text-sm space-y-3 opacity-90">
              <div class="flex items-center gap-2 ">$ coleo arm spawn</div>
              <div class="space-y-2">
                <div class="flex items-center gap-2">
                  <div class="w-2 h-2 rounded-full bg-accent animate-pulse"></div>
                  <span class="text-accent font-semibold">Brain</span>
                  <span class="">→ Spawning Arms...</span>
                </div>
                <div class="pl-4 space-y-1 opacity-80">
                  <div class="flex justify-between"><span>🐙 Ixis</span><span class="text-green-400">● Active</span></div>
                  <div class="flex justify-between"><span>🐙 Argoaia-Zero</span><span class="text-green-400">● Active</span></div>
                  <div class="flex justify-between"><span>🐙 Viola</span><span class="text-accent">● Stuck</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section id="philosophy" class="section-glass light-1">
    <div class="container">
      <div class="text-center max-w-3xl mx-auto mb-16">
        <h2 class="font-display font-bold text-xl mb-4">Soft Architecture</h2>
        <p class="text-lg opacity-80">
          Most agent frameworks rely on rigid control hierarchies or chaotic autonomy. Coleo occupies the evolutionary niche between: coordinated independence.
        </p>
      </div>
      <div class="grid md:grid-cols-3 gap-8">
        <div class="group ui-box p-8 rounded-2xl transition-all duration-300">
          <div class="w-12 h-12 bg-accent/10 rounded-xl flex items-center justify-center mb-6">
            <svg class="w-6 h-6 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
            </svg>
          </div>
          <h3 class="font-display font-bold text-xl mb-3">Decentralized Intelligence</h3>
          <p class="opacity-70 leading-relaxed">
            Two-thirds of an octopus's neurons are in its arms, not its head. Coleo Arms possess their own memory, tools, and decision capacity.
          </p>
        </div>
        <div class="group ui-box p-8 rounded-2xl transition-all duration-300">
          <div class="w-12 h-12 bg-accent/10 rounded-xl flex items-center justify-center mb-6">
            <svg class="w-6 h-6 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z"></path>
            </svg>
          </div>
          <h3 class="font-display font-bold text-xl mb-3">Governance Through Persuasion</h3>
          <p class="opacity-70 leading-relaxed">
            The Brain does not command—it evaluates. Arms submit structured proposals with reasoning and wait for approval.
          </p>
        </div>
        <div class="group ui-box p-8 rounded-2xl transition-all duration-300">
          <div class="w-12 h-12 bg-accent/10 rounded-xl flex items-center justify-center mb-6">
            <svg class="w-6 h-6 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
          </div>
          <h3 class="font-display font-bold text-xl mb-3">Safe Experimentation</h3>
          <p class="opacity-70 leading-relaxed">
            Coleo is coordination, not blind autonomy: claims, activity, and proposals make multi-agent work inspectable and interruptible.
          </p>
        </div>
      </div>
    </div>
  </section>

  <section id="architecture" class="section-glass dark-1">
    <div class="container">
      <div class="lg:grid lg:grid-cols-2 gap-16 items-center">
        <div>
          <h2 class="font-display font-bold text-4xl mb-6">The Architecture</h2>
          <div class="space-y-8">
            <div class="flex gap-4">
              <div class="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">🧠</div>
              <div>
                <h4 class="font-display font-bold text-xl mb-2">The Brain</h4>
                <p class="opacity-70 leading-relaxed">The central coordination point maintaining architectural standards and evaluating proposals.</p>
              </div>
            </div>
            <div class="flex gap-4">
              <div class="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">🐙</div>
              <div>
                <h4 class="font-display font-bold text-xl mb-2">Arms</h4>
                <p class="opacity-70 leading-relaxed">General-purpose agents run through harnesses (headless API or a visible terminal), coordinated by the Brain.</p>
              </div>
            </div>
            <div class="flex gap-4">
              <div class="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">🌿</div>
              <div>
                <h4 class="font-display font-bold text-xl mb-2">Gardens</h4>
                <p class="opacity-70 leading-relaxed">A living map of the workspace: file claims, activity, and conflict zones that help arms avoid collisions.</p>
              </div>
            </div>
            <div class="flex gap-4">
              <div class="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">📡</div>
              <div>
                <h4 class="font-display font-bold text-xl mb-2">The Observatory</h4>
                <p class="opacity-70 leading-relaxed">The monitoring interface tracking activity across all Arms and Gardens.</p>
              </div>
            </div>
          </div>
        </div>
        <div>
          <div class="ui-box rounded-3xl p-8">
            <h3 class="font-display font-bold text-2xl mb-6 text-center">How Coordination Works</h3>
            <div class="space-y-6">
              <div class="flex items-start gap-4">
                <div class="w-8 h-8 rounded-full bg-accent flex items-center justify-center flex-shrink-0 text-sm font-bold">1</div>
                <div>
                  <h5 class="font-semibold mb-1">Spawn</h5>
                  <p class="text-sm opacity-60">The Brain instantiates Arms and assigns them to Gardens.</p>
                </div>
              </div>
              <div class="flex items-start gap-4">
                <div class="w-8 h-8 rounded-full bg-accent flex items-center justify-center flex-shrink-0 text-sm font-bold">2</div>
                <div>
                  <h5 class="font-semibold mb-1">Execute</h5>
                  <p class="text-sm opacity-60">Arms work independently within their Gardens.</p>
                </div>
              </div>
              <div class="flex items-start gap-4">
                <div class="w-8 h-8 rounded-full bg-accent flex items-center justify-center flex-shrink-0 text-sm font-bold">3</div>
                <div>
                  <h5 class="font-semibold mb-1">Propose</h5>
                  <p class="text-sm opacity-60">Arms submit structured proposals to the Brain.</p>
                </div>
              </div>
              <div class="flex items-start gap-4">
                <div class="w-8 h-8 rounded-full bg-accent flex items-center justify-center flex-shrink-0 text-sm font-bold">4</div>
                <div>
                  <h5 class="font-semibold mb-1">Integrate</h5>
                  <p class="text-sm opacity-60">The Brain evaluates and approves or requests revisions.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section id="observatory" class="section-glass light-2">
    <div class="container">
      <div class="text-center max-w-3xl mx-auto mb-16">
        <h2 class="font-display font-bold text-4xl mb-4">Observe the Distributed Mind</h2>
        <p class="text-lg opacity-80">
          Unlike opaque AI tools, Coleo's Observatory makes visible the normally hidden activity of distributed agent coordination.
        </p>
      </div>
      <div class="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div class="ui-box p-6 rounded-xl shadow-sm">
          <div class="text-3xl font-bold text-accent mb-1">Real-time</div>
          <div class="text-sm opacity-70">WebSocket feeds show activity as it happens.</div>
        </div>
        <div class="ui-box p-6 rounded-xl shadow-sm">
          <div class="text-3xl font-bold text-accent mb-1">Persistent</div>
          <div class="text-sm opacity-70">Activity history stored in SQLite or Postgres.</div>
        </div>
        <div class="ui-box p-6 rounded-xl shadow-sm">
          <div class="text-3xl font-bold text-accent mb-1">Inspectable</div>
          <div class="text-sm opacity-70">Query past proposals and decisions.</div>
        </div>
        <div class="ui-box p-6 rounded-xl shadow-sm">
          <div class="text-3xl font-bold text-accent mb-1">Transparent</div>
          <div class="text-sm opacity-70">See not just what changed, but why.</div>
        </div>
      </div>
    </div>
  </section>

  <section class="section-glass dark-2">
    <div class="container">
      <div class="text-center max-w-3xl mx-auto mb-16">
        <h2 class="font-display font-bold text-4xl mb-4">Proposals Not Commands</h2>
        <p class="text-lg opacity-80">
          Traditional orchestration dictates. Coleo converses. Each interaction is a proposal that can be accepted, rejected, or debated.
        </p>
      </div>
      <div class="grid md:grid-cols-3 gap-8">
        <div class="text-center p-6">
          <div class="w-20 h-20 mx-auto mb-4 rounded-full bg-accent/20 flex items-center justify-center text-3xl">📨</div>
          <h3 class="font-display font-bold text-xl mb-2">Structured Messages</h3>
          <p class="opacity-70">Arms communicate through typed proposals with reasoning, not raw diffs.</p>
        </div>
        <div class="text-center p-6">
          <div class="w-20 h-20 mx-auto mb-4 rounded-full bg-accent/20 flex items-center justify-center text-3xl">⚖️</div>
          <h3 class="font-display font-bold text-xl mb-2">Weighted Consensus</h3>
          <p class="opacity-70">Reputation systems and voting mechanisms resolve conflicts.</p>
        </div>
        <div class="text-center p-6">
          <div class="w-20 h-20 mx-auto mb-4 rounded-full bg-accent/20 flex items-center justify-center text-3xl">🔍</div>
          <h3 class="font-display font-bold text-xl mb-2">Human Override</h3>
          <p class="opacity-70">The Brain can intervene at any point—this is coordination, not autonomy.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section-glass light-3">
    <div class="container">
      <div class="lg:grid lg:grid-cols-2 gap-16 items-center">
        <div class="order-2 lg:order-1">
          <div class="space-y-4">
            <div class="ui-box p-4 rounded-lg">
              <div class="flex items-center justify-between mb-2">
                <span class="font-semibold">🌿 Garden: auth-refactor</span>
                <span class="text-xs bg-green-400 text-white px-2 py-1 rounded">Active</span>
              </div>
              <div class="text-sm opacity-70 font-mono">Arm: Ixis • Files: 12 modified</div>
            </div>
            <div class="ui-box p-4 rounded-lg">
              <div class="flex items-center justify-between mb-2">
                <span class="font-semibold">🌿 Garden: ui-redesign</span>
                <span class="text-xs bg-green-400 text-white px-2 py-1 rounded">Active</span>
              </div>
              <div class="text-sm opacity-70 font-mono">Arm: Argoaia-Zero • Files: 8 modified</div>
              <div class="text-sm opacity-70 font-mono">Arm: Verox • Files: 2 modified</div>
            </div>
            <div class="ui-box p-4 rounded-lg">
              <div class="flex items-center justify-between mb-2">
                <span class="font-semibold">🌿 Garden: test-coverage</span>
                <span class="text-xs bg-accent text-white px-2 py-1 rounded">Debating</span>
              </div>
              <div class="text-sm opacity-70 font-mono">Arm: Viola • Files: 3 modified</div>
              <div class="text-sm opacity-70 font-mono">Arm: Pom Pom • Proposal pending</div>
            </div>
          </div>
        </div>
        <div class="order-1 lg:order-2">
          <h2 class="font-display font-bold text-4xl mb-6">Living Gardens</h2>
          <p class="text-lg opacity-80 mb-6">
            A Garden is your workspace made visible: who is touching what, what they claim, and where conflicts are forming.
          </p>
          <ul class="space-y-3 opacity-80">
            <li class="flex items-center gap-2">✓ File claims (read/write/exclusive) and ownership markers</li>
            <li class="flex items-center gap-2">✓ Activity trail: who touched what, when</li>
            <li class="flex items-center gap-2">✓ Conflict zones when multiple arms overlap</li>
            <li class="flex items-center gap-2">✓ Topology view for coordination in the Observatory</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section id="license" class="section-glass dark-3">
    <div class="container">
      <div class="text-center mb-16">
        <h2 class="font-display font-bold text-4xl mb-4">Licensing</h2>
        <p class="text-lg opacity-80">
          Released under Business Source License 1.1—balancing sustainable development with individual access.
        </p>
      </div>
      <div class="grid md:grid-cols-2 gap-8 mb-12 max-w-4xl mx-auto">
        <div class="ui-box p-8 rounded-2xl">
          <h3 class="font-display font-bold text-2xl mb-4">Individual Use</h3>
          <p class="opacity-70 mb-6">Free for individual developers. Install locally, use commercially, experiment freely.</p>
          <ul class="space-y-2 text-sm opacity-70 mb-6">
            <li>✓ Unlimited local deployment</li>
            <li>✓ All core features included</li>
            <li>✓ Commercial use permitted</li>
          </ul>
          <a href="#" class="block w-full py-3 bg-accent text-white rounded-full font-semibold hover:opacity-90 transition-all text-center no-underline mt-4">Download</a>
        </div>
        <div class="ui-box p-8 rounded-2xl">
          <h3 class="font-display font-bold text-2xl mb-4">Organizational Use</h3>
          <p class="opacity-70 mb-6">For teams and companies. Contact us for commercial licensing options.</p>
          <ul class="space-y-2 text-sm opacity-70 mb-6">
            <li>✓ Multi-seat coordination</li>
            <li>✓ Custom deployment support</li>
            <li>✓ Training and consultation</li>
          </ul>
          <a href="#" class="block w-full py-3 rounded-full font-semibold transition-all text-center no-underline bg-white/20 text-white border border-white/30 hover:bg-white/30 mt-4">Contact for Licensing</a>
        </div>
      </div>
      <div class="ui-box p-6 rounded-xl text-center max-w-2xl mx-auto">
        <p class="text-sm opacity-80">
          <strong class="text-accent">Business Source License 1.1 (BSL)</strong><br>
          Becomes Apache 2.0 on the Change Date (four years after release).
        </p>
      </div>
    </div>
  </section>

  <footer class="py-12 px-4 relative z-10">
    <div class="max-w-7xl mx-auto">
      <div class="flex flex-col md:flex-row justify-between items-center gap-4 text-white/60">
        <p class="text-sm">© 2025 Coleo. All rights reserved.</p>
        <div class="flex gap-6 text-sm">
          <a href="#" class="hover:text-white transition-colors no-underline">Privacy</a>
          <a href="#" class="hover:text-white transition-colors no-underline">Terms</a>
          <a href="#" class="hover:text-white transition-colors no-underline">License</a>
        </div>
      </div>
    </div>
  </footer>
</div>
