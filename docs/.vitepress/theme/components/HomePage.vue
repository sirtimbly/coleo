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

    <header class="landing-nav landing-nav-simple">
      <a class="landing-brand" href="/">
        <img src="/coleo-logo.png" alt="" width="600" height="600" />
        <span>Coleo</span>
      </a>
      <nav class="landing-nav-links" aria-label="Primary navigation">
        <a href="#workflow">How it works</a>
        <a href="/guides/getting-started">Documentation</a>
        <a href="/architecture/overview">Architecture</a>
        <a href="https://github.com/sirtimbly/coleo">GitHub <span aria-hidden="true">↗</span></a>
      </nav>
    </header>

    <main id="main-content">
      <section class="landing-hero landing-hero-simple" aria-labelledby="landing-title">
        <div class="landing-hero-copy">
          <p class="landing-kicker">Self-hosted multi-agent control plane</p>
          <h1 id="landing-title">Set the plan.<br /><em>Let Coleo organize the execution.</em></h1>
          <p class="landing-lede">
            The Brain progressively assigns work across multiple coding agents, preserves what they learn, and keeps everything observable. Stay hands‑on, require checkpoints, or let the system run.
          </p>
          <div class="landing-actions">
            <a class="landing-action landing-action-primary" href="/guides/getting-started">
              Start locally <span aria-hidden="true">→</span>
            </a>
            <a class="landing-action landing-action-secondary" href="/architecture/overview">
              How Coleo works
            </a>
          </div>
        </div>
      </section>

      <section id="workflow" class="quick-start workflow-section" aria-labelledby="workflow-title">
        <div class="workflow-intro">
          <p class="section-label">How Coleo works</p>
          <h2 id="workflow-title">You write a plan, then many agents rally around it.</h2>
          <p>The plain-text plan will be regularly synced with a database of tasks for agents to access. Human operators get detailed oversight of the generated plans and can quickly add and modify work in multiple ways. Coleo keeps reevaluating the project as work progresses, so agents receive the best directions for the current moment and state of the project. Conflicts are resolved by the brain.</p>
          <a class="text-link" href="/guides/task-workflow">See the complete task workflow <span aria-hidden="true">→</span></a>
        </div>
        <ol class="workflow-steps">
          <li>
            <span>1</span>
            <div><h3>Set the direction</h3><p>Describe the goal, constraints, and checkpoints in your project plan.</p></div>
          </li>
          <li>
            <span>2</span>
            <div><h3>The Brain coordinates</h3><p>Coleo evaluates the plan, completed tasks, discoveries, and agent status to decide what happens next.</p></div>
          </li>
          <li>
            <span>3</span>
            <div><h3>Arms work in parallel</h3><p>Multiple agents claim tasks, execute independently, and return findings to shared context.</p></div>
          </li>
          <li>
            <span>4</span>
            <div><h3>Choose your involvement</h3><p>Observe everything, require approval at checkpoints, intervene directly, or let the system continue.</p></div>
          </li>
        </ol>
      </section>

      <section class="docs-routes docs-routes-simple" aria-labelledby="docs-routes-title">
        <div class="docs-routes-head">
          <div>
            <p class="section-label">Documentation</p>
            <h2 id="docs-routes-title">An architecture that enables complex management and multi-user collaboration.</h2>
          </div>
          <p>Our distributed architecture enables remote agent sandboxes, a robust web UI and functional CLI and TUI. Set up your local orchestrator and manage it how you like.</p>
        </div>

        <div class="docs-link-list">
          <a href="/guides/getting-started">
            <strong>Getting started</strong>
            <small>Install Coleo and launch a local control plane.</small>
          </a>
          <a href="/guides/task-workflow">
            <strong>Task workflow</strong>
            <small>Create work, route it through the Brain, and inspect outcomes.</small>
          </a>
          <a href="/philosophy">
            <strong>Philosophy</strong>
            <small>Understand coordinated independence and the Octopus Model.</small>
          </a>
          <a href="/architecture/overview">
            <strong>Architecture</strong>
            <small>Trace the API, event stream, state, harnesses, and Observatory.</small>
          </a>
        </div>
      </section>
    </main>

    <footer class="landing-footer landing-footer-simple">
      <p>Distributed agent orchestration for software development.</p>
      <div>
        <a href="https://coleo.app">Hosted</a>
        <a href="/licensing">License</a>
        <a href="https://github.com/sirtimbly/coleo">Source</a>
      </div>
    </footer>
  </div>
</template>
