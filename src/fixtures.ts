import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { CONFIG_FILE } from "./constants.js";
import { errorMessage, evaluateFixtureScript } from "./handler.js";
import type { Fixture, FixtureMethod, InvalidFixture, Route } from "./types.js";
import { HTTP_METHODS } from "./types.js";

const IGNORED_FILES = new Set([CONFIG_FILE]);
const FIXTURE_EXTENSIONS = [".json", ".js"];

/** Skip node_modules and any dot-directory (.git, .stubway/.local, …). */
function isIgnoredDir(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}

/** Read the fixtures directory into a catalog of routes (filesystem-as-routing). */
export function loadCatalog(fixturesDir: string): Route[] {
  const byDir = new Map<string, Route>();

  for (const file of listFixtureFiles(fixturesDir)) {
    const dir = path.dirname(file);
    let route = byDir.get(dir);
    if (!route) {
      route = { dir, path: toRoutePath(fixturesDir, dir), fixtures: [], invalidFixtures: [] };
      byDir.set(dir, route);
    }
    const parsed = parseFixture(file);
    const taken = [...route.fixtures, ...route.invalidFixtures].find((f) => f.name === parsed.name);
    if (taken) {
      const reason = `${path.basename(taken.file)} already defines fixture "${parsed.name}"`;
      warn(`skipping ${rel(file)}: ${reason}`);
      route.invalidFixtures.push({ name: parsed.name, file, reason });
    } else if ("reason" in parsed) route.invalidFixtures.push(parsed);
    else route.fixtures.push(parsed);
  }

  for (const route of byDir.values()) route.fixtures.sort((a, b) => a.name.localeCompare(b.name));
  return [...byDir.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function listFixtureFiles(root: string): string[] {
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
      } else if (entry.isFile() && isFixtureFile(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

function isFixtureFile(name: string): boolean {
  return FIXTURE_EXTENSIONS.includes(path.extname(name)) && !IGNORED_FILES.has(name);
}

function parseFixture(file: string): Fixture | InvalidFixture {
  const isScript = path.extname(file) === ".js";
  const name = path.basename(file, path.extname(file));
  const invalid = (reason: string): InvalidFixture => {
    warn(`skipping ${rel(file)}: ${reason}`);
    return { name, file, reason };
  };

  let data: unknown;
  try {
    const source = readFileSync(file, "utf8");
    data = isScript ? evaluateFixtureScript(source, file) : JSON.parse(source);
  } catch (err) {
    return invalid(`${isScript ? "evaluating it threw" : "invalid JSON"} (${errorMessage(err)})`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return invalid(`fixture must be ${isScript ? "an object literal" : "a JSON object"}`);
  }

  const record = data as Record<string, unknown>;
  const problem = envelopeProblem(record);
  if (problem) return invalid(problem);

  return {
    name,
    file,
    method: record.method === undefined ? "ANY" : ((record.method as string).toUpperCase() as FixtureMethod),
    status: record.status as number,
    description: typeof record.description === "string" ? record.description : undefined,
    headers: record.headers as Record<string, string> | undefined,
    body: record.body,
    timeoutMs: record.timeoutMs as number | undefined,
    respond: record.respond as Fixture["respond"],
  };
}

/** The first rule a fixture envelope breaks, or null. Shared by loading from disk and scaffolding. */
export function envelopeProblem(envelope: Record<string, unknown>): string | null {
  const { method, status, timeoutMs, headers, respond, body } = envelope;
  if (method !== undefined && !isFixtureMethod(method)) {
    return `"method" must be ANY or one of ${HTTP_METHODS.join(", ")}, got ${JSON.stringify(method)}`;
  }
  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) {
    return `"status" must be an integer from 200 to 599, got ${JSON.stringify(status)}`;
  }
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    return `"timeoutMs" must be a non-negative number, got ${JSON.stringify(timeoutMs)}`;
  }
  if (headers !== undefined && !isStringRecord(headers)) {
    return `"headers" must be an object of string values`;
  }
  if (respond !== undefined && typeof respond !== "function") {
    return `"respond" must be a function of the request, in a .js fixture`;
  }
  if (respond !== undefined && body !== undefined) {
    return `give "body" or "respond", not both`;
  }
  return null;
}

function isFixtureMethod(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const upper = value.toUpperCase();
  return upper === "ANY" || (HTTP_METHODS as readonly string[]).includes(upper);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
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
