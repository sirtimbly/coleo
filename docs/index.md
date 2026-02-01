---
layout: page
sidebar: false
aside: false
outline: false
lastUpdated: false
title: Coleo — Multi-Agent Development Coordination
---

<script setup>
import { ref, onMounted } from 'vue'

const time = ref(0)
const brightness = ref(0.7)
const scrollY = ref(0)
const docHeight = ref(0)
const viewportHeight = ref(0)
const viewportWidth = ref(0)

const SPARKLE_COUNT = 40
const MAX_SPARKLES = 160

let raysCanvas, sparklesCanvas, waterLayer, depthSlider, depthControl, depthIcon
let rays = []
let sparkles = []
let animationId = null
const mouse = ref({ x: 0, y: 0, active: false })
let nextCursorSparkleAt = 0
let swirls = []
let streaks = []
const ENABLE_BURST = true // toggle big burst on direction change while refining
const MAX_STREAK_SPEED = 300 // px/s clamp for streak motion
const STREAK_DRAG_COEFF = 0.02 // quadratic drag dv/dt = -k v^2 (px units)
const STREAK_FREQ_MIN = 12  // Hz at threshold speed
const STREAK_FREQ_MAX = 40 // Hz at 500 px/s
let mouseHistory = [] // { x, y, t }
let lastDirAngle = 0
let eddy = null // { cx, cy, vx, vy, created, prevTime, side }
let eddySide = 1
let lastEddySpawnAt = 0
let lastContinuousSpawnAt = 0
let nextContinuousSpawnAt = 0
let newDirectionCooldownUntil = 0
let mass = { x: 0, y: 0, vx: 0, vy: 0 }
let prevFrameNow = 0
let lastMoving = null // snapshot of last reliable motion (x,y,angle,speed,t)

function randomCursorSpawnInterval() {
  // ~3–9 per second → 100–333ms
  return 100 + Math.random() * (333 - 100)
}

function getMouseDirectionAngle(nowTs = performance.now()) {
  const windowMs = 500
  const cutoff = nowTs - windowMs
  const pts = mouseHistory.filter(p => p.t >= cutoff)
  if (pts.length < 2) return lastDirAngle
  let dx = 0, dy = 0
  for (let i = 1; i < pts.length; i++) {
    dx += pts[i].x - pts[i - 1].x
    dy += pts[i].y - pts[i - 1].y
  }
  if (Math.hypot(dx, dy) < 1) return lastDirAngle
  lastDirAngle = Math.atan2(dy, dx)
  return lastDirAngle
}

function getMouseAngleOver(windowMs, nowTs = performance.now()) {
  const cutoff = nowTs - windowMs
  const pts = mouseHistory.filter(p => p.t >= cutoff)
  if (pts.length < 2) return null
  let dx = 0, dy = 0
  for (let i = 1; i < pts.length; i++) {
    dx += pts[i].x - pts[i - 1].x
    dy += pts[i].y - pts[i - 1].y
  }
  if (Math.hypot(dx, dy) < 1e-2) return null
  return Math.atan2(dy, dx)
}

function getMouseSpeedOver(windowMs, nowTs = performance.now()) {
  const cutoff = nowTs - windowMs
  const pts = mouseHistory.filter(p => p.t >= cutoff)
  if (pts.length < 2) return 0
  let dist = 0
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x
    const dy = pts[i].y - pts[i - 1].y
    dist += Math.hypot(dx, dy)
  }
  const dt = (pts[pts.length - 1].t - pts[0].t) / 1000
  if (dt <= 0) return 0
  return dist / dt // px/s
}

function angleDiff(a, b) {
  let d = a - b
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return Math.abs(d)
}

