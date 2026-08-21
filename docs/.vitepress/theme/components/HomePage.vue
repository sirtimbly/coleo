<script setup lang="ts">
import { ref } from "vue";

interface ShowcaseView {
  label: string;
  eyebrow: string;
  title: string;
  description: string;
  src: string;
  alt: string;
  width: number;
  height: number;
  contain?: boolean;
}

const showcaseViews: readonly ShowcaseView[] = [
  {
    label: "Plan",
    eyebrow: "Living direction",
    title: "Shape the canonical plan",
    description: "Edit the durable project documents that inform Brain and Arm work, then prepare tasks from the latest direction.",
    src: "/screenshots/plan%20editor.png",
    alt: "Coleo Plan and Documents workspace showing the project file tree and canonical plan editor.",
    width: 2504,
    height: 1656,
  },
  {
    label: "Tasks",
    eyebrow: "Observable execution",
    title: "See the plan become work",
    description: "Inspect burndown, activity, priority, phase, and task state while execution progresses.",
    src: "/screenshots/tasks%20screen.png",
    alt: "Coleo Tasks workspace showing a burndown chart, status controls, and the generated task grid.",
    width: 2522,
    height: 1890,
  },
  {
    label: "Garden",
    eyebrow: "Shared environment",
    title: "Watch the organism take shape",
    description: "Move through the shared Garden, inspect the Brain and arms, and choose where new agents run.",
    src: "/screenshots/arm%20garden.png",
    alt: "Coleo Garden beside the Spawn New Arm panel, showing the Brain and agent forms in the shared environment.",
    width: 2492,
    height: 2292,
  },
  {
    label: "CLI",
    eyebrow: "Composable control",
    title: "Operate from any shell",
    description: "Inspect health, manage arms, query tasks, and follow live activity with commands made for local work and automation.",
    src: "/screenshots/coleo-cli.jpg",
    alt: "Coleo command-line interface showing system health, connected arms, tasks, and a live activity stream.",
    width: 1280,
    height: 720,
    contain: true,
  },
  {
    label: "TUI",
    eyebrow: "Terminal observatory",
    title: "Stay close to every heartbeat",
    description: "Navigate arms, messages, discoveries, status reports, and live activity in a full-screen terminal workspace.",
    src: "/screenshots/arm%20tui.png",
    alt: "Coleo terminal interface showing four arms, one selected arm's details, and its live activity stream.",
    width: 2442,
    height: 2434,
    contain: true,
  },
] as const;

const activeShowcase = ref(0);

function selectShowcase(index: number): void {
  activeShowcase.value = index;
}

function moveShowcase(direction: number): void {
  activeShowcase.value = (activeShowcase.value + direction + showcaseViews.length) % showcaseViews.length;
}
</script>

