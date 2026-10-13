import { closeSync, existsSync, openSync } from "fs";
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "nats";
import { getColeoDir } from "./context";
import { isProcessRunning } from "../daemon/utils";
import { resolveNatsHost, resolveNatsHttpPort, resolveNatsPort, resolveNatsUrl } from "../network-config";

const DEFAULT_NATS_VERSION = "2.12.3";
const NATS_READY_TIMEOUT_MS = 15_000;
const NATS_READY_POLL_MS = 250;
const execFileAsync = promisify(execFile);

interface LocalNatsPaths {
  binaryPath: string;
  dataDir: string;
  logPath: string;
  pidPath: string;
  runDir: string;
}

interface LocalNatsProcessInfo {
  pid: number;
  startedAt: string;
  command: string[];
}

interface NatsDownloadInfo {
  archive: string;
  downloadUrl: string;
  extractedBinaryPath: string;
  version: string;
}

export interface LocalNatsBootstrapResult {
  started: boolean;
  url: string;
}

export function getLocalNatsPaths(coleoDir = getColeoDir()): LocalNatsPaths {
  const runDir = join(coleoDir, "run");
  return {
    binaryPath: process.env.NATS_BIN || join(process.env.COLEO_BIN_DIR || join(coleoDir, "bin"), "nats-server"),
    dataDir: process.env.COLEO_NATS_DATA_DIR || join(coleoDir, "nats"),
    logPath: join(runDir, "nats.log"),
    pidPath: join(runDir, "nats.pid"),
    runDir,
  };
}

export function getLocalNatsUrl(): string {
  return resolveNatsUrl({ ...process.env, COLEO_NATS_URL: undefined });
}

export async function ensureLocalNatsForServe(
  log: (message: string) => void = console.log,
): Promise<LocalNatsBootstrapResult | null> {
  const configuredUrl = process.env.COLEO_NATS_URL?.trim();
  if (configuredUrl) {
    return null;
  }

  const url = getLocalNatsUrl();
  if (await canConnectToNats(url)) {
    process.env.COLEO_NATS_URL = url;
    log(`[serve] COLEO_NATS_URL not set; using local NATS at ${url}`);
    return { started: false, url };
  }

  const paths = getLocalNatsPaths();

  try {
    await clearStalePidFile(paths.pidPath);

    const existingPid = await readLocalNatsPid(paths.pidPath);
    if (existingPid && isProcessRunning(existingPid.pid)) {
      await waitForNats(url, NATS_READY_TIMEOUT_MS);
      process.env.COLEO_NATS_URL = url;
      log(`[serve] COLEO_NATS_URL not set; reusing background local NATS at ${url}`);
      return { started: false, url };
    }

    log(`[serve] COLEO_NATS_URL not set; bootstrapping local nats-server at ${url}`);
    await installLocalNatsBinary(paths.binaryPath);
    await startDetachedLocalNats(paths);
    await waitForNats(url, NATS_READY_TIMEOUT_MS);
    process.env.COLEO_NATS_URL = url;
    log(`[serve] Local NATS ready at ${url}`);
    return { started: true, url };
  } catch (error) {
    log(`[serve] Warning: failed to bootstrap local NATS automatically: ${formatError(error)}`);
    log(`[serve] Continuing without NATS. Set COLEO_NATS_URL to use an external server, or inspect ${paths.logPath}`);
    return null;
  }
}

export function getNatsDownloadInfo(version = process.env.NATS_VERSION || DEFAULT_NATS_VERSION): NatsDownloadInfo {
  const normalizedVersion = version.replace(/^v/, "");
  const platform = normalizePlatform(process.platform);
  const arch = normalizeArch(process.arch);
  const archive = `nats-server-v${normalizedVersion}-${platform}-${arch}.tar.gz`;
  const extractedDir = `nats-server-v${normalizedVersion}-${platform}-${arch}`;

  return {
    archive,
    downloadUrl: `https://github.com/nats-io/nats-server/releases/download/v${normalizedVersion}/${archive}`,
    extractedBinaryPath: join(extractedDir, "nats-server"),
    version: normalizedVersion,
  };
}

