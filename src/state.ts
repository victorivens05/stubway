import { randomUUID } from "node:crypto";
import { canonicalizeRoutePath, loadCatalog } from "./fixtures.js";
import type {
  Fixture,
  FixtureMethod,
  LogEntry,
  Route,
  RuntimeConfig,
  Selections,
} from "./types.js";

/** Preference order when no explicit selection exists for a method. */
const DEFAULT_FIXTURE_NAMES = ["default", "ok", "success"];

/** In-memory source of truth for a running daemon. */
export class StubwayState {
  catalog: Route[];
  selections: Selections;
  readonly log: LogEntry[] = [];
  readonly runtime: RuntimeConfig;

  constructor(catalog: Route[], selections: Selections, runtime: RuntimeConfig) {
    this.catalog = catalog;
    this.selections = selections;
    this.runtime = runtime;
  }

  /** Re-read fixtures from disk (selections are preserved; stale ones simply fall back). */
  reload(): void {
    this.catalog = loadCatalog(this.runtime.fixturesDir);
  }

  /**
   * Match a concrete request path against the catalog, capturing dynamic segments.
   * Static segments beat dynamic ones, compared left-to-right, so /users/me wins over
   * /users/[id] when both could match. Returns the most specific route.
   */
  matchRoute(pathname: string): RouteMatch | undefined {
    const requestSegments = splitSegments(normalizePath(pathname));
    let best: (RouteMatch & { specificity: number[] }) | undefined;
    for (const route of this.catalog) {
      const attempt = matchSegments(route.path, requestSegments);
      if (!attempt) continue;
      if (!best || compareSpecificity(attempt.specificity, best.specificity) > 0) {
        best = { route, params: attempt.params, specificity: attempt.specificity };
      }
    }
    if (!best) return undefined;
    return { route: best.route, params: best.params };
  }

  /** Look up a route by its declared path (accepts `:id` or `[id]` addressing). */
  getRoute(routePath: string): Route | undefined {
    const normalized = normalizePath(canonicalizeRoutePath(routePath));
    return this.catalog.find((route) => route.path === normalized);
  }

  /** Distinct methods declared across a route's fixtures. */
  methodsFor(route: Route): FixtureMethod[] {
    return [...new Set(route.fixtures.map((f) => f.method))];
  }

  /** Resolve which fixture answers a request for the given method. */
  resolveFixture(route: Route, method: FixtureMethod): Fixture | undefined {
    const candidates = route.fixtures.filter(
      (f) => f.method === method || (method !== "ANY" && f.method === "ANY"),
    );
    if (candidates.length === 0) return undefined;

    const routeSelections = this.selections[route.path];
    const selectedName =
      routeSelections?.[method] ?? (method !== "ANY" ? routeSelections?.ANY : undefined);
    if (selectedName) {
      const chosen = candidates.find((f) => f.name === selectedName);
      if (chosen) return chosen;
    }

    for (const preferred of DEFAULT_FIXTURE_NAMES) {
      const match = candidates.find((f) => f.name === preferred);
      if (match) return match;
    }
    return candidates[0];
  }

  /** The set of fixture names currently active (across every method of a route). */
  activeByMethod(route: Route): Record<string, string> {
    const result: Record<string, string> = {};
    for (const method of this.methodsFor(route)) {
      const fixture = this.resolveFixture(route, method);
      if (fixture) result[method] = fixture.name;
    }
    return result;
  }

  /** Set the active fixture for a route. The fixture's own method decides the slot. */
  setSelection(routePath: string, fixtureName: string): Route {
    const route = this.getRoute(routePath);
    if (!route) throw new StateError(`unknown route: ${routePath}`);
    const fixture = route.fixtures.find((f) => f.name === fixtureName);
    if (!fixture) {
      const available = route.fixtures.map((f) => f.name).join(", ") || "(none)";
      throw new StateError(`unknown fixture "${fixtureName}" for ${routePath}. available: ${available}`);
    }
    const slot = (this.selections[route.path] ??= {});
    slot[fixture.method] = fixture.name;
    return route;
  }

  record(entry: Omit<LogEntry, "id" | "timestamp">): LogEntry {
    const full: LogEntry = { id: randomUUID().slice(0, 8), timestamp: new Date().toISOString(), ...entry };
    this.log.push(full);
    return full;
  }

  queryLog(opts: { route?: string; since?: string } = {}): LogEntry[] {
    let entries = this.log;
    if (opts.route) {
      const wanted = normalizePath(canonicalizeRoutePath(opts.route));
      entries = entries.filter((e) => e.matchedRoute === wanted || e.path === wanted);
    }
    if (opts.since) {
      const cutoff = Date.parse(opts.since);
      if (!Number.isNaN(cutoff)) {
        entries = entries.filter((e) => Date.parse(e.timestamp) >= cutoff);
      }
    }
    return entries;
  }

  /** Look up one logged request by its short id, most recent first. */
  getLogEntry(id: string): LogEntry | undefined {
    return [...this.log].reverse().find((e) => e.id === id);
  }

  clearLog(): number {
    const count = this.log.length;
    this.log.length = 0;
    return count;
  }
}

export class StateError extends Error {}

/** A route that matched a concrete request, with any captured dynamic segments. */
export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
}

/** Strip query, collapse duplicate slashes, drop trailing slash (except root). */
export function normalizePath(pathname: string): string {
  const withoutQuery = pathname.split("?")[0] ?? pathname;
  const collapsed = ("/" + withoutQuery).replace(/\/+/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
}

/** Break a normalized path into its non-empty segments; root ("/") yields []. */
function splitSegments(normalizedPath: string): string[] {
  return normalizedPath.split("/").filter((segment) => segment.length > 0);
}

/** Name of the captured param if the segment is dynamic (`[id]`), else null. */
function dynamicParamName(segment: string): string | null {
  return segment.startsWith("[") && segment.endsWith("]") && segment.length > 2
    ? segment.slice(1, -1)
    : null;
}

interface SegmentMatch {
  params: Record<string, string>;
  /** Per-segment specificity: 1 for a static match, 0 for a dynamic capture. */
  specificity: number[];
}

/** Match a route's declared path against request segments, capturing dynamic parts. */
function matchSegments(routePath: string, requestSegments: string[]): SegmentMatch | null {
  const routeSegments = splitSegments(routePath);
  if (routeSegments.length !== requestSegments.length) return null;

  const params: Record<string, string> = {};
  const specificity: number[] = [];
  for (let i = 0; i < routeSegments.length; i++) {
    const routeSegment = routeSegments[i]!;
    const requestSegment = requestSegments[i]!;
    const paramName = dynamicParamName(routeSegment);
    if (paramName) {
      params[paramName] = requestSegment;
      specificity.push(0);
    } else if (routeSegment === requestSegment) {
      specificity.push(1);
    } else {
      return null;
    }
  }
  return { params, specificity };
}

/** Compare two equal-length specificity vectors left-to-right; >0 means `a` is more specific. */
function compareSpecificity(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
