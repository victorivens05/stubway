import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { envelopeProblem, toRouteDir } from "./fixtures.js";
import type { Fixture, FixtureMethod } from "./types.js";

export interface NewFixtureInput {
  route: string;
  name: string;
  method?: FixtureMethod;
  status?: number;
  description?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

/** Write a fixture file. Returns its absolute path. Throws if it already exists or is invalid. */
export function createFixture(fixturesDir: string, input: NewFixtureInput): string {
  const envelope = buildEnvelope(input);
  const file = fixtureFilePath(fixturesDir, input.route, input.name);
  const problem = envelopeProblem(envelope);
  if (problem) throw new Error(`invalid fixture ${input.name}: ${problem}`);
  if (existsSync(file)) {
    throw new Error(`fixture already exists: ${path.relative(process.cwd(), file)}`);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(envelope, null, 2) + "\n");
  return file;
}

/** Ordered so the generated file reads well: envelope metadata first, body last. */
function buildEnvelope(input: NewFixtureInput): Record<string, unknown> {
  const method = input.method ?? "ANY";
  const envelope: Record<string, unknown> = {};
  if (method !== "ANY") envelope.method = method;
  envelope.status = input.status ?? (method === "POST" ? 201 : 200);
  if (input.description) envelope.description = input.description;
  if (input.headers) envelope.headers = input.headers;
  if (input.timeoutMs !== undefined) envelope.timeoutMs = input.timeoutMs;
  envelope.body = input.body === undefined ? {} : input.body;
  return envelope;
}

/** Resolve where a fixture file goes, refusing names or routes that would land outside fixturesDir. */
function fixtureFilePath(fixturesDir: string, route: string, name: string): string {
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
    throw new Error(`invalid fixture name "${name}": use a plain file name without slashes`);
  }
  const root = path.resolve(fixturesDir);
  const dir = path.resolve(toRouteDir(root, route));
  const relative = path.relative(root, dir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`route "${route}" resolves outside the fixtures dir ${root}`);
  }
  return path.join(dir, `${name}.json`);
}

/** Persist a proxied upstream response as a new fixture (record mode). */
export function recordFixture(
  fixturesDir: string,
  routePath: string,
  fixture: Omit<Fixture, "name" | "file">,
): string {
  const name = `recorded-${Date.now()}`;
  return createFixture(fixturesDir, {
    route: routePath,
    name,
    method: fixture.method,
    status: fixture.status,
    description: fixture.description ?? "recorded from upstream",
    headers: fixture.headers,
    body: fixture.body,
  });
}
