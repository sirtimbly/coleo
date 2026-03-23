import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";

const ROOT_DIR = process.cwd();
const OUTPUT_DIR = path.join(ROOT_DIR, "artifacts", "docs-demo");
const RAW_DIR = path.join(OUTPUT_DIR, "raw");

const DOCS_URL = process.env.DOCS_DEMO_URL ?? "http://127.0.0.1:4173";
const DOCS_PORT = process.env.DOCS_DEMO_PORT ?? "4173";
const API_URL = process.env.APP_API_URL ?? "http://127.0.0.1:8080/api/health";
const APP_URL = process.env.APP_DEMO_URL ?? "http://127.0.0.1:5173";
const APP_PORT = process.env.APP_DEMO_PORT ?? "5173";

const DOCS_TARGET_MS = 56_000;
const APP_TARGET_MS = 28_000;

function log(message: string): void {
  console.log(`[docs-demo] ${message}`);
}

async function wait(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

function spawnProcess(command: string[], cwd = ROOT_DIR): Bun.Subprocess {
  return Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitForServer(url: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }
    await wait(600);
  }

  throw new Error(`Timed out waiting for server ${url}`);
}

async function isServerReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

function killProcess(process: Bun.Subprocess | null): void {
  if (!process) {
    return;
  }
  try {
    process.kill();
  } catch {
    // ignore shutdown errors
  }
}

function runFfmpeg(args: string[], description: string): void {
  log(description);
  const ffmpeg = Bun.spawnSync(["ffmpeg", "-y", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (ffmpeg.exitCode !== 0) {
    const stdoutText = new TextDecoder().decode(ffmpeg.stdout);
    const stderrText = new TextDecoder().decode(ffmpeg.stderr);
    throw new Error(`ffmpeg failed (${ffmpeg.exitCode})\n${stdoutText}\n${stderrText}`);
  }
}

function readDuration(filePath: string): number {
  const probe = Bun.spawnSync([
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (probe.exitCode !== 0) {
    const stderrText = new TextDecoder().decode(probe.stderr);
    throw new Error(`ffprobe failed for ${filePath}: ${stderrText}`);
  }

  const value = new TextDecoder().decode(probe.stdout).trim();
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unable to parse duration for ${filePath}: ${value}`);
  }
  return parsed;
}

async function addDemoCursor(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      #demo-cursor {
        position: fixed;
        width: 18px;
        height: 18px;
        margin-left: -9px;
        margin-top: -9px;
        border: 2px solid rgba(173, 244, 255, 0.96);
        border-radius: 999px;
        pointer-events: none;
        z-index: 2147483647;
        box-shadow: 0 0 24px rgba(88, 224, 255, 0.8);
      }
      #demo-cursor::after {
        content: "";
        position: absolute;
        inset: 3px;
        border-radius: 999px;
        background: rgba(173, 244, 255, 0.7);
      }
    `,
  });

  await page.evaluate(`
    (() => {
      const existing = document.getElementById("demo-cursor");
      if (existing) {
        existing.remove();
      }
      const cursor = document.createElement("div");
      cursor.id = "demo-cursor";
      cursor.style.left = "-100px";
      cursor.style.top = "-100px";
      document.body.appendChild(cursor);

      window.addEventListener("mousemove", (event) => {
        cursor.style.left = event.clientX + "px";
        cursor.style.top = event.clientY + "px";
      });
    })();
  `);
}

async function moveBezier(
  page: Page,
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  durationMs: number,
  steps = 90,
): Promise<void> {
  const stepDuration = Math.max(8, Math.floor(durationMs / steps));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x =
      (1 - t) ** 3 * p0.x +
      3 * (1 - t) ** 2 * t * p1.x +
      3 * (1 - t) * t ** 2 * p2.x +
      t ** 3 * p3.x;
    const y =
      (1 - t) ** 3 * p0.y +
      3 * (1 - t) ** 2 * t * p1.y +
      3 * (1 - t) * t ** 2 * p2.y +
      t ** 3 * p3.y;
    await page.mouse.move(x, y);
    await wait(stepDuration);
  }
}

async function gentleScroll(page: Page, repeats: number, delta = 140, pauseMs = 120): Promise<void> {
  for (let i = 0; i < repeats; i += 1) {
    await page.mouse.wheel(0, delta);
    await wait(pauseMs);
  }
}

async function docsChoreography(page: Page): Promise<void> {
  await page.goto(DOCS_URL, { waitUntil: "networkidle" });
  await page.mouse.move(960, 540);
  await wait(1500);

  await moveBezier(page, { x: 390, y: 280 }, { x: 700, y: 110 }, { x: 1200, y: 530 }, { x: 1560, y: 240 }, 3200);
  await moveBezier(page, { x: 1560, y: 240 }, { x: 1260, y: 780 }, { x: 780, y: 760 }, { x: 380, y: 390 }, 3100);
  await wait(900);

  const slider = page.locator("#depthSlider");
  if (await slider.count()) {
    const box = await slider.boundingBox();
    if (box) {
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width * 0.72, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.18, y, { steps: 44 });
      await wait(550);
      await page.mouse.move(box.x + box.width * 0.9, y, { steps: 55 });
      await page.mouse.up();
    }
  }

  await wait(900);
  await gentleScroll(page, 22, 105, 95);
  await wait(650);
  await gentleScroll(page, 16, -120, 90);

  await page.goto(`${DOCS_URL}/architecture/overview`, { waitUntil: "networkidle" });
  await wait(900);
  await gentleScroll(page, 14, 120, 100);
  await wait(650);
  await page.goto(DOCS_URL, { waitUntil: "networkidle" });

  await wait(1200);
  await moveBezier(page, { x: 420, y: 310 }, { x: 740, y: 680 }, { x: 1260, y: 90 }, { x: 1640, y: 470 }, 2600);
  await wait(900);
}

