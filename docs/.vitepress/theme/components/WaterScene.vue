<template>
  <div>
    <div class="depth-control" id="depthControl">
      <label>
        <span id="depthIcon">☀️</span>
      </label>
      <input type="range" id="depthSlider" min="0" max="100" value="70" />
    </div>

  </div>
  <slot />
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";

const time = ref(0);
const brightness = ref(0.7);
const scrollY = ref(0);
const docHeight = ref(0);
const viewportHeight = ref(0);
const viewportWidth = ref(0);

const SPARKLE_COUNT = 40;
const MAX_SPARKLES = 160;

let raysCanvas: HTMLCanvasElement | null = null;
let sparklesCanvas: HTMLCanvasElement | null = null;
let waterLayer: HTMLElement | null = null;
let depthSlider: HTMLInputElement | null = null;
let depthControl: HTMLElement | null = null;
let depthIcon: HTMLElement | null = null;

let rays: any[] = [];
let sparkles: any[] = [];
let animationId = 0;
const mouse = ref({ x: 0, y: 0, active: false });
let swirls: any[] = [];
let streaks: any[] = [];

const ENABLE_BURST = false;
const MAX_STREAK_SPEED = 300;
const STREAK_DRAG_COEFF = 0.02;
const STREAK_FREQ_MIN = 12;
const STREAK_FREQ_MAX = 40;
const DRIFT_DRAG_COEFF = 0.35;
const PERP_SEG_DRIFT = 20;

let mouseHistory: Array<{ x: number; y: number; t: number }> = [];
let lastDirAngle = 0;
let lastEddySpawnAt = 0;
let lastContinuousSpawnAt = 0;
let nextContinuousSpawnAt = 0;
let newDirectionCooldownUntil = 0;
let mass = { x: 0, y: 0, vx: 0, vy: 0 };
let prevFrameNow = 0;
let lastMoving: {
	x: number;
	y: number;
	angle: number;
	speed: number;
	t: number;
} | null = null;

function getMouseAngleOver(windowMs: number, nowTs = performance.now()) {
	const cutoff = nowTs - windowMs;
	const pts = mouseHistory.filter((p) => p.t >= cutoff);
	if (pts.length < 2) return null;
	let dx = 0,
		dy = 0;
	for (let i = 1; i < pts.length; i++) {
		dx += pts[i].x - pts[i - 1].x;
		dy += pts[i].y - pts[i - 1].y;
	}
	const mag = Math.hypot(dx, dy);
	return mag < 1e-2 ? null : Math.atan2(dy, dx);
}
function getMouseSpeedOver(windowMs: number, nowTs = performance.now()) {
	const cutoff = nowTs - windowMs;
	const pts = mouseHistory.filter((p) => p.t >= cutoff);
	if (pts.length < 2) return 0;
	let dist = 0;
	for (let i = 1; i < pts.length; i++) {
		const dx = pts[i].x - pts[i - 1].x,
			dy = pts[i].y - pts[i - 1].y;
		dist += Math.hypot(dx, dy);
	}
	const dt = (pts[pts.length - 1].t - pts[0].t) / 1000;
	return dt <= 0 ? 0 : dist / dt;
}

function spawnStreak(x: number, y: number, angle: number, speed: number) {
	const now = performance.now();
	const minV = 120,
		maxV = 500;
	const v = Math.min(maxV, Math.max(minV, speed));
	const t = (v - minV) / (maxV - minV);
	const lifetime = 250 + t * (900 - 250);
	streaks.push({ x, y, px: x, py: y, angle, speed, created: now, lifetime });
}

