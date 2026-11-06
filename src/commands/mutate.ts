import path from "node:path";
import pc from "picocolors";
import { formatRoute, printJson } from "../format.js";
import { createFixture, type NewFixtureInput } from "../scaffold.js";
import type { FixtureMethod } from "../types.js";
import { resolveFixturesDir } from "./start.js";
import { makeClient, run } from "./context.js";

interface JsonOpt {
  port?: string;
  json?: boolean;
}

/** `fixture` is one name, or a comma-separated list that becomes a sequence. */
export function useCommand(route: string, fixture: string, opts: JsonOpt): Promise<void> {
  return run(async () => {
    const names = fixture.split(",").map((name) => name.trim()).filter(Boolean);
    const updated = await makeClient(opts).use(route, names.length === 1 ? names[0]! : names);
    if (opts.json) return printJson(updated);
    process.stdout.write(`${pc.green("✓")} ${route} → ${pc.green(names.join(" → "))}\n${formatRoute(updated)}\n`);
  });
}

export interface NewFixtureOptions extends JsonOpt {
  fixtures?: string;
  method?: string;
  status?: string;
  description?: string;
  timeoutMs?: string;
  body?: string;
}

/**
 * Create a fixture by writing directly to disk — no running daemon required. A running
 * daemon (which reloads from disk per request) picks it up automatically.
 */
export function newFixtureCommand(
  route: string,
  name: string,
  opts: NewFixtureOptions,
): Promise<void> {
  return run(async () => {
    const input: NewFixtureInput = { route, name };
    if (opts.method) input.method = opts.method.toUpperCase() as FixtureMethod;
    if (opts.status) input.status = Number(opts.status);
    if (opts.description) input.description = opts.description;
    if (opts.timeoutMs) input.timeoutMs = Number(opts.timeoutMs);
    if (opts.body) input.body = parseBody(opts.body);

    const fixturesDir = await resolveFixturesDir(opts);
    const file = createFixture(fixturesDir, input);
    if (opts.json) return printJson({ file, route, name });
    process.stdout.write(
      `${pc.green("✓")} created fixture ${pc.green(name)} for ${route}\n${pc.dim(path.relative(process.cwd(), file))}\n`,
    );
  });
}

function parseBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // allow plain-string bodies
  }
}