function maybeSpawnEddyOnTurn(nowTs = performance.now()) {
  // Trigger when direction change over last 200ms exceeds ~50 degrees
  const newAngle = getMouseAngleOver(300, nowTs)
  if (newAngle == null) return
  const prevAngle = maybeSpawnEddyOnTurn.prevAngle
  if (!prevAngle) {
    maybeSpawnEddyOnTurn.prevAngle = newAngle
    maybeSpawnEddyOnTurn.prevSpeed = getMouseSpeedOver(200, nowTs)
    return
  }
  const delta = ((newAngle - prevAngle + Math.PI) % (2 * Math.PI)) - Math.PI
  maybeSpawnEddyOnTurn.prevAngle = newAngle
  const threshold = (40 * Math.PI) / 180
  const speedNow = getMouseSpeedOver(64, nowTs)
  const speedPrev = maybeSpawnEddyOnTurn.prevSpeed ?? speedNow
  maybeSpawnEddyOnTurn.prevSpeed = speedNow
  const bigTurn = Math.abs(delta) >= threshold && speedPrev > 120
  const bigSlowdown = speedPrev > 120 && speedNow < 40
  if (!bigTurn && !bigSlowdown) return
  // Cooldown to avoid spamming
  if (nowTs - lastEddySpawnAt < 250) return
  lastEddySpawnAt = nowTs
  // Determine side from sign of turn (CCW positive => left)
  eddySide = delta > 0 ? 1 : -1
  // Use last moving snapshot as eddy center and previous direction
  const sample = lastMoving
  if (!sample) return
  let speed = Math.max(80, Math.min(sample.speed, 600))
  if (ENABLE_BURST) {
    const vmag = speed
    const straightDist = 60 + Math.random() * 40
    spawnSwirlsAt(sample.x, sample.y, sample.angle, vmag, eddySide, 12, { straightDist })
  }
  newDirectionCooldownUntil = nowTs + 500
}

function spawnSparkleAt(sx, sy, opts = {}) {
  sparkles.push({
    x: Math.max(0, Math.min(viewportWidth.value, sx)),
    y: Math.max(-50, Math.min(docHeight.value + 50, sy)),
    radius: opts.radius ?? (1.5 + Math.random() * 2.5),
    speed: opts.speed ?? (0.5 + Math.random() * 1.0),
    wobble: Math.random() * Math.PI * 2,
    wobbleSpeed: 0.01 + Math.random() * 0.02,
    phase: Math.random() * Math.PI * 2,
    maxOpacity: opts.maxOpacity ?? (0.5 + Math.random() * 0.4),
    fromCursor: !!opts.fromCursor
  })
  if (sparkles.length > MAX_SPARKLES) {
    sparkles.splice(0, sparkles.length - MAX_SPARKLES)
  }
}

function spawnCursorSparkle() {
  const jitter = () => (Math.random() - 0.5) * 100 // ±50px
  const sx = mouse.value.x + jitter()
  const sy = scrollY.value + mouse.value.y + jitter()
  spawnSparkleAt(sx, sy, { fromCursor: true })
}

function spawnSwirlsAt(centerX, centerY, dirAngle, initSpeed, side, countOverride, opts = {}) {
  const created = performance.now()
  const lifetime = 1400 + Math.random() * 1200
  const count = countOverride ?? 3
  const baseAngle = dirAngle  ?? getMouseDirectionAngle(created)
  const cone = 0.35
  for (let i = 0; i < count; i++) {
    const curlSide = side ?? eddySide
    const jitter = (Math.random() - 0.5) * cone
    const angle = baseAngle + curlSide * 0.18 + jitter * 0.3
    const angVel = (1.6 + Math.random() * 1.6) * curlSide
    const radVel = 0
    // pick a point along the recent path within ~60px behind the center
    const back = Math.random() * 60
    const pathX = centerX - Math.cos(baseAngle) * back
    const pathY = centerY - Math.sin(baseAngle) * back
    // perpendicular offset within 20px on chosen side
    const perp = baseAngle + Math.PI / 2
    const offMag = Math.random() * 20
    const offX = Math.cos(perp) * offMag * curlSide
    const offY = Math.sin(perp) * offMag * curlSide
    const ox = pathX + offX
    const oy = pathY + offY
    const targetRad = 18 + Math.random() * 4
    swirls.push({
      created,
      lifetime,
      cx: centerX,
      cy: centerY,
      cVx: Math.cos(baseAngle) * (initSpeed ?? 200),
      cVy: Math.sin(baseAngle) * (initSpeed ?? 200),
      baseAngle,
      angle,
      angVel,
      rad: targetRad,
      radVel,
      width: 1.5 + Math.random() * 2.5,
      hue: 190 + Math.random() * 20,
      curlStrength: 0.35 + Math.random() * 0.35,
      oscSpeed: 2 + Math.random() * 3,
      oscPhase: Math.random() * Math.PI * 2,
      maxRad: targetRad + 6,
      targetRad,
      // straight phase before curl (distance-based, used for burst)
      forwardTarget: opts.straightDist ?? 0,
      forwardSpeed: initSpeed ?? 200,
      forwardDist: 0,
      straightX: centerX,
      straightY: centerY,
      turned: false,
      turnedAt: 0,
      baseOmega: 0,
      swirlBurstMs: 800,
      dir: curlSide,
      trail: [{ x: ox, y: oy, t: 0 }],
      prevTime: created
    })
  }
}

