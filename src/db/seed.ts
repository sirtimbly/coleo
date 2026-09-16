import type { Database } from "bun:sqlite";

export async function seedDatabase(db: Database): Promise<void> {
  console.log("Seeding development data...");

  const now = new Date().toISOString();

  // Create some sample arms
  const sampleArms = [
    {
      id: "arm-explorer",
      name: "explorer",
      domain: "general",
      harness: "opencode-api",
      status: "idle",
      context_budget: 300000,
      current_context_used: 45000,
      created_at: now,
      updated_at: now,
      last_activity_at: now,
      personality: "Curious explorer who loves finding new patterns in code",
      convictions: JSON.stringify(["Clean code matters", "Tests are essential"]),
      reputation: 65,
      generation: 1,
      parent_arm_id: null,
      pid: null,
      provider: "opencode",
      model: "gpt-5.1-codex-mini",
      config: JSON.stringify({ workdir: "~/projects" }),
    },
    {
      id: "arm-frontend-expert",
      name: "frontend-expert",
      domain: "frontend",
      harness: "opencode-api",
      status: "idle",
      context_budget: 300000,
      current_context_used: 62000,
      created_at: now,
      updated_at: now,
      last_activity_at: now,
      personality: "Detail-oriented UI specialist focused on accessibility",
      convictions: JSON.stringify(["Accessibility is not optional", "Performance is a feature"]),
      reputation: 72,
      generation: 1,
      parent_arm_id: null,
      pid: null,
      provider: "opencode",
      model: "gpt-5.1-codex-mini",
      config: JSON.stringify({ workdir: "~/projects/web" }),
    },
    {
      id: "arm-backend-architect",
      name: "backend-architect",
      domain: "backend",
      harness: "opencode-api",
      status: "busy",
      context_budget: 300000,
      current_context_used: 125000,
      created_at: now,
      updated_at: now,
      last_activity_at: now,
      personality: "Systems thinker focused on scalability and reliability",
      convictions: JSON.stringify(["Data consistency is paramount", "APIs should be versioned"]),
      reputation: 80,
      generation: 2,
      parent_arm_id: "arm-explorer",
      pid: 12345,
      provider: "opencode",
      model: "claude-opus-4",
      config: JSON.stringify({ workdir: "~/projects/api" }),
    },
  ];

  for (const arm of sampleArms) {
    try {
      db.run(`
        INSERT OR IGNORE INTO arms (
          id, name, domain, harness, status, context_budget, current_context_used,
          created_at, updated_at, last_activity_at, personality, convictions,
          reputation, generation, parent_arm_id, pid, provider, model, config
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        arm.id, arm.name, arm.domain, arm.harness, arm.status, arm.context_budget,
        arm.current_context_used, arm.created_at, arm.updated_at, arm.last_activity_at,
        arm.personality, arm.convictions, arm.reputation, arm.generation,
        arm.parent_arm_id, arm.pid, arm.provider, arm.model, arm.config
      ]);
    } catch (err) {
      console.log(`Arm ${arm.name} already exists or error: ${err}`);
    }
  }

  // Create some activity entries
  const sampleActivity = [
    { actor: "brain", action: "started", target: null, details: JSON.stringify({}) },
    { actor: "arm-explorer", action: "registered", target: null, details: JSON.stringify({ domain: "general" }) },
    { actor: "arm-frontend-expert", action: "registered", target: null, details: JSON.stringify({ domain: "frontend" }) },
    { actor: "arm-backend-architect", action: "registered", target: null, details: JSON.stringify({ domain: "backend" }) },
    { actor: "arm-backend-architect", action: "claimed", target: "src/api/server.ts", details: JSON.stringify({ claim_type: "write" }) },
  ];

  for (const entry of sampleActivity) {
    try {
      db.run(`
        INSERT INTO activity (timestamp, actor, action, target, details)
        VALUES (?, ?, ?, ?, ?)
      `, [now, entry.actor, entry.action, entry.target, entry.details]);
    } catch (err) {
      console.log(`Activity entry error: ${err}`);
    }
  }

  // Create a sample proposal
  try {
    db.run(`
      INSERT OR IGNORE INTO proposals (
        id, proposer, type, title, description, status, arguments_for, arguments_against,
        signals, created_at, updated_at, timeout_ticks, ticks_elapsed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      "proposal-001",
      "arm-backend-architect",
      "change",
      "Migrate to PostgreSQL",
      "Proposal to migrate from SQLite to PostgreSQL for better concurrency",
      "open",
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify({}),
      now,
      now,
      10,
      2
    ]);
  } catch (err) {
    console.log(`Proposal error: ${err}`);
  }

  // Create some claims
  try {
    db.run(`
      INSERT OR IGNORE INTO claims (arm_id, file_path, claim_type, claimed_at)
      VALUES (?, ?, ?, ?)
    `, ["arm-backend-architect", "src/api/server.ts", "write", now]);
  } catch (err) {
    console.log(`Claim error: ${err}`);
  }

  console.log("Database seeded with development data");
}

// Migration 056: Add blocked_at timestamp to tasks for tracking when tasks become blocked