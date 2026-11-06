import pc from "picocolors";
import type { LogEntryDetailDto, LogEntryDto, RouteDto } from "./client.js";
import type { FixtureSequence } from "./types.js";

/** Render a route's fixtures, marking the active one per method. */
export function formatRoute(route: RouteDto): string {
  const lines: string[] = [pc.bold(route.path)];
  if (route.fixtures.length === 0 && route.problems.length === 0) lines.push(pc.dim("  (no fixtures yet)"));
  for (const fixture of route.fixtures) {
    const isActive = route.active[fixture.method] === fixture.name;
    const marker = isActive ? pc.green("●") : pc.dim("○");
    const name = isActive ? pc.green(fixture.name) : fixture.name;
    const meta = [
      pc.cyan(fixture.method.padEnd(6)),
      colorStatus(fixture.status),
      fixture.timeoutMs ? pc.yellow(`${fixture.timeoutMs}ms`) : "",
      fixture.handler ? pc.magenta("respond(req)") : "",
    ]
      .filter(Boolean)
      .join(" ");
    const desc = fixture.description ? pc.dim(`— ${fixture.description}`) : "";
    lines.push(`  ${marker} ${name.padEnd(20)} ${meta}  ${desc}`.trimEnd());
  }
  for (const [method, sequence] of Object.entries(route.sequences)) {
    lines.push(`  ${pc.dim("sequence")} ${pc.cyan(method)} ${formatSequence(sequence)}`);
  }
  for (const problem of route.problems) lines.push(`  ${pc.red("✗")} ${pc.red(problem)}`);
  return lines.join("\n");
}

export function formatRouteList(routes: RouteDto[]): string {
  if (routes.length === 0) return pc.dim("No routes. Add fixtures under your fixtures dir, or run `stubway new`.");
  return routes
    .map((route) => {
      const sequenceMethods = Object.keys(route.sequences);
      const active = [
        ...Object.entries(route.active)
          .filter(([method]) => !sequenceMethods.includes(method))
          .map(([method, name]) => `${pc.cyan(method)}:${pc.green(name)}`),
        ...Object.entries(route.sequences).map(
          ([method, sequence]) => `${pc.cyan(method)}:${formatSequence(sequence)}`,
        ),
      ].join(" ");
      const problems = route.problems.length ? pc.red(` ✗ ${route.problems.length} problem(s), see show`) : "";
      return `${pc.bold(route.path.padEnd(40))} ${active}${problems}`;
    })
    .join("\n");
}

export function formatLog(entries: LogEntryDto[]): string {
  if (entries.length === 0) return pc.dim("No requests logged.");
  return entries
    .map((e) => {
      const time = e.timestamp.slice(11, 23);
      const tag = logTag(e);
      const fixture = e.fixture ? pc.dim(`→ ${e.fixture}`) : "";
      // Show which pattern served a dynamic route, e.g. /users/123 (/users/[id]).
      const pattern =
        e.matchedRoute && e.matchedRoute !== e.path ? pc.dim(`(${e.matchedRoute})`) : "";
      const error = e.error ? pc.red(`! ${e.error}`) : "";
      return `${pc.dim(e.id)} ${pc.dim(time)} ${tag.padEnd(5)} ${pc.cyan(e.method.padEnd(6))} ${e.path} ${pattern} ${colorStatus(e.status)} ${fixture} ${pc.dim(`${e.durationMs}ms`)} ${error}`.trimEnd();
    })
    .join("\n");
}

/** Full detail for one logged request — headers and bodies, for `log show <id>`. */
export function formatLogEntryDetail(e: LogEntryDetailDto): string {
  const tag = logTag(e);
  const pattern = e.matchedRoute && e.matchedRoute !== e.path ? pc.dim(` (${e.matchedRoute})`) : "";
  const lines: string[] = [
    `${pc.bold(e.id)} ${pc.dim(e.timestamp)}`,
    `${tag} ${pc.cyan(e.method)} ${e.path}${pattern} ${colorStatus(e.status)} ${pc.dim(`${e.durationMs}ms`)}`,
  ];
  if (e.fixture) lines.push(`${pc.dim("fixture:")} ${e.fixture}`);
  if (e.error) lines.push(`${pc.dim("error:")} ${pc.red(e.error)}`);
  if (Object.keys(e.params).length > 0) lines.push(`${pc.dim("params:")} ${JSON.stringify(e.params)}`);
  lines.push(`${pc.dim("request headers:")} ${JSON.stringify(e.requestHeaders)}`);
  lines.push(`${pc.dim("request body:")} ${JSON.stringify(e.requestBody, null, 2)}`);
  lines.push(`${pc.dim("response body:")} ${JSON.stringify(e.responseBody, null, 2)}`);
  return lines.join("\n");
}

/** `pendente → [excluida]`: brackets mark the fixture the next request gets. */
export function formatSequence(sequence: FixtureSequence): string {
  return sequence.names
    .map((name, index) => (index === sequence.cursor ? pc.green(`[${name}]`) : name))
    .join(pc.dim(" → "));
}

/** WAIT: still being answered (e.g. a fixture's timeoutMs); ABORT: client gave up; FAIL: stubway threw. */
function logTag(e: LogEntryDto): string {
  if (e.state === "pending") return pc.yellow("WAIT");
  if (e.state === "aborted") return pc.yellow("ABORT");
  if (e.state === "failed") return pc.red("FAIL");
  if (e.error) return pc.red("ERR");
  if (e.unmatched) return pc.red("MISS");
  return e.proxied ? pc.magenta("PROXY") : pc.green("HIT");
}

function colorStatus(status: number | null): string {
  if (status === null) return pc.dim("---");
  const text = String(status);
  if (status < 300) return pc.green(text);
  if (status < 400) return pc.cyan(text);
  if (status < 500) return pc.yellow(text);
  return pc.red(text);
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
