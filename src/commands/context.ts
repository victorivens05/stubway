import { ControlClient, DaemonUnreachableError } from "../client.js";
import { DEFAULT_PORT } from "../constants.js";
import { readDaemonInfo } from "../daemon.js";
import { findProjectDir } from "../paths.js";
import pc from "picocolors";

/**
 * Which daemon a client command talks to: --port, then STUBWAY_PORT, then the daemon running
 * for this project (this folder or an ancestor, see findProjectDir), then the default.
 * An unparseable --port or STUBWAY_PORT is an error, never a silent fallback.
 */
export function resolvePort(opts: { port?: string }, cwd = process.cwd()): number {
  return resolveTarget(opts, cwd).port;
}

/** The port to reach, plus the pid expected there when the port came from the project's pidfile. */
export function resolveTarget(opts: { port?: string }, cwd = process.cwd()): { port: number; pid?: number } {
  const explicit = explicitPort(opts);
  if (explicit !== undefined) return { port: explicit };
  const info = readDaemonInfo(findProjectDir(cwd));
  return info ? { port: info.port, pid: info.pid } : { port: DEFAULT_PORT };
}

/** --port, else STUBWAY_PORT, else undefined. */
export function explicitPort(opts: { port?: string }): number | undefined {
  if (opts.port) return parsePort(opts.port, "--port");
  if (process.env.STUBWAY_PORT) return parsePort(process.env.STUBWAY_PORT, "STUBWAY_PORT");
  return undefined;
}

export function parsePort(raw: string, source: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${source} must be a port number from 1 to 65535, got "${raw}"`);
  }
  return port;
}

export function makeClient(opts: { port?: string }): ControlClient {
  const target = resolveTarget(opts);
  return new ControlClient(target.port, target.pid);
}

/** Run a client command, printing a friendly error and exiting non-zero on failure. */
export async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    if (err instanceof DaemonUnreachableError) {
      process.stderr.write(pc.red(`\n${err.message}\n`));
    } else {
      process.stderr.write(pc.red(`stubway: ${(err as Error).message}\n`));
    }
    process.exitCode = 1;
  }
}
