import { ref, onMounted, onUnmounted } from 'vue'

const time = ref(0)
const brightness = ref(0.7)
const scrollY = ref(0)
const docHeight = ref(0)
const viewportHeight = ref(0)
const viewportWidth = ref(0)

const DISTORTION = 30
const SPARKLE_AMOUNT = 0.25
const SUN_ANGLE = 0.3

let raysCanvas = null
let sparklesCanvas = null
let displacementMap = null
let waterLayer = null
let depthSlider = null
let depthControl = null
let depthIcon = null

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

  if (raysCanvas && raysCanvas.getContext) {
    const ctx = raysCanvas.getContext('2d')
    ctx.clearRect(0, 0, viewportWidth.value, viewportHeight.value)
    ctx.globalCompositeOperation = 'screen'
    if (raysInitialized) {
      rays.forEach((ray) => {
        ray.draw(ctx, time.value, brightness.value, viewportWidth.value, viewportHeight.value)
      })
    }
  }

  if (sparklesCanvas && sparklesCanvas.getContext) {
    const ctx = sparklesCanvas.getContext('2d')
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
  if (waterLayer) {
    waterLayer.style.filter = `url(#water-distortion) brightness(${bgBrightness})`
  }
}

function handleResize() {
  viewportWidth.value = window.innerWidth
  viewportHeight.value = window.innerHeight
  docHeight.value = document.documentElement.scrollHeight

  if (raysCanvas) {
    raysCanvas.width = viewportWidth.value
    raysCanvas.height = viewportHeight.value
  }
  if (sparklesCanvas) {
    sparklesCanvas.width = viewportWidth.value
    sparklesCanvas.height = docHeight.value
  }

  raysInitialized = false
  sparklesInitialized = false
  initRays(viewportWidth.value, viewportHeight.value)
  initSparkles(viewportWidth.value, viewportHeight.value, docHeight.value)
}

function handleScroll() {
  scrollY.value = window.scrollY
  const parallaxOffset = -scrollY.value * 0.2
  if (waterLayer) {
    waterLayer.style.transform = `translate3d(0, ${parallaxOffset}px, 0)`
  }
  if (raysCanvas) {
    raysCanvas.style.transform = `translate3d(0, ${parallaxOffset}px, 0)`
  }
}

export function initColeoAnimation() {
  raysCanvas = document.getElementById('raysCanvas')
  sparklesCanvas = document.getElementById('sparklesCanvas')
  displacementMap = document.querySelector('#water-distortion feDisplacementMap')
  waterLayer = document.getElementById('waterLayer')
  depthSlider = document.getElementById('depthSlider')
  depthControl = document.getElementById('depthControl')
  depthIcon = document.getElementById('depthIcon')

  handleResize()
  initRays(viewportWidth.value, viewportHeight.value)
  initSparkles(viewportWidth.value, viewportHeight.value, docHeight.value)

  window.addEventListener('resize', handleResize)
  window.addEventListener('scroll', handleScroll)

  if (displacementMap) {
    displacementMap.setAttribute('scale', DISTORTION)
  }

  depthSlider.addEventListener('input', updateDepth)
  animate()
  updateDepth()
}

export function destroyColeoAnimation() {
  window.removeEventListener('resize', handleResize)
  window.removeEventListener('scroll', handleScroll)
  if (animationId) {
    cancelAnimationFrame(animationId)
  }
}
