import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { CONFIG_FILE } from "./constants.js";
import type { Fixture, FixtureMethod, Route } from "./types.js";
import { HTTP_METHODS } from "./types.js";

const IGNORED_FILES = new Set([CONFIG_FILE]);

/** Skip node_modules and any dot-directory (.git, .stubway/.local, …). */
function isIgnoredDir(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}

/** Read the fixtures directory into a catalog of routes (filesystem-as-routing). */
export function loadCatalog(fixturesDir: string): Route[] {
  const byDir = new Map<string, Fixture[]>();

  for (const file of listJsonFiles(fixturesDir)) {
    const fixture = parseFixture(file);
    if (!fixture) continue;
    const dir = path.dirname(file);
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(fixture);
    else byDir.set(dir, [fixture]);
  }

  return [...byDir.entries()]
    .map(([dir, fixtures]) => ({
      dir,
      path: toRoutePath(fixturesDir, dir),
      fixtures: fixtures.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function listJsonFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // dir does not exist yet — empty catalog
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnoredDir(entry.name)) walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".json") && !IGNORED_FILES.has(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function parseFixture(file: string): Fixture | null {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    warn(`skipping ${rel(file)}: invalid JSON (${(err as Error).message})`);
    return null;
  }

  if (typeof data !== "object" || data === null) {
    warn(`skipping ${rel(file)}: fixture must be a JSON object`);
    return null;
  }

  const record = data as Record<string, unknown>;
  if (typeof record.status !== "number") {
    warn(`skipping ${rel(file)}: missing numeric "status"`);
    return null;
  }

  return {
    name: path.basename(file, ".json"),
    file,
    method: normalizeMethod(record.method),
    status: record.status,
    description: typeof record.description === "string" ? record.description : undefined,
    headers: isStringRecord(record.headers) ? record.headers : undefined,
    body: record.body,
    timeoutMs: typeof record.timeoutMs === "number" ? record.timeoutMs : undefined,
  };
}

function normalizeMethod(value: unknown): FixtureMethod {
  if (typeof value !== "string") return "ANY";
  const upper = value.toUpperCase();
  if (upper === "ANY") return "ANY";
  return (HTTP_METHODS as readonly string[]).includes(upper) ? (upper as FixtureMethod) : "ANY";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

/** Convert an absolute directory into its URL route path. */
export function toRoutePath(fixturesDir: string, dir: string): string {
  const relative = path.relative(fixturesDir, dir);
  if (relative === "" || relative === ".") return "/";
  return "/" + relative.split(path.sep).join("/");
}

/**
 * Turn CLI-friendly dynamic segments (`:id`) into the canonical on-disk form (`[id]`).
 * Next.js-style brackets are used on disk because a colon is not a valid path character
 * on every platform; the colon form is only ergonomic shell input.
 */
export function canonicalizeRoutePath(routePath: string): string {
  return routePath
    .split("/")
    .map((segment) =>
      segment.startsWith(":") && segment.length > 1 ? `[${segment.slice(1)}]` : segment,
    )
    .join("/");
}

/** Convert a URL route path back into its on-disk directory. */
export function toRouteDir(fixturesDir: string, routePath: string): string {
  const clean = canonicalizeRoutePath(routePath).replace(/^\/+/, "");
  return clean ? path.join(fixturesDir, ...clean.split("/")) : fixturesDir;
}

function rel(file: string): string {
  return path.relative(process.cwd(), file) || file;
}

function warn(message: string): void {
  process.stderr.write(`${pc.yellow("stubway:")} ${message}\n`);
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