async function canConnectToNats(url: string): Promise<boolean> {
  try {
    const connection = await connect({
      servers: [url],
      timeout: 1_500,
      reconnect: false,
      maxReconnectAttempts: 0,
      noEcho: true,
      name: "coleo-serve-bootstrap-check",
    });
    await connection.close();
    return true;
  } catch {
    return false;
  }
}

async function waitForNats(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnectToNats(url)) {
      return;
    }
    await sleep(NATS_READY_POLL_MS);
  }
  throw new Error(`timed out waiting for NATS at ${url}`);
}

async function installLocalNatsBinary(binaryPath: string): Promise<void> {
  if (existsSync(binaryPath)) {
    return;
  }

  const downloadInfo = getNatsDownloadInfo();
  const tempDir = await mkdtemp(join(tmpdir(), "coleo-nats-"));
  const archivePath = join(tempDir, downloadInfo.archive);

  try {
    await mkdir(dirname(binaryPath), { recursive: true });
    const response = await fetch(downloadInfo.downloadUrl);
    if (!response.ok) {
      throw new Error(`download failed with HTTP ${response.status}`);
    }

    await Bun.write(archivePath, response);
    await runCommand("tar", ["-xzf", archivePath, "-C", tempDir]);

    const extractedBinary = join(tempDir, downloadInfo.extractedBinaryPath);
    const extractedFile = Bun.file(extractedBinary);
    if (!(await extractedFile.exists())) {
      throw new Error(`extracted archive did not contain ${downloadInfo.extractedBinaryPath}`);
    }

    await Bun.write(binaryPath, extractedFile);
    await chmod(binaryPath, 0o755);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function startDetachedLocalNats(paths: LocalNatsPaths): Promise<void> {
  await mkdir(paths.runDir, { recursive: true });
  await mkdir(paths.dataDir, { recursive: true });

  const startMarker = `\n\n========== NATS STARTED AT ${new Date().toISOString()} ==========\n\n`;
  await Bun.write(paths.logPath, startMarker, { createPath: true });

  const logFd = openSync(paths.logPath, "a");
  try {
    const child = spawn(
      paths.binaryPath,
      [
        "-js",
        "-sd",
        paths.dataDir,
        "-p",
        String(resolveNatsPort()),
        "-a",
        resolveNatsHost(),
        "--http_port",
        String(resolveNatsHttpPort()),
      ],
      {
        cwd: getColeoDir(),
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: process.env,
      },
    );

    if (!child.pid) {
      throw new Error("nats-server did not report a PID");
    }

    child.unref();

    const info: LocalNatsProcessInfo = {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      command: [
        paths.binaryPath,
        "-js",
        "-sd",
        paths.dataDir,
        "-p",
        String(resolveNatsPort()),
        "-a",
        resolveNatsHost(),
        "--http_port",
        String(resolveNatsHttpPort()),
      ],
    };

    await writeFile(paths.pidPath, JSON.stringify(info, null, 2), "utf-8");
  } finally {
    closeSync(logFd);
  }
}

async function clearStalePidFile(pidPath: string): Promise<void> {
  const info = await readLocalNatsPid(pidPath);
  if (!info) {
    return;
  }

  if (isProcessRunning(info.pid)) {
    return;
  }

  await unlink(pidPath).catch(() => undefined);
}

async function readLocalNatsPid(pidPath: string): Promise<LocalNatsProcessInfo | null> {
  try {
    const content = await readFile(pidPath, "utf-8");
    return JSON.parse(content) as LocalNatsProcessInfo;
  } catch {
    return null;
  }
}

async function runCommand(command: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(command, args, { env: process.env });
  } catch (error) {
    if (error instanceof Error && "stderr" in error) {
      const stderr = String(error.stderr || "").trim();
      throw new Error(`${command} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
    }
    throw error;
  }
}

function normalizePlatform(platform: NodeJS.Platform): "darwin" | "linux" {
  if (platform === "darwin" || platform === "linux") {
    return platform;
  }
  throw new Error(`unsupported platform for local nats-server bootstrap: ${platform}`);
}

function normalizeArch(arch: string): "amd64" | "arm64" {
  if (arch === "x64" || arch === "amd64") {
    return "amd64";
  }
  if (arch === "arm64" || arch === "aarch64") {
    return "arm64";
  }
  throw new Error(`unsupported architecture for local nats-server bootstrap: ${arch}`);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
