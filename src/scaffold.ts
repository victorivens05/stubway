import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { toRouteDir } from "./fixtures.js";
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

/** Write a fixture file. Returns its absolute path. Throws if it already exists. */
export function createFixture(fixturesDir: string, input: NewFixtureInput): string {
  const dir = toRouteDir(fixturesDir, input.route);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${input.name}.json`);
  if (existsSync(file)) {
    throw new Error(`fixture already exists: ${path.relative(process.cwd(), file)}`);
  }

  // Ordered so the generated file reads well: envelope metadata first, body last.
  const method = input.method ?? "ANY";
  const envelope: Record<string, unknown> = {};
  if (method !== "ANY") envelope.method = method;
  envelope.status = input.status ?? (method === "POST" ? 201 : 200);
  if (input.description) envelope.description = input.description;
  if (input.headers) envelope.headers = input.headers;
  if (input.timeoutMs !== undefined) envelope.timeoutMs = input.timeoutMs;
  envelope.body = input.body ?? {};

  writeFileSync(file, JSON.stringify(envelope, null, 2) + "\n");
  return file;
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