function spawnSwirlsAt(
	centerX: number,
	centerY: number,
	dirAngle: number,
	initSpeed: number,
	side: number,
	countOverride?: number,
	opts: any = {},
) {
	const created = performance.now();
	const lifetime = 2500;
	const count = countOverride ?? 10;
	const baseAngle = dirAngle;
	const cone = 0.35;
	for (let i = 0; i < count; i++) {
		const curlSide = side;
		const jitter = (Math.random() - 0.5) * cone;
		const angle = baseAngle + curlSide * 0.18 + jitter * 0.3;
		const back = Math.random() * 60;
		const pathX = centerX - Math.cos(baseAngle) * back;
		const pathY = centerY - Math.sin(baseAngle) * back;
		const perp = baseAngle + Math.PI / 2;
		const offMag = Math.random() * 20;
		const offX = Math.cos(perp) * offMag * curlSide;
		const offY = Math.sin(perp) * offMag * curlSide;
		const ox = pathX + offX,
			oy = pathY + offY;
		const targetRad = 32 + Math.random() * 10;
		swirls.push({
			created,
			lifetime,
			cx: centerX,
			cy: centerY,
			cVx: Math.cos(baseAngle) * ((initSpeed ?? 200) * 0.25),
			cVy: Math.sin(baseAngle) * ((initSpeed ?? 200) * 0.25),
			baseAngle,
			angle,
			angVel: (1.6 + Math.random() * 1.6) * curlSide,
			rad: targetRad,
			radVel: 0,
			width: 1.5 + Math.random() * 2.5,
			hue: 190 + Math.random() * 20,
			curlStrength: 0.35 + Math.random() * 0.35,
			oscSpeed: 2 + Math.random() * 3,
			oscPhase: Math.random() * Math.PI * 2,
			maxRad: targetRad + 14,
			targetRad,
			forwardTarget: opts.straightDist ?? 0,
			forwardSpeed: initSpeed ?? 200,
			forwardDist: 0,
			straightX: centerX,
			straightY: centerY,
			turned: false,
			turnedAt: 0,
			baseOmega: 0,
			swirlBurstMs: 250,
			dir: curlSide,
			trail: [{ x: ox, y: oy, t: 0 }],
			prevTime: created,
		});
	}
}

function maybeSpawnEddyOnTurn(nowTs = performance.now()) {
	const newAngle = getMouseAngleOver(32, nowTs) ?? getMouseAngleOver(64, nowTs);
	if (newAngle == null) return;
	const prevAngle = (maybeSpawnEddyOnTurn as any).prevAngle;
	if (!prevAngle) {
		(maybeSpawnEddyOnTurn as any).prevAngle = newAngle;
		(maybeSpawnEddyOnTurn as any).prevSpeed = getMouseSpeedOver(200, nowTs);
		return;
	}
	const delta = ((newAngle - prevAngle + Math.PI) % (2 * Math.PI)) - Math.PI;
	(maybeSpawnEddyOnTurn as any).prevAngle = newAngle;
	const threshold = (40 * Math.PI) / 180;
	const speedNow = getMouseSpeedOver(64, nowTs);
	const speedPrev = (maybeSpawnEddyOnTurn as any).prevSpeed ?? speedNow;
	(maybeSpawnEddyOnTurn as any).prevSpeed = speedNow;
	const bigTurn = Math.abs(delta) >= threshold && speedPrev > 120;
	const bigSlowdown = speedPrev > 120 && speedNow < 40;
	if (!bigTurn && !bigSlowdown) return;
	if (nowTs - lastEddySpawnAt < 250) return;
	lastEddySpawnAt = nowTs;
	const side = delta > 0 ? 1 : -1;
	if (ENABLE_BURST && lastMoving) {
		const straightDist = 60 + Math.random() * 40;
		spawnSwirlsAt(
			lastMoving.x,
			lastMoving.y,
			lastMoving.angle,
			lastMoving.speed,
			side,
			12,
			{ straightDist },
		);
	}
	newDirectionCooldownUntil = nowTs + 500;
}

function updateDepth() {
	if (!depthSlider || !depthControl || !waterLayer) return;
	const value = parseInt(depthSlider.value);
	brightness.value = value / 100;
	if (depthIcon) depthIcon.textContent = value > 50 ? "☀️" : "🌙";
	depthControl.classList.toggle("dark-mode", value <= 50);
	const bgBrightness = 0.6 + brightness.value * 0.8;
	const bgSaturation = 1.0 + brightness.value * 0.8;
	(waterLayer as HTMLElement).style.filter =
		`brightness(${bgBrightness}) saturate(${bgSaturation})`;
}

