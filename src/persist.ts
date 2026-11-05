import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE, REQUESTS_DIR } from "./constants.js";
import { ensureLocalDir, localDir } from "./paths.js";
import type { LogEntry, PersistedConfig, RuntimeConfig, Selections } from "./types.js";

export function loadPersistedConfig(cwd: string): PersistedConfig | null {
  try {
    const raw = readFileSync(path.join(localDir(cwd), CONFIG_FILE), "utf8");
    return JSON.parse(raw) as PersistedConfig;
  } catch {
    return null;
  }
}

export function savePersistedConfig(runtime: RuntimeConfig, selections: Selections): string {
  const config: PersistedConfig = {
    port: runtime.port,
    fixturesDir: path.relative(runtime.cwd, runtime.fixturesDir) || ".",
    proxy: runtime.proxy,
    record: runtime.record,
    selections,
  };
  ensureLocalDir(runtime.cwd);
  const target = path.join(localDir(runtime.cwd), CONFIG_FILE);
  writeFileSync(target, JSON.stringify(config, null, 2) + "\n");
  return target;
}

/** Dump the in-memory request log to the local dir as one navigable file per request. */
export function dumpRequests(runtime: RuntimeConfig, entries: LogEntry[]): string {
  const dir = path.join(localDir(runtime.cwd), REQUESTS_DIR);
  mkdirSync(dir, { recursive: true });
  entries.forEach((entry, index) => {
    const seq = String(index + 1).padStart(4, "0");
    const name = `${seq}-${entry.method}-${slug(entry.path)}.json`;
    writeFileSync(path.join(dir, name), JSON.stringify(entry, null, 2) + "\n");
  });
  return dir;
}

function slug(value: string): string {
  return value.replace(/^\/+/, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "root";
}
