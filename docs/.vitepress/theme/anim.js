// Plain JS home animation bootstrap to avoid Vue render overhead
/** biome-ignore-all lint/complexity/useArrowFunction: <explanation> */
(function () {
	const DBG = (...args) => {
		try {
			console.log("[homeAnim]", ...args);
		} catch (_) {}
	};
	let state = {
		inited: false,
		raf: 0,
		raysCanvas: null,
		sparklesCanvas: null,
		waterLayer: null,
		waterFx: null,
		depthSlider: null,
		depthControl: null,
		depthIcon: null,
		colorSchemeQuery: null,
		colorSchemeHandler: null,
		iconClickHandler: null,
		time: 0,
		brightness: 0.7,
		scrollY: 0,
		docHeight: 0,
		viewportHeight: 0,
		viewportWidth: 0,
		rays: [],
		sparkles: [],
		mouse: { x: 0, y: 0, active: false },
		nextCursorSparkleAt: 0,
		swirls: [],
		streaks: [],
		mouseHistory: [],
		lastDirAngle: 0,
		lastEddySpawnAt: 0,
		lastContinuousSpawnAt: 0,
		nextContinuousSpawnAt: 0,
		newDirectionCooldownUntil: 0,
		movingStartAt: 0,
		mass: { x: 0, y: 0, vx: 0, vy: 0 },
		prevFrameNow: 0,
		lastMoving: null,
		resizeHandler: null,
		mousemoveHandler: null,
		mouseleaveHandler: null,
		scrollHandler: null,
		depthInputHandler: null,
		retryTimer: 0,
		retries: 0,
		loggedAnimateStart: false,
		reefRGB: "73, 215, 175",
		perf: { lastReport: 0, frames: 0, accum: 0 },
	};
	const SPARKLE_COUNT = 20,
		MAX_SPARKLES = 200;
	const INTERACTIVE_CURRENTS = true;
	const ENABLE_BURST = true,
		MAX_STREAK_SPEED = 300;

	function getSystemIsLight() {
		try {
			if (window.matchMedia) {
				return window.matchMedia("(prefers-color-scheme: light)").matches;
			}
		} catch (_) {}
		return true;
	}

	const SWIRL_SETTINGS = {
		burst: {
			intervalMs: 3600,
			lifetimeMs: 2900,
			speed: 200,
			directionDeg: 45,
			straightDist: 25,
			swirlCount: 44,
		},
		render: {
			mode: "bucketed",
			renderStyle: "dots",
			alpha: 0.55,
			lineWidth: 3.9,
			buckets: 16,
			composite: "source-over",
			dpr: "off",
		},
		geometry: {
			curveTightness: 1.3,
			cone: 3.1,
			backMax: 150,
			offMagMax: 0,
			turnModel: "arc",
			turnSpeedScale: 1.3,
			turnRampScale: 0.8,
			turnMinRad: 19,
			turnOmegaMax: 15.5,
			hideFraction: 0.74,
			headFade: 0.52,
			trailLength: 180,
			tailFade: 0.54,
			targetRadMin: 22,
			targetRadMax: 48,
			maxRadExtra: 0,
			angVelMin: 0.5,
			angVelMax: 1.2,
			curlStrengthMin: 0.3,
			curlStrengthMax: 1.05,
			omegaMin: 0.5,
			omegaMax: 0.6,
			swirlBurstMs: 0,
			driftDrag: 1.8,
			perpDrift: 123,
		},
	};

	// Swirl/burst tuning
	const SWIRL_BURST_COUNT = SWIRL_SETTINGS.burst.swirlCount; // number of swirls spawned per burst
	const SWIRL_BURST_INTERVAL_MS = SWIRL_SETTINGS.burst.intervalMs;
	const SWIRL_LIFETIME_MS = SWIRL_SETTINGS.burst.lifetimeMs;
	const SWIRL_STRAIGHT_DIST = SWIRL_SETTINGS.burst.straightDist;
	const SWIRL_MAX_TRAIL_POINTS = SWIRL_SETTINGS.geometry.trailLength; // cap stored trail points
	const SWIRL_HIDE_FRACTION = SWIRL_SETTINGS.geometry.hideFraction; // hide first X% of trail
	const SWIRL_HEAD_FADE = SWIRL_SETTINGS.geometry.headFade;
	const SWIRL_TAIL_FADE = SWIRL_SETTINGS.geometry.tailFade;
	const SWIRL_DRAW_SEGMENTS = 14; // max segments drawn per swirl per frame
	const SWIRL_CONE = SWIRL_SETTINGS.geometry.cone;
	const SWIRL_BACK_MAX = SWIRL_SETTINGS.geometry.backMax;
	const SWIRL_OFFMAG_MAX = SWIRL_SETTINGS.geometry.offMagMax;
	const SWIRL_TARGET_RAD_MIN = SWIRL_SETTINGS.geometry.targetRadMin;
	const SWIRL_TARGET_RAD_MAX = SWIRL_SETTINGS.geometry.targetRadMax;
	const SWIRL_MAX_RAD_EXTRA = SWIRL_SETTINGS.geometry.maxRadExtra;
	const SWIRL_ANGVEL_MIN = SWIRL_SETTINGS.geometry.angVelMin;
	const SWIRL_ANGVEL_MAX = SWIRL_SETTINGS.geometry.angVelMax;
	const SWIRL_CURL_MIN = SWIRL_SETTINGS.geometry.curlStrengthMin;
	const SWIRL_CURL_MAX = SWIRL_SETTINGS.geometry.curlStrengthMax;
	const SWIRL_OMEGA_MIN = SWIRL_SETTINGS.geometry.omegaMin;
	const SWIRL_OMEGA_MAX = SWIRL_SETTINGS.geometry.omegaMax;
	const SWIRL_BURST_MS = SWIRL_SETTINGS.geometry.swirlBurstMs;
	const SWIRL_CURVE_TIGHTNESS = SWIRL_SETTINGS.geometry.curveTightness;
	const SWIRL_TURN_MODEL = SWIRL_SETTINGS.geometry.turnModel;
	const SWIRL_TURN_SPEED_SCALE = SWIRL_SETTINGS.geometry.turnSpeedScale;
	const SWIRL_TURN_RAMP_SCALE = SWIRL_SETTINGS.geometry.turnRampScale;
	const SWIRL_TURN_MIN_RAD = SWIRL_SETTINGS.geometry.turnMinRad;
	const SWIRL_TURN_OMEGA_MAX = SWIRL_SETTINGS.geometry.turnOmegaMax;
	const SWIRL_RENDER_MODE = SWIRL_SETTINGS.render.mode;
	const SWIRL_RENDER_STYLE = SWIRL_SETTINGS.render.renderStyle;
	const SWIRL_RENDER_ALPHA = SWIRL_SETTINGS.render.alpha;
	const SWIRL_RENDER_LINE_WIDTH = SWIRL_SETTINGS.render.lineWidth;
	const SWIRL_RENDER_BUCKETS = SWIRL_SETTINGS.render.buckets;
	const SWIRL_RENDER_COMPOSITE = SWIRL_SETTINGS.render.composite;

	const STREAK_DRAG_COEFF = 0.08,
		STREAK_FREQ_MIN = 22,
		STREAK_FREQ_MAX = 52;
	const DRIFT_DRAG_COEFF = SWIRL_SETTINGS.geometry.driftDrag,
		PERP_SEG_DRIFT = SWIRL_SETTINGS.geometry.perpDrift;

	function getMouseAngleOver(windowMs, nowTs) {
		const cutoff = nowTs - windowMs;
		const pts = state.mouseHistory.filter((p) => p.t >= cutoff);
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
	function getMouseSpeedOver(windowMs, nowTs) {
		const cutoff = nowTs - windowMs;
		const pts = state.mouseHistory.filter((p) => p.t >= cutoff);
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
	function getAverageSpeedLastFrames(frameCount) {
		const need = frameCount + 1;
		if (state.mouseHistory.length < need) return { speed: 0, duration: 0 };
		const slice = state.mouseHistory.slice(state.mouseHistory.length - need);
		let dist = 0;
		for (let i = 1; i < slice.length; i++) {
			const dx = slice[i].x - slice[i - 1].x;
			const dy = slice[i].y - slice[i - 1].y;
			dist += Math.hypot(dx, dy);
		}
		const dt = (slice[slice.length - 1].t - slice[0].t) / 1000;
		return dt <= 0
			? { speed: 0, duration: 0 }
			: { speed: dist / dt, duration: dt };
	}
	function getTurnSignLastFrames(frameCount) {
		const need = frameCount + 1;
		if (state.mouseHistory.length < need) return 0;
		const slice = state.mouseHistory.slice(state.mouseHistory.length - need);
		const p0 = slice[0];
		const p1 = slice[1];
		const pN1 = slice[slice.length - 2];
		const pN = slice[slice.length - 1];
		const v0x = p1.x - p0.x;
		const v0y = p1.y - p0.y;
		const v1x = pN.x - pN1.x;
		const v1y = pN.y - pN1.y;
		const mag0 = Math.hypot(v0x, v0y);
		const mag1 = Math.hypot(v1x, v1y);
		if (mag0 < 1e-3 || mag1 < 1e-3) return 0;
		const cross = v0x * v1y - v0y * v1x;
		if (Math.abs(cross) < 1e-3) return 0;
		// In screen coordinates (y down), positive cross corresponds to clockwise turn.
		return cross > 0 ? 1 : -1;
	}
	function spawnStreak(x, y, angle, speed) {
		const now = performance.now();
		const minV = 120,
			maxV = 500;
		const v = Math.min(maxV, Math.max(minV, speed));
		const t = (v - minV) / (maxV - minV);
		const lifetime = 550 + t * 1000;
		state.streaks.push({
			x,
			y,
			px: x,
			py: y,
			angle,
			speed,
			created: now,
			lifetime,
		});
	}
	function spawnSwirlsAt(
		centerX,
		centerY,
		dirAngle,
		initSpeed,
		side,
		countOverride,
		opts = {},
	) {
		const created = performance.now(),
			lifetime = SWIRL_LIFETIME_MS;
		const count = countOverride ?? 10;
		const baseAngle = dirAngle,
			cone = SWIRL_CONE;
		for (let i = 0; i < count; i++) {
			const curlSide = side;
			const jitter = (Math.random() - 0.5) * cone;
			const angle = baseAngle + curlSide * 0.18 + jitter * 0.3;
			const back = Math.random() * SWIRL_BACK_MAX;
			const pathX = centerX - Math.cos(baseAngle) * back,
				pathY = centerY - Math.sin(baseAngle) * back;
			const perp = baseAngle + Math.PI / 2,
				offMag = Math.random() * SWIRL_OFFMAG_MAX;
			const offX = Math.cos(perp) * offMag * curlSide,
				offY = Math.sin(perp) * offMag * curlSide;
			const ox = pathX + offX,
				oy = pathY + offY;
			const targetRad =
				SWIRL_TARGET_RAD_MIN +
				Math.random() *
					Math.max(0, SWIRL_TARGET_RAD_MAX - SWIRL_TARGET_RAD_MIN);
			const baseSpeed = initSpeed ?? SWIRL_SETTINGS.burst.speed;
			state.swirls.push({
				created,
				lifetime,
				cx: centerX,
				cy: centerY,
				// Keep trail points in local coordinates and apply a shared offset in draw/update.
				// This avoids per-frame loops that translate every point (a big perf win).
				trailOx: 0,
				trailOy: 0,
				// Seed used for stable, cheap pseudo-random jitter during rendering.
				seed: (Math.random() * 0x7fffffff) | 0,
				cVx: Math.cos(baseAngle) * (baseSpeed * 0.25),
				cVy: Math.sin(baseAngle) * (baseSpeed * 0.25),
				baseAngle,
				angle,
				angVel:
					(SWIRL_ANGVEL_MIN +
						Math.random() * Math.max(0, SWIRL_ANGVEL_MAX - SWIRL_ANGVEL_MIN)) *
					curlSide,
				rad: targetRad,
				radVel: 0,
				width: 1.5 + Math.random() * 2.5,
				hue: 190 + Math.random() * 20,
				curlStrength:
					SWIRL_CURL_MIN +
					Math.random() * Math.max(0, SWIRL_CURL_MAX - SWIRL_CURL_MIN),
				oscSpeed: 2 + Math.random() * 3,
				oscPhase: Math.random() * Math.PI * 2,
				maxRad: targetRad + SWIRL_MAX_RAD_EXTRA,
				targetRad,
				forwardTarget: opts.straightDist ?? SWIRL_STRAIGHT_DIST,
				forwardSpeed: baseSpeed,
				forwardDist: 0,
				straightX: centerX,
				straightY: centerY,
				curveTightness: SWIRL_CURVE_TIGHTNESS,
				turnModel: SWIRL_TURN_MODEL,
				turnSpeedScale: SWIRL_TURN_SPEED_SCALE,
				turnRampScale: SWIRL_TURN_RAMP_SCALE,
				turnMinRad: SWIRL_TURN_MIN_RAD,
				turnOmegaMax: SWIRL_TURN_OMEGA_MAX,
				omegaMin: SWIRL_OMEGA_MIN,
				omegaMax: SWIRL_OMEGA_MAX,
				turned: false,
				turnedAt: 0,
				baseOmega: 0,
				swirlBurstMs: SWIRL_BURST_MS,
				dir: curlSide,
				trail: [{ x: ox, y: oy, t: 0 }],
				prevTime: created,
			});
		}
	}
	function maybeSpawnEddyOnTurn(nowTs) {
		const newAngle =
			getMouseAngleOver(32, nowTs) ?? getMouseAngleOver(64, nowTs);
		if (newAngle == null) return;
		const prevAngle = maybeSpawnEddyOnTurn.prevAngle;
		if (!prevAngle) {
			maybeSpawnEddyOnTurn.prevAngle = newAngle;
			maybeSpawnEddyOnTurn.prevSpeed = getMouseSpeedOver(200, nowTs);
			return;
		}
		const delta = ((newAngle - prevAngle + Math.PI) % (2 * Math.PI)) - Math.PI;
		maybeSpawnEddyOnTurn.prevAngle = newAngle;
		const threshold = (40 * Math.PI) / 180;
		const speedNow = getMouseSpeedOver(64, nowTs),
			speedPrev = maybeSpawnEddyOnTurn.prevSpeed ?? speedNow;
		maybeSpawnEddyOnTurn.prevSpeed = speedNow;
		const bigTurn = Math.abs(delta) >= threshold && speedPrev > 120;
		const bigSlowdown = speedPrev > 100 && speedNow < 50;
		if (!bigTurn && !bigSlowdown) return;
		if (nowTs - state.lastEddySpawnAt < SWIRL_BURST_INTERVAL_MS) return;
		state.lastEddySpawnAt = nowTs;
		const turnSign = getTurnSignLastFrames(4);
		const side = turnSign !== 0 ? turnSign : delta > 0 ? 1 : -1;
		if (ENABLE_BURST && state.lastMoving) {
			const sd = SWIRL_STRAIGHT_DIST;
			spawnSwirlsAt(
				state.lastMoving.x,
				state.lastMoving.y,
				state.lastMoving.angle,
				state.lastMoving.speed,
				side,
				SWIRL_BURST_COUNT,
				{ straightDist: sd },
			);
		}
		state.newDirectionCooldownUntil = nowTs + 300;
	}
	function updateDepth() {
		if (!state.depthSlider || !state.depthControl || !state.waterFx) return;
		const value = parseInt(state.depthSlider.value);
		state.brightness = value / 100;
		const isLight = value > 50;
		if (state.depthIcon) state.depthIcon.textContent = "💡";
		state.depthControl.classList.toggle("dark-mode", !isLight);
		// Toggle mode globally and on marketing root for CSS
		document.body.classList.toggle("light-mode", isLight);
		document.body.classList.toggle("dark-mode", !isLight);
		const mr = document.querySelector(".marketing-root");
		if (mr) {
			mr.classList.toggle("light-mode", isLight);
		}
		const bgBrightness = 0.2 + state.brightness * 0.8,
			bgSaturation = 1.0 + state.brightness * 0.5;
		// Apply brightness/saturation to wrapper to avoid overwriting `.water-layer` filter.
		state.waterFx.style.filter = `brightness(${bgBrightness}) saturate(${bgSaturation})`;
	}

	function applySystemPreference() {
		if (!state.depthSlider) return;
		state.depthSlider.value = getSystemIsLight() ? "70" : "30";
		updateDepth();
	}
	function syncLayerHeight() {
		if (!state.waterLayer && !state.waterFx) return;
		const minHeight = state.viewportHeight * 2;
		const targetHeight = Math.max(state.docHeight, minHeight);
		const heightValue = `${Math.round(targetHeight)}px`;
		try {
			document.documentElement.style.setProperty(
				"--water-layer-height",
				heightValue,
			);
		} catch (_) {}
		if (state.waterFx) {
			state.waterFx.style.height = heightValue;
		}
		if (state.waterLayer) {
			state.waterLayer.style.height = heightValue;
		}
	}
	function isHomeDomPresent() {
		return !!document.querySelector(".marketing-root");
	}
	function removeHandlers() {
		DBG("removeHandlers");
		if (state.resizeHandler) {
			window.removeEventListener("resize", state.resizeHandler);
			state.resizeHandler = null;
		}
		if (state.mousemoveHandler) {
			window.removeEventListener("mousemove", state.mousemoveHandler);
			state.mousemoveHandler = null;
		}
		if (state.mouseleaveHandler) {
			window.removeEventListener("mouseleave", state.mouseleaveHandler);
			state.mouseleaveHandler = null;
		}
		if (state.scrollHandler) {
			window.removeEventListener("scroll", state.scrollHandler);
			state.scrollHandler = null;
		}
		if (state.depthInputHandler && state.depthSlider) {
			state.depthSlider.removeEventListener("input", state.depthInputHandler);
			state.depthInputHandler = null;
		}
		if (state.depthIcon && state.iconClickHandler) {
			state.depthIcon.removeEventListener("click", state.iconClickHandler);
			state.iconClickHandler = null;
		}
		if (state.colorSchemeQuery && state.colorSchemeHandler) {
			if (state.colorSchemeQuery.removeEventListener) {
				state.colorSchemeQuery.removeEventListener(
					"change",
					state.colorSchemeHandler,
				);
			} else if (state.colorSchemeQuery.removeListener) {
				state.colorSchemeQuery.removeListener(state.colorSchemeHandler);
			}
			state.colorSchemeQuery = null;
			state.colorSchemeHandler = null;
		}
		if (state.retryTimer) {
			clearTimeout(state.retryTimer);
			state.retryTimer = 0;
		}
	}
	function init() {
		DBG("init called", { inited: state.inited, path: location.pathname });
		if (!isHomeDomPresent()) {
			DBG("no .marketing-root present; will retry", { retries: state.retries });
			if (state.retries < 20) {
				state.retries++;
				state.retryTimer = setTimeout(init, 50);
			}
			return;
		}
		if (state.inited) return;
		state.raysCanvas = document.getElementById("raysCanvas");
		state.sparklesCanvas = document.getElementById("sparklesCanvas");
		state.waterLayer = document.getElementById("waterLayer");
		// Create/mount wrapper so we can apply brightness/saturation without clobbering water CSS filters.
		if (!document.getElementById("waterFxHome")) {
			const wfx = document.createElement("div");
			wfx.id = "waterFxHome";
			wfx.className = "water-fx-layer";
			document.body.appendChild(wfx);
		}
		state.waterFx = document.getElementById("waterFxHome");
		try {
			if (
				state.waterFx &&
				state.waterLayer &&
				state.waterLayer.parentElement !== state.waterFx
			) {
				state.waterFx.appendChild(state.waterLayer);
			}
		} catch (_) {}
		state.depthSlider = document.getElementById("depthSlider");
		state.depthControl = document.getElementById("depthControl");
		state.depthIcon = document.getElementById("depthIcon");
		if (!state.raysCanvas || !state.sparklesCanvas || !state.waterLayer) {
			DBG("elements missing", {
				rays: !!state.raysCanvas,
				sparkles: !!state.sparklesCanvas,
				water: !!state.waterLayer,
				retries: state.retries,
			});
			if (state.retries < 20) {
				state.retries++;
				state.retryTimer = setTimeout(init, 50);
			}
			return;
		}
		DBG("elements found; initializing");
		state.viewportWidth = window.innerWidth;
		state.viewportHeight = window.innerHeight;
		state.docHeight = document.documentElement.scrollHeight;
		syncLayerHeight();
		state.raysCanvas.width = state.viewportWidth;
		state.raysCanvas.height = state.viewportHeight;
		state.sparklesCanvas.width = state.viewportWidth;
		state.sparklesCanvas.height = state.viewportHeight;
		state.rays = [];
		for (let i = 0; i < 8; i++) {
			state.rays.push({
				x: (state.viewportWidth / 8) * i + (Math.random() - 0.5) * 40,
				y: -200 - Math.random() * 200,
				width: 120 + Math.random() * 80,
				length: state.viewportHeight * 1.5,
				speed: 0.1 + Math.random() * 0.2,
				phase: Math.random() * Math.PI * 2,
				opacity: 0.08 + Math.random() * 0.1,
			});
		}
		// Seed sparkles near current viewport for immediate visibility
		state.sparkles = [];
		const top = state.scrollY - 100,
			bottom = state.scrollY + state.viewportHeight + 100;
		for (let i = 0; i < SPARKLE_COUNT; i++) {
			state.sparkles.push({
				x: Math.random() * state.viewportWidth * 2,
				y: top + Math.random() * (bottom - top),
				radius: 2 + Math.random() * 3,
				speed: 0.5 + Math.random() * 1.0,
				wobble: Math.random() * Math.PI * 2,
				wobbleSpeed: 0.01 + Math.random() * 0.02,
				phase: Math.random() * Math.PI * 2,
				maxOpacity: 0.4 + Math.random() * 0.4,
			});
		}
		// Cache reef color once
		try {
			const v = getComputedStyle(state.waterLayer)
				.getPropertyValue("--reef-rgb")
				.trim();
			if (v) state.reefRGB = v;
		} catch (_) {}
		state.resizeHandler = () => {
			state.viewportWidth = window.innerWidth;
			state.viewportHeight = window.innerHeight;
			state.docHeight = document.documentElement.scrollHeight;
			syncLayerHeight();
			state.raysCanvas.width = state.viewportWidth;
			state.raysCanvas.height = state.viewportHeight;
			state.sparklesCanvas.width = state.viewportWidth;
			state.sparklesCanvas.height = state.viewportHeight;
		};
		state.mousemoveHandler = (e) => {
			state.mouse.x = e.clientX;
			state.mouse.y = e.clientY;
			state.mouse.active = true;
			const now = performance.now();
			state.mouseHistory.push({ x: e.clientX, y: e.clientY, t: now });
			while (state.mouseHistory.length && now - state.mouseHistory[0].t > 1000)
				state.mouseHistory.shift();
		};
		state.mouseleaveHandler = () => {
			state.mouse.active = false;
		};
		state.scrollHandler = () => {
			state.scrollY = window.scrollY;
			const parallax = -state.scrollY * 0.2;
			state.waterLayer.style.transform = `translate3d(0,${parallax}px,0)`;
			state.raysCanvas.style.transform = `translate3d(0,${parallax}px,0)`;
		};
		window.addEventListener("resize", state.resizeHandler);
		window.addEventListener("mousemove", state.mousemoveHandler);
		window.addEventListener("mouseleave", state.mouseleaveHandler);
		window.addEventListener("scroll", state.scrollHandler);
		if (state.depthSlider) {
			state.depthInputHandler = updateDepth;
			state.depthSlider.addEventListener("input", state.depthInputHandler);
		}
		if (state.depthIcon) {
			state.depthIcon.style.cursor = "pointer";
			state.iconClickHandler = () => {
				const val = parseInt(state.depthSlider?.value || "70", 10);
				state.depthSlider.value = val > 50 ? "30" : "80";
				updateDepth();
			};
			state.depthIcon.addEventListener("click", state.iconClickHandler);
		}
		if (window.matchMedia) {
			state.colorSchemeQuery = window.matchMedia("(prefers-color-scheme: light)");
			state.colorSchemeHandler = (event) => {
				if (!state.depthSlider) return;
				state.depthSlider.value = event.matches ? "70" : "30";
				updateDepth();
			};
			if (state.colorSchemeQuery.addEventListener) {
				state.colorSchemeQuery.addEventListener("change", state.colorSchemeHandler);
			} else if (state.colorSchemeQuery.addListener) {
				state.colorSchemeQuery.addListener(state.colorSchemeHandler);
			}
		}
		applySystemPreference();
		state.inited = true;
		state.loggedAnimateStart = false;
		DBG("init complete; starting animate loop");
		animate();
	}
	function animate() {
		if (!state.inited) return;
		if (!state.loggedAnimateStart) {
			DBG("animate start");
			state.loggedAnimateStart = true;
		}
		const nowTs = performance.now();
		const dt = state.prevFrameNow
			? Math.max(0.001, (nowTs - state.prevFrameNow) / 1000)
			: 0.016;
		state.prevFrameNow = nowTs;
		state.time += dt;
		if (state.raysCanvas) {
			const ctx = state.raysCanvas.getContext("2d");
			ctx.clearRect(0, 0, state.viewportWidth, state.viewportHeight);
			ctx.globalCompositeOperation = "screen";
			state.rays.forEach((ray) => {
				const sway = Math.sin(state.time * ray.speed + ray.phase) * 15;
				const breathing = Math.sin(state.time * 0.4 + ray.phase) * 0.5 + 0.5;
				const alpha = ray.opacity * (0.4 + state.brightness * 0.6) * breathing;
				if (alpha > 0.01) {
					const startX = ray.x + sway,
						endX = startX + Math.sin(0.3) * ray.length,
						endY = ray.y + Math.cos(0.3) * ray.length;
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
		if (state.sparklesCanvas) {
			const ctx = state.sparklesCanvas.getContext("2d");
			ctx.clearRect(
				0,
				0,
				state.sparklesCanvas.width,
				state.sparklesCanvas.height,
			);
			ctx.globalCompositeOperation = "source-over";
			// Sparkles: update and draw in viewport slice
			let visible = 0;
			for (let i = 0; i < state.sparkles.length; i++) {
				const sp = state.sparkles[i];
				sp.y -= sp.speed;
				sp.x += Math.sin(sp.y * 0.005 + sp.wobble) * 0.3;
				sp.wobble += sp.wobbleSpeed;
				if (sp.y < state.scrollY - 120) {
					sp.y = state.scrollY + state.viewportHeight + 120;
					sp.x = Math.random() * state.viewportWidth * 2;
				}
				if (
					sp.y >= state.scrollY - 100 &&
					sp.y <= state.scrollY + state.viewportHeight + 100
				) {
					visible++;
					const tw = Math.sin(state.time * 2 + sp.phase) * 0.5 + 0.5;
					const alpha = sp.maxOpacity * tw;
					if (alpha > 0.01) {
						const vx = sp.x,
							vy = sp.y - state.scrollY;
						const g = ctx.createRadialGradient(
							vx,
							vy,
							0,
							vx,
							vy,
							sp.radius * 2,
						);
						g.addColorStop(0, `rgba(255,255,230,${alpha})`);
						g.addColorStop(0.5, `rgba(255,255,255,${alpha * 0.8})`);
						g.addColorStop(1, `rgba(255,255,255,0)`);
						ctx.beginPath();
						ctx.arc(vx, vy, sp.radius * 2, 0, Math.PI * 2);
						ctx.fillStyle = g;
						ctx.fill();
						ctx.beginPath();
						ctx.arc(vx, vy, sp.radius * 0.6, 0, Math.PI * 2);
						ctx.fillStyle = `rgba(255,255,255,${alpha})`;
						ctx.fill();
					}
				}
			}
			// Optional interactive currents (disabled by default for perf)
			if (INTERACTIVE_CURRENTS) {
				if (state.mouse.active) {
					const k = 8,
						damp = Math.max(0, 1 - 4 * dt);
					const mx = state.mouse.x,
						my = state.scrollY + state.mouse.y;
					const ax = (mx - state.mass.x) * k,
						ay = (my - state.mass.y) * k;
					state.mass.vx = (state.mass.vx + ax * dt) * damp;
					state.mass.vy = (state.mass.vy + ay * dt) * damp;
					state.mass.x += state.mass.vx * dt;
					state.mass.y += state.mass.vy * dt;
				}
				const lastSampleAge = state.mouseHistory.length
					? nowTs - state.mouseHistory[state.mouseHistory.length - 1].t
					: Infinity;
				const recentMotion = lastSampleAge < 120;
				const angleCandidate = recentMotion
					? getMouseAngleOver(200, nowTs)
					: null;
				if (angleCandidate != null) state.lastDirAngle = angleCandidate;
				const angNow = angleCandidate ?? state.lastDirAngle;
				const speedNow = recentMotion ? getMouseSpeedOver(200, nowTs) : 0;
				const avgWindow = recentMotion
					? getAverageSpeedLastFrames(4)
					: { speed: 0, duration: 0 };
				const avgSpeed = avgWindow.speed;
				const movingDuration =
					recentMotion && state.mouseHistory.length
						? (nowTs - state.mouseHistory[0].t) / 1000
						: 0;
				const movingOk = recentMotion && avgSpeed > 60 && movingDuration >= 0.3;
				state.movingStartAt = movingOk ? state.mouseHistory[0].t : 0;
				const cappedSpeed = Math.min(600, avgSpeed);
				state.lastMoving = movingOk
					? {
							x: state.mouse.x,
							y: state.scrollY + state.mouse.y,
							angle: angNow,
							speed: cappedSpeed,
							t: nowTs,
						}
					: null;
				maybeSpawnEddyOnTurn(nowTs);
				const SPEED_THRESHOLD = 180;
				if (
					movingOk &&
					nowTs >= state.nextContinuousSpawnAt &&
					nowTs >= state.newDirectionCooldownUntil
				) {
					const mx = state.mouse.x,
						my = state.scrollY + state.mouse.y;
					const streakCount = Math.random() < 0.3 ? 2 : 1;
					const clampedSpeed = Math.min(MAX_STREAK_SPEED, cappedSpeed);
					for (let i = 0; i < streakCount; i++)
						spawnStreak(mx, my, angNow, clampedSpeed);
					const v = Math.min(600, Math.max(SPEED_THRESHOLD, cappedSpeed));
					const t = (v - SPEED_THRESHOLD) / (600 - SPEED_THRESHOLD);
					const freq =
						STREAK_FREQ_MIN + t * (STREAK_FREQ_MAX - STREAK_FREQ_MIN);
					state.nextContinuousSpawnAt = nowTs + 1000 / freq;
					state.lastContinuousSpawnAt = nowTs;
				}
				ctx.save();
				ctx.globalCompositeOperation = SWIRL_RENDER_COMPOSITE;
				const reefRGB = state.reefRGB,
					scrollY = state.scrollY,
					reefStroke = `rgb(${reefRGB})`;
				const renderMode = SWIRL_RENDER_MODE;
				const renderStyle = SWIRL_RENDER_STYLE;
				const baseAlpha = SWIRL_RENDER_ALPHA;
				const bucketCount = Math.max(1, SWIRL_RENDER_BUCKETS);
				const bucketStep = 1 / bucketCount;
				const dotRadius = Math.max(0.4, SWIRL_RENDER_LINE_WIDTH * 0.6);

				// Swirls: update + draw without per-frame array allocations and without per-segment gradients.
				// Hotspots (profiled): the old total length scans + createLinearGradient per segment were expensive.
				ctx.lineWidth = SWIRL_RENDER_LINE_WIDTH;
				ctx.lineCap = "round";
				ctx.lineJoin = "round";
				ctx.shadowColor = "transparent";
				ctx.shadowBlur = 0;
				let swWrite = 0;
				for (let si = 0; si < state.swirls.length; si++) {
					const s = state.swirls[si];
					const lifeT = (nowTs - s.created) / s.lifetime;
					if (lifeT >= 1) continue;

					const dtL = Math.max(0.001, (nowTs - (s.prevTime || nowTs)) / 1000);
					s.prevTime = nowTs;
					const ramp = Math.min(1, (nowTs - s.created) / 300);
					const inStraight =
						!s.turned &&
						(s.forwardTarget || 0) > 0 &&
						(s.forwardDist || 0) < (s.forwardTarget || 0);
					let angFric = inStraight ? 2.0 : 1.3,
						radFric = inStraight ? 0.6 : 2.2;
					s.angVel *= Math.max(0, 1 - angFric * dtL);
					s.radVel = Math.max(0, s.radVel - radFric * 120 * dtL);

					if (!inStraight && !s.turned) {
						const curlSign = s.dir || 1;
						s.angVel += curlSign * (s.curlStrength ?? 0.25) * 1.0;
						s.radVel *= 0.6;
						s.turnedAt = nowTs;
						const omMin = s.omegaMin ?? SWIRL_OMEGA_MIN;
						const omMax = s.omegaMax ?? SWIRL_OMEGA_MAX;
						const om = omMin + Math.random() * Math.max(0, omMax - omMin);
						s.baseOmega = om * (s.dir || 1);
						// Align the swirl center so the first curved point is continuous with the straight path.
						// Also align angle so the circle tangent matches the straight direction.
						const alignAngle = (s.baseAngle || 0) - curlSign * (Math.PI / 2);
						s.angle = alignAngle;
						const currentX = s.straightX;
						const currentY = s.straightY;
						const r0 = s.rad || 0;
						s.cx = currentX - Math.cos(s.angle) * r0;
						s.cy = currentY - Math.sin(s.angle) * r0;
						s.turned = true;
					}

					let effAng = inStraight ? 0 : s.angVel;
					if (!inStraight && s.turned) {
						const swirlAge = nowTs - (s.turnedAt || nowTs);
						if (swirlAge < (s.swirlBurstMs || 250)) {
							angFric = 0.3;
							const sign = Math.sign(effAng) || Math.sign(s.baseOmega) || 1;
							const minOm = Math.abs(s.baseOmega || 2.0);
							const mag = Math.max(Math.abs(effAng), minOm);
							effAng = sign * mag;
							const cap = s.maxRad || 38,
								target = s.targetRad || 30;
							s.rad += (target - s.rad) * Math.min(1, 2 * dtL);
							s.radVel *= Math.max(0, 1 - 3 * dtL);
						}
						// Keep a small baseline rotation so the swirl continues orbiting.
						const minOmega = Math.abs(s.baseOmega || 0) * 0.35;
						const sign = Math.sign(s.angVel || s.baseOmega || 1);
						if (Math.abs(s.angVel) < minOmega) s.angVel = sign * minOmega;
						if (s.turnModel === "arc") {
							const speed = Math.max(
								20,
								s.forwardSpeed || SWIRL_SETTINGS.burst.speed,
							);
							const minRad = Math.max(1, s.turnMinRad || SWIRL_TURN_MIN_RAD);
							const maxOmega = Math.max(
								1,
								s.turnOmegaMax || SWIRL_TURN_OMEGA_MAX,
							);
							const targetOmega =
								Math.min(
									maxOmega,
									(speed * (s.turnSpeedScale || SWIRL_TURN_SPEED_SCALE)) /
										Math.max(s.rad, minRad),
								) * (s.dir || 1);
							const blend = Math.min(1, 6 * dtL);
							s.angVel = s.angVel + (targetOmega - s.angVel) * blend;
							effAng = s.angVel;
						}
					}

					const cap = s.maxRad || 28,
						approach = Math.min(1, s.rad / cap),
						radialFactor = Math.max(0.2, 1 - approach * 0.8);
					const vx0 = s.cVx || 0,
						vy0 = s.cVy || 0;
					const v0 = Math.hypot(vx0, vy0);
					if (v0 > 0) {
						const v1 = Math.max(0, v0 - DRIFT_DRAG_COEFF * v0 * v0 * dtL);
						const scale = v1 / v0;
						s.cVx = vx0 * scale;
						s.cVy = vy0 * scale;
					}

					const prevCx = s.cx || 0,
						prevCy = s.cy || 0;
					if (inStraight) {
						const step = (s.forwardSpeed || 200) * dtL;
						s.forwardDist = (s.forwardDist || 0) + step;
						s.straightX += Math.cos(s.baseAngle || 0) * step;
						s.straightY += Math.sin(s.baseAngle || 0) * step;
					} else {
						s.cx += (s.cVx || 0) * dtL;
						s.cy += (s.cVy || 0) * dtL;
						const dtx = (s.cx || 0) - prevCx,
							dty = (s.cy || 0) - prevCy;
						const curlSide = s.dir || 1;
						const perpA = (s.baseAngle || 0) - (curlSide * Math.PI) / 2;
						const ux = Math.cos(perpA),
							uy = Math.sin(perpA);
						const segDrift = PERP_SEG_DRIFT * dtL;
						// Instead of translating every trail point each frame, accumulate offsets.
						s.trailOx = (s.trailOx || 0) + dtx + ux * segDrift;
						s.trailOy = (s.trailOy || 0) + dty + uy * segDrift;
					}

					const tightness = s.curveTightness || SWIRL_CURVE_TIGHTNESS;
					const turnRamp = inStraight
						? ramp
						: s.turnRampScale || SWIRL_TURN_RAMP_SCALE;
					s.rad += s.radVel * dtL * turnRamp * radialFactor * (1 / tightness);
					if (s.rad > cap) s.rad = cap;
					s.angle += effAng * dtL * turnRamp * tightness;

					const px = inStraight
						? s.straightX
						: (s.cx || 0) + Math.cos(s.angle) * s.rad;
					const py = inStraight
						? s.straightY
						: (s.cy || 0) + Math.sin(s.angle) * s.rad;
					const tox = s.trailOx || 0,
						toy = s.trailOy || 0;
					s.trail.push({ x: px - tox, y: py - toy, t: lifeT });
					if (s.trail.length > SWIRL_MAX_TRAIL_POINTS) s.trail.shift();

					// Hide the start of the trail using a point fraction (cheap) instead of scanning lengths each frame.
					const maxStart = Math.min(
						Math.max(0, s.trail.length - 2),
						Math.max(0, SWIRL_MAX_TRAIL_POINTS - 2),
					);
					const startIdxFloat = s.trail.length * SWIRL_HIDE_FRACTION;
					const startIdx = Math.min(
						maxStart,
						Math.max(0, Math.floor(startIdxFloat)),
					);
					const visCount = s.trail.length - startIdx;
					if (visCount >= 2) {
						const stepN = Math.max(
							1,
							Math.ceil(visCount / SWIRL_DRAW_SEGMENTS),
						);
						const seed = s.seed | 0 || 1;
						const headFadeSpan = Math.max(
							1,
							Math.floor(visCount * Math.max(0, SWIRL_HEAD_FADE)),
						);
						const tailFadeSpan = Math.max(
							1,
							Math.floor(visCount * Math.max(0, SWIRL_TAIL_FADE)),
						);
						ctx.strokeStyle = reefStroke;
						ctx.fillStyle = reefStroke;
						const singleStroke = renderMode === "singleStroke";
						if (singleStroke) {
							ctx.globalAlpha = baseAlpha;
							ctx.beginPath();
						}
						for (let i = startIdx + 1; i < s.trail.length; i += stepN) {
							const a = s.trail[i - 1],
								b = s.trail[i];
							const idxFrac = (i - startIdx) / visCount;
							const env = 1 - Math.abs(2 * idxFrac - 1);
							const timeBias = Math.max(0, 1 - lifeT * (0.3 + 0.7 * idxFrac));
							const globalFade = Math.max(
								0,
								0.5 * (1 + Math.cos(Math.PI * lifeT)),
							);
							const headFade =
								SWIRL_HEAD_FADE > 0
									? Math.min(1, Math.max(0, (i - startIdxFloat) / headFadeSpan))
									: 1;
							const tailFade =
								SWIRL_TAIL_FADE > 0
									? Math.min(
											1,
											Math.max(0, (s.trail.length - i) / tailFadeSpan),
										)
									: 1;
							const alpha =
								baseAlpha * env * timeBias * globalFade * headFade * tailFade;
							if (alpha <= 0.002) continue;

							const dx = b.x - a.x,
								dy = b.y - a.y;
							const segLen = Math.hypot(dx, dy) || 1;
							const inv = 1 / segLen;
							const nx = dy * inv,
								ny = -dx * inv;
							// Cheap, stable jitter (no trig).
							const r = (Math.imul(i + 1, 1664525) + seed) | 0;
							const j = (((r >>> 0) / 4294967296) * 2 - 1) * 1.2;
							const ax = a.x + nx * j + tox,
								ay = a.y + ny * j + toy;
							const bx = b.x + nx * j + tox,
								by = b.y + ny * j + toy;

							if (singleStroke) {
								if (renderStyle === "dots") {
									ctx.moveTo(ax + dotRadius, ay - scrollY);
									ctx.arc(ax, ay - scrollY, dotRadius, 0, Math.PI * 2);
								} else {
									ctx.moveTo(ax, ay - scrollY);
									ctx.lineTo(bx, by - scrollY);
								}
								continue;
							}

							if (renderMode === "bucketed") {
								const bucket = Math.min(
									bucketCount - 1,
									Math.max(0, Math.floor(alpha / bucketStep)),
								);
								const quant = Math.max(
									0.001,
									Math.min(1, bucket * bucketStep + bucketStep * 0.5),
								);
								ctx.globalAlpha = quant;
								ctx.beginPath();
								if (renderStyle === "dots") {
									ctx.moveTo(ax + dotRadius, ay - scrollY);
									ctx.arc(ax, ay - scrollY, dotRadius, 0, Math.PI * 2);
									ctx.fill();
								} else {
									ctx.moveTo(ax, ay - scrollY);
									ctx.lineTo(bx, by - scrollY);
									ctx.stroke();
								}
							} else {
								ctx.globalAlpha = alpha;
								ctx.beginPath();
								if (renderStyle === "dots") {
									ctx.moveTo(ax + dotRadius, ay - scrollY);
									ctx.arc(ax, ay - scrollY, dotRadius, 0, Math.PI * 2);
									ctx.fill();
								} else {
									ctx.moveTo(ax, ay - scrollY);
									ctx.lineTo(bx, by - scrollY);
									ctx.stroke();
								}
							}
						}
						if (singleStroke) {
							if (renderStyle === "dots") ctx.fill();
							else ctx.stroke();
						}
						ctx.globalAlpha = 1;
					}

					state.swirls[swWrite++] = s;
				}
				state.swirls.length = swWrite;

				ctx.globalCompositeOperation = "source-over";
				// Streaks: same deal, avoid filter allocations.
				// Also disable shadows here - streaks are numerous and shadow blur is expensive.
				ctx.shadowBlur = 0;
				ctx.shadowColor = "transparent";
				let stWrite = 0;
				for (let si = 0; si < state.streaks.length; si++) {
					const s = state.streaks[si];
					const life = nowTs - s.created,
						t = life / s.lifetime;
					if (t >= 1) continue;
					s.px = s.x;
					s.py = s.y;
					s.speed = Math.max(
						0,
						s.speed - STREAK_DRAG_COEFF * s.speed * s.speed * dt,
					);
					const step = s.speed * dt;
					s.x += Math.cos(s.angle) * step;
					s.y += Math.sin(s.angle) * step;
					const dy1 = s.py - scrollY,
						dy2 = s.y - scrollY;
					ctx.beginPath();
					ctx.moveTo(s.px, dy1);
					ctx.lineTo(s.x, dy2);
					ctx.strokeStyle = `rgba(255,255,255,${0.4 * (1 - t)})`;
					ctx.lineWidth = 1.25;
					ctx.lineCap = "round";
					ctx.stroke();
					state.streaks[stWrite++] = s;
				}
				state.streaks.length = stWrite;

				ctx.restore();
			}
		}
		// Perf logging every ~2s
		const end = performance.now();
		state.perf.frames++;
		state.perf.accum += end - nowTs;
		if (!state.perf.lastReport) state.perf.lastReport = end;
		if (end - state.perf.lastReport > 2000) {
			DBG("perf", {
				fps: Math.round(
					(state.perf.frames * 1000) / (end - state.perf.lastReport),
				),
				avgMs: +(state.perf.accum / state.perf.frames).toFixed(2),
				sparkles: state.sparkles.length,
				swirls: state.swirls.length,
				streaks: state.streaks.length,
			});
			state.perf.frames = 0;
			state.perf.accum = 0;
			state.perf.lastReport = end;
		}
		state.raf = requestAnimationFrame(animate);
	}
	function initHomeAnimation() {
		if (typeof window === "undefined") return;
		DBG("initHomeAnimation");
		state.retries = 0;
		init();
	}
	function stopHomeAnimation() {
		DBG("stopHomeAnimation");
		if (state.raf) {
			cancelAnimationFrame(state.raf);
			state.raf = 0;
		}
		removeHandlers();
		state.inited = false;
		state.prevFrameNow = 0;
		state.rays = [];
		state.sparkles = [];
		state.swirls = [];
		state.streaks = [];
		state.raysCanvas = null;
		state.sparklesCanvas = null;
		state.waterLayer = null;
		state.waterFx = null;
		state.depthSlider = null;
		state.depthControl = null;
		state.depthIcon = null;
		const waterFx = document.getElementById("waterFxHome");
		if (waterFx) waterFx.remove();
	}
	window.__homeAnim = { initHomeAnimation, stopHomeAnimation };
})();