async function appChoreography(page: Page): Promise<void> {
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await page.mouse.move(960, 540);
  await wait(1200);

  await moveBezier(page, { x: 320, y: 220 }, { x: 520, y: 180 }, { x: 1050, y: 430 }, { x: 1710, y: 255 }, 2600);
  await wait(700);
  await gentleScroll(page, 8, 120, 100);
  await gentleScroll(page, 8, -120, 95);

  const routes = ["/garden", "/tasks", "/messaging"];
  for (const route of routes) {
    await page.goto(`${APP_URL}${route}`, { waitUntil: "domcontentloaded" });
    await wait(500);
    await moveBezier(page, { x: 520, y: 240 }, { x: 860, y: 200 }, { x: 1300, y: 620 }, { x: 1600, y: 320 }, 1400, 56);
    await wait(450);

    if (route === "/messaging") {
      const button = page.getByRole("button", { name: /new message|compose/i });
      if (await button.count()) {
        await button.first().click();
        await wait(850);
        await page.keyboard.press("Escape");
      }
    }
  }

  await wait(900);
}

async function recordClip(
  outputRawPath: string,
  durationTargetMs: number,
  choreography: (page: Page) => Promise<void>,
): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: {
      dir: RAW_DIR,
      size: { width: 1920, height: 1080 },
    },
  });

  const page = await context.newPage();
  const startedAt = Date.now();

  await addDemoCursor(page);
  await choreography(page);

  const elapsed = Date.now() - startedAt;
  if (elapsed < durationTargetMs) {
    await wait(durationTargetMs - elapsed);
  }

  const video = page.video();
  await context.close();
  await browser.close();

  if (!video) {
    throw new Error("Playwright did not provide a recorded video file.");
  }

  const rawPath = await video.path();
  await cp(rawPath, outputRawPath);
}

function gradeVideo(input: string, output: string): void {
  const duration = readDuration(input);
  const easeOut = `1-pow(1-min(t/${duration.toFixed(3)},1),3)`;
  const zoom = `1+0.12*(${easeOut})`;
  const filter = [
    "fps=60",
    `crop=w='iw/(${zoom})':h='ih/(${zoom})':x='(iw-ow)/2':y='(ih-oh)/2'`,
    "scale=1920:1080:flags=lanczos",
    "eq=saturation=1.09:contrast=1.06:brightness=0.018",
    "format=yuv420p",
    "fps=30",
  ].join(",");

  runFfmpeg(
    [
      "-i",
      input,
      "-vf",
      filter,
      "-an",
      "-c:v",
      "libx264",
      "-crf",
      "14",
      "-preset",
      "slow",
      "-pix_fmt",
      "yuv420p",
      output,
    ],
    `Grading ${path.basename(input)}`,
  );
}

