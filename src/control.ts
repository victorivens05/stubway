import type { IncomingMessage, ServerResponse } from "node:http";
import type { LogEntryDto, RouteDto } from "./client.js";
import { CONTROL_PREFIX } from "./constants.js";
import { readBody, sendJson } from "./http.js";
import { StateError, type StubwayState } from "./state.js";
import type { LogEntry, Route } from "./types.js";
import { version } from "./version.js";

/** DTO for a route as exposed by the control API. */
export function routeDto(state: StubwayState, route: Route): RouteDto {
  return {
    path: route.path,
    active: state.activeByMethod(route),
    sequences: state.sequencesByMethod(route),
    problems: state.problemsFor(route),
    fixtures: route.fixtures.map((f) => ({
      name: f.name,
      method: f.method,
      status: f.status,
      description: f.description,
      timeoutMs: f.timeoutMs,
      handler: f.respond !== undefined,
    })),
  };
}

/** Lean summary for the log list — omits request/response bodies to keep listings cheap. */
export function logSummaryDto(entry: LogEntry): LogEntryDto {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    method: entry.method,
    path: entry.path,
    matchedRoute: entry.matchedRoute,
    params: entry.params,
    fixture: entry.fixture,
    status: entry.status,
    unmatched: entry.unmatched,
    proxied: entry.proxied,
    durationMs: entry.durationMs,
    state: entry.state,
    error: entry.error,
  };
}

/**
 * Handle a control-plane request (anything under CONTROL_PREFIX).
 * Everything here is JSON in / JSON out.
 */
export async function handleControl(
  state: StubwayState,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const method = req.method ?? "GET";
  const route = url.pathname.slice(CONTROL_PREFIX.length) || "/";

  try {
    if (method === "GET" && route === "/health") {
      return sendJson(res, 200, {
        ok: true,
        version,
        pid: process.pid,
        port: state.runtime.port,
        fixturesDir: state.runtime.fixturesDir,
        proxy: state.runtime.proxy,
        record: state.runtime.record,
        persist: state.runtime.persist,
        routes: state.catalog.length,
      });
    }

    if (method === "GET" && route === "/routes") {
      return sendJson(res, 200, {
        routes: state.catalog.map((r) => routeDto(state, r)),
      });
    }

    if (method === "GET" && route === "/routes/show") {
      const path = url.searchParams.get("path");
      if (!path) return sendJson(res, 400, { error: "missing ?path=" });
      const found = state.getRoute(path);
      if (!found) return sendJson(res, 404, { error: `unknown route: ${path}` });
      return sendJson(res, 200, routeDto(state, found));
    }

    if (method === "POST" && route === "/use") {
      const { value } = await readBody(req);
      const { route: routePath, fixture } = asObject(value);
      if (typeof routePath !== "string" || !isFixtureNames(fixture)) {
        return sendJson(res, 400, { error: 'body must be { "route": string, "fixture": string | string[] }' });
      }
      const updated = state.setSelection(routePath, fixture);
      return sendJson(res, 200, routeDto(state, updated));
    }

    if (method === "GET" && route === "/log") {
      const entries = state.queryLog({
        route: url.searchParams.get("route") ?? undefined,
        method: url.searchParams.get("method") ?? undefined,
        since: url.searchParams.get("since") ?? undefined,
        limit: parseLimit(url.searchParams.get("limit")),
      });
      const withBodies = url.searchParams.get("bodies") === "1";
      return sendJson(res, 200, {
        count: entries.length,
        entries: withBodies ? entries : entries.map(logSummaryDto),
      });
    }

    if (method === "GET" && route.startsWith("/log/") && route !== "/log/clear") {
      const id = route.slice("/log/".length);
      const found = state.getLogEntry(id);
      if (!found) return sendJson(res, 404, { error: `unknown log entry: ${id}` });
      return sendJson(res, 200, found);
    }

    if (method === "POST" && route === "/log/clear") {
      return sendJson(res, 200, { cleared: state.clearLog() });
    }

    return sendJson(res, 404, { error: `unknown control endpoint: ${method} ${route}` });
  } catch (err) {
    const status = err instanceof StateError ? 400 : 500;
    return sendJson(res, status, { error: (err as Error).message });
  }
}

function parseLimit(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new StateError(`limit must be a positive integer, got "${raw}"`);
  }
  return limit;
}

function isFixtureNames(value: unknown): value is string | string[] {
  if (typeof value === "string") return true;
  return Array.isArray(value) && value.length > 0 && value.every((name) => typeof name === "string");
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
