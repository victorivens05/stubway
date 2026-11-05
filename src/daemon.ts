import { spawn } from "node:child_process";
import { openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROL_PREFIX, DAEMON_LOG, PIDFILE } from "./constants.js";
import { ensureLocalDir, localDir } from "./paths.js";
import type { RuntimeConfig } from "./types.js";

export interface DaemonInfo {
  pid: number;
  port: number;
  fixturesDir: string;
  proxy: string | null;
  record: boolean;
  persist: boolean;
  startedAt: string;
}

export interface DaemonStatus {
  running: boolean;
  info: DaemonInfo | null;
}

export function pidfilePath(cwd: string): string {
  return path.join(localDir(cwd), PIDFILE);
}

export function daemonLogPath(cwd: string): string {
  return path.join(localDir(cwd), DAEMON_LOG);
}

export function writeDaemonInfo(info: DaemonInfo, cwd: string): void {
  ensureLocalDir(cwd);
  writeFileSync(pidfilePath(cwd), JSON.stringify(info, null, 2) + "\n");
}

export function readDaemonInfo(cwd: string): DaemonInfo | null {
  try {
    return JSON.parse(readFileSync(pidfilePath(cwd), "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

export function removeDaemonInfo(cwd: string): void {
  try {
    rmSync(pidfilePath(cwd));
  } catch {
    /* already gone */
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function isHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${CONTROL_PREFIX}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/** Resolve the daemon's status from the pidfile, pruning stale entries. */
export async function daemonStatus(cwd: string): Promise<DaemonStatus> {
  const info = readDaemonInfo(cwd);
  if (!info) return { running: false, info: null };
  if (!isAlive(info.pid) || !(await isHealthy(info.port))) {
    removeDaemonInfo(cwd);
    return { running: false, info: null };
  }
  return { running: true, info };
}

const CLI_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");

/**
 * Spawn a detached foreground daemon, wait until it answers health, and return its info.
 * Throws if one is already running or startup times out.
 */
export async function startDetached(runtime: RuntimeConfig): Promise<DaemonInfo> {
  const existing = await daemonStatus(runtime.cwd);
  if (existing.running) {
    throw new Error(`stubway already running (pid ${existing.info!.pid}) on port ${existing.info!.port}`);
  }

  ensureLocalDir(runtime.cwd);
  const logFd = openSync(daemonLogPath(runtime.cwd), "a");

  const args = [CLI_ENTRY, "start", "--foreground", "--port", String(runtime.port), "--fixtures", runtime.fixturesDir];
  if (runtime.proxy) args.push("--proxy", runtime.proxy);
  if (runtime.record) args.push("--record");
  if (runtime.persist) args.push("--persist");

  const child = spawn(process.execPath, args, {
    cwd: runtime.cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();

  for (let attempt = 0; attempt < 100; attempt++) {
    if (await isHealthy(runtime.port)) {
      const info = readDaemonInfo(runtime.cwd);
      if (info) return info;
    }
    if (child.exitCode !== null) {
      throw new Error(`daemon exited during startup — see ${path.relative(runtime.cwd, daemonLogPath(runtime.cwd))}`);
    }
    await delay(100);
  }
  throw new Error(`daemon did not become healthy on port ${runtime.port} within 10s`);
}

/** Stop a running daemon. Returns the info of the daemon that was stopped, or null. */
export async function stopDaemon(cwd: string): Promise<DaemonInfo | null> {
  const status = await daemonStatus(cwd);
  if (!status.running || !status.info) return null;

  try {
    process.kill(status.info.pid, "SIGTERM");
  } catch {
    /* fall through to cleanup */
  }

  for (let attempt = 0; attempt < 50; attempt++) {
    if (!isAlive(status.info.pid)) break;
    await delay(100);
  }
  removeDaemonInfo(cwd);
  return status.info;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