<template>
  <div class="landing-shell landing-shell-simple">
    <a class="landing-skip" href="#main-content">Skip to content</a>
    <div id="waterLayer" class="water-layer" aria-hidden="true"></div>
    <canvas id="raysCanvas" class="rays-layer" aria-hidden="true"></canvas>
    <canvas id="sparklesCanvas" class="sparkles-layer" aria-hidden="true"></canvas>
    <div id="depthControl" class="depth-control">
      <button id="depthIcon" type="button" aria-label="Toggle scene brightness">💡</button>
      <input id="depthSlider" type="range" min="0" max="100" value="70" aria-label="Scene brightness" />
    </div>

    <header class="landing-nav landing-nav-organic">
      <a class="landing-brand" href="/">
        <img src="/coleo-logo.png" alt="" width="600" height="600" />
        <span>Coleo</span>
      </a>
      <nav class="landing-nav-links" aria-label="Primary navigation">
        <a href="#workflow">How it works</a>
        <a href="#observatory">Interfaces</a>
        <a href="/guides/getting-started">Documentation</a>
        <a href="/architecture/overview">Architecture</a>
        <a href="https://github.com/sirtimbly/coleo">GitHub <span aria-hidden="true">↗</span></a>
      </nav>
    </header>

    <main id="main-content">
      <section class="landing-hero landing-hero-organic" aria-labelledby="landing-title">
        <div class="landing-hero-copy">
          <p class="landing-kicker">Self-hosted multi-agent control plane</p>
          <h1 id="landing-title">Stop baby-sitting your agents.</h1>
          <p class="landing-thesis">Install Coleo to use organic intelligence with observability.</p>
          <p class="landing-lede">
            Coding agents are the arms of this organism, each posessing it's own intelligence, but limited in it's focus. The brain monitors the situation, assigns work, preserves what they learn, and answers their questions. Coleo creates the distributed infrastructure to make it work, and a human interface to manage the overall project.
          </p>
          <div class="landing-actions">
            <a class="landing-action landing-action-primary" href="/guides/getting-started">
              Self-hosted Setup <span aria-hidden="true">→</span>
            </a>
            <a class="landing-action landing-action-secondary" href="/architecture/overview">
              How Coleo works
            </a>
          </div>
        </div>

        <figure class="plan-organism">
          <div class="plan-halo" aria-hidden="true"></div>
          <svg class="organism-currents" viewBox="0 0 520 640" aria-hidden="true">
            <path d="M260 104 C260 146 260 157 260 190" />
            <path d="M220 242 C161 214 105 193 61 146" />
            <path d="M300 241 C363 216 418 194 463 149" />
            <path d="M211 372 C148 398 104 438 68 489" />
            <path d="M309 372 C371 401 419 438 455 489" />
            <path d="M260 422 C260 468 260 493 260 536" />
          </svg>
          <div class="plan-brain">
            <img src="/coleo-pet-v2.png" alt="" width="600" height="600" />
            <span>Brain</span>
          </div>
          <div class="living-plan-sheet">
            <p>Living plan</p>
            <strong>Coordination Server</strong>
            <ul>
              <li><span></span>Maintain Purpose</li>
              <li><span></span>Verify Progress</li>
              <li><span></span>Integrate Discoveries</li>
              <li><span></span>Route Messages</li>
            </ul>
          </div>
          <ul class="arm-signals" aria-label="Signals shared by agent arms">
            <li class="arm-signal arm-signal-one"><span>Arm 01</span> Claim Task</li>
            <li class="arm-signal arm-signal-two"><span>Arm 02</span> Review Work</li>
            <li class="arm-signal arm-signal-three"><span>Arm 03</span> Report Problem</li>
            <li class="arm-signal arm-signal-four"><span>Arm 04</span> Update Plans</li>
          </ul>
          <div class="human-altitude"><strong>Human:</strong> Write & Review</div>
        </figure>
      </section>

      <section id="workflow" class="quick-start workflow-section" aria-labelledby="workflow-title">
        <div class="workflow-intro">
          <h2 id="workflow-title">Manage numerous agents with the Coleo infrastructure.</h2>
          <p>Your plain-text plan will be regularly synced with a database of tasks for agents on multiple hosts to access. Human operators get detailed oversight of the generated plans and can quickly add and modify work in multiple ways. Coleo keeps reevaluating the project as work progresses, so sagents receive the best directions for the current moment and state of the project. Conflicts are resolved by the brain.</p>
          <a class="text-link" href="/guides/task-workflow">See the complete task workflow <span aria-hidden="true">→</span></a>
        </div>
        <svg class="workflow-current" viewBox="0 0 1000 180" preserveAspectRatio="none" aria-hidden="true">
          <path d="M45 94 C155 22 247 27 327 91 S504 160 585 94 S756 20 955 91" />
        </svg>
        <ol class="workflow-steps">
          <li>
            <span class="workflow-marker">1</span>
            <div><h3>Set the direction</h3><p>Describe the goal, constraints, and checkpoints in your project plan.</p></div>
          </li>
          <li>
            <span class="workflow-marker">2</span>
            <div><h3>The Brain coordinates</h3><p>Coleo evaluates the plan, completed tasks, discoveries, and agent status to decide what happens next.</p></div>
          </li>
          <li>
            <span class="workflow-marker">3</span>
            <div><h3>Arms work in parallel</h3><p>Multiple agents claim tasks, execute independently, and return findings to shared context.</p></div>
          </li>
          <li>
            <span class="workflow-marker">4</span>
            <div><h3>Choose your involvement</h3><p>Observe everything, require approval at checkpoints, intervene directly, or let the system continue.</p></div>
          </li>
        </ol>
      </section>

      <section id="observatory" class="product-observatory" aria-labelledby="observatory-title">
        <div class="observatory-intro">
          <p class="section-label">The Observatory</p>
          <h2 id="observatory-title">A complete web app. A CLI and TUI when you want them.</h2>
          <p>Use the full Observatory to plan and inspect execution, automate the same control plane from the CLI, or stay immersed in the live terminal interface.</p>
        </div>

        <div
          class="showcase-carousel"
          role="region"
          aria-roledescription="carousel"
          aria-label="Coleo interfaces"
          tabindex="0"
          @keydown.left.prevent="moveShowcase(-1)"
          @keydown.right.prevent="moveShowcase(1)"
        >
          <div class="showcase-stage">
            <figure
              v-for="(view, index) in showcaseViews"
              :id="`showcase-slide-${index}`"
              :key="view.src"
              class="showcase-slide"
              :class="{ 'is-active': activeShowcase === index }"
              :aria-hidden="activeShowcase !== index"
            >
              <img
                :src="view.src"
                :alt="view.alt"
                :class="{ 'is-contained': view.contain }"
                :width="view.width"
                :height="view.height"
                :loading="index === 0 ? 'eager' : 'lazy'"
                decoding="async"
              />
            </figure>
            <span class="showcase-feed-label" aria-hidden="true">
              Observatory current · {{ String(activeShowcase + 1).padStart(2, "0") }} / {{ String(showcaseViews.length).padStart(2, "0") }}
            </span>
          </div>

          <div class="showcase-caption" aria-live="polite">
            <div>
              <span>{{ showcaseViews[activeShowcase].eyebrow }}</span>
              <h3>{{ showcaseViews[activeShowcase].title }}</h3>
            </div>
            <p>{{ showcaseViews[activeShowcase].description }}</p>
          </div>

          <div class="showcase-controls">
            <button type="button" aria-label="Show previous interface" @click="moveShowcase(-1)">←</button>
            <div aria-label="Choose an interface">
              <button
                v-for="(view, index) in showcaseViews"
                :key="view.label"
                type="button"
                :class="{ 'is-active': activeShowcase === index }"
                :aria-pressed="activeShowcase === index"
                :aria-controls="`showcase-slide-${index}`"
                @click="selectShowcase(index)"
              >
                <span>{{ String(index + 1).padStart(2, "0") }}</span>
                {{ view.label }}
              </button>
            </div>
            <button type="button" aria-label="Show next interface" @click="moveShowcase(1)">→</button>
          </div>
        </div>
      </section>

      <section class="docs-routes docs-routes-organic" aria-labelledby="docs-routes-title">
        <div class="docs-routes-head">
          <div>
            <p class="section-label">Documentation</p>
            <h2 id="docs-routes-title">An architecture that enables complex management and multi-user collaboration.</h2>
          </div>
          <p>Our distributed architecture enables remote agent sandboxes, a robust web UI and functional CLI and TUI. Set up your local orchestrator and manage it how you like.</p>
        </div>

        <nav class="docs-depth-map" aria-label="Documentation paths">
          <svg viewBox="0 0 600 540" preserveAspectRatio="none" aria-hidden="true">
            <path d="M42 16 C58 112 28 179 91 265 S159 394 233 524" />
          </svg>
          <a class="depth-route depth-route-one" href="/guides/getting-started">
            <span class="depth-route-level">Surface · Begin</span>
            <span class="depth-route-copy"><strong>Getting started</strong><small>Install Coleo and launch a local control plane.</small></span>
            <span class="depth-route-arrow" aria-hidden="true">↗</span>
          </a>
          <a class="depth-route depth-route-two" href="/guides/task-workflow">
            <span class="depth-route-level">Current · Operate</span>
            <span class="depth-route-copy"><strong>Task workflow</strong><small>Create work, route it through the Brain, and inspect outcomes.</small></span>
            <span class="depth-route-arrow" aria-hidden="true">↗</span>
          </a>
          <a class="depth-route depth-route-three" href="/philosophy">
            <span class="depth-route-level">Garden · Principles</span>
            <span class="depth-route-copy"><strong>Philosophy</strong><small>Understand coordinated independence and the Octopus Model.</small></span>
            <span class="depth-route-arrow" aria-hidden="true">↗</span>
          </a>
          <a class="depth-route depth-route-four" href="/architecture/overview">
            <span class="depth-route-level">Deep structure · System</span>
            <span class="depth-route-copy"><strong>Architecture</strong><small>Trace the API, event stream, state, harnesses, and Observatory.</small></span>
            <span class="depth-route-arrow" aria-hidden="true">↗</span>
          </a>
        </nav>
      </section>
    </main>

    <footer class="landing-footer landing-footer-organic">
      <p>Distributed agent orchestration for software development.</p>
      <div>
        <a href="https://coleo.app">Hosted</a>
        <a href="/licensing">License</a>
        <a href="https://github.com/sirtimbly/coleo">Source</a>
      </div>
    </footer>
  </div>
</template>
