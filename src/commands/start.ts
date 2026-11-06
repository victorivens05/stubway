import path from "node:path";
import pc from "picocolors";
import { CONTROL_PREFIX, DEFAULT_FIXTURES_DIR, DEFAULT_PORT } from "../constants.js";
import {
  daemonStatus,
  fetchHealth,
  removeDaemonInfo,
  startDetached,
  stopDaemon,
  writeDaemonInfo,
} from "../daemon.js";
import { isDirectory, loadCatalog } from "../fixtures.js";
import { findProjectDir } from "../paths.js";
import { dumpRequests, loadPersistedConfig, savePersistedConfig } from "../persist.js";
import { createStubwayServer } from "../server.js";
import { restoreSelections, StubwayState } from "../state.js";
import type { Route, RuntimeConfig } from "../types.js";
import { printJson } from "../format.js";
import { version } from "../version.js";
import { explicitPort, parsePort, run } from "./context.js";

export interface StartOptions {
  port?: string;
  fixtures?: string;
  proxy?: string;
  record?: boolean;
  persist?: boolean;
  foreground?: boolean;
}

/** Resolve effective runtime config from CLI flags, then STUBWAY_PORT, then config.json, then defaults. */
export function resolveRuntime(opts: StartOptions, cwd = process.cwd()): RuntimeConfig {
  const persisted = loadPersistedConfig(cwd) ?? {};
  return {
    port: startPort(opts, persisted.port),
    fixturesDir: path.resolve(cwd, opts.fixtures ?? persisted.fixturesDir ?? DEFAULT_FIXTURES_DIR),
    proxy: opts.proxy ?? persisted.proxy ?? null,
    record: opts.record ?? persisted.record ?? false,
    persist: !!opts.persist,
    cwd,
  };
}

function startPort(opts: StartOptions, persistedPort: number | undefined): number {
  if (opts.port) return parsePort(opts.port, "--port");
  if (process.env.STUBWAY_PORT) return parsePort(process.env.STUBWAY_PORT, "STUBWAY_PORT");
  return persistedPort ?? DEFAULT_PORT;
}

/**
 * Where fixture files should be written: an explicit --fixtures, else the running daemon's
 * fixtures dir (so writes land where it serves from), else config.json / default.
 */
export async function resolveFixturesDir(opts: StartOptions, cwd = process.cwd()): Promise<string> {
  if (opts.fixtures) return path.resolve(cwd, opts.fixtures);
  const port = explicitPort(opts);
  if (port !== undefined) {
    const health = await fetchHealth(port);
    if (!health?.fixturesDir) throw new Error(`no stubway daemon answers on port ${port}; pass --fixtures`);
    return health.fixturesDir;
  }
  const status = await daemonStatus(findProjectDir(cwd));
  if (status.running && status.info) return status.info.fixturesDir;
  return resolveRuntime(opts, cwd).fixturesDir;
}

export function startCommand(opts: StartOptions): Promise<void> {
  return run(async () => {
    const runtime = resolveRuntime(opts);
    if (opts.foreground) return runForeground(runtime);
    const info = await startDetached(runtime);
    const catalog = loadCatalog(runtime.fixturesDir);
    process.stdout.write(
      `${pc.green("✓")} stubway ${version} running (pid ${info.pid}) on ${pc.cyan(`http://localhost:${info.port}`)}\n` +
        pc.dim(`  fixtures ${runtime.fixturesDir} · ${catalog.length} route(s) · stop with \`stubway stop\`\n`),
    );
    process.stderr.write(fixturesRootWarnings(runtime.fixturesDir, catalog));
  });
}

/** Problems an agent should see before trusting the daemon: an empty or missing root, invalid files. */
export function fixturesRootProblems(fixturesDir: string, catalog: Route[]): string[] {
  const lines: string[] = [];
  if (!isDirectory(fixturesDir)) {
    lines.push(`fixtures folder ${fixturesDir} does not exist. Is that the correct folder? Every request will 404.`);
  } else if (catalog.every((route) => route.fixtures.length === 0)) {
    lines.push(`fixtures folder ${fixturesDir} has no fixtures. Is that the correct folder? Every request will 404.`);
  }
  const invalid = catalog.flatMap((route) => route.invalidFixtures);
  if (invalid.length > 0) {
    lines.push(`${invalid.length} invalid fixture file(s), skipped:`);
    for (const fixture of invalid) lines.push(`  ${fixture.file}: ${fixture.reason}`);
  }
  return lines;
}

function fixturesRootWarnings(fixturesDir: string, catalog: Route[]): string {
  return fixturesRootProblems(fixturesDir, catalog)
    .map((line) => pc.yellow(`⚠ ${line}`) + "\n")
    .join("");
}

/** Run the server in the current process (used directly, or by the detached parent). */
export function runForeground(runtime: RuntimeConfig): void {
  const persisted = loadPersistedConfig(runtime.cwd) ?? {};
  const state = new StubwayState([], restoreSelections(persisted.selections ?? {}), runtime);
  state.reload();
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
    process.stderr.write(fixturesRootWarnings(runtime.fixturesDir, state.catalog));
  });

  server.on("error", (err) => {
    process.stderr.write(`stubway: cannot listen on port ${runtime.port}: ${err.message}\n`);
    process.exit(1);
  });

  installShutdown(state, () => server.close());
}

export function stopCommand(opts: { json?: boolean; port?: string }): Promise<void> {
  return run(async () => {
    const cwd = findProjectDir(process.cwd());
    const port = explicitPort(opts);
    const stopped = await stopDaemon(cwd, port);
    if (opts.json) return printJson({ stopped: !!stopped, info: stopped });
    const where = port ? `on port ${port} in this directory` : "in this directory";
    process.stdout.write(
      stopped
        ? `${pc.green("✓")} stopped stubway (pid ${stopped.pid}) on port ${stopped.port}\n`
        : pc.dim(`no running stubway daemon ${where}\n`),
    );
  });
}

export function statusCommand(opts: { json?: boolean }): Promise<void> {
  return run(async () => {
    const status = await daemonStatus(findProjectDir(process.cwd()));
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
