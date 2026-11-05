import pc from "picocolors";
import type { LogEntryDetailDto, LogEntryDto, RouteDto } from "./client.js";

/** Render a route's fixtures, marking the active one per method. */
export function formatRoute(route: RouteDto): string {
  const lines: string[] = [pc.bold(route.path)];
  if (route.fixtures.length === 0) {
    lines.push(pc.dim("  (no fixtures yet)"));
    return lines.join("\n");
  }
  for (const fixture of route.fixtures) {
    const isActive = route.active[fixture.method] === fixture.name;
    const marker = isActive ? pc.green("●") : pc.dim("○");
    const name = isActive ? pc.green(fixture.name) : fixture.name;
    const meta = [
      pc.cyan(fixture.method.padEnd(6)),
      colorStatus(fixture.status),
      fixture.timeoutMs ? pc.yellow(`${fixture.timeoutMs}ms`) : "",
    ]
      .filter(Boolean)
      .join(" ");
    const desc = fixture.description ? pc.dim(`— ${fixture.description}`) : "";
    lines.push(`  ${marker} ${name.padEnd(20)} ${meta}  ${desc}`.trimEnd());
  }
  return lines.join("\n");
}

export function formatRouteList(routes: RouteDto[]): string {
  if (routes.length === 0) return pc.dim("No routes. Add fixtures under your fixtures dir, or run `stubway new`.");
  return routes
    .map((route) => {
      const active = Object.entries(route.active)
        .map(([method, name]) => `${pc.cyan(method)}:${pc.green(name)}`)
        .join(" ");
      return `${pc.bold(route.path.padEnd(40))} ${active}`;
    })
    .join("\n");
}

export function formatLog(entries: LogEntryDto[]): string {
  if (entries.length === 0) return pc.dim("No requests logged.");
  return entries
    .map((e) => {
      const time = e.timestamp.slice(11, 23);
      const tag = e.unmatched ? pc.red("MISS") : e.proxied ? pc.magenta("PROXY") : pc.green("HIT");
      const fixture = e.fixture ? pc.dim(`→ ${e.fixture}`) : "";
      // Show which pattern served a dynamic route, e.g. /users/123 (/users/[id]).
      const pattern =
        e.matchedRoute && e.matchedRoute !== e.path ? pc.dim(`(${e.matchedRoute})`) : "";
      return `${pc.dim(e.id)} ${pc.dim(time)} ${tag.padEnd(5)} ${pc.cyan(e.method.padEnd(6))} ${e.path} ${pattern} ${colorStatus(e.status)} ${fixture} ${pc.dim(`${e.durationMs}ms`)}`.trimEnd();
    })
    .join("\n");
}

/** Full detail for one logged request — headers and bodies, for `log show <id>`. */
export function formatLogEntryDetail(e: LogEntryDetailDto): string {
  const tag = e.unmatched ? pc.red("MISS") : e.proxied ? pc.magenta("PROXY") : pc.green("HIT");
  const pattern = e.matchedRoute && e.matchedRoute !== e.path ? pc.dim(` (${e.matchedRoute})`) : "";
  const lines: string[] = [
    `${pc.bold(e.id)} ${pc.dim(e.timestamp)}`,
    `${tag} ${pc.cyan(e.method)} ${e.path}${pattern} ${colorStatus(e.status)} ${pc.dim(`${e.durationMs}ms`)}`,
  ];
  if (e.fixture) lines.push(`${pc.dim("fixture:")} ${e.fixture}`);
  if (Object.keys(e.params).length > 0) lines.push(`${pc.dim("params:")} ${JSON.stringify(e.params)}`);
  lines.push(`${pc.dim("request headers:")} ${JSON.stringify(e.requestHeaders)}`);
  lines.push(`${pc.dim("request body:")} ${JSON.stringify(e.requestBody, null, 2)}`);
  lines.push(`${pc.dim("response body:")} ${JSON.stringify(e.responseBody, null, 2)}`);
  return lines.join("\n");
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
