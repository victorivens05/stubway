import type { LogQuery } from "../client.js";
import { formatLog, formatLogEntryDetail, formatRoute, formatRouteList, printJson } from "../format.js";
import { makeClient, run } from "./context.js";

interface JsonOpt {
  port?: string;
  json?: boolean;
}

export function routesCommand(opts: JsonOpt): Promise<void> {
  return run(async () => {
    const routes = await makeClient(opts).routes();
    if (opts.json) return printJson(routes);
    process.stdout.write(formatRouteList(routes) + "\n");
  });
}

export function showCommand(routePath: string, opts: JsonOpt): Promise<void> {
  return run(async () => {
    const route = await makeClient(opts).route(routePath);
    if (opts.json) return printJson(route);
    process.stdout.write(formatRoute(route) + "\n");
  });
}

export function logCommand(
  opts: JsonOpt & { route?: string; method?: string; since?: string; limit?: string; bodies?: boolean },
): Promise<void> {
  return run(async () => {
    if (opts.bodies && !opts.json) throw new Error("--bodies only works with --json");
    const query: LogQuery = {
      route: opts.route,
      method: opts.method,
      since: opts.since,
      limit: opts.limit === undefined ? undefined : Number(opts.limit),
    };
    if (opts.json && opts.bodies) return printJson((await makeClient(opts).logWithBodies(query)).entries);
    const { entries } = await makeClient(opts).log(query);
    if (opts.json) return printJson(entries);
    process.stdout.write(formatLog(entries) + "\n");
  });
}

export function logShowCommand(id: string, opts: JsonOpt): Promise<void> {
  return run(async () => {
    const entry = await makeClient(opts).logEntry(id);
    if (opts.json) return printJson(entry);
    process.stdout.write(formatLogEntryDetail(entry) + "\n");
  });
}

export function logClearCommand(opts: JsonOpt): Promise<void> {
  return run(async () => {
    const result = await makeClient(opts).clearLog();
    if (opts.json) return printJson(result);
    process.stdout.write(`Cleared ${result.cleared} log entr${result.cleared === 1 ? "y" : "ies"}.\n`);
  });
}
