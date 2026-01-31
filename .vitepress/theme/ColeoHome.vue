<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useData } from 'vitepress'

const { frontmatter } = useData()

const time = ref(0)
const brightness = ref(0.7)
const scrollY = ref(0)
const docHeight = ref(0)
const viewportHeight = ref(0)
const viewportWidth = ref(0)

const DISTORTION = 30
const SPARKLE_AMOUNT = 0.25
const SUN_ANGLE = 0.3

const raysCanvas = ref(null)
const sparklesCanvas = ref(null)
const displacementMap = ref(null)
const waterLayer = ref(null)
const depthSlider = ref(null)
const depthControl = ref(null)
const depthIcon = ref(null)

let rays = []
let sparkles = []
let raysInitialized = false
let sparklesInitialized = false
let animationId = null

class LightRay {
  constructor(index, total, vw, vh) {
    const section = vw / total
    this.x = (section * index) + (Math.random() - 0.5) * 40
    this.y = -150 - Math.random() * 200
    this.angle = SUN_ANGLE
    this.width = 100 + Math.random() * 100
    this.length = vh * 1.5
    this.speed = 0.1 + Math.random() * 0.2
    this.phase = Math.random() * Math.PI * 2
    this.opacity = 0.08 + Math.random() * 0.1
  }

  draw(ctx, time, brightness, vw, vh) {
    const sway = Math.sin(time * this.speed + this.phase) * 15
    const breathing = Math.sin(time * 0.4 + this.phase) * 0.5 + 0.5
    const alpha = this.opacity * (0.4 + brightness * 0.6) * breathing

    if (alpha < 0.01) return

    const startX = this.x + sway
    const endX = startX + Math.sin(this.angle) * this.length
    const endY = this.y + Math.cos(this.angle) * this.length

    const grad = ctx.createLinearGradient(startX, this.y, endX, endY)
    grad.addColorStop(0, `rgba(255, 255, 240, ${alpha})`)
    grad.addColorStop(0.4, `rgba(220, 255, 250, ${alpha * 0.6})`)
    grad.addColorStop(1, `rgba(150, 240, 255, 0)`)

    ctx.save()
    ctx.translate(startX, this.y)
    ctx.rotate(this.angle)

    ctx.beginPath()
    ctx.moveTo(-this.width/2, 0)
    ctx.lineTo(this.width/2, 0)
    ctx.lineTo(this.width/3, this.length)
    ctx.lineTo(-this.width/3, this.length)
    ctx.closePath()

    ctx.fillStyle = grad
    ctx.fill()
    ctx.restore()
  }
}

class Sparkle {
  constructor(initial = false, vw, vh, dh) {
    this.x = Math.random() * vw * 2
    if (initial && dh > 0) {
      this.y = Math.random() * dh
    } else {
      this.y = dh + 50
    }
    this.radius = 2 + Math.random() * 3
    this.speed = 0.5 + Math.random() * 1.0
    this.wobble = Math.random() * Math.PI * 2
    this.wobbleSpeed = 0.01 + Math.random() * 0.02
    this.phase = Math.random() * Math.PI * 2
    this.maxOpacity = 0.4 + Math.random() * 0.4
    this.vw = vw
    this.dh = dh
  }

  update(vw, dh) {
    this.y -= this.speed
    this.x += Math.sin(this.y * 0.005 + this.wobble) * 0.3
    this.wobble += this.wobbleSpeed

    if (this.y < -50) {
      this.y = dh + 50
      this.x = Math.random() * this.vw
    }
  }