function spawnStreak(x, y, angle, speed) {
  const now = performance.now()
  // Lifetime directly correlated to speed: 250ms @120 px/s → 900ms @500 px/s (clamped)
  const minV = 120, maxV = 500
  const v = Math.min(maxV, Math.max(minV, speed))
  const t = (v - minV) / (maxV - minV)
  const lifetime = 250 + t * (900 - 250)
  streaks.push({ x, y, px: x, py: y, angle, speed, created: now, lifetime })
}

function spawnBurstAt(cx, cy) {
  // Bubble burst: 10–18 sparkles with slightly larger radius
  const bubbles = 10 + Math.floor(Math.random() * 9)
  for (let i = 0; i < bubbles; i++) {
    const jitter = () => (Math.random() - 0.5) * 120
    spawnSparkleAt(cx + jitter(), cy + jitter(), {
      radius: 2.5 + Math.random() * 3.5,
      speed: 0.6 + Math.random() * 1.0,
      maxOpacity: 0.6 + Math.random() * 0.4,
      fromCursor: true
    })
  }
  // Swirl lines emanating from the click (will orbit a moving eddy)
  // Initialize a single eddy center that moves forward and eases out
  const dir = getMouseDirectionAngle(performance.now())
  const centerSpeed = 200 + Math.random() * 80 // px/s initial
  // Choose curl side once: -1 (left) or +1 (right) of the motion vector
  eddySide = Math.random() < 0.5 ? -1 : 1
  // Offset the eddy center perpendicular to motion so orbits stay on one side
  const perp = dir + eddySide * (Math.PI / 2)
  const offset = 22
  eddy = {
    cx: cx + Math.cos(perp) * offset,
    cy: cy + Math.sin(perp) * offset,
    vx: Math.cos(dir) * centerSpeed,
    vy: Math.sin(dir) * centerSpeed,
    created: performance.now(),
    side: eddySide
  }
  spawnSwirlsAt(cx, cy)
}

function initAnimation() {
  raysCanvas = document.getElementById('raysCanvas')
  sparklesCanvas = document.getElementById('sparklesCanvas')
  waterLayer = document.getElementById('waterLayer')
  depthSlider = document.getElementById('depthSlider')
  depthControl = document.getElementById('depthControl')
  depthIcon = document.getElementById('depthIcon')

  viewportWidth.value = window.innerWidth
  viewportHeight.value = window.innerHeight
  docHeight.value = document.documentElement.scrollHeight

  if (raysCanvas) {
    raysCanvas.width = viewportWidth.value
    raysCanvas.height = viewportHeight.value
  }
  if (sparklesCanvas) {
    sparklesCanvas.width = viewportWidth.value
    // Keep canvas the size of the viewport to avoid scaling squish; we'll translate by scroll
    sparklesCanvas.height = viewportHeight.value
  }

  rays = []
  for (let i = 0; i < 8; i++) {
    rays.push({
      x: (viewportWidth.value / 8) * i + (Math.random() - 0.5) * 40,
      y: -150 - Math.random() * 200,
      width: 100 + Math.random() * 100,
      length: viewportHeight.value * 1.5,
      speed: 0.1 + Math.random() * 0.2,
      phase: Math.random() * Math.PI * 2,
      opacity: 0.08 + Math.random() * 0.1
    })
  }

  sparkles = []
  for (let i = 0; i < SPARKLE_COUNT; i++) {
    sparkles.push({
      x: Math.random() * viewportWidth.value * 2,
      y: Math.random() * docHeight.value,
      radius: 2 + Math.random() * 3,
      speed: 0.5 + Math.random() * 1.0,
      wobble: Math.random() * Math.PI * 2,
      wobbleSpeed: 0.01 + Math.random() * 0.02,
      phase: Math.random() * Math.PI * 2,
      maxOpacity: 0.4 + Math.random() * 0.4
    })
  }

  window.addEventListener('resize', () => {
    viewportWidth.value = window.innerWidth
    viewportHeight.value = window.innerHeight
    docHeight.value = document.documentElement.scrollHeight
    if (raysCanvas) {
      raysCanvas.width = viewportWidth.value
      raysCanvas.height = viewportHeight.value
    }
    if (sparklesCanvas) {
      sparklesCanvas.width = viewportWidth.value
      sparklesCanvas.height = viewportHeight.value
    }
  })

  window.addEventListener('mousemove', (e) => {
    mouse.value.x = e.clientX
    mouse.value.y = e.clientY
    mouse.value.active = true
    const now = performance.now()
    mouseHistory.push({ x: e.clientX, y: e.clientY, t: now })
    while (mouseHistory.length && (now - mouseHistory[0].t) > 1000) mouseHistory.shift()
  })
  window.addEventListener('mouseleave', () => {
    mouse.value.active = false
  })
  // Remove click-to-burst; we trigger on sudden direction change instead

  window.addEventListener('scroll', () => {
    scrollY.value = window.scrollY
    const parallax = -scrollY.value * 0.2
    if (waterLayer) {
      waterLayer.style.transform = `translate3d(0, ${parallax}px, 0)`
    }
    if (raysCanvas) {
      raysCanvas.style.transform = `translate3d(0, ${parallax}px, 0)`
    }
  })

  animate()
}

