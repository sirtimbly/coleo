# Docs Demo Video Report

Date: 2026-03-16

## Deliverables

- Final video: `artifacts/docs-demo/docs-demo-final.mp4`
- Raw browser capture: `artifacts/docs-demo/docs-demo-raw.webm`
- Graded intermediate: `artifacts/docs-demo/docs-demo-graded.mp4`
- App raw capture: `artifacts/docs-demo/app-demo-raw.webm`
- App graded clip: `artifacts/docs-demo/app-demo-graded.mp4`
- Combined silent base: `artifacts/docs-demo/combined-demo-video.mp4`
- Generated backing track: `artifacts/docs-demo/underwater-bed.m4a`
- Optional Strudel pattern: `.project/reports/strudel-underwater-pattern.js`

## Technical Flow

- Script: `src/scripts/make-docs-demo.ts`
- Command: `bun run demo:docs:video`
- Server lifecycle handled by script:
  - starts `bun run docs:dev --host 127.0.0.1 --port 4173`
  - starts API/web app as needed for observatory capture
  - records docs + app clips with Playwright Chromium video capture (1920x1080)
  - runs FFmpeg post-processing and muxing

## Choreography Highlights

- Homepage hero reveal with underwater rays/sparkles active
- Custom visible cursor overlay for clean cinematic capture
- Curved cursor paths to trigger the interactive swirl/spark effects
- Depth slider interaction pass (bright/dim/bright)
- Smooth scroll through homepage content blocks
- Architecture page transition and return to homepage
- Observatory app pass across `/garden`, `/tasks`, and `/messaging`

## Output Characteristics

- Resolution: 1920x1080
- Duration: ~84.9 seconds
- Format: H.264 + AAC (`.mp4`)
- Approx bitrate: ~2.65 Mbps

## Audio Verification

- Final file contains AAC stereo track (present in stream metadata).
- Loudness probe (`volumedetect`) shows audible levels:
  - mean volume: ~`-17.8 dB`
  - max volume: ~`-8.8 dB`

## Notes

- Backing audio in this run is locally synthesized in FFmpeg for deterministic output.
- If you want strict Strudel-origin audio only, use the provided Strudel pattern and replace `underwater-bed.m4a` before final mux.
