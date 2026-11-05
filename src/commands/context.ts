import { ControlClient, DaemonUnreachableError } from "../client.js";
import { DEFAULT_PORT } from "../constants.js";
import pc from "picocolors";

/** Resolve the daemon port from --port, then STUBWAY_PORT, then the default. */
export function resolvePort(opts: { port?: string }): number {
  if (opts.port) {
    const parsed = Number(opts.port);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  const fromEnv = process.env.STUBWAY_PORT;
  if (fromEnv) {
    const parsed = Number(fromEnv);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_PORT;
}

export function makeClient(opts: { port?: string }): ControlClient {
  return new ControlClient(resolvePort(opts));
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