function animate() {
  const nowTs = performance.now()
  const dt = prevFrameNow ? Math.max(0.001, (nowTs - prevFrameNow) / 1000) : 0.016
  prevFrameNow = nowTs
  time.value += dt

  if (raysCanvas && raysCanvas.getContext) {
    const ctx = raysCanvas.getContext('2d')
    ctx.clearRect(0, 0, viewportWidth.value, viewportHeight.value)
    ctx.globalCompositeOperation = 'screen'
    
    rays.forEach((ray) => {
      const sway = Math.sin(time.value * ray.speed + ray.phase) * 15
      const breathing = Math.sin(time.value * 0.4 + ray.phase) * 0.5 + 0.5
      const alpha = ray.opacity * (0.4 + brightness.value * 0.6) * breathing
      
      if (alpha > 0.01) {
        const startX = ray.x + sway
        const endX = startX + Math.sin(0.3) * ray.length
        const endY = ray.y + Math.cos(0.3) * ray.length
        
        const grad = ctx.createLinearGradient(startX, ray.y, endX, endY)
        grad.addColorStop(0, `rgba(255, 255, 240, ${alpha})`)
        grad.addColorStop(0.4, `rgba(220, 255, 250, ${alpha * 0.6})`)
        grad.addColorStop(1, `rgba(150, 240, 255, 0)`)
        
        ctx.save()
        ctx.translate(startX, ray.y)
        ctx.rotate(0.3)
        ctx.beginPath()
        ctx.moveTo(-ray.width/2, 0)
        ctx.lineTo(ray.width/2, 0)
        ctx.lineTo(ray.width/3, ray.length)
        ctx.lineTo(-ray.width/3, ray.length)
        ctx.closePath()
        ctx.fillStyle = grad
        ctx.fill()
        ctx.restore()
      }
    })
  }

  if (sparklesCanvas && sparklesCanvas.getContext) {
    const ctx = sparklesCanvas.getContext('2d')
    // Clear the entire sparkles canvas to prevent trails across the full document height
    ctx.clearRect(0, 0, sparklesCanvas.width, sparklesCanvas.height)
    ctx.globalCompositeOperation = 'source-over'

    // Cursor-follow sparkles: spawn at randomized intervals near pointer
    const now = nowTs

    // Update gravitational mass to follow the mouse (spring + damping)
    if (mouse.value.active) {
      const k = 8 // spring strength
      const damp = Math.max(0, 1 - 4 * dt)
      const mx = mouse.value.x
      const my = scrollY.value + mouse.value.y
      const ax = (mx - mass.x) * k
      const ay = (my - mass.y) * k
      mass.vx = (mass.vx + ax * dt) * damp
      mass.vy = (mass.vy + ay * dt) * damp
      mass.x += mass.vx * dt
      mass.y += mass.vy * dt
    }

    // Update last moving snapshot for reliable burst direction
    const speedNow = getMouseSpeedOver(200, now)
    const angNow = getMouseAngleOver(200, now) ?? lastDirAngle
    if (speedNow > 120) {
      const mx = mouse.value.x
      const my = scrollY.value + mouse.value.y
      lastMoving = { x: mx, y: my, angle: angNow, speed: speedNow, t: now }
    }
    // Detect sudden direction change and spawn eddies if enabled
    maybeSpawnEddyOnTurn(now)
    // Continuous spawn when moving fast: 1 line at 3–6 Hz (>120 px/s), unless cooling down after a turn
    const SPEED_THRESHOLD = 90 // px/s
    if (speedNow > SPEED_THRESHOLD && now >= nextContinuousSpawnAt && now >= newDirectionCooldownUntil) {
      const angNow = getMouseAngleOver(200, now) ?? lastDirAngle
      const mx = mouse.value.x
      const my = scrollY.value + mouse.value.y
      // Spawn 1 (occasionally 2) short streaks at the cursor, no curl, fade quickly
      const streakCount = Math.random() < 0.3 ? 2 : 1
      for (let i = 0; i < streakCount; i++) spawnStreak(mx, my, angNow, speedNow)
      // schedule next spawn: frequency scales 6 Hz @120 px/s up to 40 Hz @500 px/s
      const v = Math.min(500, Math.max(SPEED_THRESHOLD, speedNow))
      const t = (v - SPEED_THRESHOLD) / (500 - SPEED_THRESHOLD)
      const freq = STREAK_FREQ_MIN + t * (STREAK_FREQ_MAX - STREAK_FREQ_MIN)
      const intervalMs = 1000 / freq
      nextContinuousSpawnAt = now + intervalMs
      lastContinuousSpawnAt = now
    }
    if (mouse.value.active && now >= nextCursorSparkleAt) {
      let spawns = 1
      if (Math.random() < 0.40) spawns = 2
      if (Math.random() < 0.10) spawns = 3
      for (let i = 0; i < spawns; i++) spawnCursorSparkle()
      nextCursorSparkleAt = now + randomCursorSpawnInterval()
    }

    // Per-swirl center update handled below; global eddy kept for reference only

    // Draw straight streaks (follow mouse while moving fast)
    ctx.save()
    ctx.globalCompositeOperation = 'screen'
    const streakAlphaBase = 0.40
    const streakWidth = 2.25
    streaks = streaks.filter((s) => {
      const life = now - s.created
      const t = life / s.lifetime
      if (t >= 1) return false
      s.px = s.x
      s.py = s.y
      // Strong quadratic drag so streaks trail and don't overshoot
      s.speed = Math.max(0, s.speed - STREAK_DRAG_COEFF * s.speed * s.speed * dt)
      const step = s.speed * dt
      s.x += Math.cos(s.angle) * step
      s.y += Math.sin(s.angle) * step
      const dy1 = s.py - scrollY.value
      const dy2 = s.y - scrollY.value
      ctx.beginPath()
      ctx.moveTo(s.px, dy1)
      ctx.lineTo(s.x, dy2)
      ctx.strokeStyle = `rgba(100,255,255,${streakAlphaBase * (0.8 - t * s.speed * dt)})`
      ctx.lineWidth = streakWidth
      ctx.lineCap = 'round'
      ctx.stroke()
      return true
    })
    ctx.restore()

    // Draw swirl trails (water current lines)
    ctx.save()
    ctx.globalCompositeOperation = 'screen'
    // Read current reef color from CSS var to tint lines cohesively
    let reefRGB = '73, 215, 175'
    try {
      const css = getComputedStyle(waterLayer)
      const v = css.getPropertyValue('--reef-rgb')
      if (v && v.trim().length > 0) reefRGB = v.trim()
    } catch {}

    swirls = swirls.filter((s) => {
      const elapsed = now - s.created
      const lifeT = elapsed / s.lifetime
      if (lifeT >= 0.7) return false // slower decay: fade by 70% of lifetime
      const dt = Math.max(0.001, (now - s.prevTime) / 1000)
      s.prevTime = now
      const ramp = Math.min(1, elapsed / 300) // start slower (viscosity)

      // For burst lines: straight phase distance before curl
      const inStraight = !s.turned && (s.forwardTarget || 0) > 0 && (s.forwardDist || 0) < (s.forwardTarget || 0)
      let angFriction = inStraight ? 2.0 : 1.3
      let radFriction = inStraight ? 0.6 : 2.2 // stronger radial damping after turn

      // Damping preserving sign
      s.angVel *= Math.max(0, 1 - angFriction * dt)
      s.radVel = Math.max(0, s.radVel - radFriction * 120 * dt)

      // On first frame after straight phase, inject a curl impulse and increase damping (sudden slow + curve)
      if (!inStraight && !s.turned) {
        const curlSign = (eddy?.side) || s.dir || Math.sign(s.angVel) || (Math.random() < 0.5 ? -1 : 1)
        s.angVel += curlSign * (s.curlStrength ?? 0.25) * 2.0
        s.radVel *= 0.2 // stronger immediate slow-down to keep curl tight
        s.turnedAt = now
        s.baseOmega = (3.0 + Math.random() * 2.0) * curlSign // slower multi-orbit
        // Snap center and radius to eddy center and target radius
        s.cx = s.straightX
        s.cy = s.straightY
        s.rad = s.targetRad || s.rad
        s.turned = true
      }

      const osc = Math.sin(elapsed / 1000 * s.oscSpeed + s.oscPhase) * 0.06 * (1 - lifeT)
      let effAng = inStraight ? osc * 0.2 : (s.angVel + osc)

      // During swirl burst window, keep angular speed sufficient for multiple orbits, but slower
      if (!inStraight && s.turned) {
        const swirlAge = now - (s.turnedAt || now)
        if (swirlAge < (s.swirlBurstMs || 800)) {
          // Low angular damping and enforce minimum angular velocity magnitude
          angFriction = 0.2
          const sign = Math.sign(effAng) || Math.sign(s.baseOmega) || 1
          const minOmega = Math.abs(s.baseOmega || 3.5)
          const mag = Math.max(Math.abs(effAng), minOmega)
          effAng = sign * mag
          // Pull radius toward target tightly
          const cap = s.maxRad || 26
          const target = s.targetRad || 20
          s.rad += (target - s.rad) * Math.min(1, 8 * dt)
          s.radVel *= Math.max(0, 1 - 6 * dt)
        }
      }

      // additional radial damping as radius approaches cap
      const cap = s.maxRad || 28
      const approach = Math.min(1, (s.rad / cap))
      const radialFactor = Math.max(0.2, 1 - approach * 0.8)
      // Update each swirl's eddy center with strong damping from initial speed
      const cf = 2.8
      s.cVx = (s.cVx ?? 0) * Math.max(0, 1 - cf * dt)
      s.cVy = (s.cVy ?? 0) * Math.max(0, 1 - cf * dt)
      // During straight phase, advance along base movement; after, center drifts by damped velocity
      if (inStraight) {
        const step = (s.forwardSpeed || 200) * dt
        s.forwardDist = (s.forwardDist || 0) + step
        s.straightX += Math.cos(s.baseAngle || 0) * step
        s.straightY += Math.sin(s.baseAngle || 0) * step
      } else {
        s.cx += (s.cVx ?? 0) * dt
        s.cy += (s.cVy ?? 0) * dt
      }
      s.rad += s.radVel * dt * ramp * radialFactor
      if (s.rad > cap) s.rad = cap
      s.angle += effAng * dt * ramp
      const px = inStraight ? s.straightX : (s.cx || 0) + Math.cos(s.angle) * s.rad
      const py = inStraight ? s.straightY : (s.cy || 0) + Math.sin(s.angle) * s.rad
      s.trail.push({ x: px, y: py, t: lifeT })
      if (s.trail.length > 50) s.trail.shift()

      // Compute path length and hide the first 20% of the path
      let totalLen = 0
      for (let i = 1; i < s.trail.length; i++) {
        const a = s.trail[i - 1], b = s.trail[i]
        totalLen += Math.hypot(b.x - a.x, b.y - a.y)
      }
      let startIdx = 0, acc = 0
      const hideFrac = 0.2
      const hideLen = totalLen * hideFrac
      for (let i = 1; i < s.trail.length; i++) {
        const a = s.trail[i - 1], b = s.trail[i]
        const seg = Math.hypot(b.x - a.x, b.y - a.y)
        if (acc + seg >= hideLen) { startIdx = i; break }
        acc += seg
      }
      // Draw sub-segments with their own alpha and slight perpendicular jitter to avoid stacking
      const visibleLen = Math.max(0, totalLen - hideLen)
      if (s.trail.length - startIdx >= 2 && visibleLen > 0) {
        let accVis = 0
        for (let i = startIdx + 1; i < s.trail.length; i++) {
          const a = s.trail[i - 1], b = s.trail[i]
          const segLen = Math.hypot(b.x - a.x, b.y - a.y)
          accVis += segLen
          const midFrac = Math.min(1, Math.max(0, (accVis - segLen / 2) / visibleLen))
          // Envelope: 0 at start, peak at mid, 0 at end (lower peak to reduce additive brightness)
          const peak = 0.45
          const env = 1 - Math.abs(2 * midFrac - 1) // triangle 0..1..0
          const alpha = peak * env
          // Perpendicular jitter ~2-3 px, deterministic per segment
          let nx = b.y - a.y, ny = -(b.x - a.x)
          const nlen = Math.hypot(nx, ny) || 1
          nx /= nlen; ny /= nlen
          const seed = Math.sin(i * 12.9898 + s.created * 0.001) * 43758.5453
          const j = ((seed - Math.floor(seed)) * 2 - 1) * 3.0 // [-3,3] px
          const ax = a.x + nx * j, ay = a.y + ny * j
          const bx = b.x + nx * j, by = b.y + ny * j
          ctx.beginPath()
          ctx.moveTo(ax, ay - scrollY.value)
          ctx.lineTo(bx, by - scrollY.value)
          ctx.strokeStyle = `rgba(${reefRGB}, ${alpha})`
          ctx.lineWidth = s.width * (1 - lifeT) + 0.5
          ctx.lineCap = 'round'
          ctx.lineJoin = 'round'
          ctx.stroke()
        }
      }
      return true
    })
    ctx.restore()
    
    sparkles.forEach((sparkle) => {
      sparkle.y -= sparkle.speed
      sparkle.x += Math.sin(sparkle.y * 0.005 + sparkle.wobble) * 0.3
      sparkle.wobble += sparkle.wobbleSpeed
      
      if (sparkle.y < -50) {
        sparkle.y = docHeight.value + 50
        sparkle.x = Math.random() * viewportWidth.value
      }
      
      if (sparkle.y < scrollY.value - 100 || sparkle.y > scrollY.value + viewportHeight.value + 100) return
      
      const twinkle = Math.sin(time.value * 2 + sparkle.phase) * 0.5 + 0.5
      const alpha = sparkle.maxOpacity * twinkle * 0.25
      
      if (alpha > 0.01) {
        const drawY = sparkle.y - scrollY.value
        const gradient = ctx.createRadialGradient(sparkle.x, drawY, 0, sparkle.x, drawY, sparkle.radius * 2)
        gradient.addColorStop(0, `rgba(255, 255, 230, ${alpha})`)
        gradient.addColorStop(0.5, `rgba(255, 255, 255, ${alpha * 0.8})`)
        gradient.addColorStop(1, `rgba(255, 255, 255, 0)`)
        
        ctx.beginPath()
        ctx.arc(sparkle.x, drawY, sparkle.radius * 2, 0, Math.PI * 2)
        ctx.fillStyle = gradient
        ctx.fill()
        
        ctx.beginPath()
        ctx.arc(sparkle.x, drawY, sparkle.radius * 0.6, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`
        ctx.fill()
      }
    })
  }

  animationId = requestAnimationFrame(animate)
}

function updateDepth() {
  const value = parseInt(depthSlider.value)
  brightness.value = value / 100
  depthIcon.textContent = value > 50 ? '☀️' : '🌙'
  depthControl.classList.toggle('dark-mode', value <= 50)
  if (waterLayer) {
    const bgBrightness = 0.6 + brightness.value * 0.8 // up to 1.4 at lightest
    const bgSaturation = 1.0 + brightness.value * 0.8 // up to 1.8 at lightest
    waterLayer.style.filter = `url(#water-distortion) brightness(${bgBrightness}) saturate(${bgSaturation})`
    // Also strengthen the aqua/blue gradient components as depth gets shallower
    const aqua1 = Math.min(0.15 + 0.75 * brightness.value, 0.90)
    const aqua2 = Math.min(0.20 + 0.75 * brightness.value, 0.95)
    const blue1 = Math.min(0.10 + 0.45 * brightness.value, 0.60)
    const green1 = Math.min(0.08 + 0.55 * brightness.value, 0.70)
    waterLayer.style.setProperty('--aqua1', aqua1.toFixed(3))
    waterLayer.style.setProperty('--aqua2', aqua2.toFixed(3))
    waterLayer.style.setProperty('--blue1', blue1.toFixed(3))
    waterLayer.style.setProperty('--green1', green1.toFixed(3))
    // Morph the primary teal towards tropical reef (#49d7af) at lighter depths
    const base = { r: 20, g: 184, b: 166 }
    const reef = { r: 73, g: 215, b: 175 } // #49d7af
    const t = Math.max(0, Math.min(1, (brightness.value - 0.66) / 0.34))
    const lerp = (a, b) => Math.round(a + (b - a) * t)
    const rr = lerp(base.r, reef.r)
    const rg = lerp(base.g, reef.g)
    const rb = lerp(base.b, reef.b)
    waterLayer.style.setProperty('--reef-rgb', `${rr}, ${rg}, ${rb}`)
  }
  // Flip UI to light mode when slider is above ~66%
  const root = document.querySelector('.marketing-root')
  if (root) {
    if (brightness.value >= 0.66) root.classList.add('light-mode')
    else root.classList.remove('light-mode')
  }
}

onMounted(() => {
  initAnimation()
  if (depthSlider) {
    depthSlider.addEventListener('input', updateDepth)
  }
  if (depthIcon && depthSlider) {
    depthIcon.addEventListener('click', () => {
      const target = brightness.value >= 0.66 ? 0 : 100
      depthSlider.value = String(target)
      updateDepth()
    })
  }
  updateDepth()
})
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
    <div class="max-w-7xl mx-auto flex justify-between items-center">
      <div class="flex items-center gap-2 group">
        <div class="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-sm border border-white/30">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m0 0l-4-4m4 4l4-4M8 8a4 4 0 118 0 4 4 0 01-8 0z"></path>
          </svg>
        </div>
        <span class="brand-title font-display font-bold text-2xl tracking-tight">Coleo</span>
      </div>
      <div class="hidden md:flex items-center space-x-8">
        <a href="/architecture/overview" class="nav-link text-sm font-medium transition-colors">Philosophy</a>
        <a href="/architecture/overview" class="nav-link text-sm font-medium transition-colors">Architecture</a>
        <a href="/architecture/components#observatory-web-ui-api" class="nav-link text-sm font-medium transition-colors">Observatory</a>
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
            Distributed agent orchestration inspired by the soft architecture of intelligent cephalopods.
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
              <div class="flex items-center gap-2 opacity-60">$ coleo spawn --arms 3 --task "explore"</div>
              <div class="space-y-2">
                <div class="flex items-center gap-2">
                  <div class="w-2 h-2 rounded-full bg-accent animate-pulse"></div>
                  <span class="text-accent font-semibold">Brain</span>
                  <span class="opacity-60">→ Spawning Arms...</span>
                </div>
                <div class="pl-4 space-y-1 opacity-80">
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
              <div class="text-sm opacity-70 font-mono">Arm: arm-7f3d9 • Files: 12 modified</div>
            </div>
            <div class="ui-box p-4 rounded-lg">
              <div class="flex items-center justify-between mb-2">
                <span class="font-semibold">🌿 Garden: test-coverage</span>
                <span class="text-xs bg-green-400 text-white px-2 py-1 rounded">Active</span>
              </div>
              <div class="text-sm opacity-70 font-mono">Arm: arm-2a8b1 • Files: 8 modified</div>
            </div>
            <div class="ui-box p-4 rounded-lg">
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