  draw(ctx, time, scrollY, viewportH, vw, alphaMult) {
    if (this.y < scrollY - 100 || this.y > scrollY + viewportH + 100) return

    const twinkle = Math.sin(time * 2 + this.phase) * 0.5 + 0.5
    const alpha = this.maxOpacity * twinkle * SPARKLE_AMOUNT * alphaMult

    if (alpha < 0.01) return

    const gradient = ctx.createRadialGradient(
      this.x, this.y, 0,
      this.x, this.y, this.radius * 2
    )
    gradient.addColorStop(0, `rgba(255, 255, 230, ${alpha})`)
    gradient.addColorStop(0.5, `rgba(255, 255, 255, ${alpha * 0.8})`)
    gradient.addColorStop(1, `rgba(255, 255, 255, 0)`)

    ctx.beginPath()
    ctx.arc(this.x, this.y, this.radius * 2, 0, Math.PI * 2)
    ctx.fillStyle = gradient
    ctx.fill()

    ctx.beginPath()
    ctx.arc(this.x, this.y, this.radius * 0.6, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`
    ctx.fill()
  }
}

function initRays(vw, vh) {
  if (raysInitialized || vw === 0) return
  rays = []
  for (let i = 0; i < 8; i++) {
    rays.push(new LightRay(i, 8, vw, vh))
  }
  raysInitialized = true
}

function initSparkles(vw, vh, dh) {
  if (sparklesInitialized || dh === 0) return
  sparkles = []
  const count = Math.max(40, Math.floor(dh / 80))
  for (let i = 0; i < count; i++) {
    sparkles.push(new Sparkle(true, vw, vh, dh))
  }
  sparklesInitialized = true
}

function animate() {
  time.value += 0.016

  if (raysCanvas.value && raysCanvas.value.getContext) {
    const ctx = raysCanvas.value.getContext('2d')
    ctx.clearRect(0, 0, viewportWidth.value, viewportHeight.value)
    ctx.globalCompositeOperation = 'screen'
    if (raysInitialized) {
      rays.forEach((ray) => {
        ray.draw(ctx, time.value, brightness.value, viewportWidth.value, viewportHeight.value)
      })
    }
  }

  if (sparklesCanvas.value && sparklesCanvas.value.getContext) {
    const ctx = sparklesCanvas.value.getContext('2d')
    ctx.clearRect(0, 0, viewportWidth.value, viewportHeight.value)
    ctx.globalCompositeOperation = 'source-over'
    if (sparklesInitialized) {
      sparkles.forEach((sparkle) => {
        sparkle.update(viewportWidth.value, docHeight.value)
        sparkle.draw(ctx, time.value, scrollY.value, viewportHeight.value, viewportWidth.value, 1)
      })
    }
  }

  animationId = requestAnimationFrame(animate)
}

function updateDepth() {
  const value = parseInt(depthSlider.value)
  brightness.value = value / 100

  depthIcon.textContent = value > 50 ? '☀️' : '🌙'
  depthControl.classList.toggle('dark-mode', value <= 50)

  const bgBrightness = 0.5 + brightness.value * 0.5
  if (waterLayer.value) {
    waterLayer.value.style.filter = `url(#water-distortion) brightness(${bgBrightness})`
  }
}

function handleResize() {
  viewportWidth.value = window.innerWidth
  viewportHeight.value = window.innerHeight
  docHeight.value = document.documentElement.scrollHeight

  if (raysCanvas.value) {
    raysCanvas.value.width = viewportWidth.value
    raysCanvas.value.height = viewportHeight.value
  }
  if (sparklesCanvas.value) {
    sparklesCanvas.value.width = viewportWidth.value
    sparklesCanvas.value.height = docHeight.value
  }

  raysInitialized = false
  sparklesInitialized = false
  initRays(viewportWidth.value, viewportHeight.value)
  initSparkles(viewportWidth.value, viewportHeight.value, docHeight.value)
}

function handleScroll() {
  scrollY.value = window.scrollY
  const parallaxOffset = -scrollY.value * 0.2
  if (waterLayer.value) {
    waterLayer.value.style.transform = `translate3d(0, ${parallaxOffset}px, 0)`
  }
  if (raysCanvas.value) {
    raysCanvas.value.style.transform = `translate3d(0, ${parallaxOffset}px, 0)`
  }
}

onMounted(() => {
  handleResize()
  initRays(viewportWidth.value, viewportHeight.value)
  initSparkles(viewportWidth.value, viewportHeight.value, docHeight.value)

  window.addEventListener('resize', handleResize)
  window.addEventListener('scroll', handleScroll)

  if (displacementMap.value) {
    displacementMap.value.setAttribute('scale', DISTORTION)
  }

  depthSlider.addEventListener('input', updateDepth)
  animate()
  updateDepth()
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  window.removeEventListener('scroll', handleScroll)
  if (animationId) {
    cancelAnimationFrame(animationId)
  }
})
</script>

<template>
  <div class="coleo-home">
    <svg style="display: none;">
      <defs>
        <filter id="water-distortion" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.008 0.006"
            numOctaves="4"
            result="noise"
            seed="0">
            <animate
              attributeName="baseFrequency"
              dur="30s"
              values="0.008 0.006;0.015 0.01;0.008 0.006"
              repeatCount="indefinite"/>
          </feTurbulence>
          <feDisplacementMap
            ref="displacementMap"
            in="SourceGraphic"
            in2="noise"
            scale="30"
            xChannelSelector="R"
            yChannelSelector="G"/>
          <feGaussianBlur stdDeviation="0.4" result="blurred"/>
          <feComponentTransfer>
            <feFuncA type="linear" slope="0.9"/>
          </feComponentTransfer>
          <feBlend in="SourceGraphic" in2="blurred" mode="multiply"/>
        </filter>
      </defs>
    </svg>

    <div class="depth-control" ref="depthControl">
      <label>
        <span ref="depthIcon">☀️</span>
        <span>Depth</span>
      </label>
      <input type="range" ref="depthSlider" min="20" max="100" value="70">
    </div>

    <div class="water-layer" ref="waterLayer"></div>
    <canvas class="rays-layer" ref="raysCanvas"></canvas>
    <canvas class="sparkles-layer" ref="sparklesCanvas"></canvas>

    <div class="home-content">
      <nav class="navbar-custom">
        <div class="max-w-7xl mx-auto flex justify-between items-center">
          <div class="flex items-center gap-2 group">
            <div class="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-sm border border-white/30">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m0 0l-4-4m4 4l4-4M8 8a4 4 0 118 0 4 4 0 01-8 0z"></path>
              </svg>
            </div>
            <span class="font-display font-bold text-2xl text-white tracking-tight">Coleo</span>
          </div>

          <div class="hidden md:flex items-center space-x-8">
            <a href="#philosophy" class="text-sm font-medium text-white/90 hover:text-white transition-colors">Philosophy</a>
            <a href="#architecture" class="text-sm font-medium text-white/90 hover:text-white transition-colors">Architecture</a>
            <a href="#observatory" class="text-sm font-medium text-white/90 hover:text-white transition-colors">Observatory</a>
            <a href="#license" class="text-sm font-medium text-white/90 hover:text-white transition-colors">License</a>
          </div>
        </div>
      </nav>

      <section class="hero-section">
        <div class="container mx-auto px-4 sm:px-6 lg:px-8">
          <div class="lg:grid lg:grid-cols-2 lg:gap-16 items-center">
            <div class="mb-12 lg:mb-0">
              <h1 class="font-display font-bold text-5xl lg:text-7xl text-white leading-[0.9] tracking-tight mb-6 drop-shadow-lg">
                Many Arms.<br>
                <span class="text-white">One Mind.</span>
              </h1>
              <p class="text-xl text-white/90 mb-8 leading-relaxed max-w-lg drop-shadow-md">
                Distributed agent orchestration inspired by the soft architecture of intelligent cephalopods.
              </p>
              <div class="flex flex-col sm:flex-row gap-4">
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
              <p class="mt-4 text-xs text-white/70">
                Open Source under BSL 1.1 • Free for individual use
              </p>
            </div>

            <div class="relative">
              <div class="relative bg-white/10 backdrop-blur-md rounded-3xl shadow-2xl p-8 border border-white/20">
                <div class="absolute top-4 right-4 flex gap-2">
                  <div class="w-3 h-3 rounded-full bg-red-400/80"></div>
                  <div class="w-3 h-3 rounded-full bg-yellow-400/80"></div>
                  <div class="w-3 h-3 rounded-full bg-green-400/80"></div>
                </div>
                <div class="mt-4 font-mono text-xs sm:text-sm space-y-3 text-white/90">
                  <div class="flex items-center gap-2 text-white/60">$ coleo spawn --arms 3 --task "explore"</div>
                  <div class="space-y-2">
                    <div class="flex items-center gap-2">
                      <div class="w-2 h-2 rounded-full bg-accent animate-pulse"></div>
                      <span class="text-accent font-semibold">Brain</span>
                      <span class="text-white/60">→ Spawning Arms...</span>
                    </div>
                    <div class="pl-4 space-y-1 text-white/80">
                      <div class="flex justify-between"><span>🐙 Arm-One</span><span class="text-green-400">● Active</span></div>
                      <div class="flex justify-between"><span>🐙 Arm-Two</span><span class="text-green-400">● Active</span></div>
                      <div class="flex justify-between"><span>🐙 Arm-Three</span><span class="text-accent">● Proposing</span></div>
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
            <h2 class="font-display font-bold text-4xl mb-4">Soft Architecture</h2>
            <p class="text-lg opacity-80">
              Most agent frameworks rely on rigid control hierarchies or chaotic autonomy. Coleo occupies the evolutionary niche between: coordinated independence.
            </p>
          </div>

          <div class="grid md:grid-cols-3 gap-8">
            <div class="group p-8 rounded-2xl bg-white/50 hover:bg-white/80 transition-all duration-300 border border-current/10">
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

            <div class="group p-8 rounded-2xl bg-white/50 hover:bg-white/80 transition-all duration-300 border border-current/10">
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

            <div class="group p-8 rounded-2xl bg-white/50 hover:bg-white/80 transition-all duration-300 border border-current/10">
              <div class="w-12 h-12 bg-accent/10 rounded-xl flex items-center justify-center mb-6">
                <svg class="w-6 h-6 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
              </div>
              <h3 class="font-display font-bold text-xl mb-3">Safe Experimentation</h3>
              <p class="opacity-70 leading-relaxed">
                Each Arm operates within its own isolated Garden—an ephemeral environment where work happens safely.
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
                    <p class="opacity-70 leading-relaxed">Autonomous workers with specialized capabilities operating within their own context windows.</p>
                  </div>
                </div>

                <div class="flex gap-4">
                  <div class="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">🌿</div>
                  <div>
                    <h4 class="font-display font-bold text-xl mb-2">Gardens</h4>
                    <p class="opacity-70 leading-relaxed">Isolated execution contexts providing safe spaces to work without contamination.</p>
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
              <div class="bg-white/5 rounded-3xl p-8 border border-white/10">
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
            <div class="bg-white/60 p-6 rounded-xl shadow-sm border border-current/10">
              <div class="text-3xl font-bold text-accent mb-1">Real-time</div>
              <div class="text-sm opacity-70">WebSocket feeds show activity as it happens.</div>
            </div>
            <div class="bg-white/60 p-6 rounded-xl shadow-sm border border-current/10">
              <div class="text-3xl font-bold text-accent mb-1">Persistent</div>
              <div class="text-sm opacity-70">Activity history stored in SQLite or Postgres.</div>
            </div>
            <div class="bg-white/60 p-6 rounded-xl shadow-sm border border-current/10">
              <div class="text-3xl font-bold text-accent mb-1">Inspectable</div>
              <div class="text-sm opacity-70">Query past proposals and decisions.</div>
            </div>
            <div class="bg-white/60 p-6 rounded-xl shadow-sm border border-current/10">
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
                <div class="p-4 rounded-lg bg-white/60 border border-teal-200">
                  <div class="flex items-center justify-between mb-2">
                    <span class="font-semibold">🌿 Garden: auth-refactor</span>
                    <span class="text-xs bg-green-400 text-white px-2 py-1 rounded">Active</span>
                  </div>
                  <div class="text-sm opacity-70 font-mono">Arm: arm-7f3d9 • Files: 12 modified</div>
                </div>
                <div class="p-4 rounded-lg bg-white/60 border border-teal-200">
                  <div class="flex items-center justify-between mb-2">
                    <span class="font-semibold">🌿 Garden: test-coverage</span>
                    <span class="text-xs bg-green-400 text-white px-2 py-1 rounded">Active</span>
                  </div>
                  <div class="text-sm opacity-70 font-mono">Arm: arm-2a8b1 • Files: 8 modified</div>
                </div>
                <div class="p-4 rounded-lg bg-white/60 border border-teal-200">
                  <div class="flex items-center justify-between mb-2">
                    <span class="font-semibold">🌿 Garden: doc-updates</span>
                    <span class="text-xs bg-accent text-white px-2 py-1 rounded">Proposing</span>
                  </div>
                  <div class="text-sm opacity-70 font-mono">Arm: arm-9c4e2 • Proposal pending</div>
                </div>
              </div>
            </div>
            <div class="order-1 lg:order-2">
              <h2 class="font-display font-bold text-4xl mb-6">Ephemeral Gardens</h2>
              <p class="text-lg opacity-80 mb-6">
                Each Arm works in isolation. Like an octopus's arm—which can taste and feel independently—Gardens let Arms operate without stepping on each other's work.
              </p>
              <ul class="space-y-3 opacity-80">
                <li class="flex items-center gap-2">✓ Fully isolated file systems</li>
                <li class="flex items-center gap-2">✓ Independent tool access</li>
                <li class="flex items-center gap-2">✓ Snapshots and restoration points</li>
                <li class="flex items-center gap-2">✓ Automatic cleanup after merge</li>
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
            <div class="bg-white/10 p-8 rounded-2xl border border-white/10">
              <h3 class="font-display font-bold text-2xl mb-4">Individual Use</h3>
              <p class="opacity-70 mb-6">Free for individual developers. Install locally, use commercially, experiment freely.</p>
              <ul class="space-y-2 text-sm opacity-70 mb-6">
                <li>✓ Unlimited local deployment</li>
                <li>✓ All core features included</li>
                <li>✓ Commercial use permitted</li>
              </ul>
              <a href="#" class="block w-full py-3 bg-accent text-white rounded-full font-semibold hover:opacity-90 transition-all text-center no-underline">
                Download
              </a>
            </div>

            <div class="bg-black/20 p-8 rounded-2xl border border-white/10">
              <h3 class="font-display font-bold text-2xl mb-4">Organizational Use</h3>
              <p class="opacity-70 mb-6">For teams and companies. Contact us for commercial licensing options.</p>
              <ul class="space-y-2 text-sm opacity-70 mb-6">
                <li>✓ Multi-seat coordination</li>
                <li>✓ Custom deployment support</li>
                <li>✓ Training and consultation</li>
              </ul>
              <a href="#" class="block w-full py-3 bg-white text-teal-900 rounded-full font-semibold hover:bg-gray-100 transition-all text-center no-underline">
                Contact for Licensing
              </a>
            </div>
          </div>

          <div class="bg-white/10 p-6 rounded-xl border border-white/10 text-center max-w-2xl mx-auto">
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
  </div>
</template>