function initAnimation() {
	raysCanvas = document.getElementById("raysCanvas") as HTMLCanvasElement;
	sparklesCanvas = document.getElementById(
		"sparklesCanvas",
	) as HTMLCanvasElement;
	waterLayer = document.getElementById("waterLayer") as HTMLElement;
	depthSlider = document.getElementById("depthSlider") as HTMLInputElement;
	depthControl = document.getElementById("depthControl") as HTMLElement;
	depthIcon = document.getElementById("depthIcon") as HTMLElement;

	viewportWidth.value = window.innerWidth;
	viewportHeight.value = window.innerHeight;
	docHeight.value = document.documentElement.scrollHeight;
	if (raysCanvas) {
		raysCanvas.width = viewportWidth.value;
		raysCanvas.height = viewportHeight.value;
	}
	if (sparklesCanvas) {
		sparklesCanvas.width = viewportWidth.value;
		sparklesCanvas.height = viewportHeight.value;
	}

	rays = [];
	for (let i = 0; i < 8; i++) {
		rays.push({
			x: (viewportWidth.value / 8) * i + (Math.random() - 0.5) * 40,
			y: -200 - Math.random() * 200,
			width: 120 + Math.random() * 80,
			length: viewportHeight.value * 1.5,
			speed: 0.1 + Math.random() * 0.2,
			phase: Math.random() * Math.PI * 2,
			opacity: 0.08 + Math.random() * 0.1,
		});
	}
	sparkles = [];
	for (let i = 0; i < SPARKLE_COUNT; i++) {
		sparkles.push({
			x: Math.random() * viewportWidth.value * 2,
			y: Math.random() * docHeight.value,
			radius: 2 + Math.random() * 3,
			speed: 0.5 + Math.random() * 1.0,
			wobble: Math.random() * Math.PI * 2,
			wobbleSpeed: 0.01 + Math.random() * 0.02,
			phase: Math.random() * Math.PI * 2,
			maxOpacity: 0.4 + Math.random() * 0.4,
		});
	}

	window.addEventListener("resize", () => {
		viewportWidth.value = window.innerWidth;
		viewportHeight.value = window.innerHeight;
		docHeight.value = document.documentElement.scrollHeight;
		if (raysCanvas) {
			raysCanvas.width = viewportWidth.value;
			raysCanvas.height = viewportHeight.value;
		}
		if (sparklesCanvas) {
			sparklesCanvas.width = viewportWidth.value;
			sparklesCanvas.height = viewportHeight.value;
		}
	});
	window.addEventListener("mousemove", (e) => {
		mouse.value.x = e.clientX;
		mouse.value.y = e.clientY;
		mouse.value.active = true;
		const now = performance.now();
		mouseHistory.push({ x: e.clientX, y: e.clientY, t: now });
		while (mouseHistory.length && now - mouseHistory[0].t > 1000)
			mouseHistory.shift();
	});
	window.addEventListener("mouseleave", () => {
		mouse.value.active = false;
	});
	window.addEventListener("scroll", () => {
		scrollY.value = window.scrollY;
		const parallax = -scrollY.value * 0.2;
		if (waterLayer)
			(waterLayer as HTMLElement).style.transform =
				`translate3d(0,${parallax}px,0)`;
		if (raysCanvas)
			(raysCanvas as HTMLCanvasElement).style.transform =
				`translate3d(0,${parallax}px,0)`;
	});

	if (depthSlider) depthSlider.addEventListener("input", updateDepth);
	updateDepth();
}

