import { randomUUID } from "node:crypto";
import path from "node:path";
import { canonicalizeRoutePath, loadCatalog, toRouteDir } from "./fixtures.js";
import type {
  Fixture,
  FixtureMethod,
  FixtureSequence,
  LogEntry,
  Route,
  RuntimeConfig,
  Selections,
} from "./types.js";

/** The largest timestamp a JavaScript Date can hold. */
const MAX_DATE_MS = 8.64e15;

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

  /**
   * Re-read fixtures from disk. A route someone selected a fixture on stays in the catalog even
   * after its last file is gone, so its requests report the broken selection instead of falling
   * through to a dynamic sibling route or the proxy.
   */
  reload(): void {
    const catalog = loadCatalog(this.runtime.fixturesDir);
    const vanished = Object.keys(this.selections)
      .filter((routePath) => !catalog.some((route) => route.path === routePath))
      .map((routePath) => ({
        path: routePath,
        dir: toRouteDir(this.runtime.fixturesDir, routePath),
        fixtures: [],
        invalidFixtures: [],
      }));
    this.catalog = [...catalog, ...vanished].sort((a, b) => a.path.localeCompare(b.path));
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

  /**
   * Resolve which fixture answers a request for the given method. Never advances a sequence;
   * the server does that with advanceSequence once the step answered.
   */
  resolveFixture(route: Route, method: FixtureMethod): FixtureResolution {
    const selected = this.selectedFixture(route, method);
    if (selected) return selected;
    const fixture = defaultFixture(route, method);
    return fixture ? { kind: "served", fixture } : { kind: "noFixture" };
  }

  /** The fixture name currently active per method of a route, broken selections included. */
  activeByMethod(route: Route): Record<string, string> {
    const result: Record<string, string> = {};
    for (const method of this.methodsFor(route)) {
      const resolution = this.resolveFixture(route, method);
      if (resolution.kind !== "noFixture") result[method] = resolutionName(resolution);
    }
    return result;
  }

  /** Invalid fixture files and selections that can't be served, as readable lines. */
  problemsFor(route: Route): string[] {
    const problems = route.invalidFixtures.map((f) => `${path.basename(f.file)} is invalid: ${f.reason}`);
    for (const method of Object.keys(this.selections[route.path] ?? {}) as FixtureMethod[]) {
      const resolution = this.selectedFixture(route, method);
      if (resolution?.kind === "brokenSelection") problems.push(`${method} selection: ${resolution.reason}`);
    }
    return problems;
  }

  /** Sequences set on a route, keyed by the method slot that holds them. */
  sequencesByMethod(route: Route): Record<string, FixtureSequence> {
    const result: Record<string, FixtureSequence> = {};
    for (const [method, selection] of Object.entries(this.selections[route.path] ?? {})) {
      if (selection && typeof selection !== "string") {
        result[method] = { names: [...selection.names], cursor: selection.cursor };
      }
    }
    return result;
  }

  /**
   * Set the active fixture for a route, or a sequence served one per request. The fixtures'
   * own method decides the slot, so every name in a sequence must share one. Resets the cursor.
   */
  setSelection(routePath: string, fixtureNames: string | string[]): Route {
    const route = this.getRoute(routePath);
    if (!route) throw new StateError(`unknown route: ${routePath}`);
    const names = typeof fixtureNames === "string" ? [fixtureNames] : fixtureNames;
    if (names.length === 0) throw new StateError(`no fixture name given for ${routePath}`);

    const fixtures = names.map((name) => findFixture(route, routePath, name));
    const methods = new Set(fixtures.map((f) => f.method));
    if (methods.size > 1) {
      const listed = fixtures.map((f) => `${f.name} (${f.method})`).join(", ");
      throw new StateError(`a sequence must use fixtures of one method, got: ${listed}`);
    }

    const slot = (this.selections[route.path] ??= {});
    slot[fixtures[0]!.method] = names.length === 1 ? names[0]! : { names: [...names], cursor: 0 };
    return route;
  }

  private selectedFixture(
    route: Route,
    method: FixtureMethod,
  ): FixtureResolution | undefined {
    const routeSelections = this.selections[route.path];
    const selection = routeSelections?.[method] ?? (method !== "ANY" ? routeSelections?.ANY : undefined);
    if (selection === undefined) return undefined;
    const name = typeof selection === "string" ? selection : selection.names[selection.cursor]!;
    const fixture = candidatesFor(route, method).find((f) => f.name === name);
    if (fixture) {
      const sequence = typeof selection === "string" ? undefined : selection;
      return { kind: "served", fixture, sequence };
    }
    return { kind: "brokenSelection", name, reason: brokenSelectionReason(route, name) };
  }

  record(entry: Omit<LogEntry, "id" | "timestamp">): LogEntry {
    const full: LogEntry = { id: randomUUID().slice(0, 8), timestamp: new Date().toISOString(), ...entry };
    this.log.push(full);
    return full;
  }

  /** Filter the log; `limit` keeps the most recent entries. Throws StateError on an unreadable `since`. */
  queryLog(opts: LogFilter = {}): LogEntry[] {
    let entries = this.log;
    if (opts.route) {
      const wanted = normalizePath(canonicalizeRoutePath(opts.route));
      entries = entries.filter((e) => e.matchedRoute === wanted || e.path === wanted);
    }
    if (opts.method) {
      const wanted = opts.method.toUpperCase();
      entries = entries.filter((e) => e.method === wanted);
    }
    if (opts.since) {
      const cutoff = parseSince(opts.since);
      entries = entries.filter((e) => Date.parse(e.timestamp) >= cutoff);
    }
    if (opts.limit !== undefined) entries = entries.slice(-opts.limit);
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

/** Saved selections prepared for a daemon that is starting: every sequence is back at its first fixture. */
export function restoreSelections(selections: Selections): Selections {
  return Object.fromEntries(
    Object.entries(selections).map(([routePath, byMethod]) => [routePath, rewindSequences(byMethod)]),
  );
}

function rewindSequences(byMethod: Selections[string]): Selections[string] {
  return Object.fromEntries(
    Object.entries(byMethod).map(([method, selection]) => [
      method,
      typeof selection === "string" ? selection : { names: [...selection.names], cursor: 0 },
    ]),
  );
}

/**
 * served: this fixture answers; `sequence` is set when a sequence chose it.
 * brokenSelection: a fixture was chosen with `use` but can't be served (deleted, invalid, method changed).
 * noFixture: nothing on the route answers this method.
 */
export type FixtureResolution =
  | { kind: "served"; fixture: Fixture; sequence?: FixtureSequence }
  | { kind: "brokenSelection"; name: string; reason: string }
  | { kind: "noFixture" };

export interface LogFilter {
  route?: string;
  method?: string;
  /** ISO timestamp or epoch milliseconds. */
  since?: string;
  limit?: number;
}

function candidatesFor(route: Route, method: FixtureMethod): Fixture[] {
  return route.fixtures.filter((f) => f.method === method || (method !== "ANY" && f.method === "ANY"));
}

/** With nothing selected: the method's own fixtures first, ANY fixtures only as a fallback. */
function defaultFixture(route: Route, method: FixtureMethod): Fixture | undefined {
  const exact = route.fixtures.filter((f) => f.method === method);
  const fallback = method === "ANY" ? [] : route.fixtures.filter((f) => f.method === "ANY");
  return preferredFixture(exact) ?? preferredFixture(fallback);
}

function preferredFixture(fixtures: Fixture[]): Fixture | undefined {
  for (const preferred of DEFAULT_FIXTURE_NAMES) {
    const match = fixtures.find((f) => f.name === preferred);
    if (match) return match;
  }
  return fixtures[0];
}

function resolutionName(resolution: Exclude<FixtureResolution, { kind: "noFixture" }>): string {
  return resolution.kind === "served" ? resolution.fixture.name : resolution.name;
}

function brokenSelectionReason(route: Route, name: string): string {
  const invalid = route.invalidFixtures.find((f) => f.name === name);
  if (invalid) return `selected fixture "${name}" is invalid: ${invalid.reason}`;
  const otherMethod = route.fixtures.find((f) => f.name === name);
  if (otherMethod) return `selected fixture "${name}" now declares method ${otherMethod.method}`;
  return `selected fixture "${name}" no longer exists in ${route.dir}`;
}

function parseSince(since: string): number {
  const cutoff = /^\d+$/.test(since) ? Number(since) : Date.parse(since);
  if (!Number.isFinite(cutoff) || Math.abs(cutoff) > MAX_DATE_MS) {
    throw new StateError(`unreadable since "${since}": use an ISO timestamp or epoch milliseconds`);
  }
  return cutoff;
}

/** Move a sequence to its next fixture, staying on the last one. */
export function advanceSequence(sequence: FixtureSequence): void {
  sequence.cursor = Math.min(sequence.cursor + 1, sequence.names.length - 1);
}

function findFixture(route: Route, routePath: string, name: string): Fixture {
  const fixture = route.fixtures.find((f) => f.name === name);
  if (fixture) return fixture;
  const available = route.fixtures.map((f) => f.name).join(", ") || "(none)";
  throw new StateError(`unknown fixture "${name}" for ${routePath}. available: ${available}`);
}

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
