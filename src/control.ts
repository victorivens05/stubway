import type { IncomingMessage, ServerResponse } from "node:http";
import { CONTROL_PREFIX } from "./constants.js";
import { readBody, sendJson } from "./http.js";
import { StateError, type StubwayState } from "./state.js";
import type { LogEntry, Route } from "./types.js";
import { version } from "./version.js";

/** DTO for a route as exposed by the control API. */
export function routeDto(state: StubwayState, route: Route) {
  return {
    path: route.path,
    active: state.activeByMethod(route),
    fixtures: route.fixtures.map((f) => ({
      name: f.name,
      method: f.method,
      status: f.status,
      description: f.description,
      timeoutMs: f.timeoutMs,
    })),
  };
}

/** Lean summary for the log list — omits request/response bodies to keep listings cheap. */
export function logSummaryDto(entry: LogEntry) {
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
      if (typeof routePath !== "string" || typeof fixture !== "string") {
        return sendJson(res, 400, { error: 'body must be { "route": string, "fixture": string }' });
      }
      const updated = state.setSelection(routePath, fixture);
      return sendJson(res, 200, routeDto(state, updated));
    }

    if (method === "GET" && route === "/log") {
      const entries = state.queryLog({
        route: url.searchParams.get("route") ?? undefined,
        since: url.searchParams.get("since") ?? undefined,
      });
      return sendJson(res, 200, { count: entries.length, entries: entries.map(logSummaryDto) });
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

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