function animate() {
	const nowTs = performance.now();
	const dt = prevFrameNow
		? Math.max(0.001, (nowTs - prevFrameNow) / 1000)
		: 0.016;
	prevFrameNow = nowTs;
	time.value += dt;

	// Rays
	if (raysCanvas) {
		const ctx = raysCanvas.getContext("2d")!;
		ctx.clearRect(0, 0, viewportWidth.value, viewportHeight.value);
		ctx.globalCompositeOperation = "screen";
		rays.forEach((ray) => {
			const sway = Math.sin(time.value * ray.speed + ray.phase) * 15;
			const breathing = Math.sin(time.value * 0.4 + ray.phase) * 0.5 + 0.5;
			const alpha = ray.opacity * (0.4 + brightness.value * 0.6) * breathing;
			if (alpha > 0.01) {
				const startX = ray.x + sway;
				const endX = startX + Math.sin(0.3) * ray.length;
				const endY = ray.y + Math.cos(0.3) * ray.length;
				const grad = ctx.createLinearGradient(startX, ray.y, endX, endY);
				grad.addColorStop(0, `rgba(255,255,240,${alpha})`);
				grad.addColorStop(0.4, `rgba(220,255,250,${alpha * 0.6})`);
				grad.addColorStop(1, `rgba(150,240,255,0)`);
				ctx.save();
				ctx.translate(startX, ray.y);
				ctx.rotate(0.3);
				ctx.beginPath();
				ctx.moveTo(-ray.width / 2, 0);
				ctx.lineTo(ray.width / 2, 0);
				ctx.lineTo(ray.width / 3, ray.length);
				ctx.lineTo(-ray.width / 3, ray.length);
				ctx.closePath();
				ctx.fillStyle = grad;
				ctx.fill();
				ctx.restore();
			}
		});
	}

	if (sparklesCanvas) {
		const ctx = sparklesCanvas.getContext("2d")!;
		ctx.clearRect(0, 0, sparklesCanvas.width, sparklesCanvas.height);
		ctx.globalCompositeOperation = "source-over";

		// Update mass (spring to mouse)
		if (mouse.value.active) {
			const k = 8,
				damp = Math.max(0, 1 - 4 * dt);
			const mx = mouse.value.x,
				my = scrollY.value + mouse.value.y;
			const ax = (mx - mass.x) * k,
				ay = (my - mass.y) * k;
			mass.vx = (mass.vx + ax * dt) * damp;
			mass.vy = (mass.vy + ay * dt) * damp;
			mass.x += mass.vx * dt;
			mass.y += mass.vy * dt;
		}

		// Update lastMoving snapshot
		const speedNow = getMouseSpeedOver(200, nowTs);
		const angNow = getMouseAngleOver(200, nowTs) ?? lastDirAngle;
		if (speedNow > 120) {
			lastMoving = {
				x: mouse.value.x,
				y: scrollY.value + mouse.value.y,
				angle: angNow!,
				speed: speedNow,
				t: nowTs,
			};
		}
		// Turn/stop bursts
		maybeSpawnEddyOnTurn(nowTs);

		// Continuous streaks
		const SPEED_THRESHOLD = 90;
		if (
			speedNow > SPEED_THRESHOLD &&
			nowTs >= nextContinuousSpawnAt &&
			nowTs >= newDirectionCooldownUntil
		) {
			const mx = mouse.value.x,
				my = scrollY.value + mouse.value.y;
			const streakCount = Math.random() < 0.3 ? 2 : 1;
			const clampedSpeed = Math.min(MAX_STREAK_SPEED, speedNow);
			for (let i = 0; i < streakCount; i++)
				spawnStreak(mx, my, angNow!, clampedSpeed);
			const v = Math.min(500, Math.max(SPEED_THRESHOLD, speedNow));
			const t = (v - SPEED_THRESHOLD) / (500 - SPEED_THRESHOLD);
			const freq = STREAK_FREQ_MIN + t * (STREAK_FREQ_MAX - STREAK_FREQ_MIN);
			nextContinuousSpawnAt = nowTs + 1000 / freq;
			lastContinuousSpawnAt = nowTs;
		}

		// Draw swirls (drifting current) and streaks
		ctx.save();
		ctx.globalCompositeOperation = "screen";
		// Swirls
		const waterStyle = getComputedStyle(waterLayer!);
		let reefRGB =
			waterStyle.getPropertyValue("--reef-rgb").trim() || "73, 215, 175";
		swirls = swirls.filter((s: any) => {
			const lifeT = (nowTs - s.created) / s.lifetime;
			if (lifeT >= 1) return false;
			const dtLocal = Math.max(0.001, (nowTs - (s.prevTime || nowTs)) / 1000);
			s.prevTime = nowTs;
			const ramp = Math.min(1, (nowTs - s.created) / 300);
			const inStraight =
				!s.turned &&
				(s.forwardTarget || 0) > 0 &&
				(s.forwardDist || 0) < (s.forwardTarget || 0);
			let angFriction = inStraight ? 2.0 : 1.3;
			let radFriction = inStraight ? 0.6 : 2.2;
			s.angVel *= Math.max(0, 1 - angFriction * dtLocal);
			s.radVel = Math.max(0, s.radVel - radFriction * 120 * dtLocal);
			if (!inStraight && !s.turned) {
				const curlSign = s.dir || 1;
				s.angVel += curlSign * (s.curlStrength ?? 0.25) * 1.0;
				s.radVel *= 0.6;
				s.turnedAt = nowTs;
				s.baseOmega = (2.2 + Math.random() * 1.2) * curlSign;
				s.cx = s.straightX;
				s.cy = s.straightY;
				s.turned = true;
			}
			let effAng = inStraight ? 0 : s.angVel;
			if (!inStraight && s.turned) {
				const swirlAge = nowTs - (s.turnedAt || nowTs);
				if (swirlAge < (s.swirlBurstMs || 250)) {
					angFriction = 0.3;
					const sign = Math.sign(effAng) || Math.sign(s.baseOmega) || 1;
					const minOmega = Math.abs(s.baseOmega || 2.0);
					const mag = Math.max(Math.abs(effAng), minOmega);
					effAng = sign * mag;
					const cap = s.maxRad || 38,
						target = s.targetRad || 30;
					s.rad += (target - s.rad) * Math.min(1, 2 * dtLocal);
					s.radVel *= Math.max(0, 1 - 3 * dtLocal);
				}
			}
			const cap = s.maxRad || 28;
			const approach = Math.min(1, s.rad / cap);
			const radialFactor = Math.max(0.2, 1 - approach * 0.8);
			// center drift with quadratic easing
			const vx0 = s.cVx || 0,
				vy0 = s.cVy || 0;
			const v0 = Math.hypot(vx0, vy0);
			if (v0 > 0) {
				const v1 = Math.max(0, v0 - DRIFT_DRAG_COEFF * v0 * v0 * dtLocal);
				const scale = v0 > 0 ? v1 / v0 : 0;
				s.cVx = vx0 * scale;
				s.cVy = vy0 * scale;
			}
			const prevCx = s.cx || 0,
				prevCy = s.cy || 0;
			if (inStraight) {
				const step = (s.forwardSpeed || 200) * dtLocal;
				s.forwardDist = (s.forwardDist || 0) + step;
				s.straightX += Math.cos(s.baseAngle || 0) * step;
				s.straightY += Math.sin(s.baseAngle || 0) * step;
			} else {
				s.cx += (s.cVx || 0) * dtLocal;
				s.cy += (s.cVy || 0) * dtLocal;
				const dtx = (s.cx || 0) - prevCx,
					dty = (s.cy || 0) - prevCy;
				if (Math.abs(dtx) + Math.abs(dty) > 0) {
					for (let k = 0; k < s.trail.length; k++) {
						s.trail[k].x += dtx;
						s.trail[k].y += dty;
					}
				}
				const curlSide = s.dir || 1;
				const perpA = (s.baseAngle || 0) - (curlSide * Math.PI) / 2;
				const ux = Math.cos(perpA),
					uy = Math.sin(perpA);
				const segDrift = PERP_SEG_DRIFT * dtLocal;
				for (let k = 0; k < s.trail.length; k++) {
					s.trail[k].x += ux * segDrift;
					s.trail[k].y += uy * segDrift;
				}
			}
			s.rad += s.radVel * dtLocal * ramp * radialFactor;
			if (s.rad > cap) s.rad = cap;
			s.angle += effAng * dtLocal * ramp;
			const px = inStraight
				? s.straightX
				: (s.cx || 0) + Math.cos(s.angle) * s.rad;
			const py = inStraight
				? s.straightY
				: (s.cy || 0) + Math.sin(s.angle) * s.rad;
			s.trail.push({ x: px, y: py, t: lifeT });
			if (s.trail.length > 200) s.trail.shift();
			// compute path length and hide first 20%
			let totalLen = 0;
			for (let i = 1; i < s.trail.length; i++) {
				const a = s.trail[i - 1],
					b = s.trail[i];
				totalLen += Math.hypot(b.x - a.x, b.y - a.y);
			}
			let startIdx = 0,
				acc = 0;
			const hideLen = totalLen * 0.2;
			for (let i = 1; i < s.trail.length; i++) {
				const a = s.trail[i - 1],
					b = s.trail[i];
				const seg = Math.hypot(b.x - a.x, b.y - a.y);
				if (acc + seg >= hideLen) {
					startIdx = i;
					break;
				}
				acc += seg;
			}
			const visibleLen = Math.max(0, totalLen - hideLen);
			if (s.trail.length - startIdx >= 2 && visibleLen > 0) {
				let accVis = 0;
				for (let i = startIdx + 1; i < s.trail.length; i++) {
					const a = s.trail[i - 1],
						b = s.trail[i];
					const segLen = Math.hypot(b.x - a.x, b.y - a.y);
					accVis += segLen;
					const midFrac = Math.min(
						1,
						Math.max(0, (accVis - segLen / 2) / visibleLen),
					);
					const peak = 0.15;
					const env = 1 - Math.abs(2 * midFrac - 1);
					const timeBias = Math.max(0, 1 - lifeT * (0.3 + 0.7 * midFrac));
					const globalFade = Math.max(0, 0.5 * (1 + Math.cos(Math.PI * lifeT)));
					const alpha = peak * env * timeBias * globalFade;
					let nx = b.y - a.y,
						ny = -(b.x - a.x);
					const nlen = Math.hypot(nx, ny) || 1;
					nx /= nlen;
					ny /= nlen;
					const seed = Math.sin(i * 12.9898 + s.created * 0.001) * 43758.5453;
					const j = ((seed - Math.floor(seed)) * 2 - 1) * 1.5;
					const ax = a.x + nx * j,
						ay = a.y + ny * j;
					const bx = b.x + nx * j,
						by = b.y + ny * j;
					const gSeg = ctx.createLinearGradient(
						ax,
						ay - scrollY.value,
						bx,
						by - scrollY.value,
					);
					gSeg.addColorStop(0, `rgba(${reefRGB}, 0)`);
					gSeg.addColorStop(0.5, `rgba(${reefRGB}, ${alpha})`);
					gSeg.addColorStop(1, `rgba(${reefRGB}, 0)`);
					ctx.beginPath();
					ctx.moveTo(ax, ay - scrollY.value);
					ctx.lineTo(bx, by - scrollY.value);
					ctx.strokeStyle = gSeg;
					ctx.lineWidth = 1.2;
					ctx.lineCap = "round";
					ctx.lineJoin = "round";
					ctx.shadowColor = `rgba(${reefRGB}, ${alpha * 0.5})`;
					ctx.shadowBlur = 1.5;
					ctx.stroke();
				}
			}
			return true;
		});
		// Streaks
		const streakAlphaBase = 0.4,
			streakWidth = 1.25;
		streaks = streaks.filter((s: any) => {
			const life = nowTs - s.created;
			const t = life / s.lifetime;
			if (t >= 1) return false;
			s.px = s.x;
			s.py = s.y;
			s.speed = Math.max(
				0,
				s.speed - STREAK_DRAG_COEFF * s.speed * s.speed * dt,
			);
			const step = s.speed * dt;
			s.x += Math.cos(s.angle) * step;
			s.y += Math.sin(s.angle) * step;
			const dy1 = s.py - scrollY.value,
				dy2 = s.y - scrollY.value;
			ctx.beginPath();
			ctx.moveTo(s.px, dy1);
			ctx.lineTo(s.x, dy2);
			ctx.strokeStyle = `rgba(255,255,255,${streakAlphaBase * (1 - t)})`;
			ctx.lineWidth = streakWidth;
			ctx.lineCap = "round";
			ctx.stroke();
			return true;
		});
		ctx.restore();
	}

	animationId = requestAnimationFrame(animate);
}

onMounted(() => {
	initAnimation();
	animate();
});
onUnmounted(() => {
	cancelAnimationFrame(animationId);
});
</script>

<style scoped>
</style>