function generateSoundtrack(outputPath: string, durationSec: number): void {
  const duration = durationSec.toFixed(3);
  runFfmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=82:sample_rate=48000:duration=${duration}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=123:sample_rate=48000:duration=${duration}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=246:sample_rate=48000:duration=${duration}`,
      "-f",
      "lavfi",
      "-i",
      `anoisesrc=color=white:sample_rate=48000:duration=${duration}`,
      "-filter_complex",
      "[0:a]volume=0.55,lowpass=f=220,afade=t=in:st=0:d=2.5,afade=t=out:st=86:d=5[a0];[1:a]volume=0.30,lowpass=f=520,afade=t=in:st=0:d=3,afade=t=out:st=86:d=5[a1];[2:a]volume=0.12,lowpass=f=1350,afade=t=in:st=0:d=4,afade=t=out:st=86:d=5[a2];[3:a]volume=0.02,lowpass=f=3600[a3];[a0][a1][a2][a3]amix=inputs=4:normalize=0,apulsator=hz=0.075:amount=0.22,aecho=0.6:0.7:70|140:0.20|0.11,loudnorm=I=-17:LRA=7:TP=-1.5[aout]",
      "-map",
      "[aout]",
      "-c:a",
      "aac",
      "-b:a",
      "256k",
      outputPath,
    ],
    "Generating louder underwater backing track",
  );
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await rm(RAW_DIR, { recursive: true, force: true });
  await mkdir(RAW_DIR, { recursive: true });

  let docsServer: Bun.Subprocess | null = null;
  let apiServer: Bun.Subprocess | null = null;
  let webServer: Bun.Subprocess | null = null;

  const docsRaw = path.join(OUTPUT_DIR, "docs-demo-raw.webm");
  const appRaw = path.join(OUTPUT_DIR, "app-demo-raw.webm");
  const docsGraded = path.join(OUTPUT_DIR, "docs-demo-graded.mp4");
  const appGraded = path.join(OUTPUT_DIR, "app-demo-graded.mp4");
  const combinedVideo = path.join(OUTPUT_DIR, "combined-demo-video.mp4");
  const soundtrack = path.join(OUTPUT_DIR, "underwater-bed.m4a");
  const finalVideo = path.join(OUTPUT_DIR, "docs-demo-final.mp4");

  try {
    if (!(await isServerReady(DOCS_URL))) {
      docsServer = spawnProcess([
        "bun",
        "run",
        "docs:dev",
        "--host",
        "127.0.0.1",
        "--port",
        DOCS_PORT,
      ]);
    }
    log(`Waiting for docs server at ${DOCS_URL}`);
    await waitForServer(DOCS_URL, 60_000);

    if (!(await isServerReady(API_URL))) {
      apiServer = spawnProcess(["bun", "run", "src/cli/index.ts", "serve"]);
    }

    if (!(await isServerReady(APP_URL))) {
      webServer = spawnProcess([
        "bun",
        "run",
        "web:dev",
        "--",
        "--host",
        "127.0.0.1",
        "--port",
        APP_PORT,
      ]);
    }

    log("Waiting for observatory API and web app");
    await waitForServer(API_URL, 70_000);
    await waitForServer(APP_URL, 90_000);

    log("Recording docs clip");
    await recordClip(docsRaw, DOCS_TARGET_MS, docsChoreography);

    log("Recording observatory app clip");
    await recordClip(appRaw, APP_TARGET_MS, appChoreography);

    gradeVideo(docsRaw, docsGraded);
    gradeVideo(appRaw, appGraded);

    runFfmpeg(
      [
        "-i",
        docsGraded,
        "-i",
        appGraded,
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map",
        "[v]",
        "-c:v",
        "libx264",
        "-crf",
        "14",
        "-preset",
        "slow",
        "-pix_fmt",
        "yuv420p",
        combinedVideo,
      ],
      "Concatenating docs + app clips",
    );

    const combinedDuration = readDuration(combinedVideo);
    generateSoundtrack(soundtrack, combinedDuration + 0.5);

    runFfmpeg(
      [
        "-i",
        combinedVideo,
        "-i",
        soundtrack,
        "-shortest",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "256k",
        finalVideo,
      ],
      "Muxing final video with soundtrack",
    );

    log(`Done. Final video: ${finalVideo}`);
    log(`Docs clip: ${docsGraded}`);
    log(`App clip: ${appGraded}`);
    log(`Soundtrack: ${soundtrack}`);
  } finally {
    killProcess(docsServer);
    killProcess(webServer);
    killProcess(apiServer);
  }
}

await main();
