import path from "node:path";
import pc from "picocolors";
import { CONTROL_PREFIX, DEFAULT_FIXTURES_DIR, DEFAULT_PORT } from "../constants.js";
import {
  daemonStatus,
  removeDaemonInfo,
  startDetached,
  stopDaemon,
  writeDaemonInfo,
} from "../daemon.js";
import { loadCatalog } from "../fixtures.js";
import { dumpRequests, loadPersistedConfig, savePersistedConfig } from "../persist.js";
import { createStubwayServer } from "../server.js";
import { StubwayState } from "../state.js";
import type { RuntimeConfig } from "../types.js";
import { printJson } from "../format.js";
import { version } from "../version.js";
import { run } from "./context.js";

export interface StartOptions {
  port?: string;
  fixtures?: string;
  proxy?: string;
  record?: boolean;
  persist?: boolean;
  foreground?: boolean;
}

/** Resolve effective runtime config from CLI flags, then config.json, then defaults. */
export function resolveRuntime(opts: StartOptions, cwd = process.cwd()): RuntimeConfig {
  const persisted = loadPersistedConfig(cwd) ?? {};
  return {
    port: opts.port ? Number(opts.port) : persisted.port ?? DEFAULT_PORT,
    fixturesDir: path.resolve(cwd, opts.fixtures ?? persisted.fixturesDir ?? DEFAULT_FIXTURES_DIR),
    proxy: opts.proxy ?? persisted.proxy ?? null,
    record: opts.record ?? persisted.record ?? false,
    persist: !!opts.persist,
    cwd,
  };
}

/**
 * Where fixture files should be written. Prefer a running daemon's fixtures dir (so writes
 * land where it serves from); otherwise resolve from flags / config.json / default.
 */
export async function resolveFixturesDir(opts: StartOptions, cwd = process.cwd()): Promise<string> {
  const status = await daemonStatus(cwd);
  if (status.running && status.info) return status.info.fixturesDir;
  return resolveRuntime(opts, cwd).fixturesDir;
}

export function startCommand(opts: StartOptions): void {
  const runtime = resolveRuntime(opts);
  if (opts.foreground) {
    runForeground(runtime);
    return;
  }
  void run(async () => {
    const info = await startDetached(runtime);
    process.stdout.write(
      `${pc.green("✓")} stubway ${version} running (pid ${info.pid}) on ${pc.cyan(`http://localhost:${info.port}`)}\n` +
        pc.dim(`  fixtures ${path.relative(runtime.cwd, runtime.fixturesDir) || "."} · stop with \`stubway stop\`\n`),
    );
  });
}

/** Run the server in the current process (used directly, or by the detached parent). */
export function runForeground(runtime: RuntimeConfig): void {
  const persisted = loadPersistedConfig(runtime.cwd) ?? {};
  const state = new StubwayState(loadCatalog(runtime.fixturesDir), persisted.selections ?? {}, runtime);
  const server = createStubwayServer(state);

  server.listen(runtime.port, () => {
    writeDaemonInfo(
      {
        pid: process.pid,
        port: runtime.port,
        fixturesDir: runtime.fixturesDir,
        proxy: runtime.proxy,
        record: runtime.record,
        persist: runtime.persist,
        startedAt: new Date().toISOString(),
      },
      runtime.cwd,
    );
    printBanner(state);
  });

  installShutdown(state, () => server.close());
}

export function stopCommand(opts: { json?: boolean }): Promise<void> {
  return run(async () => {
    const cwd = process.cwd();
    const stopped = await stopDaemon(cwd);
    if (opts.json) return printJson({ stopped: !!stopped, info: stopped });
    process.stdout.write(
      stopped
        ? `${pc.green("✓")} stopped stubway (pid ${stopped.pid}) on port ${stopped.port}\n`
        : pc.dim("no running stubway daemon in this directory\n"),
    );
  });
}

export function statusCommand(opts: { json?: boolean }): Promise<void> {
  return run(async () => {
    const status = await daemonStatus(process.cwd());
    if (opts.json) return printJson(status);
    if (!status.running || !status.info) {
      process.stdout.write(pc.dim("stubway: not running\n"));
      return;
    }
    const i = status.info;
    process.stdout.write(
      `${pc.green("● running")}  pid ${i.pid}  ${pc.cyan(`http://localhost:${i.port}`)}  ` +
        `${pc.dim(`fixtures ${path.relative(process.cwd(), i.fixturesDir) || "."}`)}\n`,
    );
  });
}

function printBanner(state: StubwayState): void {
  const { runtime, catalog } = state;
  const line = (label: string, value: string) => `  ${pc.dim(label.padEnd(11))} ${value}`;
  process.stdout.write(
    [
      pc.bold(pc.green(`\n  stubway ${version}`)) + pc.dim("  listening"),
      line("mock", pc.cyan(`http://localhost:${runtime.port}`)),
      line("control", pc.cyan(`http://localhost:${runtime.port}${CONTROL_PREFIX}`)),
      line("fixtures", path.relative(runtime.cwd, runtime.fixturesDir) || "."),
      line("routes", String(catalog.length)),
      line(
        "proxy",
        runtime.proxy
          ? pc.magenta(runtime.proxy) + (runtime.record ? pc.yellow(" (recording)") : "")
          : pc.dim("off"),
      ),
      line("persist", runtime.persist ? pc.green("on") : pc.dim("off (ephemeral)")),
      "",
    ].join("\n") + "\n",
  );
}

function installShutdown(state: StubwayState, closeServer: () => void): void {
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    if (state.runtime.persist) {
      savePersistedConfig(state.runtime, state.selections);
      dumpRequests(state.runtime, state.log);
    }
    removeDaemonInfo(state.runtime.cwd);
    closeServer();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
