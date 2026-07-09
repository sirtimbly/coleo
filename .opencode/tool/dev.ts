import { tool } from "@opencode-ai/plugin";

/**
 * Dev server control tools for Coleo
 * 
 * These tools help manage the development environment:
 * - API server (port 8080)
 * - Web UI dev server (port 5173)
 * - Brain loop
 */

export const server_start = tool({
  description: `Start the Coleo API server on port 8080.

This starts the main API server which provides:
- REST API for arm management, tasks, mail, etc.
- WebSocket for real-time updates
- Connection to NATS for distributed messaging

The server runs in the background. Use dev_server_stop to stop it.`,
  args: {},
  async execute() {
    try {
      // Check if already running
      const check = await Bun.$`curl -s http://localhost:8080/api/health 2>/dev/null`.text();
      if (check.includes('"status":"ok"')) {
        return "Server is already running on port 8080";
      }
    } catch {
      // Not running, proceed to start
    }

    // Start the server via the daemon manager so it tracks PID/uptime
    // (bare `serve` never writes ~/.coleo/run/server.pid, which breaks
    // the Arms TUI's "service" status even though the API itself is up)
    await Bun.$`bun run src/cli/index.ts serve start &>/tmp/coleo-server.log`.text();

    // Wait for server to be ready
    let attempts = 0;
    while (attempts < 10) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        const check = await Bun.$`curl -s http://localhost:8080/api/health`.text();
        if (check.includes('"status":"ok"')) {
          return "Server started successfully on port 8080. Logs at /tmp/coleo-server.log";
        }
      } catch {
        // Not ready yet
      }
      attempts++;
    }
    
    return "Server may have started but health check timed out. Check /tmp/coleo-server.log for details.";
  },
});

export const server_stop = tool({
  description: `Stop the Coleo API server.

Kills any running Coleo server process.`,
  args: {},
  async execute() {
    // Use the daemon manager's stop so the PID file is removed cleanly.
    // Falls back to pkill in case the process was started outside `serve start`.
    await Bun.$`bun run src/cli/index.ts serve stop -f 2>/dev/null || true`.text();
    await Bun.$`pkill -f "bun.*cli/index.ts.*serve" 2>/dev/null || true`.text();
    
    // Verify it's stopped
    await new Promise(resolve => setTimeout(resolve, 500));
    try {
      const check = await Bun.$`curl -s --max-time 1 http://localhost:8080/api/health 2>/dev/null`.text();
      if (check.includes('"status":"ok"')) {
        return "Warning: Server still appears to be running";
      }
    } catch {
      // Expected - server is stopped
    }
    
    return "Server stopped";
  },
});

export const server_status = tool({
  description: `Check if the Coleo API server is running.

Returns the health status if running, or indicates it's not running.`,
  args: {},
  async execute() {
    try {
      const health = await Bun.$`curl -s --max-time 2 http://localhost:8080/api/health`.text();
      const data = JSON.parse(health);
      return `Server is running. Status: ${data.status}, Timestamp: ${data.timestamp}`;
    } catch (err) {
      return "Server is not running";
    }
  },
});

export const web_start = tool({
  description: `Start the Coleo Web UI development server on port 5173.

This starts the Vite dev server for the React dashboard.
The web UI connects to the API server on port 8080.

Note: The API server should be running first (use dev_server_start).`,
  args: {},
  async execute() {
    try {
      // Check if already running
      const check = await Bun.$`curl -s --max-time 1 http://localhost:5173 2>/dev/null`.text();
      if (check.length > 0) {
        return "Web UI dev server is already running on port 5173";
      }
    } catch {
      // Not running, proceed to start
    }

    // Start the web dev server in background
    await Bun.$`cd src/web && bun run dev &>/tmp/coleo-web.log &`.text();
    
    // Wait for server to be ready
    let attempts = 0;
    while (attempts < 15) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        const check = await Bun.$`curl -s --max-time 1 http://localhost:5173`.text();
        if (check.length > 100) { // HTML content
          return "Web UI dev server started on http://localhost:5173. Logs at /tmp/coleo-web.log";
        }
      } catch {
        // Not ready yet
      }
      attempts++;
    }
    
    return "Web server may have started but health check timed out. Check /tmp/coleo-web.log";
  },
});

export const web_stop = tool({
  description: `Stop the Coleo Web UI development server.`,
  args: {},
  async execute() {
    await Bun.$`pkill -f "vite.*src/web" 2>/dev/null || true`.text();
    await Bun.$`pkill -f "bun.*web.*dev" 2>/dev/null || true`.text();
    return "Web UI dev server stopped";
  },
});

export const brain_start = tool({
  description: `Start the Coleo Brain loop.

The brain is the central coordinator that:
- Monitors arm health and activity
- Assigns tasks to arms
- Handles permission requests
- Manages the overall workflow

Note: The API server should be running first (use dev_server_start).`,
  args: {},
  async execute() {
    // Start the brain in background
    await Bun.$`bun run src/cli/index.ts brain run &>/tmp/coleo-brain.log &`.text();
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Check status via API
    try {
      const status = await Bun.$`curl -s http://localhost:8080/api/status`.text();
      if (status.includes('"brain"')) {
        return "Brain started. Logs at /tmp/coleo-brain.log";
      }
    } catch {
      // API not available
    }
    
    return "Brain process started. Check /tmp/octopai-brain.log for status.";
  },
});

export const brain_stop = tool({
  description: `Stop the Coleo Brain loop.`,
  args: {},
  async execute() {
    await Bun.$`pkill -f "bun.*brain.*run" 2>/dev/null || true`.text();
    return "Brain stopped";
  },
});

export const logs = tool({
  description: `View recent logs from Coleo services.

Shows the last N lines from server, web, or brain logs.`,
  args: {
    service: tool.schema.enum(["server", "web", "brain"]).describe("Which service logs to view"),
    lines: tool.schema.number().optional().describe("Number of lines to show (default: 50)"),
  },
  async execute(args) {
    const logFiles: Record<string, string> = {
      server: "/tmp/coleo-server.log",
      web: "/tmp/coleo-web.log",
      brain: "/tmp/coleo-brain.log",
    };
    
    const logFile = logFiles[args.service];
    const lines = args.lines || 50;
    
    try {
      const result = await Bun.$`tail -${lines} ${logFile} 2>/dev/null`.text();
      if (result.trim().length === 0) {
        return `No logs found for ${args.service} (file: ${logFile})`;
      }
      return `=== Last ${lines} lines of ${args.service} logs ===\n${result}`;
    } catch {
      return `No logs found for ${args.service} (file may not exist)`;
    }
  },
});
